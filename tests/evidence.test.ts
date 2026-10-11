/** Evidence signing, the custody chain and the disk watch (server/recording/evidence.ts). No video needed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCustody, canonical, createDiskWatch, diskLevel, generateEvidenceKey, readCustody, signManifest, signingKeyFromEnv, verifyCustody, verifyManifest, type DiskLevel,
} from '../server/recording/evidence.ts';

test('canonical: key order and undefined do not change the bytes; arrays keep their order', () => {
  assert.equal(canonical({ b: 1, a: { d: [3, 2], c: undefined } }), canonical({ a: { c: undefined, d: [3, 2] }, b: 1 }));
  assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
  assert.equal(canonical({ a: 1, b: undefined }), '{"a":1}');
});

test('signing key from the environment: a PEM (also with \\n written out) works; none is null; garbage and a wrong key type are errors', () => {
  const k = generateEvidenceKey();
  const a = signingKeyFromEnv({ EVIDENCE_SIGNING_KEY: k.privatePem })!;
  const b = signingKeyFromEnv({ EVIDENCE_SIGNING_KEY: k.privatePem.trim().replace(/\n/g, '\\n') })!;
  assert.equal(a.keyId, k.keyId);
  assert.equal(b.keyId, k.keyId);
  assert.equal(signingKeyFromEnv({}), null);
  assert.throws(() => signingKeyFromEnv({ EVIDENCE_SIGNING_KEY: 'not a key' }), /not a PEM private key/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => signingKeyFromEnv({ EVIDENCE_SIGNING_KEY: rsa }), /Ed25519/);
});

test('manifest signature: valid for the same manifest whatever the key order, invalid for any change or another key', () => {
  const key = signingKeyFromEnv({ EVIDENCE_SIGNING_KEY: generateEvidenceKey().privatePem })!;
  const m = { id: 'x', cameraId: 'c', segments: [{ name: 'a.mp4', sha256: 'aa' }], sha256: 'bb' };
  const sig = signManifest(m, key, new Date('2026-10-11T00:00:00Z'));
  assert.equal(sig.signedAt, '2026-10-11T00:00:00.000Z');
  assert.equal(verifyManifest({ sha256: 'bb', segments: [{ sha256: 'aa', name: 'a.mp4' }], cameraId: 'c', id: 'x' }, sig, key.publicPem), true);
  assert.equal(verifyManifest({ ...m, sha256: 'bc' }, sig, key.publicPem), false);
  assert.equal(verifyManifest(m, { signature: sig.signature.slice(0, -2) + 'AA' }, key.publicPem), false);
  assert.equal(verifyManifest(m, sig, generateEvidenceKey().publicPem), false);
  assert.equal(verifyManifest(m, sig, 'not a pem'), false);
});

test('custody chain: lines link to each other; concurrent appends keep order; a removed, reordered or edited line is found at the right place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cust-'));
  assert.deepEqual(await readCustody(dir), []);
  assert.deepEqual(verifyCustody([]), { ok: true });
  await Promise.all([1, 2, 3, 4, 5].map((i) => appendCustody(dir, { by: `u${i}`, action: 'downloaded', at: new Date(Date.UTC(2026, 9, 11, 10, i)) })));
  const log = await readCustody(dir);
  assert.equal(log.length, 5);
  assert.deepEqual(verifyCustody(log), { ok: true }, 'five simultaneous appends still make one unbroken chain');
  assert.deepEqual(verifyCustody(log.slice(1)), { ok: false, brokenAt: 1, why: 'a line is missing or out of order' });
  assert.deepEqual(verifyCustody([log[1], log[0], ...log.slice(2)]).ok, false);
  assert.deepEqual(verifyCustody(log.map((e, i) => (i === 3 ? { ...e, detail: 'edited' } : e))), { ok: false, brokenAt: 4, why: 'a line was changed' });
  assert.deepEqual(verifyCustody(log.slice(0, 3)), { ok: true }, 'dropping the newest lines cannot be told from a log that was never longer (the chain proves order, not completeness)');
});

test('disk level: low under 15% free, critical under 5%; thresholds can be set', () => {
  const r = (free: number) => ({ freeBytes: free, totalBytes: 100 });
  assert.deepEqual([r(50), r(15), r(14.9), r(5), r(4.9), r(0)].map((x) => diskLevel(x)), ['ok', 'ok', 'low', 'low', 'critical', 'critical']);
  assert.equal(diskLevel(r(25), { lowPercent: 30 }), 'low');
  assert.equal(diskLevel({ freeBytes: 0, totalBytes: 0 }), 'ok', 'an unreadable total is not an alarm');
});

test('disk watch: one event when the level changes (worse at once, better when it recovers), none while it stays; a failed reading keeps the last level', async () => {
  const levels = [60, 60, 12, 12, 3, 3, 12, 60, 60];
  let i = 0, fail = false;
  const events: Array<[DiskLevel, DiskLevel]> = [];
  const warned: string[] = [];
  const w = createDiskWatch({ read: async () => { if (fail) throw new Error('statfs failed'); return { freeBytes: levels[i++], totalBytes: 100 }; }, emit: (l, _r, prev) => { events.push([l, prev]); }, log: { warn: (m: string) => { warned.push(m); } } });
  for (let n = 0; n < 4; n++) await w.tick();
  assert.deepEqual(events, [['low', 'ok']]);
  await w.tick();
  fail = true; await w.tick(); fail = false;
  assert.equal(w.level(), 'critical', 'a failed reading does not clear the alarm');
  assert.equal(warned.length, 1);
  for (let n = 0; n < 4; n++) await w.tick();
  assert.deepEqual(events, [['low', 'ok'], ['critical', 'low'], ['low', 'critical'], ['ok', 'low']]);
});
