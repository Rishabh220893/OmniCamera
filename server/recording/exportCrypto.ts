/**
 * Encryption at rest for evidence exports (gap A21, docs/security-architecture.md).
 *
 * An export is a video file that may be evidence in a case; left as a plain file in a folder it is readable by anyone who can read that disk or a backup of
 * it. With `EVIDENCE_ENCRYPTION_KEY` set, an export is stored encrypted and decrypted only as it is streamed to a person who is allowed to download it.
 *
 *   - **Per-file key.** Each file gets a random 256-bit data key; the data key is *wrapped* (AES-256-GCM) with the master key and stored in the file's header.
 *     Rotating the master key means re-wrapping the small header (`rewrap`), not re-encrypting the video; losing the master key loses the files.
 *   - **Chunked AES-256-GCM.** The file is cut into 1 MiB chunks, each encrypted with its own nonce (a counter) and checked with its own tag, so a download
 *     can start at once, a flipped bit anywhere is found, and memory stays small. The chunk number is part of what is authenticated, so chunks cannot be
 *     reordered, dropped from the middle or repeated, and a file cut short is found at the end (the last chunk is marked).
 *   - **Format:** `OMNX1` (5 bytes) | wrapped key (12 nonce + 32 key + 16 tag = 60 bytes) | 4 bytes chunk size | then chunks: 4 bytes length of ciphertext, 1 byte
 *     `last` flag, ciphertext, 16 bytes tag. The manifest's SHA-256 stays that of the *plain* video, so an export can be checked after it is decrypted.
 *
 * This protects files at rest against someone with the disk, not against someone with the running server and the key: the server holds the master key.
 * Keeping it in a KMS or HSM (so the server asks for a data key instead of holding the master) is the next step and is described in the security document.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAGIC = Buffer.from('OMNX1');
export const CHUNK = 1024 * 1024;
const TAG = 16, NONCE = 12, HEADER_LEN = MAGIC.length + NONCE + 32 + TAG + 4;

export class CryptoError extends Error { constructor(message: string) { super(message); this.name = 'CryptoError'; } }

/** A master key given as 64 hex characters or base64 (of 32 bytes). */
export function parseMasterKey(raw: string): Buffer {
  const t = raw.trim();
  const k = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (k.length !== 32) throw new CryptoError('EVIDENCE_ENCRYPTION_KEY must be 32 random bytes, as 64 hex characters or base64.');
  return k;
}

export function masterKeyFromEnv(env: Record<string, string | undefined>): Buffer | null {
  const raw = env.EVIDENCE_ENCRYPTION_KEY;
  return raw && raw.trim() ? parseMasterKey(raw) : null;
}

/** Whether a file starts like one of ours. */
export async function isEncryptedFile(file: string): Promise<boolean> {
  const fh = await fs.open(file, 'r');
  try { const b = Buffer.alloc(MAGIC.length); const { bytesRead } = await fh.read(b, 0, b.length, 0); return bytesRead === MAGIC.length && b.equals(MAGIC); } finally { await fh.close(); }
}

const wrap = (master: Buffer, dataKey: Buffer): Buffer => { const iv = randomBytes(NONCE); const c = createCipheriv('aes-256-gcm', master, iv, { authTagLength: TAG }); c.setAAD(MAGIC); return Buffer.concat([iv, c.update(dataKey), c.final(), c.getAuthTag()]); };
const unwrap = (master: Buffer, wrapped: Buffer): Buffer => {
  try { const d = createDecipheriv('aes-256-gcm', master, wrapped.subarray(0, NONCE), { authTagLength: TAG }); d.setAAD(MAGIC); d.setAuthTag(wrapped.subarray(NONCE + 32)); return Buffer.concat([d.update(wrapped.subarray(NONCE, NONCE + 32)), d.final()]); }
  catch { throw new CryptoError('The file cannot be unlocked with this key (wrong key, or the header was changed).'); }
};
const chunkNonce = (index: number, last: boolean): Buffer => { const n = Buffer.alloc(NONCE); n.writeUInt32BE(index >>> 0, 4); n.writeUInt32BE(Math.floor(index / 2 ** 32), 0); if (last) n[NONCE - 1] ^= 0x01; return n; };

