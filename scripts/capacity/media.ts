/**
 * What a real MediaMTX and real ffmpeg cost on this machine, per simulated camera:
 *   - the media server's CPU and memory as 5/10/20/30 live RTSP cameras are published to it, and again with viewers/analysis readers attached
 *   - the CPU and time one still-frame capture takes (the worker's `extractFrameDetailed`, pulling one frame from RTSP)
 *   - the CPU and time of one frame-gate fingerprint
 *   - the CPU and time of one 8-second probe
 *
 * Each simulated camera is `ffmpeg -re -stream_loop -1 -c copy` of a 720p/15fps H.264 clip into a private MediaMTX on 127.0.0.1:18700 (no
 * transcoding, so the publishers are cheap; their CPU is reported separately). It stops raising the load if free memory drops under 700 MB.
 *
 *   node --import tsx scripts/capacity/media.ts [stage sizes...]       default: 5 10 20 30
 *   node --import tsx scripts/capacity/media.ts --costs-only           only the per-operation costs (capture, gate, probe)
 *
 * Writes scripts/capacity/results/media.json. Nothing is touched outside a temp folder and ports 18700-18701.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFrameArgs } from '../../server/frameSource';
import { FINGERPRINT_ARGS } from '../../server/frameGate';
import { buildSampleArgs } from '../../server/cameraProfile';
import { probeSource } from '../../server/cameraProbe';

const PORT = 18700;
const MIN_FREE_MB = 700;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MEDIAMTX = path.resolve('media-server/bin', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');

/** Busy CPU-seconds across all cores since the previous call (system-wide; includes anything else that is running). */
function cpuSnapshot() {
  let busy = 0, total = 0;
  for (const c of os.cpus()) { const t = c.times; busy += t.user + t.sys + t.irq + t.nice; total += t.user + t.sys + t.irq + t.nice + t.idle; }
  return { busy: busy / 1000, total: total / 1000 };
}
const cpuBetween = (a: ReturnType<typeof cpuSnapshot>, b: ReturnType<typeof cpuSnapshot>) => ({ busyS: b.busy - a.busy, coreS: b.total - a.total });

