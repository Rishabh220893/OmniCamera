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

// A 16x16 grey JPEG: valid image, no plates. Used to test that the service
// accepts our key end to end without running real footage through it.
const PROBE_JPEG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABKAAEAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAEAAQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AAA//2Q==', 'base64');

export interface AnprClient {
  /** Authenticated round trip with a blank image — unlike health(), fails if the API key is wrong. */
  probe(): Promise<void>;
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
  /** Consecutive failed detect() calls after which the service is skipped for `cooldownMs`. */
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
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
  const failureThreshold = opts.failureThreshold ?? 3;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const now = opts.now ?? Date.now;
  // Circuit breaker: if the service is down (e.g. a rented GPU was switched off), every frame would
  // otherwise wait out the full timeout before falling back. After repeated failures, skip it for a
  // while, then let one request through to see whether it has come back.
  let consecutiveFailures = 0;
  let skipUntil = 0;
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...(opts.apiKey ? { 'X-ANPR-Key': opts.apiKey } : {}) });

  async function detectOnce(jpeg: Buffer): Promise<PlateRead[]> {
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
  }

  return {
    async detect(jpeg) {
      if (now() < skipUntil) throw new Error('ANPR service skipped: it failed repeatedly and is in a cool-down');
      try {
        const reads = await detectOnce(jpeg);
        consecutiveFailures = 0;
        return reads;
      } catch (err) {
        if (++consecutiveFailures >= failureThreshold) skipUntil = now() + cooldownMs;
        throw err;
      }
    },
    async probe() {
      const res = await doFetch(`${base}/v1/anpr`, {
        method: 'POST', headers: headers({ 'Content-Type': 'image/jpeg' }), body: new Uint8Array(PROBE_JPEG),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401) throw new Error('ANPR service rejected the API key (ANPR_API_KEY does not match the service)');
      if (!res.ok) throw new Error(`ANPR service responded ${res.status}`);
    },
    async health() {
      const res = await doFetch(`${base}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`ANPR service responded ${res.status}`);
      return (await res.json()) as AnprHealth;
    },
  };
}
