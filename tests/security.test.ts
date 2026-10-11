/**
 * Security (gap A21): headers and HTTPS, encryption of exports at rest, and the sealed audit export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, truncateSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { cspFor, isHttps, registerCspReport, securityMiddleware } from '../server/security/headers.ts';
import { CHUNK, CryptoError, decryptFile, decryptStream, encryptFile, exportFile, exportSha256, isEncryptedFile, masterKeyFromEnv, openExport, parseMasterKey, rewrap, sealExport } from '../server/recording/exportCrypto.ts';
import { auditCsv, buildAuditExport, entriesHash, filterEntries, verifyAuditExport } from '../server/security/auditExport.ts';
import { generateEvidenceKey, signingKeyFromEnv } from '../server/recording/evidence.ts';
import { sha256File } from '../server/recording/clip.ts';
import type { AccessLogEntry } from '../server/authz/authz.ts';

// ---- headers -------------------------------------------------------------------------------------------------------------------------

async function withApp(o: Parameters<typeof securityMiddleware>[0] & { trust?: boolean }, run: (get: (path: string, headers?: Record<string, string>) => Promise<{ status: number; headers: Headers; location: string | null }>, logs: string[]) => Promise<void>) {
  const logs: string[] = [];
  const app = express();
  if (o.trust) app.set('trust proxy', true);
  app.use(securityMiddleware(o));
  app.get('/', (_req, res) => { res.send('ok'); });
  app.get('/api/health', (_req, res) => { res.send('ok'); });
  app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/json'] }));
  registerCspReport(app, { log: { warn: (m: string) => logs.push(m) }, perMinute: 2, now: () => 1_000_000 });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (p, headers) => { const r = await fetch(base + p, { headers, redirect: 'manual' }); return { status: r.status, headers: r.headers, location: r.headers.get('location') }; }, logs);
  } finally { server.close(); }
}

test('headers: the basic ones on every response; the CSP is report-only by default, enforced or off when asked; HSTS only over HTTPS', async () => {
  await withApp({}, async (get) => {
    const r = await get('/');
    assert.deepEqual([r.headers.get('x-content-type-options'), r.headers.get('x-frame-options'), r.headers.get('referrer-policy')], ['nosniff', 'SAMEORIGIN', 'strict-origin-when-cross-origin']);
    assert.match(r.headers.get('permissions-policy') ?? '', /camera=\(self\)/);
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups', 'Google sign-in pop-ups keep working');
    assert.match(r.headers.get('content-security-policy-report-only') ?? '', /default-src 'self'.*frame-ancestors 'self'.*report-uri \/api\/csp-report/);
    assert.equal(r.headers.get('content-security-policy'), null, 'report-only does not block anything');
    assert.equal(r.headers.get('strict-transport-security'), null, 'plain HTTP: no HSTS');
  });
  await withApp({ csp: 'enforce' }, async (get) => { const r = await get('/'); assert.equal(r.headers.get('content-security-policy-report-only'), null); assert.match(r.headers.get('content-security-policy') ?? '', /object-src 'none'/); });
  await withApp({ csp: 'off' }, async (get) => { const r = await get('/'); assert.equal(r.headers.get('content-security-policy'), null); assert.equal(r.headers.get('content-security-policy-report-only'), null); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); });
});

test('https: behind a trusted proxy X-Forwarded-Proto: https sets HSTS; without trust it is ignored; FORCE_HTTPS redirects plain HTTP (not loopback, not the health check)', async () => {
  await withApp({ trustProxy: true, trust: true }, async (get) => {
    const r = await get('/', { 'X-Forwarded-Proto': 'https' });
    assert.match(r.headers.get('strict-transport-security') ?? '', /max-age=31536000; includeSubDomains/);
  });
  await withApp({ trustProxy: false }, async (get) => { assert.equal((await get('/', { 'X-Forwarded-Proto': 'https' })).headers.get('strict-transport-security'), null, 'a forged header from the internet is not believed'); });
  assert.equal(isHttps({ secure: false, headers: { 'x-forwarded-proto': 'https,http' } } as never, true), true);
  assert.equal(isHttps({ secure: false, headers: {} } as never, true), false);
  // Loopback requests are exempt (a local health check or the dev machine), so to see the redirect the test would need a non-loopback address; check the
  // two exemptions and the plain case through the middleware directly.
  const mw = securityMiddleware({ forceHttps: true });
  const call = (req: Record<string, unknown>) => { const out: { status?: number; to?: string; next: boolean; headers: Record<string, string> } = { next: false, headers: {} }; mw({ secure: false, headers: { host: 'omnisee.example.org:3000' }, ip: '203.0.113.9', path: '/', originalUrl: '/feed?x=1', ...req } as never, { redirect: (s: number, to: string) => { out.status = s; out.to = to; }, status: (s: number) => ({ type: () => ({ send: () => { out.status = s; } }) }), setHeader: (k: string, v: string) => { out.headers[k] = v; } } as never, () => { out.next = true; }); return out; };
  const redirected = call({});
  assert.deepEqual([redirected.status, redirected.to, redirected.next], [308, 'https://omnisee.example.org/feed?x=1', false]);
  assert.equal(call({ ip: '127.0.0.1' }).next, true, 'loopback is let through');
  assert.equal(call({ path: '/api/health' }).next, true, 'so is the health check');
  assert.equal(call({ headers: { host: 'bad host!' } }).status, 400, 'a host that is not a host name is refused, not redirected to');
  assert.equal(call({ secure: true }).next, true);
});

test('csp report: violations are logged briefly, never trusted, and rate limited', async () => {
  await withApp({}, async (_get, logs) => {
    // (the helper only does GET: post directly)
  });
  const logs: string[] = [];
  const app = express();
  app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/json'] }));
  registerCspReport(app, { log: { warn: (m: string) => logs.push(m) }, perMinute: 2, now: () => 5 });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const post = (body: unknown, type = 'application/csp-report') => fetch(`${base}/api/csp-report`, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) }).then((r) => r.status);
    assert.equal(await post({ 'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'https://x.example/a.png', 'document-uri': 'http://app/', evil: 'x'.repeat(5000) } }), 204);
    assert.equal(await post([{ body: { effectiveDirective: 'script-src', blockedURL: 'inline', documentURL: 'http://app/' } }], 'application/json'), 204);
    assert.equal(await post({ 'csp-report': { 'blocked-uri': 'third' } }), 204, 'over the limit: accepted, not logged');
    assert.equal(logs.length, 2);
    assert.match(logs[0], /img-src blocked https:\/\/x\.example\/a\.png on http:\/\/app\//);
    assert.match(logs[1], /script-src blocked inline/);
    assert.equal(logs.every((l) => l.length < 500), true, 'long values are cut');
    assert.match(cspFor(['https://media.example.org', 'javascript:alert(1)']), /connect-src[^;]*https:\/\/media\.example\.org/);
    assert.equal(cspFor(['javascript:alert(1)']).includes('javascript:'), false, 'only http(s)/ws(s) origins are accepted as extras');
  } finally { server.close(); }
});

// ---- encryption of exports ------------------------------------------------------------------------------------------------------------

const tmp = () => mkdtempSync(join(tmpdir(), 'enc-'));
const key = () => randomBytes(32);

test('master key: 64 hex or base64 of 32 bytes; anything else is an error; none is null', () => {
  const k = key();
  assert.deepEqual(parseMasterKey(k.toString('hex')), k);
  assert.deepEqual(parseMasterKey(k.toString('base64')), k);
  assert.throws(() => parseMasterKey('short'), /32 random bytes/);
  assert.equal(masterKeyFromEnv({}), null);
  assert.deepEqual(masterKeyFromEnv({ EVIDENCE_ENCRYPTION_KEY: k.toString('hex') }), k);
});

test('encrypt and decrypt: round trip for empty, small, exact-chunk and multi-chunk files; the file on disk shows nothing of the content; a range can start part-way in', async () => {
  const dir = tmp(), master = key();
  for (const size of [0, 1, 1000, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 12345]) {
    const plain = join(dir, `p${size}.bin`), enc = join(dir, `p${size}.enc`);
    const data = randomBytes(size);
    writeFileSync(plain, data);
    assert.equal(await encryptFile(plain, enc, master), size);
    assert.equal(await isEncryptedFile(enc), true);
    assert.equal(await isEncryptedFile(plain), size === 0 ? false : false);
    const back: Buffer[] = [];
    for await (const c of decryptStream(enc, master)) back.push(c as Buffer);
    assert.equal(Buffer.concat(back).equals(data), true, `size ${size}`);
    assert.equal(size < 100 || !readFileSync(enc).includes(data.subarray(10, 40)), true, 'plain bytes do not appear in the encrypted file');
  }
  const plain = join(dir, 'range.bin'), enc = join(dir, 'range.enc');
  const data = randomBytes(2 * CHUNK + 500);
  writeFileSync(plain, data); await encryptFile(plain, enc, master);
  const part: Buffer[] = [];
  for await (const c of decryptStream(enc, master, { start: CHUNK + 100 })) part.push(c as Buffer);
  assert.equal(Buffer.concat(part).equals(data.subarray(CHUNK + 100)), true);
  const out = join(dir, 'whole.bin');
  await decryptFile(enc, out, master);
  assert.equal(readFileSync(out).equals(data), true);
});

async function drain(file: string, master: Buffer) { const parts: Buffer[] = []; for await (const c of decryptStream(file, master)) parts.push(c as Buffer); return Buffer.concat(parts); }

test('tampering is found: a wrong key, a changed byte anywhere, chunks reordered or dropped, a cut-off file, data added after the end', async () => {
  const dir = tmp(), master = key();
  const plain = join(dir, 'p.bin'), enc = join(dir, 'p.enc');
  writeFileSync(plain, randomBytes(3 * CHUNK + 777));
  await encryptFile(plain, enc, master);
  const good = readFileSync(enc);
  await assert.rejects(drain(enc, key()), CryptoError, 'wrong key');
  const flip = (at: number) => { const b = Buffer.from(good); b[at] ^= 0x01; const f = join(dir, `flip-${at}.enc`); writeFileSync(f, b); return f; };
  await assert.rejects(drain(flip(20), master), /cannot be unlocked/, 'a changed byte in the wrapped key');
  await assert.rejects(drain(flip(70), master), CryptoError, 'a changed byte in a chunk length');
  await assert.rejects(drain(flip(200), master), /changed, damaged or reordered/, 'a changed byte in the first chunk');
  await assert.rejects(drain(flip(good.length - 5), master), /changed, damaged or reordered/, 'a changed byte near the end');
  // Chunk layout: header (5+60+4=69), then [5 + len + 16] each.
  const sizes: Array<[number, number]> = []; let pos = 69;
  while (pos < good.length) { const len = good.readUInt32BE(pos); sizes.push([pos, 5 + len + 16]); pos += 5 + len + 16; }
  assert.equal(sizes.length, 4);
  const slice = (i: number) => good.subarray(sizes[i][0], sizes[i][0] + sizes[i][1]);
  const swapped = join(dir, 'swap.enc'); writeFileSync(swapped, Buffer.concat([good.subarray(0, 69), slice(1), slice(0), slice(2), slice(3)]));
  await assert.rejects(drain(swapped, master), /changed, damaged or reordered/, 'two chunks swapped');
  const dropped = join(dir, 'drop.enc'); writeFileSync(dropped, Buffer.concat([good.subarray(0, 69), slice(0), slice(2), slice(3)]));
  await assert.rejects(drain(dropped, master), /changed, damaged or reordered/, 'a chunk taken out of the middle');
  const noLast = join(dir, 'nolast.enc'); writeFileSync(noLast, Buffer.concat([good.subarray(0, 69), slice(0), slice(1), slice(2)]));
  await assert.rejects(drain(noLast, master), /cut short: its last part is missing/, 'the last chunk removed');
  const cut = join(dir, 'cut.enc'); writeFileSync(cut, good.subarray(0, good.length - 40));
  await assert.rejects(drain(cut, master), /cut short/, 'truncated');
  const extra = join(dir, 'extra.enc'); writeFileSync(extra, Buffer.concat([good, slice(0)]));
  await assert.rejects(drain(extra, master), /after the last chunk|changed, damaged or reordered/, 'a chunk added at the end');
  const notOurs = join(dir, 'x.bin'); writeFileSync(notOurs, randomBytes(500));
  await assert.rejects(drain(notOurs, master), /not an encrypted export/);
  assert.equal((await drain(enc, master)).length, 3 * CHUNK + 777, 'the untouched file still reads');
});

test('key rotation: rewrap changes only the header, the new key opens the file and the old one no longer does', async () => {
  const dir = tmp(), oldKey = key(), newKey = key();
  const plain = join(dir, 'p.bin'), enc = join(dir, 'p.enc');
  const data = randomBytes(CHUNK + 99);
  writeFileSync(plain, data); await encryptFile(plain, enc, oldKey);
  const before = readFileSync(enc);
  await rewrap(enc, oldKey, newKey);
  const after = readFileSync(enc);
  assert.equal(after.length, before.length);
  assert.equal(after.subarray(69).equals(before.subarray(69)), true, 'the video part was not touched');
  assert.equal((await drain(enc, newKey)).equals(data), true);
  await assert.rejects(drain(enc, oldKey), CryptoError);
  await assert.rejects(rewrap(enc, oldKey, key()), /cannot be unlocked/, 'you need the current key to rewrap');
});

test('an export folder: sealing replaces the plain file; the plain hash is still the one to check; without the key it cannot be read; without a key nothing is sealed', async () => {
  const dir = tmp(), master = key();
  const data = randomBytes(CHUNK + 5);
  writeFileSync(join(dir, 'camA.mp4'), data);
  const want = await sha256File(join(dir, 'camA.mp4'));
  assert.equal(await sealExport(dir, 'camA', null), false);
  assert.deepEqual((await exportFile(dir, 'camA'))!.encrypted, false);
  assert.equal(await sealExport(dir, 'camA', master), true);
  assert.deepEqual([(await exportFile(dir, 'camA'))!.encrypted, statSyncSafe(join(dir, 'camA.mp4'))], [true, null], 'the plain file is gone');
  assert.equal(await exportSha256(dir, 'camA', master), want, 'the manifest hash (of the plain video) still checks');
  await assert.rejects(openExport(dir, 'camA', null), /no EVIDENCE_ENCRYPTION_KEY/);
  assert.equal(await openExport(tmp(), 'camB', master), null, 'nothing there');
  appendFileSync(join(dir, 'camA.mp4.enc'), 'x');
  await assert.rejects(exportSha256(dir, 'camA', master));
  void truncateSync;
});
const statSyncSafe = (f: string) => { try { return statSync(f).size; } catch { return null; } };

// ---- audit export --------------------------------------------------------------------------------------------------------------------

const entry = (i: number, over: Partial<AccessLogEntry> = {}): AccessLogEntry => ({ at: new Date(Date.UTC(2026, 9, 11, 10, i)).toISOString(), uid: i % 2 ? 'ann' : 'bob', role: 'operator', source: 'claims', permission: 'event.view', allowed: i % 3 !== 0, method: 'GET', path: `/api/events?i=${i}`, ...over });

test('audit export: filtered, ordered oldest first, hashed; signed with a key and checkable with the public key alone; any change is found', () => {
  const k = generateEvidenceKey();
  const signing = signingKeyFromEnv({ EVIDENCE_SIGNING_KEY: k.privatePem });
  const entries = Array.from({ length: 12 }, (_, i) => entry(11 - i));
  const doc = buildAuditExport(entries, { by: 'root', signing, filter: { from: new Date(Date.UTC(2026, 9, 11, 10, 2)), to: new Date(Date.UTC(2026, 9, 11, 10, 9)), uid: 'ann' }, caveats: ['memory only'], now: new Date('2026-10-11T12:00:00Z') });
  assert.deepEqual(doc.entries.map((e) => e.path), ['/api/events?i=3', '/api/events?i=5', '/api/events?i=7'], 'in range, for ann, oldest first');
  assert.deepEqual([doc.count, doc.generatedBy, doc.caveats, doc.period.from], [3, 'root', ['memory only'], '2026-10-11T10:02:00.000Z']);
  assert.equal(doc.entriesSha256, entriesHash(doc.entries));
  assert.deepEqual(verifyAuditExport(doc, k.publicPem), { ok: true });
  assert.deepEqual(verifyAuditExport(JSON.parse(JSON.stringify(doc)), k.publicPem), { ok: true }, 'it survives being saved and read back');
  const mutate = (fn: (d: ReturnType<typeof buildAuditExport>) => void) => { const d = JSON.parse(JSON.stringify(doc)); fn(d); return verifyAuditExport(d, k.publicPem); };
  assert.match((mutate((d) => { d.entries[0].allowed = !d.entries[0].allowed; }) as { why: string }).why, /do not match their hash/);
  assert.match((mutate((d) => { d.entries.pop(); }) as { why: string }).why, /says 3 entries but holds 2/);
  assert.match((mutate((d) => { d.entries[1].uid = 'mallory'; d.entriesSha256 = entriesHash(d.entries); }) as { why: string }).why, /signature does not match/, 'changing an entry AND its hash still breaks the signature');
  assert.match((mutate((d) => { d.generatedBy = 'someone else'; }) as { why: string }).why, /signature does not match/);
  assert.match((mutate((d) => { d.signature = null; }) as { why: string }).why, /not signed/);
  assert.match((verifyAuditExport(doc, generateEvidenceKey().publicPem) as { why: string }).why, /signature does not match/, 'another key');
  assert.deepEqual(verifyAuditExport(buildAuditExport(entries, { by: 'root' })), { ok: true }, 'unsigned: the hash is still checked');
});

test('audit filters and CSV: allowed/denied, a person; spreadsheet formulas are neutralised', () => {
  const es = [entry(0), entry(1), entry(2), entry(3, { reason: '=HYPERLINK("http://x")', path: '/a,b' })];
  assert.deepEqual(filterEntries(es, { allowed: false }).map((e) => e.path), ['/api/events?i=0', '/api/events?i=3'].filter((p) => es.find((e) => e.path === p && !e.allowed)).concat(es.filter((e) => !e.allowed && e.path === '/a,b').map((e) => e.path)));
  assert.equal(filterEntries(es, { uid: 'bob' }).every((e) => e.uid === 'bob'), true);
  const csv = auditCsv(es).trim().split('\r\n');
  assert.equal(csv[0], 'at,uid,role,source,permission,allowed,reason,method,path,department');
  assert.equal(csv.length, 5);
  assert.match(csv[4], /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(csv[4], /"\/a,b"/);
});
