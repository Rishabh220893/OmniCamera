/**
 * Client for the ANPR service (anpr-service/). It receives a JPEG and returns
 * the licence plates found in it, read by a dedicated plate detector + OCR
 * model rather than a general vision LLM.
 */
export interface PlateRead {
  /** Normalised (and, for Indian plates, positionally corrected) plate text. */
  text: string;
  rawText: string;
  /** Mean OCR confidence over the characters read, 0–1. */
  confidence: number;
  detectionConfidence: number;
  bbox: [number, number, number, number];
  formatValid: boolean;
  corrected: boolean;
}

export interface AnprHealth {
  status: string;
  device: string;
  [key: string]: unknown;
}

export interface AnprClient {
  /** Plates at or above the confidence threshold, de-duplicated by text. Throws if the service is unreachable or errors. */
  detect(jpeg: Buffer): Promise<PlateRead[]>;
  health(): Promise<AnprHealth>;
}

export interface AnprClientOptions {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
  minConfidence?: number;
  fetchImpl?: typeof fetch;
}

interface RawPlate {
  text: string; raw_text: string; confidence: number; detection_confidence: number;
  bbox: [number, number, number, number]; format_valid: boolean; corrected: boolean;
}

export function createAnprClient(opts: AnprClientOptions): AnprClient {
  const base = opts.url.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const minConfidence = opts.minConfidence ?? 0.6;
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...(opts.apiKey ? { 'X-ANPR-Key': opts.apiKey } : {}) });

  return {
    async detect(jpeg) {
      const res = await doFetch(`${base}/v1/anpr`, {
        method: 'POST', headers: headers({ 'Content-Type': 'image/jpeg' }), body: new Uint8Array(jpeg),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`ANPR service responded ${res.status}`);
      const body = (await res.json()) as { plates?: RawPlate[] };
      const best = new Map<string, PlateRead>();
      for (const p of body.plates ?? []) {
        if (!p.text || p.confidence < minConfidence) continue;
        const existing = best.get(p.text);
        if (existing && existing.confidence >= p.confidence) continue;
        best.set(p.text, {
          text: p.text, rawText: p.raw_text, confidence: p.confidence, detectionConfidence: p.detection_confidence,
          bbox: p.bbox, formatValid: p.format_valid, corrected: p.corrected,
        });
      }
      return [...best.values()];
    },
    async health() {
      const res = await doFetch(`${base}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`ANPR service responded ${res.status}`);
      return (await res.json()) as AnprHealth;
    },
  };
}
