/**
 * AI analysis of a recorded clip: frames are taken evenly across the video, each is sent to the same frame analysis the live views use
 * (`/api/gemini/analyze-frame`), and the answers form a timeline. One request at a time (the analysis has a cost and a rate limit).
 */
import { captureFrame } from './lastFrame';

export interface FrameFinding {
  /** Seconds from the start of the clip. */
  at: number;
  summary: string;
  people: number;
  vehicles: number;
  plates: string[];
  alerts: string[];
  unusual: boolean;
  /** Set when this frame could not be analysed (the others are still shown). */
  error?: string;
}

export interface ClipSummary { frames: number; failed: number; maxPeople: number; maxVehicles: number; plates: string[]; unusualAt: number[]; alerts: string[] }

export const MAX_FRAMES = 12;
export const MIN_GAP_SECONDS = 4;

/** Where to look: evenly spread through the clip, at most `maxFrames`, at least `minGap` seconds apart, never right at the first or last instant. */
export function sampleTimes(duration: number, maxFrames = MAX_FRAMES, minGap = MIN_GAP_SECONDS): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const n = Math.max(1, Math.min(maxFrames, Math.floor(duration / minGap)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) * duration) / n;
    out.push(Math.round(Math.min(Math.max(t, 0.2), Math.max(0.2, duration - 0.2)) * 10) / 10);
  }
  return [...new Set(out)];
}

export function summarizeFindings(f: FrameFinding[]): ClipSummary {
  const ok = f.filter((x) => !x.error);
  return {
    frames: f.length, failed: f.length - ok.length,
    maxPeople: Math.max(0, ...ok.map((x) => x.people)), maxVehicles: Math.max(0, ...ok.map((x) => x.vehicles)),
    plates: [...new Set(ok.flatMap((x) => x.plates))].slice(0, 12),
    unusualAt: ok.filter((x) => x.unusual).map((x) => x.at),
    alerts: [...new Set(ok.flatMap((x) => x.alerts))].slice(0, 8),
  };
}

/** The finding that applies at playback time `t`: the latest one at or before it. */
export function findingAt(f: FrameFinding[], t: number): FrameFinding | null {
  let best: FrameFinding | null = null;
  for (const x of f) if (x.at <= t + 0.3 && (!best || x.at > best.at)) best = x;
  return best;
}

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** What the analysis answered, as a finding (tolerant of missing fields). */
export function findingFromAnswer(at: number, d: Record<string, unknown>): FrameFinding {
  const counts = (d.counts ?? {}) as { people?: unknown; vehicles?: unknown };
  const strs = (v: unknown, n: number) => (Array.isArray(v) ? v.map(String).slice(0, n) : []);
  return {
    at, summary: String(d.summary ?? '').trim() || 'Nothing to report.', people: Number(counts.people) || 0, vehicles: Number(counts.vehicles) || 0,
    plates: strs(d.detected_plates, 4), alerts: strs(d.alerts, 3), unusual: !!d.isUnusual,
  };
}

export interface ClipCamera { id: string; name: string; sensitivity?: number; peopleThreshold?: number; vehicleThreshold?: number; suspiciousRules?: string }

export interface AnalyzeOptions {
  videoUrl: string;
  duration: number;
  camera: ClipCamera;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, finding: FrameFinding) => void;
  /** Replaces the network call (tests). */
  ask?: (jpegBase64: string, camera: ClipCamera) => Promise<Record<string, unknown>>;
  /** Replaces taking a frame from the video (tests). */
  grab?: (at: number) => Promise<string | null>;
}

const askServer = async (imageBase64: string, camera: ClipCamera): Promise<Record<string, unknown>> => {
  const res = await fetch('/api/gemini/analyze-frame', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64, knownFaces: [], watchlist: [], camera: { id: camera.id, name: camera.name, sensitivity: camera.sensitivity, peopleThreshold: camera.peopleThreshold, vehicleThreshold: camera.vehicleThreshold, suspiciousRules: camera.suspiciousRules } }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `The analysis answered ${res.status}.`);
  return res.json();
};

/** Seeks a hidden copy of the video to each time and returns a frame as base64 JPEG (null if the browser gives no picture). */
async function grabFromVideo(video: HTMLVideoElement, at: number): Promise<string | null> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { video.removeEventListener('seeked', ok); reject(new Error('The video did not seek in time.')); }, 8000);
    const ok = () => { clearTimeout(timer); resolve(); };
    video.addEventListener('seeked', ok, { once: true });
    video.currentTime = at;
  });
  const url = captureFrame(video, 768, 0.8);
  return url ? url.split(',')[1] ?? null : null;
}

/** Analyses the clip frame by frame. Stops (returning what it has) when aborted, or after three failures in a row (the analysis is down or unconfigured). */
export async function analyzeClip(o: AnalyzeOptions): Promise<FrameFinding[]> {
  const times = sampleTimes(o.duration);
  const out: FrameFinding[] = [];
  let video: HTMLVideoElement | null = null;
  let grab = o.grab;
  if (!grab) {
    video = document.createElement('video');
    video.muted = true; video.preload = 'auto'; video.src = o.videoUrl;
    await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error('The video could not be opened.')), 15_000); video!.onloadeddata = () => { clearTimeout(t); resolve(); }; video!.onerror = () => { clearTimeout(t); reject(new Error('The video could not be opened.')); }; });
    const v = video; grab = (at) => grabFromVideo(v, at);
  }
  const ask = o.ask ?? askServer;
  let streak = 0;
  try {
    for (let i = 0; i < times.length; i++) {
      if (o.signal?.aborted) break;
      const at = times[i];
      let finding: FrameFinding;
      try {
        const b64 = await grab(at);
        if (!b64) throw new Error('No picture at this point of the video.');
        finding = findingFromAnswer(at, await ask(b64, o.camera));
        streak = 0;
      } catch (e) {
        streak++;
        finding = { at, summary: '', people: 0, vehicles: 0, plates: [], alerts: [], unusual: false, error: e instanceof Error ? e.message : 'The analysis failed.' };
      }
      out.push(finding);
      o.onProgress?.(i + 1, times.length, finding);
      if (streak >= 3) break;
    }
  } finally { if (video) { video.removeAttribute('src'); video.load(); } }
  return out;
}
