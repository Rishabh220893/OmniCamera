/**
 * Stages 2 and 3 of the onboarding probe (docs/camera-onboarding-plan.md section 2) for one input:
 * describe it with ffprobe, then sample it with ffmpeg. The input is an RTSP URL for a real camera, or a local file
 * for the synthetic camera lab, so the same measurement code is tested without any camera.
 * Stage 1 (reachability) and the WHEP check are network-specific and stay with the caller.
 */
import { spawn } from 'node:child_process';
import {
  THRESHOLDS, buildSample, buildSampleArgs, classifyConnectError, parseFfmpegInput, parseFfprobeStreams,
  type DescribeResult, type FailureStage, type SampleMeasurement,
} from './cameraProfile';

export interface CommandRun { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean }

export function runCommand(cmd: string, args: string[], timeoutMs: number, onStderr?: (chunk: string, elapsedMs: number) => void): Promise<CommandRun> {
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

export interface SourceOptions {
  /** rtsp://… for a camera, or a file path for the lab. */
  url: string;
  rtsp: boolean;
  /** RTSP is always pulled over TCP (integrator guide). */
  transport: 'tcp';
  sampleSec: number;
  /** Removes credentials from any text that ends up in a report. */
  redact?: (text: string) => string;
  describeTimeoutMs?: number;
  /** Read a file at its own frame rate, like a live camera (the lab sets this; a camera is real time already). */
  realtime?: boolean;
}

export interface SourceResult {
  describe: DescribeResult | null;
  sample: SampleMeasurement;
  /** Set when nothing usable came back, or when the source rejected us / was unreachable. */
  failure: { stage: FailureStage; detail: string } | null;
  notes: string[];
}

export async function probeSource(o: SourceOptions): Promise<SourceResult> {
  const redact = o.redact ?? ((t: string) => t);
  const notes: string[] = [];
  const describeTimeoutMs = o.describeTimeoutMs ?? 20_000;

  // Describe. A timeout or error here is not fatal: a camera with sparse keyframes can take longer than ffprobe waits,
  // so the sample gets to decide, and ffmpeg's own description of the input fills the gap.
  const d = await runCommand('ffprobe', ['-v', 'error', ...(o.rtsp ? ['-rtsp_transport', o.transport] : []), '-show_streams', '-of', 'json', o.url], describeTimeoutMs);
  let describe = d.timedOut ? null : parseFfprobeStreams(d.stdout);
  const describeFailure = describe ? null
    : d.timedOut ? { stage: 'no_describe' as const, detail: `ffprobe timed out after ${Math.round(describeTimeoutMs / 1000)}s` } : classifyConnectError(d.stderr);
  const empty = (): SampleMeasurement => buildSample({ requestedSec: o.sampleSec, elapsedSec: 0, timeToFirstFrameMs: null, stderr: '' });
  if (describeFailure && (describeFailure.stage === 'bad_credentials' || describeFailure.stage === 'unreachable')) {
    return { describe: null, sample: empty(), failure: { stage: describeFailure.stage, detail: redact(describeFailure.detail) }, notes };
  }

  // Sample. -progress goes to stderr, so a "frame=N" line there is the first decoded frame; stdout carries packet timestamps.
  let firstFrameMs: number | null = null, seenFrame = false;
  const s = await runCommand('ffmpeg', buildSampleArgs(o.url, o.transport, o.sampleSec, o.rtsp, o.realtime), (o.sampleSec + THRESHOLDS.maxStartMs / 1000 + 10) * 1000, (chunk, ms) => {
    if (!seenFrame && /(^|\n)frame=\s*[1-9]/.test(chunk)) { seenFrame = true; firstFrameMs = ms; }
  });
  const sample = buildSample({ requestedSec: o.sampleSec, elapsedSec: s.ms / 1000, timeToFirstFrameMs: firstFrameMs, stderr: s.stderr, packets: s.stdout });
  if (!describe) {
    describe = parseFfmpegInput(s.stderr);
    if (describeFailure && sample.frames > 0) notes.push(`ffprobe could not describe the stream (${redact(describeFailure.detail)}); ffmpeg's description was used`);
  }
  let failure: SourceResult['failure'] = null;
  if (sample.frames > 0 && sample.frames < THRESHOLDS.minFrames) {
    failure = { stage: 'no_frame', detail: `only ${sample.frames} frame${sample.frames === 1 ? '' : 's'} decoded; not a live video stream` };
  } else if (sample.frames === 0) {
    const c = classifyConnectError(s.stderr);
    if (c.stage === 'bad_credentials' || c.stage === 'unreachable') failure = { stage: c.stage, detail: redact(c.detail) };
    else if (describeFailure && !describe) failure = { stage: 'no_describe', detail: redact(describeFailure.detail) };
    else failure = { stage: 'no_frame', detail: redact(s.timedOut ? `no frame within ${Math.round(s.ms / 1000)}s` : c.detail) };
  }
  return { describe, sample, failure, notes };
}
