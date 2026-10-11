/**
 * Sealed logins for department systems, the key ring, and rotating SOURCE_SECRET_KEY (camera sources and the systems file).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createKeyRing, createSecretBox, secretBoxFromEnv } from '../server/sources/secretBox.ts';
import { rotateSources, rotateSystemsFile } from '../server/sources/rotate.ts';
import { createMemorySourceStore, SOURCES_SITE, type SourceRecord } from '../server/sources/store.ts';
import { createVmsService, createFileCursorStore } from '../server/connectors/vms/service.ts';
import { createVmsConnectorTypes } from '../server/connectors/vms/index.ts';
import { createMemoryBus } from '../server/bus/memoryBus.ts';

const k1 = randomBytes(32), k2 = randomBytes(32), k3 = randomBytes(32);
const quiet = { warn() {}, info() {} };

test('key ring: seals with the newest key, opens with any; a value from an old key is stale, one from an unknown key is unreadable', () => {
  const old = createSecretBox(k1), ring = createKeyRing([k2, k1]);
  const fromOld = old.seal('secret-a'), fromNew = ring.seal('secret-b');
  assert.equal(ring.open(fromOld), 'secret-a');
  assert.equal(ring.open(fromNew), 'secret-b');
  assert.deepEqual([ring.isStale!(fromOld), ring.isStale!(fromNew)], [true, false]);
  assert.equal(createSecretBox(k2).open(fromNew), 'secret-b', 'what the ring sealed opens with the new key alone');
  assert.throws(() => createKeyRing([k3]).open(fromOld), /cannot be read/);
  assert.throws(() => createKeyRing([]), /at least one/);
});

test('secretBoxFromEnv: SOURCE_SECRET_KEY_PREVIOUS makes a ring; a bad key is an error, not silence', () => {
  assert.equal(secretBoxFromEnv({}), null);
  const sealedOld = createSecretBox(k1).seal('x');
  const box = secretBoxFromEnv({ SOURCE_SECRET_KEY: k2.toString('hex'), SOURCE_SECRET_KEY_PREVIOUS: `${k1.toString('hex')}, ${k3.toString('hex')}` })!;
  assert.equal(box.open(sealedOld), 'x');
  assert.equal(box.isStale!(sealedOld), true);
  assert.throws(() => secretBoxFromEnv({ SOURCE_SECRET_KEY: k2.toString('hex'), SOURCE_SECRET_KEY_PREVIOUS: 'nonsense' }), /32 random bytes/);
});

const rec = (id: string, sealed: string | null): SourceRecord => ({ site: SOURCES_SITE, cameraId: id, adapter: 'rtsp', name: id, ref: {}, sealed, registryId: null, ownerUid: 'u', departmentId: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' });

test('rotateSources: re-seals old-key values with the new key, leaves current ones, reports unreadable ones, a dry run changes nothing, and it can be repeated', async () => {
  const sources = createMemorySourceStore();
  const old = createSecretBox(k1), current = createSecretBox(k2);
  await sources.put(rec('fed-old', old.seal(JSON.stringify({ rtspUrl: 'rtsp://a:b@h/1' }))));
  await sources.put(rec('fed-new', current.seal('{"rtspUrl":"rtsp://c:d@h/2"}')));
  await sources.put(rec('fed-lost', createSecretBox(k3).seal('{}')));
  await sources.put(rec('fed-open', null)); // a source that needs no login
  const ring = createKeyRing([k2, k1]);

  const dry = await rotateSources({ sources, box: ring, dryRun: true });
  assert.deepEqual([dry.checked, dry.resealed, dry.alreadyCurrent, dry.unreadable], [3, 1, 1, ['fed-lost']]);
  const untouched = (await sources.get(SOURCES_SITE, 'fed-old'))!.sealed!;
  assert.throws(() => current.open(untouched), /cannot be read/, 'a dry run changed nothing');

  const done = await rotateSources({ sources, box: ring });
  assert.equal(done.resealed, 1);
  assert.equal(current.open((await sources.get(SOURCES_SITE, 'fed-old'))!.sealed!), '{"rtspUrl":"rtsp://a:b@h/1"}', 'now opens with the new key alone');
  const again = await rotateSources({ sources, box: ring });
  assert.deepEqual([again.resealed, again.alreadyCurrent], [0, 2], 'repeating does nothing more');
  assert.equal((await sources.get(SOURCES_SITE, 'fed-lost'))!.sealed !== null, true, 'an unreadable value is never overwritten');
});

test('rotateSystemsFile: clear-text logins are sealed, old-key ones re-sealed, current ones left; the file is private and nothing is lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rot-')), file = join(dir, 'vms-systems.json');
  const old = createSecretBox(k1);
  writeFileSync(file, JSON.stringify([
    { id: 'clear', kind: 'reference-json', baseUrl: 'http://x', ownerUserId: 'u', credentials: { user: 'a', pass: 'p1' } },
    { id: 'oldkey', kind: 'reference-json', baseUrl: 'http://y', ownerUserId: 'u', sealedCredentials: old.seal(JSON.stringify({ user: 'b', pass: 'p2' })) },
    { id: 'nologin', kind: 'reference-json', baseUrl: 'http://z', ownerUserId: 'u' },
  ]));
  const ring = createKeyRing([k2, k1]);
  const dry = await rotateSystemsFile({ file, box: ring, dryRun: true });
  assert.deepEqual([dry.checked, dry.resealed], [2, 2]);
  assert.equal(readFileSync(file, 'utf8').includes('p1'), true, 'dry run left the file alone');
  const r = await rotateSystemsFile({ file, box: ring });
  assert.deepEqual([r.resealed, r.unreadable], [2, []]);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes('p1') || text.includes('p2'), false, 'no clear text remains');
  const saved = JSON.parse(text) as Array<Record<string, any>>;
  assert.equal(JSON.parse(createSecretBox(k2).open(saved[0].sealedCredentials)).pass, 'p1');
  assert.equal(JSON.parse(createSecretBox(k2).open(saved[1].sealedCredentials)).pass, 'p2');
  assert.equal(saved[2].sealedCredentials, undefined);
  assert.deepEqual((await rotateSystemsFile({ file, box: ring })).resealed, 0);
  assert.deepEqual((await rotateSystemsFile({ file: join(dir, 'missing.json'), box: ring })).checked, 0, 'no file is not an error');
});

test('vms service: with a key the login is sealed in the file and still works; an old clear-text file is sealed on load; without the key a sealed system is skipped, not guessed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmsseal-')), systemsFile = join(dir, 'systems.json');
  const box = createSecretBox(k1);
  const mk = (b: typeof box | null) => createVmsService({ types: createVmsConnectorTypes(), systemsFile, cursors: createFileCursorStore(join(dir, 'cur.json')), bus: createMemoryBus(), allowPrivate: true, box: b, log: quiet, connectorFor: () => ({ kind: 'fake', async health() { return { state: 'ok' } as never; }, async cameras() { return []; }, async events() { return { events: [], cursor: '0' }; } } as never) });

  // A system saved before there was a key: clear text.
  writeFileSync(systemsFile, JSON.stringify([{ id: 'dept', kind: 'reference-json', baseUrl: 'http://10.0.0.5', ownerUserId: 'u', department: 'Traffic', credentials: { user: 'admin', pass: 'hunter2' } }]));
  const a = mk(box); await a.load();
  assert.equal(a.config('dept')!.credentials!.pass, 'hunter2', 'the running system has its login');
  assert.equal(readFileSync(systemsFile, 'utf8').includes('hunter2'), false, 'the file was sealed on load');
  await a.stop();

  const b = mk(box); await b.load();
  assert.equal(b.config('dept')!.credentials!.pass, 'hunter2', 'a sealed file loads back');
  await b.add({ id: 'second', kind: 'reference-json', baseUrl: 'http://10.0.0.6', ownerUserId: 'u', credentials: { user: 'u2', pass: 'pw-two' } });
  assert.equal(readFileSync(systemsFile, 'utf8').includes('pw-two'), false, 'a system added now is stored sealed');
  assert.equal(b.list().find((s) => s.id === 'second')!.hasCredentials, true);
  await b.stop();

  const noKey = mk(null); await noKey.load();
  assert.deepEqual(noKey.list().map((s) => s.id), [], 'without the key the sealed systems are skipped (and not rewritten)');
  assert.equal(readFileSync(systemsFile, 'utf8').includes('sealedCredentials'), true);
  await noKey.stop();
});
