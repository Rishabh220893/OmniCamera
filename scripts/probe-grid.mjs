#!/usr/bin/env node
/**
 * Quick, evidence-producing probe of every grid camera, talking to the grid DIRECTLY (no app, no media server).
 * If a camera is slow or failing here, the cause is the grid, not OmniSee. Run it before a demo and again when
 * something looks wrong; the saved report has timestamps and the raw ffmpeg error for each failure.
 *
 *   node scripts/probe-grid.mjs                      all 30 cameras, 4 at a time (about 1-3 minutes)
 *   node scripts/probe-grid.mjs --cams cam01,cam14   only those
 *   node scripts/probe-grid.mjs --parallel 1         one at a time (a slow camera cannot disturb the others)
 *   node scripts/probe-grid.mjs --timeout 30         seconds to wait for the first frame (default 25)
 *   node scripts/probe-grid.mjs --no-rtsp            only the WebRTC (WHEP) port check
 *
 * Per camera it measures:
 *   whep   HTTP OPTIONS to the grid's WebRTC endpoint (:8889): is it reachable, and how fast it answers
 *   rtsp   time until ffmpeg decodes the first frame over RTSP (:8554), plus the codec the camera sends
 * Output: a table, plus .demo-logs/probe-<timestamp>.json and .csv (credentials are never written).
 * Credentials come from scale.local / demo.local (GRID_EMAIL, GRID_PASSWORD or STREAM_EMAIL, STREAM_PASSWORD).
 * Every RTSP pull counts against the grid account's watch time, so this is a few seconds per camera, not a soak test.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const HOST = process.env.GRID_HOST || '103.250.160.189';
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);

const env = { ...process.env };
for (const f of ['demo.local', 'scale.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').replace(/\r/g, '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const email = env.GRID_EMAIL || env.STREAM_EMAIL;
const pass = env.GRID_PASSWORD || env.STREAM_PASSWORD;
const doRtsp = !flag('--no-rtsp');
if (doRtsp && (!email || !pass)) { console.error('No grid credentials found in scale.local / demo.local (GRID_EMAIL + GRID_PASSWORD).'); process.exit(1); }

const ids = (opt('--cams', '') || Array.from({ length: 30 }, (_, i) => `cam${String(i + 1).padStart(2, '0')}`).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const parallel = Math.max(1, Number(opt('--parallel', 4)));
const timeoutS = Math.max(5, Number(opt('--timeout', 25)));
const enc = (v) => encodeURIComponent(v).replace(/@/g, '%40');
const redact = (s) => (pass ? s.split(pass).join('***').split(enc(pass)).join('***') : s).replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***@');

async function whep(id) {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://${HOST}:8889/stream/${id}/whep`, { method: 'OPTIONS', signal: AbortSignal.timeout(8000) });
    return { ok: r.status < 500, status: r.status, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, status: 0, ms: Date.now() - t0, error: e.cause?.code || e.name || String(e) }; }
}

function rtsp(id) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-rtsp_transport', 'tcp', '-i', `rtsp://${enc(email)}:${enc(pass)}@${HOST}:8554/stream/${id}`, '-frames:v', '1', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); p.kill('SIGKILL'); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, ms: timeoutS * 1000, timedOut: true }), timeoutS * 1000);
    p.stderr.on('data', (d) => {
      err += d;
      if (/frame=\s*1\b/.test(err)) finish({ ok: true, ms: Date.now() - t0, codec: (err.match(/Video:\s*(\w+)/) || [])[1] || '?', size: (err.match(/,\s*(\d{3,5}x\d{3,5})/) || [])[1] || '' });
    });
    p.on('close', () => finish({ ok: false, ms: Date.now() - t0, codec: (err.match(/Video:\s*(\w+)/) || [])[1] || '', error: redact(err.trim().split('\n').slice(-2).join(' | ')).slice(0, 220) }));
    p.on('error', (e) => finish({ ok: false, ms: 0, error: e.code === 'ENOENT' ? 'ffmpeg not found on PATH' : String(e) }));
  });
}

const results = new Array(ids.length);
let next = 0;
const startedAt = new Date();
console.log(`Probing ${ids.length} cameras on ${HOST} (${parallel} at a time, ${timeoutS}s limit) - ${startedAt.toISOString()}\n`);
console.log('camera  whep                 rtsp first frame');
await Promise.all(Array.from({ length: parallel }, async () => {
  while (next < ids.length) {
    const i = next++;
    const id = ids[i];
    const w = await whep(id);
    const r = doRtsp ? await rtsp(id) : null;
    results[i] = { camera: id, at: new Date().toISOString(), whep: w, rtsp: r };
    const ws = w.ok ? `ok ${String(w.ms).padStart(5)} ms` : `FAIL ${w.error || 'HTTP ' + w.status}`;
    const rs = !r ? '-' : r.ok ? `ok ${(r.ms / 1000).toFixed(1)}s  ${r.codec} ${r.size}` : r.timedOut ? `FAIL no frame in ${timeoutS}s` : `FAIL ${r.error || 'exit'}`;
    console.log(`${id}   ${ws.padEnd(18)}   ${rs}`);
  }
}));

const rows = results.filter(Boolean).sort((a, b) => a.camera.localeCompare(b.camera));
const okW = rows.filter((r) => r.whep.ok), okR = rows.filter((r) => r.rtsp?.ok);
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const codecs = {};
okR.forEach((r) => { codecs[r.rtsp.codec] = (codecs[r.rtsp.codec] || 0) + 1; });
console.log('\n--- Summary ---');
console.log(`WebRTC port reachable : ${okW.length}/${rows.length}   median answer ${med(okW.map((r) => r.whep.ms)) ?? '-'} ms`);
if (doRtsp) {
  console.log(`RTSP first frame      : ${okR.length}/${rows.length}   median ${med(okR.map((r) => r.rtsp.ms)) != null ? (med(okR.map((r) => r.rtsp.ms)) / 1000).toFixed(1) + 's' : '-'}   slowest ${okR.length ? (Math.max(...okR.map((r) => r.rtsp.ms)) / 1000).toFixed(1) + 's' : '-'}`);
  console.log(`Codecs seen           : ${Object.entries(codecs).map(([k, v]) => `${k} x${v}`).join(', ') || '-'}`);
  const bad = rows.filter((r) => !r.rtsp.ok).map((r) => r.camera);
  console.log(`Failing cameras       : ${bad.join(', ') || 'none'}`);
  const slow = okR.filter((r) => r.rtsp.ms > 8000).map((r) => `${r.camera} (${(r.rtsp.ms / 1000).toFixed(0)}s)`);
  if (slow.length) console.log(`Slow (>8s to 1st frame): ${slow.join(', ')}`);
}

mkdirSync('.demo-logs', { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
writeFileSync(`.demo-logs/probe-${stamp}.json`, JSON.stringify({ host: HOST, startedAt, parallel, timeoutS, rows }, null, 2));
writeFileSync(`.demo-logs/probe-${stamp}.csv`, ['camera,time,whep_ok,whep_ms,whep_error,rtsp_ok,rtsp_first_frame_ms,codec,rtsp_error']
  .concat(rows.map((r) => [r.camera, r.at, r.whep.ok, r.whep.ms, r.whep.error || (r.whep.ok ? '' : 'HTTP ' + r.whep.status), r.rtsp?.ok ?? '', r.rtsp?.ms ?? '', r.rtsp?.codec || '', JSON.stringify(r.rtsp?.timedOut ? 'timeout' : r.rtsp?.error || '')].join(','))).join('\n'));
console.log(`\nSaved .demo-logs/probe-${stamp}.json and .csv`);
