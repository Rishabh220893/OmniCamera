/**
 * An analyzer that asks a separate inference service (a GPU box running a detector such as YOLO and a face-embedding model) what is in a frame
 * (gap A17, docs/inference-service.md). It is the shape the scale target needs: the app does not run neural networks itself, it sends a frame to a
 * service that can sit on a GPU server, scale on its own, and be replaced.
 *
 * The contract (HTTP, JSON, `Authorization: Bearer <key>` when a key is set):
 *   POST {url}/v1/infer   { image: <base64 JPEG>, tasks: ["person","vehicle","face"] }
 *     -> { model: "yolov8n+arcface", ms: 31, detections: [ { label: "person"|"car"|"truck"|"bus"|"motorcycle"|"bicycle", score: 0.91, box: [x, y, w, h] } ],
 *          faces: [ { box: [x, y, w, h], score: 0.97, embedding: [ ...512 numbers... ] } ] }       (box in fractions of the picture, 0..1)
 *   GET  {url}/health     -> { status: "ok", model, device }
 *
 * What it produces: people and vehicle counts for the log entry and `person.seen` / `vehicle.seen` events (the same ones the model-based scene analysis
 * makes, so alert rules and the anomaly detector work with either), and, when the service returns face embeddings and the camera's user has enrolled
 * faces with embeddings, `person.known` / `person.unknown` from the face index (`faceIndex.ts`).
 *
 * It does not replace the scene description: that still needs the language model. It is the cheap, fast, countable part.
 */
import type { EventDraft } from '../events/schema';
import type { Analyzer } from './types';
import type { FaceIndex } from './faceIndex';

export interface Detection { label: string; score: number; box: [number, number, number, number] }
export interface FaceDetection { box: [number, number, number, number]; score: number; embedding?: number[] }
export interface InferResponse { model?: string; ms?: number; detections: Detection[]; faces?: FaceDetection[] }

export const PERSON_LABELS = new Set(['person']);
export const VEHICLE_LABELS = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'van', 'auto', 'tempo']);

export interface InferenceClientOptions {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Failed calls in a row after which the service is skipped for `cooldownMs`. Default 3 and 60 s. */
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export interface InferenceClient {
  infer(jpeg: Buffer, tasks: string[], signal?: AbortSignal): Promise<InferResponse>;
  health(): Promise<{ status: string; model?: string; device?: string }>;
}

export function createInferenceClient(o: InferenceClientOptions): InferenceClient {
  const base = o.url.replace(/\/+$/, '');
  const doFetch = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 5_000;
  const threshold = o.failureThreshold ?? 3, cooldownMs = o.cooldownMs ?? 60_000;
  const now = o.now ?? Date.now;
  let failures = 0, pausedUntil = 0;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) };

  return {
    async infer(jpeg, tasks, signal) {
      if (now() < pausedUntil) throw new Error('the inference service is paused after repeated failures');
      try {
        const res = await doFetch(`${base}/v1/infer`, { method: 'POST', headers, body: JSON.stringify({ image: jpeg.toString('base64'), tasks }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`the inference service answered ${res.status}`);
        const j = (await res.json()) as Partial<InferResponse>;
        if (!Array.isArray(j.detections)) throw new Error('the inference service answered with an unexpected shape');
        failures = 0;
        return { model: typeof j.model === 'string' ? j.model : undefined, ms: typeof j.ms === 'number' ? j.ms : undefined, detections: j.detections.filter(validDetection), faces: Array.isArray(j.faces) ? j.faces.filter(validFace) : [] };
      } catch (e) {
        if (++failures >= threshold) { pausedUntil = now() + cooldownMs; failures = 0; }
        throw e;
      }
    },
    async health() {
      const res = await doFetch(`${base}/health`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`the inference service answered ${res.status}`);
      return (await res.json()) as { status: string; model?: string; device?: string };
    },
  };
}

const box = (b: unknown): b is [number, number, number, number] => Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n));
const validDetection = (d: Detection): boolean => !!d && typeof d.label === 'string' && typeof d.score === 'number' && d.score >= 0 && d.score <= 1 && box(d.box);
const validFace = (f: FaceDetection): boolean => !!f && box(f.box) && typeof f.score === 'number' && (f.embedding === undefined || (Array.isArray(f.embedding) && f.embedding.length >= 16 && f.embedding.length <= 4096 && f.embedding.every((n) => typeof n === 'number' && Number.isFinite(n))));

export interface RemoteDetectorOptions {
  client: InferenceClient;
  /** Detections below this score are ignored. Default 0.5. */
  minScore?: number;
  /** Enrolled faces: when set, face embeddings from the service are matched against it. */
  faces?: (userId: string | undefined) => FaceIndex | null;
  /** Counts the frame as a different picture size would; boxes smaller than this fraction of the frame in both directions are ignored (noise). Default 0.01. */
  minBoxFraction?: number;
  timeoutMs?: number;
}

export function createRemoteDetectorAnalyzer(o: RemoteDetectorOptions): Analyzer {
  const minScore = o.minScore ?? 0.5, minBox = o.minBoxFraction ?? 0.01;
  return {
    id: 'remote-detector',
    label: 'People and vehicle counting (inference service)',
    description: 'Counts people and vehicles, and matches faces, with a detector running on a separate (GPU) service. No language model call.',
    timeoutMs: o.timeoutMs ?? 8_000,
    async analyze({ frame, camera, signal }) {
      const wantFaces = !!o.faces?.(camera.userId);
      const r = await o.client.infer(frame.jpeg, wantFaces ? ['person', 'vehicle', 'face'] : ['person', 'vehicle'], signal);
      const ok = r.detections.filter((d) => d.score >= minScore && d.box[2] >= minBox && d.box[3] >= minBox);
      const people = ok.filter((d) => PERSON_LABELS.has(d.label)).length;
      const vehicles = ok.filter((d) => VEHICLE_LABELS.has(d.label)).length;
      const events: EventDraft[] = [];
      if (vehicles > 0) events.push({ type: 'vehicle.seen', summary: `${vehicles} vehicle${vehicles === 1 ? '' : 's'} seen`, data: { count: vehicles, detector: r.model ?? 'remote', byLabel: tally(ok.filter((d) => VEHICLE_LABELS.has(d.label))) }, dedupeKey: 'vehicles' });
      if (people > 0) events.push({ type: 'person.seen', summary: `${people} ${people === 1 ? 'person' : 'people'} seen`, data: { count: people, detector: r.model ?? 'remote' }, dedupeKey: 'people' });

      const names: string[] = [];
      const index = o.faces?.(camera.userId);
      if (index && r.faces?.length) {
        let unknown = 0;
        for (const f of r.faces) {
          if (!f.embedding) continue;
          const m = index.match(f.embedding);
          if (m) { names.push(m.name); events.push({ type: 'person.known', summary: `${m.name} recognised`, confidence: m.score, data: { name: m.name, score: Math.round(m.score * 1000) / 1000, matcher: 'face-embedding' }, dedupeKey: m.name }); }
          else unknown++;
        }
        if (unknown > 0) events.push({ type: 'person.unknown', summary: unknown === 1 ? 'An unknown person was seen' : `${unknown} unknown people were seen`, data: { names: Array(unknown).fill('Unknown Person'), matcher: 'face-embedding' }, dedupeKey: 'unknown' });
      }
      return { fields: { counts: { people, vehicles, other: 0 }, ...(names.length ? { people_identified: names } : {}) }, events };
    },
  };
}

function tally(ds: Detection[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const d of ds) t[d.label] = (t[d.label] ?? 0) + 1;
  return t;
}