class Encryptor extends Transform {
  // Incoming pieces are kept in a list and joined once per chunk (joining on every piece copied the same bytes many times over).
  private parts: Buffer[] = []; private held = 0; private index = 0;
  constructor(private key: Buffer, header: Buffer) { super(); this.push(header); }
  private seal(chunk: Buffer, last: boolean) {
    const c = createCipheriv('aes-256-gcm', this.key, chunkNonce(this.index, last), { authTagLength: TAG });
    c.setAAD(Buffer.from([last ? 1 : 0]));
    const ct = Buffer.concat([c.update(chunk), c.final()]);
    const head = Buffer.alloc(5); head.writeUInt32BE(ct.length, 0); head[4] = last ? 1 : 0;
    this.index++;
    this.push(Buffer.concat([head, ct, c.getAuthTag()]));
  }
  _transform(data: Buffer, _e: BufferEncoding, cb: TransformCallback) {
    this.parts.push(data); this.held += data.length;
    // Keep at least one byte back, so the final chunk can be marked as the last one.
    if (this.held > CHUNK) {
      let buf = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.held);
      while (buf.length > CHUNK) { this.seal(buf.subarray(0, CHUNK), false); buf = buf.subarray(CHUNK); }
      this.parts = buf.length ? [buf] : []; this.held = buf.length;
    }
    cb();
  }
  _flush(cb: TransformCallback) { this.seal(this.parts.length ? Buffer.concat(this.parts, this.held) : Buffer.alloc(0), true); cb(); }
}

/** Encrypts `src` into `dst` (replacing it). Returns the plain size in bytes. */
export async function encryptFile(src: string, dst: string, master: Buffer): Promise<number> {
  const dataKey = randomBytes(32);
  const header = Buffer.concat([MAGIC, wrap(master, dataKey), Buffer.from([0, 0, 0, 0])]);
  header.writeUInt32BE(CHUNK, header.length - 4);
  let plain = 0;
  const count = new Transform({ transform(c: Buffer, _e, cb) { plain += c.length; cb(null, c); } });
  const tmp = `${dst}.part`;
  await pipeline(createReadStream(src), count, new Encryptor(dataKey, header), createWriteStream(tmp));
  await fs.rename(tmp, dst);
  return plain;
}

/** A readable stream of the plain bytes. Errors (as a `CryptoError`) the moment a chunk fails its check, or the file ends before its last chunk. */
export function decryptStream(file: string, master: Buffer, o: { start?: number } = {}): Readable {
  async function* gen() {
    const fh = await fs.open(file, 'r');
    try {
      const head = Buffer.alloc(HEADER_LEN);
      const { bytesRead } = await fh.read(head, 0, HEADER_LEN, 0);
      if (bytesRead !== HEADER_LEN || !head.subarray(0, MAGIC.length).equals(MAGIC)) throw new CryptoError('This is not an encrypted export.');
      const key = unwrap(master, head.subarray(MAGIC.length, MAGIC.length + NONCE + 32 + TAG));
      let pos = HEADER_LEN, index = 0, seenLast = false, skip = o.start ?? 0;
      for (;;) {
        const h = Buffer.alloc(5);
        const r = await fh.read(h, 0, 5, pos);
        if (r.bytesRead === 0) break;
        if (r.bytesRead !== 5) throw new CryptoError('The file is cut short.');
        const len = h.readUInt32BE(0), last = h[4] === 1;
        if (seenLast) throw new CryptoError('There is data after the last chunk.');
        if (len > CHUNK + 1024) throw new CryptoError('A chunk is larger than allowed.');
        const body = Buffer.alloc(len + TAG);
        const rb = await fh.read(body, 0, len + TAG, pos + 5);
        if (rb.bytesRead !== len + TAG) throw new CryptoError('The file is cut short.');
        const d = createDecipheriv('aes-256-gcm', key, chunkNonce(index, last), { authTagLength: TAG });
        d.setAAD(Buffer.from([last ? 1 : 0]));
        d.setAuthTag(body.subarray(len));
        let plain: Buffer;
        try { plain = Buffer.concat([d.update(body.subarray(0, len)), d.final()]); } catch { throw new CryptoError('The file was changed, damaged or reordered: a part failed its check.'); }
        if (skip > 0) { const cut = Math.min(skip, plain.length); plain = plain.subarray(cut); skip -= cut; }
        if (plain.length) yield plain;
        seenLast = last; index++; pos += 5 + len + TAG;
      }
      if (!seenLast) throw new CryptoError('The file is cut short: its last part is missing.');
    } finally { await fh.close(); }
  }
  return Readable.from(gen());
}

