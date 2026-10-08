/**
 * The synthetic camera lab (docs/camera-onboarding-plan.md section 8). ffmpeg generates a clip for each camera type with
 * one fault injected; each clip is read in real time (like a live stream) through the same probe code as a real camera,
 * and the flags and recipe it ends up with are checked.
 *
 * What a file cannot imitate: packet loss, dropped connections, wrong credentials and an unreachable host. Those are
 * covered by unit tests on the parsers and the decision table (tests/cameraProfile.test.ts, tests/cameraRecipe.test.ts).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runCommand, probeSource } from '../../server/cameraProbe.ts';
import { deriveFlags, PROBE_VERSION, type FaultFlag, type ProbeReport } from '../../server/cameraProfile.ts';
import { decide, type Recipe } from '../../server/cameraRecipe.ts';

export const SAMPLE_SEC = 8;

export interface LabCase {
  name: string;
  what: string;
  /** Encoder this case needs; the case is skipped when ffmpeg lacks it. */
  needs?: string;
  /** ffmpeg arguments that write the clip to `out`. Or `build` for a case that needs more than one step. */
  args?: (out: string) => string[];
  build?: (out: string, dir: string) => Promise<void>;
  ext: string;
  expect: { recipe: Recipe; flags?: FaultFlag[]; notFlags?: FaultFlag[]; failure?: boolean; minFirstFrameSec?: number };
}

const src = (size: string, rate: number, secs: number) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`, '-t', String(secs)];
const x264 = (extra: string[]) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...extra];
const x265 = (extra: string[]) => ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', ...extra];
const gop = (n: number) => ['-g', String(n), '-keyint_min', String(n), '-sc_threshold', '0'];

export const CASES: LabCase[] = [
  { name: 'clean_h264', what: 'H.264, no B-frames, a keyframe every 2 s', ext: 'ts', args: (o) => [...src('640x360', 25, 14), ...x264([...gop(50), '-bf', '0']), '-y', o], expect: { recipe: 'A', notFlags: ['bframes', 'sparse_keyframes', 'h265'] } },
  { name: 'low_fps', what: 'a 5 fps camera, otherwise clean', ext: 'ts', args: (o) => [...src('640x360', 5, 14), ...x264([...gop(10), '-bf', '0']), '-y', o], expect: { recipe: 'A', notFlags: ['bframes', 'sparse_keyframes'] } },
  { name: 'bframes_h264', what: 'H.264 with B-frames', ext: 'ts', args: (o) => [...src('640x360', 25, 14), ...x264([...gop(50), '-bf', '3']), '-y', o], expect: { recipe: 'B', flags: ['bframes'] } },
  { name: 'long_gop', what: 'H.264, no B-frames, a keyframe only every 12 s', ext: 'ts', args: (o) => [...src('640x360', 25, 30), ...x264([...gop(300), '-bf', '0']), '-y', o], expect: { recipe: 'B', flags: ['sparse_keyframes'], notFlags: ['bframes'] } },
  {
    name: 'late_keyframe', what: 'a long-GOP stream joined mid-GOP: the first picture waits for the next keyframe (like cam30)', ext: 'ts',
    build: async (o, dir) => {
      const full = path.join(dir, 'late_keyframe.full.ts');
      await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...src('640x360', 25, 40), ...x264([...gop(250), '-bf', '0']), '-y', full], 60_000);
      // Drop the first 3 s of bytes (whole 188-byte TS packets) so the stream starts inside the first 10 s GOP.
      const buf = readFileSync(full);
      writeFileSync(o, buf.subarray(Math.floor((buf.length * 3) / 40 / 188) * 188));
    },
    expect: { recipe: 'B', flags: ['sparse_keyframes'], minFirstFrameSec: 4 },
  },
  { name: 'h265', what: 'H.265', needs: 'libx265', ext: 'ts', args: (o) => [...src('640x360', 25, 14), ...x265([...gop(50)]), '-y', o], expect: { recipe: 'C', flags: ['h265'] } },
  { name: 'mjpeg', what: 'Motion JPEG', ext: 'mkv', args: (o) => [...src('640x360', 10, 14), '-c:v', 'mjpeg', '-q:v', '5', '-y', o], expect: { recipe: 'C', flags: ['other_codec'] } },
  { name: 'av1', what: 'AV1', needs: 'libsvtav1', ext: 'mkv', args: (o) => [...src('640x360', 25, 14), '-c:v', 'libsvtav1', '-preset', '12', '-g', '50', '-y', o], expect: { recipe: 'C', flags: ['other_codec'] } },
  { name: 'tall_clean', what: '1440p H.264, clean', ext: 'ts', args: (o) => [...src('2560x1440', 15, 14), ...x264([...gop(30), '-bf', '0']), '-y', o], expect: { recipe: 'A', flags: ['high_resolution'] } },
  { name: 'tall_bframes', what: '1440p H.264 with B-frames', ext: 'ts', args: (o) => [...src('2560x1440', 15, 14), ...x264([...gop(30), '-bf', '3']), '-y', o], expect: { recipe: 'D', flags: ['high_resolution', 'bframes'] } },
  { name: 'tall_h265', what: '1440p H.265', needs: 'libx265', ext: 'ts', args: (o) => [...src('2560x1440', 15, 14), ...x265([...gop(30)]), '-y', o], expect: { recipe: 'D', flags: ['h265', 'high_resolution'] } },
  { name: 'ends_early', what: 'the stream ends after 3 s of an 8 s sample', ext: 'ts', args: (o) => [...src('640x360', 25, 3), ...x264([...gop(50), '-bf', '0']), '-y', o], expect: { recipe: 'F', flags: ['closed_early'] } },
  {
    name: 'damaged', what: 'clean H.264 with bytes flipped in the stream', ext: 'ts',
    build: async (o, dir) => {
      const clean = path.join(dir, 'damaged.clean.ts');
      await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...src('640x360', 25, 14), ...x264([...gop(50), '-bf', '0']), '-y', clean], 60_000);
      const buf = readFileSync(clean);
      // Flip a byte in the payload of every 40th TS packet (188 bytes), after the first few so the stream still opens.
      for (let p = 188 * 20; p + 188 < buf.length; p += 188 * 40) buf[p + 40 + (p % 100)] ^= 0xff;
      writeFileSync(o, buf);
    },
    expect: { recipe: 'A', flags: ['corrupt_frames'] },
  },
  { name: 'audio_only', what: 'a source with no video at all', ext: 'ts', args: (o) => ['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '14', '-c:a', 'aac', '-y', o], expect: { recipe: 'G', failure: true } },
  { name: 'garbage', what: 'bytes that are not a stream', ext: 'bin', build: async (o) => { writeFileSync(o, randomBytes(200_000)); }, expect: { recipe: 'G', failure: true } },
];

export async function availableEncoders(): Promise<Set<string>> {
  const r = await runCommand('ffmpeg', ['-hide_banner', '-encoders'], 10_000);
  const set = new Set<string>();
  for (const line of r.stdout.split('\n')) { const m = line.match(/^\s*V\S*\s+(\S+)/); if (m) set.add(m[1]); }
  return set;
}

export interface LabResult { case: LabCase; report: ProbeReport; recipe: Recipe; reason: string; problems: string[]; ms: number }

export async function generate(c: LabCase, dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${c.name}.${c.ext}`);
  if (c.build) await c.build(out, dir);
  else {
    const r = await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...c.args!(out)], 120_000);
    if (!existsSync(out)) throw new Error(`could not generate ${c.name}: ${r.stderr.slice(-300)}`);
  }
  return out;
}