/** CPU seconds and working set (MB) of processes by id, from the OS. */
function procs(pids: number[]): Array<{ id: number; cpuS: number; mb: number }> {
  if (pids.length === 0) return [];
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress`], { encoding: 'utf8' });
    try {
      const j = JSON.parse(r.stdout || '[]');
      return (Array.isArray(j) ? j : [j]).map((p: { Id: number; CPU: number; WorkingSet64: number }) => ({ id: p.Id, cpuS: Number(p.CPU) || 0, mb: p.WorkingSet64 / 1e6 }));
    } catch { return []; }
  }
  const r = spawnSync('ps', ['-o', 'pid=,cputime=,rss=', '-p', pids.join(',')], { encoding: 'utf8' });
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [pid, cpu, rss] = l.trim().split(/\s+/); const [h, m, s] = cpu.split(':').map(Number);
    return { id: Number(pid), cpuS: h * 3600 + m * 60 + s, mb: Number(rss) / 1024 };
  });
}
const sum = (ps: Array<{ cpuS: number; mb: number }>) => ({ cpuS: ps.reduce((a, p) => a + p.cpuS, 0), mb: ps.reduce((a, p) => a + p.mb, 0) });

async function main() {
  if (!fs.existsSync(MEDIAMTX)) throw new Error(`MediaMTX not found at ${MEDIAMTX}`);
  const costsOnly = process.argv.includes('--costs-only');
  const stages = process.argv.slice(2).map(Number).filter((n) => n > 0);
  const sizes = costsOnly ? [] : stages.length ? stages : [5, 10, 20, 30];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-'));
  const children: ChildProcess[] = [];
  const kill = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
  process.on('exit', kill);
  const cpuInfo = os.cpus()[0];
  const out: Record<string, unknown> = { when: new Date().toISOString(), machine: { cores: os.cpus().length, cpu: cpuInfo.model.trim(), mhz: cpuInfo.speed, ramGB: round(os.totalmem() / 1e9, 1), freeRamMBAtStart: Math.round(os.freemem() / 1e6) } };

  try {
    // ---- the clip: what a typical camera sends
    const clip = path.join(dir, 'clip.mp4');
    const mk = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15', '-t', '10', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1500k', '-maxrate', '1500k', '-bufsize', '3000k', '-g', '30', '-bf', '0', '-pix_fmt', 'yuv420p', '-y', clip], { encoding: 'utf8' });
    if (mk.status !== 0) throw new Error(`could not make the clip: ${mk.stderr}`);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=bit_rate,duration', '-of', 'json', clip], { encoding: 'utf8' });
    const bitrateKbps = Math.round(Number(JSON.parse(probe.stdout).format.bit_rate) / 1000);
    out.clip = { size: '1280x720', fps: 15, gop: 30, bitrateKbps };
    console.log(`clip: 1280x720 @15 fps, ${bitrateKbps} kbps`);

    // ---- a private media server
    const cfg = path.join(dir, 'mediamtx.yml');
    fs.writeFileSync(cfg, `logLevel: error\napi: false\nmetrics: false\npprof: false\nplayback: false\nrtmp: false\nhls: false\nwebrtc: false\nsrt: false\nrtsp: true\nrtspTransports: [tcp]\nrtspAddress: 127.0.0.1:${PORT}\npaths:\n  all_others: {}\n`);
    const mtx = spawn(MEDIAMTX, [cfg], { stdio: 'ignore', cwd: dir }); // MediaMTX writes throwaway TLS files into its working directory
    children.push(mtx);
    await sleep(1500);
    if (mtx.exitCode !== null) throw new Error('MediaMTX did not start');

    // ---- baseline: the machine doing nothing
    const idle0 = cpuSnapshot(); await sleep(4000); const idle = cpuBetween(idle0, cpuSnapshot());
    const baselineBusyCores = idle.busyS / (idle.coreS / os.cpus().length);
    out.baselineBusyCores = round(baselineBusyCores, 3);
    console.log(`baseline: ${round(baselineBusyCores * 100, 1)}% of one core busy with nothing of ours running`);

    // ---- stages: M publishers, then M/2 readers on top
    const publishers: ChildProcess[] = [];
    const readers: ChildProcess[] = [];
    const stageResults: unknown[] = [];
    const spawnPublisher = (i: number) => spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', clip, '-c', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${PORT}/cam${i}`], { stdio: 'ignore' });
    const spawnReader = (i: number) => spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', `rtsp://127.0.0.1:${PORT}/cam${i}`, '-c', 'copy', '-f', 'null', '-'], { stdio: 'ignore' });

    const measure = async (label: string, seconds: number) => {
      const pids = (list: ChildProcess[]) => list.map((c) => c.pid!).filter(Boolean);
      const m0 = procs([mtx.pid!]), p0 = procs(pids(publishers)), r0 = procs(pids(readers)), c0 = cpuSnapshot();
      await sleep(seconds * 1000);
      const m1 = procs([mtx.pid!]), p1 = procs(pids(publishers)), r1 = procs(pids(readers)), c1 = cpuSnapshot();
      const d = cpuBetween(c0, c1);
      return {
        label, seconds,
        mediaServerCpuPct: round(((sum(m1).cpuS - sum(m0).cpuS) / seconds) * 100, 1),
        mediaServerMB: Math.round(sum(m1).mb),
        publishersCpuPct: round(((sum(p1).cpuS - sum(p0).cpuS) / seconds) * 100, 1),
        publishersMB: Math.round(sum(p1).mb),
        readersCpuPct: round(((sum(r1).cpuS - sum(r0).cpuS) / seconds) * 100, 1),
        machineBusyCores: round(d.busyS / (d.coreS / os.cpus().length), 2),
        freeRamMB: Math.round(os.freemem() / 1e6),
      };
    };

    for (const target of sizes) {
      if (os.freemem() / 1e6 < MIN_FREE_MB) { console.log(`stopping before ${target}: only ${Math.round(os.freemem() / 1e6)} MB free`); break; }
      while (publishers.length < target) { const p = spawnPublisher(publishers.length); publishers.push(p); children.push(p); await sleep(250); }
      await sleep(4000);
      const alive = publishers.filter((p) => p.exitCode === null).length;
      const pub = await measure(`${target} cameras publishing`, 15);
      stageResults.push({ cameras: target, alive, ...pub });
      console.log(`${target} cameras (${alive} alive): media server ${pub.mediaServerCpuPct}% of a core, ${pub.mediaServerMB} MB; publishers ${pub.publishersCpuPct}%; machine ${pub.machineBusyCores} cores busy; ${pub.freeRamMB} MB free`);

      if (os.freemem() / 1e6 < MIN_FREE_MB + 200) continue;
      const want = Math.max(1, Math.floor(target / 2));
      while (readers.length < want) { const r = spawnReader(readers.length); readers.push(r); children.push(r); await sleep(250); }
      await sleep(3000);
      const both = await measure(`${target} cameras publishing, ${want} readers`, 15);
      stageResults.push({ cameras: target, readers: want, ...both });
      console.log(`  + ${want} readers: media server ${both.mediaServerCpuPct}% of a core, ${both.mediaServerMB} MB; readers ${both.readersCpuPct}%; machine ${both.machineBusyCores} cores busy`);
      for (const r of readers) r.kill('SIGKILL');
      readers.length = 0;
      await sleep(1000);
    }
    out.stages = stageResults;

    // ---- per-operation costs. ffmpeg reports its own CPU time with -benchmark (exact per process, unaffected by whatever else the machine is doing),
    // so these runs use the very arguments the worker uses, plus -benchmark. One camera keeps publishing; the rest are stopped.
    while (publishers.length > 1) { const p = publishers.pop()!; try { p.kill('SIGKILL'); } catch { /* gone */ } }
    if (publishers.length === 0) { const p = spawnPublisher(0); publishers.push(p); children.push(p); }
    await sleep(5000);
    const url = `rtsp://127.0.0.1:${PORT}/cam0`;
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;

    /** Runs ffmpeg with -benchmark and returns its wall time, user+system CPU seconds and peak memory. */
    const bench = (args: string[], stdin?: Buffer, timeoutMs = 30_000) => new Promise<{ wallMs: number; cpuS: number; maxrssMB: number; stdout: Buffer; ok: boolean }>((resolve) => {
      const a2 = args.map((x, i) => (args[i - 1] === '-loglevel' ? 'info' : x));
      const t0 = performance.now();
      const c = spawn('ffmpeg', ['-benchmark', ...a2], { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = []; let err = '';
      c.stdout!.on('data', (d) => out.push(d)); c.stderr!.on('data', (d) => { err += d; });
      if (stdin) { c.stdin!.on('error', () => {}); c.stdin!.end(stdin); }
      const timer = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
      c.on('close', (code) => {
        clearTimeout(timer);
        const m = err.match(/bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/);
        const rss = err.match(/bench: maxrss=(\d+)/);
        resolve({ wallMs: performance.now() - t0, cpuS: m ? Number(m[1]) + Number(m[2]) : NaN, maxrssMB: rss ? Number(rss[1]) / 1024 : NaN, stdout: Buffer.concat(out), ok: code === 0 });
      });
    });

    await bench(buildFrameArgs(url, true)); // warm up
    const caps = [];
    for (let i = 0; i < 12; i++) { caps.push(await bench(buildFrameArgs(url, true))); await sleep(150); }
    const good = caps.filter((c) => c.ok && c.stdout.length > 500);
    const frame = good[0]?.stdout ?? null;
    out.capture = {
      grabs: good.length, medianMs: Math.round(median(good.map((c) => c.wallMs))), maxMs: Math.round(Math.max(0, ...good.map((c) => c.wallMs))),
      cpuSecondsPerGrab: round(median(good.map((c) => c.cpuS)), 3), peakMB: Math.round(median(good.map((c) => c.maxrssMB))), frameKB: frame ? Math.round(frame.length / 1024) : null,
      note: 'ffmpeg -benchmark on the worker\'s exact frame-grab arguments, new RTSP session each time. Wall time is affected by other load on the machine; CPU seconds are the process\'s own.',
    };
    console.log('capture:', JSON.stringify(out.capture));

    if (frame) {
      const gates = [];
      for (let i = 0; i < 12; i++) gates.push(await bench(FINGERPRINT_ARGS, frame));
      out.gate = { runs: gates.length, medianMs: Math.round(median(gates.map((g) => g.wallMs))), cpuSecondsPerRun: round(median(gates.map((g) => g.cpuS)), 3), peakMB: Math.round(median(gates.map((g) => g.maxrssMB))) };
      console.log('gate:', JSON.stringify(out.gate));
    }

    // one probe: the describe step is an ffprobe run; the sample is an ffmpeg run of the requested length, which dominates
    const sampleSec = 8;
    const sample = await bench(buildSampleArgs(url, 'tcp', sampleSec, true), undefined, 60_000);
    const t0 = performance.now();
    const pr = await probeSource({ url, rtsp: true, transport: 'tcp', sampleSec });
    out.probe = { sampleSec, elapsedS: round((performance.now() - t0) / 1000, 1), frames: pr.sample.frames, ok: !pr.failure, sampleCpuSeconds: round(sample.cpuS, 2), peakMB: Math.round(sample.maxrssMB), note: 'CPU is the ffmpeg sample run (the ffprobe describe step is small beside it). A real probe uses 30 s samples, so CPU grows with the sample length.' };
    console.log('probe:', JSON.stringify(out.probe));
  } finally {
    kill();
    await sleep(500);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp files still locked on Windows */ }
  }
  const resDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'results');
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, 'media.json'), JSON.stringify(out, null, 2));
  console.log('written scripts/capacity/results/media.json');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