/** Wraps the file's data key with a new master key without touching the video (a key rotation). Needs the old key. */
export async function rewrap(file: string, oldMaster: Buffer, newMaster: Buffer): Promise<void> {
  const fh = await fs.open(file, 'r+');
  try {
    const head = Buffer.alloc(HEADER_LEN);
    const { bytesRead } = await fh.read(head, 0, HEADER_LEN, 0);
    if (bytesRead !== HEADER_LEN || !head.subarray(0, MAGIC.length).equals(MAGIC)) throw new CryptoError('This is not an encrypted export.');
    const dataKey = unwrap(oldMaster, head.subarray(MAGIC.length, MAGIC.length + NONCE + 32 + TAG));
    wrap(newMaster, dataKey).copy(head, MAGIC.length);
    await fh.write(head, 0, HEADER_LEN, 0);
  } finally { await fh.close(); }
}

// ---- an export's file, whether or not it is encrypted ----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import path from 'node:path';

/** Where an export's video is: `<cameraId>.mp4.enc` when it was encrypted, else `<cameraId>.mp4`. Null when neither exists. */
export async function exportFile(dir: string, cameraId: string): Promise<{ file: string; encrypted: boolean } | null> {
  for (const [name, encrypted] of [[`${cameraId}.mp4.enc`, true], [`${cameraId}.mp4`, false]] as const) {
    const file = path.join(dir, name);
    try { await fs.access(file); return { file, encrypted }; } catch { /* next */ }
  }
  return null;
}

/** With a key, replaces `<cameraId>.mp4` by its encrypted form and removes the plain file; without one it does nothing. Returns whether it encrypted. */
export async function sealExport(dir: string, cameraId: string, master: Buffer | null): Promise<boolean> {
  if (!master) return false;
  const plain = path.join(dir, `${cameraId}.mp4`);
  await encryptFile(plain, `${plain}.enc`, master);
  await fs.unlink(plain);
  return true;
}

/** The plain bytes of an export as a stream (decrypting on the way when needed). Throws a CryptoError when the file is encrypted and there is no key. */
export async function openExport(dir: string, cameraId: string, master: Buffer | null): Promise<Readable | null> {
  const f = await exportFile(dir, cameraId);
  if (!f) return null;
  if (!f.encrypted) return createReadStream(f.file);
  if (!master) throw new CryptoError('This export is encrypted and this server has no EVIDENCE_ENCRYPTION_KEY.');
  return decryptStream(f.file, master);
}

/** SHA-256 of the plain video of an export. */
export async function exportSha256(dir: string, cameraId: string, master: Buffer | null): Promise<string> {
  const s = await openExport(dir, cameraId, master);
  if (!s) throw new Error('no export file');
  const h = createHash('sha256');
  for await (const c of s) h.update(c as Buffer);
  return h.digest('hex');
}

/** Reads a whole encrypted file back to plain bytes into `dst` (for a verification or a one-off export). */
export async function decryptFile(src: string, dst: string, master: Buffer): Promise<void> { await pipeline(decryptStream(src, master), createWriteStream(dst)); }