export async function runCase(c: LabCase, dir: string): Promise<LabResult> {
  const t0 = Date.now();
  const file = await generate(c, dir);
  const r = await probeSource({ url: file, rtsp: false, transport: 'tcp', sampleSec: SAMPLE_SEC, realtime: true });
  const report: ProbeReport = {
    cameraId: c.name, site: 'lab', transport: 'tcp', probedAt: new Date().toISOString(), probeVersion: PROBE_VERSION, reachable: true,
    failure: r.failure?.stage ?? null, failureDetail: r.failure?.detail ?? null, describe: r.describe, sample: r.sample.elapsedSec > 0 ? r.sample : null,
    whep: null, flags: deriveFlags(r.describe, r.sample.elapsedSec > 0 ? r.sample : null),
  };
  const d = decide(report);
  const problems: string[] = [];
  if (d.recipe !== c.expect.recipe) problems.push(`recipe ${d.recipe}, expected ${c.expect.recipe} (${d.reason})`);
  for (const f of c.expect.flags ?? []) if (!report.flags.includes(f)) problems.push(`flag ${f} not seen (flags: ${report.flags.join(',') || 'none'})`);
  for (const f of c.expect.notFlags ?? []) if (report.flags.includes(f)) problems.push(`flag ${f} seen but should not be`);
  const first = (report.sample?.timeToFirstFrameMs ?? 0) / 1000;
  if (c.expect.minFirstFrameSec && first < c.expect.minFirstFrameSec) problems.push(`first frame after ${first.toFixed(1)}s, expected at least ${c.expect.minFirstFrameSec}s`);
  if (c.expect.failure && !report.failure) problems.push('expected a failure, got none');
  if (!c.expect.failure && report.failure) problems.push(`unexpected failure ${report.failure}: ${report.failureDetail}`);
  return { case: c, report, recipe: d.recipe, reason: d.reason, problems, ms: Date.now() - t0 };
}

/** Runs the cases a few at a time (each takes about the sample length, since it reads in real time). */
export async function runLab(dir: string, opts: { only?: string[]; parallel?: number } = {}): Promise<{ results: LabResult[]; skipped: Array<{ name: string; why: string }> }> {
  const encoders = await availableEncoders();
  const skipped: Array<{ name: string; why: string }> = [];
  const todo = CASES.filter((c) => !opts.only || opts.only.includes(c.name)).filter((c) => {
    if (c.needs && !encoders.has(c.needs)) { skipped.push({ name: c.name, why: `ffmpeg has no ${c.needs}` }); return false; }
    return true;
  });
  const results: LabResult[] = new Array(todo.length);
  let next = 0;
  await Promise.all(Array.from({ length: opts.parallel ?? 4 }, async () => {
    while (next < todo.length) { const i = next++; results[i] = await runCase(todo[i], dir); }
  }));
  return { results, skipped };
}
