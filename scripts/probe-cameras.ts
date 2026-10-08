/**
 * Onboarding probe, steps 1-3 of docs/camera-onboarding-plan.md section 2, for any camera that exposes
 * the three endpoints (RTSP :8554, WHEP :8889, HLS). Talks to the source directly, not through the media server.
 *
 *   node --import tsx scripts/probe-cameras.ts                       the 30 grid cameras, checked against what is known
 *   node --import tsx scripts/probe-cameras.ts --cams cam06,cam14    only those
 *   node --import tsx scripts/probe-cameras.ts --sample 30           seconds of video to sample (default 30; 5 for a smoke test)
 *   node --import tsx scripts/probe-cameras.ts --parallel 2          cameras at a time (default 2; streams are real time)
 *   node --import tsx scripts/probe-cameras.ts --host H --site NAME  another source (site name selects the credentials)
 *   node --import tsx scripts/probe-cameras.ts --udp                 probe over UDP instead of TCP
 *   node --import tsx scripts/probe-cameras.ts --db                  also save to Postgres (PROFILE_DATABASE_URL or DATABASE_URL)
 *
 * Stages, each with its own timeout and a named failure:
 *   1 reachability  TCP connect to the RTSP port -> "unreachable"; a 401/403 from ffprobe -> "bad_credentials"
 *   2 describe      ffprobe: codec, profile, resolution, fps, bitrate, B-frame hint, audio
 *   3 sample        ffmpeg decodes --sample seconds: time to first frame, keyframe spacing, B-frames, packet loss,
 *                   decode errors, timestamp problems, early close
 * Output: a table, .demo-logs/profile-<timestamp>.json (one ProbeReport per camera, no credentials), and for the
 * grid a comparison with what is already known (server/gridGroundTruth.ts). Exit code 1 if that comparison fails.
 * Credentials: GRID_EMAIL / GRID_PASSWORD (or STREAM_EMAIL / STREAM_PASSWORD) from the environment, demo.local or scale.local.
 * Every RTSP pull counts against the account's watch time: a full run is ~30 s per camera.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  PROBE_VERSION, THRESHOLDS, buildSample, buildSampleArgs, classifyConnectError, parseFfmpegInput, deriveFlags, parseFfprobeStreams,
  createProfileStore, type DescribeResult, type FailureStage, type ProbeReport,
} from '../server/cameraProfile';
import { GRID_GROUND_TRUTH } from '../server/gridGroundTruth';

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n: string) => argv.includes(n);

// Same precedence as scripts/probe-grid.mjs: demo.local, then scale.local, both overriding the shell environment.
const env: Record<string, string | undefined> = { ...process.env };
for (const f of ['demo.local', 'scale.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').replace(/\r/g, '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const HOST = opt('--host', env.GRID_HOST || '103.250.160.189');
const SITE = opt('--site', 'grid');
const email = env.GRID_EMAIL || env.STREAM_EMAIL;
const pass = env.GRID_PASSWORD || env.STREAM_PASSWORD;
if (!email || !pass) { console.error('No credentials found (GRID_EMAIL + GRID_PASSWORD in the environment, demo.local or scale.local).'); process.exit(2); }

const mask = (e: string) => (e.length > 4 ? `${e.slice(0, 2)}***${e.slice(-6)}` : '***');
console.log(`Credentials: ${mask(email)} (password ${pass.length} chars)`);

const sampleSec = Math.max(3, Number(opt('--sample', '30')));
const parallel = Math.max(1, Number(opt('--parallel', '2')));
const transport = flag('--udp') ? 'udp' : 'tcp';
const ids = (opt('--cams', '') || Array.from({ length: 30 }, (_, i) => `cam${String(i + 1).padStart(2, '0')}`).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const enc = (v: string) => encodeURIComponent(v).replace(/@/g, '%40');
const redact = (s: string) => s.replace(/\r/g, '').split(pass).join('***').split(enc(pass)).join('***').replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***@');
const url = (id: string) => `rtsp://${enc(email)}:${enc(pass)}@${HOST}:8554/stream/${id}`;

interface Run { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean }

function run(cmd: string, args: string[], timeoutMs: number, onStderr?: (chunk: string, elapsedMs: number) => void): Promise<Run> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, done = false;
    const finish = (code: number | null) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; onStderr?.(String(d), Date.now() - t0); });
    p.on('close', finish);
    p.on('error', (e: NodeJS.ErrnoException) => { stderr += e.code === 'ENOENT' ? `${cmd} not found on PATH` : String(e); finish(null); });
  });
}

function tcpReachable(port: number, ms = 5000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port, timeout: ms });
    s.once('connect', () => { s.destroy(); resolve({ ok: true }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, error: 'timed out' }); });
    s.once('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, error: e.code || String(e) }));
  });
}

async function whep(id: string) {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://${HOST}:8889/stream/${id}/whep`, { method: 'OPTIONS', signal: AbortSignal.timeout(8000) });
    return { ok: r.status < 500, status: r.status, ms: Date.now() - t0 };
  } catch (e: any) { return { ok: false, status: 0, ms: Date.now() - t0, error: e.cause?.code || e.name || String(e) }; }
}

async function probe(id: string): Promise<ProbeReport> {
  const report: ProbeReport = {
    cameraId: id, site: SITE, transport, probedAt: new Date().toISOString(), probeVersion: PROBE_VERSION,
    reachable: false, failure: null, failureDetail: null, describe: null, sample: null, whep: null, flags: [],
  };
  const fail = (stage: FailureStage, detail: string) => { report.failure = stage; report.failureDetail = redact(detail); };
  report.whep = await whep(id);

  // Stage 1: reachability
  const tcp = await tcpReachable(8554);
  if (!tcp.ok) { fail('unreachable', `RTSP port 8554: ${tcp.error}`); return report; }
  report.reachable = true;

  // Stage 2: describe. A timeout or error here is not fatal: a camera with sparse keyframes can take longer than
  // ffprobe waits, so stage 3 gets to decide, and ffmpeg's own description of the input fills the gap.
  const d = await run('ffprobe', ['-v', 'error', '-rtsp_transport', transport, '-show_streams', '-of', 'json', url(id)], 20_000);
  report.describe = d.timedOut ? null : parseFfprobeStreams(d.stdout);
  const describeFailure = report.describe ? null
    : d.timedOut ? { stage: 'no_describe' as const, detail: 'ffprobe timed out after 20s' } : classifyConnectError(d.stderr);
  if (describeFailure && (describeFailure.stage === 'bad_credentials' || describeFailure.stage === 'unreachable')) {
    fail(describeFailure.stage, describeFailure.detail);
    return report;
  }

  // Stage 3: sample. -progress goes to stderr, so a "frame=N" line there is the first decoded frame; stdout carries packet timestamps.
  let firstFrameMs: number | null = null, seenFrame = false;
  const s = await run('ffmpeg', buildSampleArgs(url(id), transport, sampleSec), (sampleSec + THRESHOLDS.maxStartMs / 1000 + 10) * 1000, (chunk, ms) => {
    if (!seenFrame && /(^|\n)frame=\s*[1-9]/.test(chunk)) { seenFrame = true; firstFrameMs = ms; }
  });
  report.sample = buildSample({ requestedSec: sampleSec, elapsedSec: s.ms / 1000, timeToFirstFrameMs: firstFrameMs, stderr: s.stderr, packets: s.stdout });
  if (!report.describe) {
    report.describe = parseFfmpegInput(s.stderr);
    if (describeFailure && report.sample.frames > 0) report.notes = [`ffprobe could not describe the stream (${redact(describeFailure.detail)}); ffmpeg's description was used`];
  }
  if (report.sample.frames === 0) {
    const c = classifyConnectError(s.stderr);
    if (c.stage === 'bad_credentials' || c.stage === 'unreachable') fail(c.stage, c.detail);
    else if (describeFailure && !report.describe) fail('no_describe', describeFailure.detail);
    else fail('no_frame', s.timedOut ? `no frame within ${Math.round(s.ms / 1000)}s` : c.detail);
  }
  report.flags = deriveFlags(report.describe, report.sample);
  return report;
}

const reports: ProbeReport[] = new Array(ids.length);
let next = 0, rejected = 0, succeeded = 0, pauseUntil = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
console.log(`Probing ${ids.length} cameras on ${HOST} (site ${SITE}, ${transport}, ${sampleSec}s sample, ${parallel} at a time) - ${new Date().toISOString()}\n`);
console.log('camera  result        codec  size       fps  first   kf max  flags');
await Promise.all(Array.from({ length: parallel }, async () => {
  while (next < ids.length && rejected < 3) {
    const i = next++;
    while (Date.now() < pauseUntil) await sleep(1000);
    let r = await probe(ids[i]);
    // The same login worked minutes ago, so a 401 now is the grid limiting sessions or rate, not a wrong password.
    if (r.failure === 'bad_credentials' && succeeded > 0) {
      console.log(`${ids[i]}: 401 after ${succeeded} good probes - the grid may be limiting this account; pausing 60s and retrying once`);
      pauseUntil = Math.max(pauseUntil, Date.now() + 60_000);
      await sleep(60_000);
      r = await probe(ids[i]);
      r.notes = [...(r.notes ?? []), 'first attempt was rejected with 401 although earlier cameras in this run were accepted'];
    }
    reports[i] = r;
    if (r.failure === 'bad_credentials') rejected++; else if (!r.failure) succeeded++;
    const d = r.describe, s = r.sample;
    console.log([
      r.cameraId.padEnd(7), (r.failure ?? 'ok').padEnd(13), (d?.codec ?? '-').padEnd(6),
      (d?.width ? `${d.width}x${d.height}` : '-').padEnd(10), String(d?.fps ?? '-').padEnd(4),
      (s?.timeToFirstFrameMs != null ? (s.timeToFirstFrameMs / 1000).toFixed(1) + 's' : '-').padEnd(7),
      (s && s.frames > 0 ? Math.max(s.keyframeIntervalSec?.max ?? 0, s.sinceLastKeyframeSec).toFixed(1) + 's' : '-').padEnd(8), r.flags.join(',') || (r.failureDetail ?? ''),
    ].join(' '));
  }
}));

const notProbed = ids.filter((_, i) => !reports[i]);
if (rejected >= 3) {
  console.error(succeeded === 0
    ? '\nThe source rejected the credentials 3 times (401) and nothing was accepted, so the run stopped early. Check GRID_EMAIL / GRID_PASSWORD in demo.local AND scale.local (scale.local wins), and that no GRID_* variables are set in the shell.'
    : `\nThe grid started refusing this account (401) after ${succeeded} good probes, even after a pause, so the run stopped. That is a limit on the grid side, not a wrong password. Wait a while, stop other users of the account (demo, app tabs), and run the rest with --cams.`);
}
if (notProbed.length) console.error(`Not probed: ${notProbed.join(',')}`);
for (let i = reports.length - 1; i >= 0; i--) if (!reports[i]) reports.splice(i, 1);

mkdirSync('.demo-logs', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`.demo-logs/profile-${stamp}.json`, JSON.stringify({ host: HOST, site: SITE, sampleSec, transport, reports }, null, 2));
console.log(`\nSaved .demo-logs/profile-${stamp}.json`);

if (flag('--db')) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: env.PROFILE_DATABASE_URL || env.DATABASE_URL });
  const store = createProfileStore(pool);
  await store.ensureSchema();
  for (const r of reports) await store.saveProbe(r);
  await pool.end();
  console.log(`Saved ${reports.length} profiles to Postgres.`);
}

// Check against what is already known (grid only).
let mismatches = 0, unchecked = 0;
if (SITE === 'grid') {
  console.log('\n--- Against what is already known ---');
  for (const r of reports) {
    const exp = GRID_GROUND_TRUTH[r.cameraId];
    if (!exp) continue;
    if (r.failure && r.failure !== exp.failure) { unchecked++; console.log(`NOT CHECKED ${r.cameraId}: probe failed (${r.failure}), so there is nothing to compare`); continue; }
    const problems: string[] = [];
    if (exp.failure && r.failure !== exp.failure) problems.push(`expected failure ${exp.failure}, got ${r.failure ?? 'none'}`);
    for (const f of exp.flags ?? []) if (!r.flags.includes(f) && !(r.describe?.codec && f === 'h265' && r.describe.codec === 'hevc')) problems.push(`expected ${f}, not seen`);
    if (problems.length) { mismatches++; console.log(`MISMATCH ${r.cameraId}: ${problems.join('; ')}`); }
  }
  const checked = reports.filter((r) => GRID_GROUND_TRUTH[r.cameraId]).length;
  if (unchecked) console.log(`${unchecked} could not be checked because the probe itself failed.`);
  console.log(mismatches ? `${mismatches} of ${checked} known cameras differ.` : `All ${checked} known cameras match.`);
}
process.exit(mismatches || unchecked ? 1 : 0);
