#!/usr/bin/env node
/**
 * Measures how reliably each demo-grid camera delivers a clean frame over RTSP and prints them best-first,
 * ready to paste into GRID_HEALTH_ORDER (src/lib/cameraHealth.ts).
 *
 *   GRID_EMAIL=... GRID_PASSWORD=... node scripts/check-grid-health.mjs
 *
 * Needs ffmpeg on PATH. Cameras are tested one at a time (the grid limits concurrent sessions and each account's
 * watch time), and a camera is only pulled for as long as it takes to get one frame. Options (env):
 *   CAMERAS=cam01,cam02   which cameras (default cam01..cam30)
 *   ROUNDS=2              grabs per camera; a camera must succeed in every round to count as healthy
 *   TIMEOUT_S=45          per-grab limit
 */
import { spawn } from 'node:child_process';

const email = process.env.GRID_EMAIL || process.env.STREAM_EMAIL || '';
const password = process.env.GRID_PASSWORD || process.env.STREAM_PASSWORD || '';
if (!email || !password) { console.error('Set GRID_EMAIL and GRID_PASSWORD (or STREAM_EMAIL / STREAM_PASSWORD).'); process.exit(1); }
const host = process.env.GRID_RTSP_HOST || '103.250.160.189:8554';
const rounds = Math.max(1, Number(process.env.ROUNDS) || 2);
const timeoutS = Math.max(10, Number(process.env.TIMEOUT_S) || 45);
const ids = (process.env.CAMERAS || Array.from({ length: 30 }, (_, i) => `cam${String(i + 1).padStart(2, '0')}`).join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const enc = encodeURIComponent;
function grab(id) {
  return new Promise((resolve) => {
    const started = Date.now();
    const url = `rtsp://${enc(email)}:${enc(password)}@${host}/stream/${id}`;
    // Same flags as the app's snapshot route: wait for a real keyframe rather than accept a half-decoded picture.
    const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-allowed_media_types', 'video', '-skip_frame', 'nokey',
      '-i', url, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0; let err = '';
    p.stdout.on('data', (d) => { bytes += d.length; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve({ ok: false, s: timeoutS, why: 'timeout' }); }, timeoutS * 1000);
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, s: 0, why: `spawn: ${e.message}` }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const s = (Date.now() - started) / 1000;
      resolve(bytes > 2000 && code === 0 ? { ok: true, s } : { ok: false, s, why: `exit ${code}${err.includes('Connection refused') ? ' refused' : ''}` });
    });
  });
}

const results = [];
for (const id of ids) {
  const runs = [];
  for (let r = 0; r < rounds; r++) {
    runs.push(await grab(id));
    await new Promise((res) => setTimeout(res, 1500));
  }
  const okRuns = runs.filter((x) => x.ok);
  const avg = okRuns.length ? okRuns.reduce((a, x) => a + x.s, 0) / okRuns.length : Infinity;
  results.push({ id, okRuns: okRuns.length, rounds, avg, worst: Math.max(...runs.map((x) => x.s)) });
  console.log(`${id}  ${okRuns.length}/${rounds} ok  avg ${Number.isFinite(avg) ? avg.toFixed(1) + 's' : '-'}  ${runs.map((x) => (x.ok ? x.s.toFixed(1) + 's' : x.why)).join(', ')}`);
}

// Best first: most successful rounds, then fastest average.
results.sort((a, b) => b.okRuns - a.okRuns || a.avg - b.avg);
console.log('\nRanked (paste into GRID_HEALTH_ORDER in src/lib/cameraHealth.ts):\n');
console.log('[' + results.map((r) => `'${r.id}'`).join(', ') + ']');
const good = results.filter((r) => r.okRuns === r.rounds && r.avg <= 20);
console.log(`\n${good.length} camera(s) succeeded every round within ~20 s: ${good.map((r) => r.id).join(', ') || 'none'}`);
