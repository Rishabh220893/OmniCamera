import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPaths, listPaths } from '../server/mediaApply.ts';
import { buildPaths, renderPathsYaml, type PathBuildOptions } from '../server/mediaPaths.ts';
import { decide, type Recipe } from '../server/cameraRecipe.ts';
import { GRID_REPORTS } from './fixtures/grid-2026-10-08.ts';

const opts: PathBuildOptions = {
  site: { host: '203.0.113.9', rtspPort: 8554, pathPrefix: 'stream' }, credentials: () => ({ user: 'u@x.y', pass: 'secret-pw' }),
  transcode: { ffmpeg: 'ffmpeg', bitrate: '2500k', publishPort: 18554, scaleFilter: null }, startTimeout: '60s', closeAfter: '5s',
};
const want = (...ids: string[]) => wantAs(ids.map((id) => [id, undefined] as [string, Recipe | undefined]));
const wantAs = (items: Array<[string, Recipe | undefined]>) =>
  buildPaths(items.map(([id, force]) => ({ cameraId: id, decision: decide(GRID_REPORTS.find((r) => r.cameraId === id)!, { force }) })), opts).paths;

/** A stand-in for the MediaMTX control API: keeps paths in memory, pages the list, and can be told to refuse a call. */
async function fakeApi(initial: Array<Record<string, unknown>>, failOn?: string) {
  const state = new Map(initial.map((p) => [String(p.name), p]));
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = url.pathname.match(/^\/v3\/config\/paths\/(list|add|replace|delete)(?:\/(.+))?$/);
      if (!m) { res.writeHead(404).end(); return; }
      const [, verb, name] = m;
      if (verb === 'list') {
        const per = Number(url.searchParams.get('itemsPerPage')), page = Number(url.searchParams.get('page'));
        const all = [...state.values()];
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ itemCount: all.length, pageCount: Math.max(1, Math.ceil(all.length / per)), items: all.slice(page * per, (page + 1) * per) }));
        return;
      }
      calls.push(`${verb} ${name}`);
      if (failOn === name) { res.writeHead(500).end(`could not ${verb} rtsp://u%40x.y:secret-pw@203.0.113.9:8554/stream/${name}`); return; }
      if (verb === 'delete') state.delete(name!); else state.set(name!, { name, source: 'publisher', ...JSON.parse(body) });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { api, state, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('apply: adds, replaces and removes only what differs, and a second apply changes nothing', async () => {
  const f = await fakeApi([{ name: 'all_others', source: 'publisher' }, { name: 'cam22', source: 'rtsp://old', sourceOnDemand: true }, { name: 'cam01', source: 'rtsp://old', sourceOnDemand: true }]);
  try {
    const w = want('cam01', 'cam28');
    const first = await applyPaths(w, ['cam01', 'cam22', 'cam28'], { api: f.api });
    assert.deepEqual(first.diff, { add: ['cam28'], replace: ['cam01'], remove: ['cam22'], unchanged: [] });
    assert.deepEqual(f.calls.sort(), ['add cam28', 'delete cam22', 'replace cam01']);
    assert.ok(f.state.has('all_others'), 'a path it does not manage is left alone');
    f.calls.length = 0;
    const second = await applyPaths(w, ['cam01', 'cam22', 'cam28'], { api: f.api });
    assert.deepEqual(second.diff, { add: [], replace: [], remove: [], unchanged: ['cam01', 'cam28'] });
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test('apply: a dry run reports the changes and makes none', async () => {
  const f = await fakeApi([]);
  try {
    const r = await applyPaths(want('cam01'), ['cam01'], { api: f.api, dryRun: true });
    assert.equal(r.applied, false);
    assert.deepEqual(r.diff.add, ['cam01']);
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test('apply: a refused call is reported without the login, and the other changes still happen', async () => {
  const f = await fakeApi([], 'cam01');
  try {
    const r = await applyPaths(want('cam01', 'cam03'), ['cam01', 'cam03'], { api: f.api });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^add cam01: 500 could not add rtsp:\/\/\*\*\*@203\.0\.113\.9/);
    assert.doesNotMatch(r.errors[0], /secret-pw/);
    assert.ok(f.state.has('cam03'));
  } finally { await f.close(); }
});

test('list: follows every page of the server\'s answer', async () => {
  const f = await fakeApi(Array.from({ length: 1200 }, (_, i) => ({ name: `p${i}`, source: 'publisher' })));
  try { assert.equal((await listPaths({ api: f.api })).length, 1200); } finally { await f.close(); }
});

test('apply: an unreachable or refusing server is an error, not a silent no-op', async () => {
  await assert.rejects(applyPaths({}, [], { api: 'http://127.0.0.1:9' }), /fetch failed|ECONNREFUSED/);
  const bad = http.createServer((_q, r) => { r.writeHead(401).end('nope'); });
  await new Promise<void>((r) => bad.listen(0, '127.0.0.1', r));
  try { await assert.rejects(applyPaths({}, [], { api: `http://127.0.0.1:${(bad.address() as { port: number }).port}` }), /answered 401/); } finally { bad.close(); }
});

// ---- Against a real MediaMTX ----------------------------------------------------------------------------------------
// Opt in with MEDIAMTX_BIN=/path/to/mediamtx. It starts the server from the generated file (nothing pulls a camera, so no
// network is needed), then applies changes through the real control API. This is what caught the "publisher" source default.

const BIN = process.env.MEDIAMTX_BIN;
test('real MediaMTX: starts from the generated file, then a live apply is idempotent and changes only what differs', { skip: !BIN && 'set MEDIAMTX_BIN to run against a real MediaMTX', timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtx-'));
  const file = join(dir, 'paths.yml');
  const initial = want('cam01', 'cam06', 'cam28');
  writeFileSync(file, renderPathsYaml(initial));
  const port = 19000 + Math.floor(Math.random() * 500) * 5;
  const env = {
    PATH: process.env.PATH ?? '', MEDIAMTX_BIN: BIN!, MEDIAMTX_CONFIG: join(dir, 'm.yml'), MEDIA_PATHS_FILE: file, GRID_EMAIL: 'a@b.c', GRID_PASSWORD: 'pw', MEDIA_VIEWER_PASSWORD: 'abc123',
    MEDIA_API_PORT: String(port), MEDIA_HLS_PORT: String(port + 1), MEDIA_WEBRTC_PORT: String(port + 2), MEDIA_WEBRTC_UDP_PORT: String(port + 3), MEDIA_TRANSCODE_RTSP_PORT: String(port + 4),
  };
  const server = spawn('sh', [join(import.meta.dirname, '..', 'media-server', 'entrypoint.sh')], { env, stdio: 'ignore' });
  const api = `http://127.0.0.1:${port}`;
  const managed = ['cam01', 'cam03', 'cam06', 'cam28'];
  try {
    for (let i = 0; i < 50; i++) { try { await listPaths({ api }); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
    const same = await applyPaths(initial, ['cam01', 'cam06', 'cam28'], { api, dryRun: true });
    assert.deepEqual(same.diff, { add: [], replace: [], remove: [], unchanged: ['cam01', 'cam06', 'cam28'] }, 'what the server loaded from the file already matches');
    // cam01 becomes a re-encode, cam06 is dropped, cam03 is new, cam28 is untouched.
    const next = { ...wantAs([['cam01', 'B'], ['cam03', undefined], ['cam28', undefined]]) };
    const r = await applyPaths(next, managed, { api });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.diff, { add: ['cam03'], replace: ['cam01'], remove: ['cam06'], unchanged: ['cam28'] });
    const again = await applyPaths(next, managed, { api });
    assert.deepEqual(again.diff, { add: [], replace: [], remove: [], unchanged: ['cam01', 'cam03', 'cam28'] });
  } finally { server.kill('SIGKILL'); }
});
