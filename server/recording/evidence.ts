/**
 * Evidence handling beyond hashes (recording.md, decision 5): a signed manifest and a chain of custody.
 *
 * **Signed manifest.** The export's manifest (what was exported, from which segments, with their SHA-256) is signed with an Ed25519 key held
 * by the server (`EVIDENCE_SIGNING_KEY`, a PEM private key; make one with `npm run evidence-key`). Anyone with the matching public key
 * (`GET /api/evidence/public-key`, or the PEM file kept offline) can check that the manifest is the one this server made and was not
 * edited, without trusting the server again. Without a key the manifest says it is unsigned.
 *
 * **Chain of custody.** Every handling of an export (made, downloaded, verified) is appended to `custody.jsonl` in its folder, each line
 * carrying the hash of the line before it, so removing or editing a line breaks the chain from there on. It shows who did what and when;
 * it does not stop a person with access to the disk from replacing the whole folder (that needs storage with write-once protection: A21).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** JSON with keys in a fixed order, so the same manifest always signs to the same bytes. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export interface SigningKey { privateKey: KeyObject; publicPem: string; keyId: string }

const idOf = (publicPem: string) => createHash('sha256').update(publicPem.trim()).digest('hex').slice(0, 16);

/** A key from the environment (a PEM; `\n` written as backslash-n is accepted, for a one-line setting). Null when none is set; a bad one throws. */
export function signingKeyFromEnv(env: Record<string, string | undefined>): SigningKey | null {
  const raw = (env.EVIDENCE_SIGNING_KEY ?? '').trim();
  if (!raw) return null;
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey(raw.replace(/\\n/g, '\n')); } catch { throw new Error('EVIDENCE_SIGNING_KEY is not a PEM private key. Make one with: npm run evidence-key'); }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('EVIDENCE_SIGNING_KEY must be an Ed25519 key. Make one with: npm run evidence-key');
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicPem, keyId: idOf(publicPem) };
}

export function generateEvidenceKey(): { privatePem: string; publicPem: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicPem, keyId: idOf(publicPem) };
}

export interface ManifestSignature { algorithm: 'ed25519'; keyId: string; signature: string; signedAt: string }

export function signManifest(manifest: unknown, key: SigningKey, now = new Date()): ManifestSignature {
  return { algorithm: 'ed25519', keyId: key.keyId, signature: sign(null, Buffer.from(canonical(manifest)), key.privateKey).toString('base64url'), signedAt: now.toISOString() };
}

/** True when `sig` is a valid signature of `manifest` by the key whose public PEM is given. Works anywhere: it needs nothing from this server. */
export function verifyManifest(manifest: unknown, sig: Pick<ManifestSignature, 'signature'>, publicPem: string): boolean {
  try { return verify(null, Buffer.from(canonical(manifest)), createPublicKey(publicPem), Buffer.from(sig.signature, 'base64url')); } catch { return false; }
}

// ---- chain of custody ------------------------------------------------------------------------------------------------------------------

export type CustodyAction = 'exported' | 'downloaded' | 'verified' | 'held' | 'released';
export interface CustodyEntry { at: string; by: string; action: CustodyAction; detail?: string; prev: string; hash: string }

const GENESIS = '0'.repeat(64);
const entryHash = (e: Omit<CustodyEntry, 'hash'>) => createHash('sha256').update(canonical(e)).digest('hex');

export async function readCustody(dir: string): Promise<CustodyEntry[]> {
  try { return (await fs.readFile(path.join(dir, 'custody.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as CustodyEntry); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}

const chains = new Map<string, Promise<unknown>>();
/** Adds one line to an export's custody log. Appends in order even when several requests arrive together. */
export function appendCustody(dir: string, e: { by: string; action: CustodyAction; detail?: string; at?: Date }): Promise<CustodyEntry> {
  const run = (chains.get(dir) ?? Promise.resolve()).then(async () => {
    const existing = await readCustody(dir);
    const base: Omit<CustodyEntry, 'hash'> = { at: (e.at ?? new Date()).toISOString(), by: e.by, action: e.action, ...(e.detail ? { detail: e.detail } : {}), prev: existing.length ? existing[existing.length - 1].hash : GENESIS };
    const entry: CustodyEntry = { ...base, hash: entryHash(base) };
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'custody.jsonl'), JSON.stringify(entry) + '\n');
    return entry;
  });
  chains.set(dir, run.catch(() => undefined));
  return run;
}

/** Checks every line's hash and its link to the one before. Returns the first line that does not fit (1-based), or null when the chain is whole. */
export function verifyCustody(entries: CustodyEntry[]): { ok: true } | { ok: false; brokenAt: number; why: string } {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...rest } = entries[i];
    if (rest.prev !== prev) return { ok: false, brokenAt: i + 1, why: 'a line is missing or out of order' };
    if (entryHash(rest) !== hash) return { ok: false, brokenAt: i + 1, why: 'a line was changed' };
    prev = hash;
  }
  return { ok: true };
}

// ---- disk watch ------------------------------------------------------------------------------------------------------------------------

export type DiskLevel = 'ok' | 'low' | 'critical';
export interface DiskReading { freeBytes: number; totalBytes: number }

/** The level for a reading: `low` under `lowPercent` free (default 15), `critical` under `criticalPercent` (default 5). */
export function diskLevel(r: DiskReading, o: { lowPercent?: number; criticalPercent?: number } = {}): DiskLevel {
  const pct = r.totalBytes > 0 ? (r.freeBytes / r.totalBytes) * 100 : 100;
  return pct < (o.criticalPercent ?? 5) ? 'critical' : pct < (o.lowPercent ?? 15) ? 'low' : 'ok';
}

export interface DiskWatch { tick(): Promise<DiskLevel>; level(): DiskLevel }

/**
 * Raises one event when the recording disk gets low and one when it recovers; it says nothing while the level stays the same, and a worse level
 * is reported at once. A reading that fails is not mistaken for "fine": the previous level stays and the failure is logged.
 */
export function createDiskWatch(o: {
  read: () => Promise<DiskReading>;
  emit: (level: DiskLevel, r: DiskReading, previous: DiskLevel) => Promise<unknown> | unknown;
  lowPercent?: number; criticalPercent?: number;
  log?: Pick<Console, 'warn'>;
}): DiskWatch {
  let current: DiskLevel = 'ok';
  return {
    level: () => current,
    async tick() {
      let r: DiskReading;
      try { r = await o.read(); } catch (e) { (o.log ?? console).warn(`[RECORDING] could not read free disk space: ${e instanceof Error ? e.message : e}`); return current; }
      const next = diskLevel(r, o);
      if (next !== current) { const prev = current; current = next; await o.emit(next, r, prev); }
      return current;
    },
  };
}

/** Free and total bytes of the disk holding `dir` (Node 18.15+). */
export async function readDisk(dir: string): Promise<DiskReading> {
  const s = await fs.statfs(dir);
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
}
