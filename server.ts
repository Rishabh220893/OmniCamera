import express from 'express';
import http from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Firestore } from 'firebase-admin/firestore';
import { extractFrameWithFfmpeg, grabFrame, isSafeCameraUrl } from './server/frameSource';
import { createAnalysisWorker, AnalysisWorker, WorkerCamera } from './server/analysisWorker';
import { createAnprClient, AnprClient } from './server/anprClient';
import { mergePlates } from './server/plateMerge';
import { writeSightings } from './server/sightingStore';

// Dedicated plate detector + OCR service (anpr-service/). Optional: when
// unset, plates are read by Gemini as before.
const anprClient: AnprClient | null = process.env.ANPR_SERVICE_URL
  ? createAnprClient({
      url: process.env.ANPR_SERVICE_URL,
      apiKey: process.env.ANPR_API_KEY,
      timeoutMs: Number(process.env.ANPR_TIMEOUT_MS) || 8_000,
      minConfidence: process.env.ANPR_MIN_CONFIDENCE ? Number(process.env.ANPR_MIN_CONFIDENCE) : 0.6,
    })
  : null;

// A distinctive custom UA on every upstream request to this camera grid
// (fronted by Cloudflare) is a textbook bot-throttling trigger — real
// browsers requesting the same paths don't get the ~30s-per-6s-segment
// throughput this proxy was measured at, and a plain RTSP client bypassing
// Cloudflare's HTTP layer entirely loaded the same camera in ~5s. Blending
// in as an ordinary browser is worth trying before assuming the origin
// itself just can't serve fast enough.
const UPSTREAM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Confirmed Sentinel Camera Grid credentials for cctv.corp8.cloud access
const DEFAULT_STREAM_EMAIL = 'rishabh.bhasin06@gmail.com';
const DEFAULT_STREAM_PASSWORD = '8JY8-D5YX-7WRS';

let aiClient: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

const auth = new google.auth.GoogleAuth({
  credentials: process.env.GOOGLE_SHEETS_CREDENTIALS ? JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS) : undefined,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Central Registry API-based onboarding (Sentinel Mesh Model 1 — mandatory
// foundation). Uses the Admin SDK so trusted external systems can onboard
// cameras server-to-server without a Firebase client session, bypassing the
// per-user Firestore rules by design. Disabled (returns 501) until a
// service account is configured.
let registryDb: Firestore | null = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const app = initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
    registryDb = getFirestore(app);
    console.log('[REGISTRY API] Firebase Admin initialized — API-based onboarding is live.');
  } catch (err) {
    console.error('[REGISTRY API] Failed to initialize Firebase Admin:', err);
  }
}

function requireRegistryAuth(req: express.Request, res: express.Response): boolean {
  if (!registryDb) {
    res.status(501).json({ error: 'Registry API is not configured (missing FIREBASE_SERVICE_ACCOUNT).' });
    return false;
  }
  const expectedKey = process.env.REGISTRY_API_KEY;
  if (expectedKey && req.header('X-Registry-Api-Key') !== expectedKey) {
    res.status(401).json({ error: 'Missing or invalid X-Registry-Api-Key header.' });
    return false;
  }
  return true;
}

// Gemini model fallback chain — the newest/preview model gives the best
// results but is also the one most likely to return 503 "high demand"
// under load. On a retryable error, fall through to the next model rather
// than failing the whole analysis cycle. Google retires model IDs over
// time (gemini-2.5-flash and gemini-2.0-flash are no longer available to
// new projects as of this writing — its own 404 response names the
// current replacement), so this list is deliberately short and should be
// updated from that error message if it goes stale again rather than
// guessing at names.
const VISION_MODELS = ['gemini-3-flash-preview', 'gemini-3.6-flash'];
const CHAT_MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash'];

function isRetryableGeminiError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Capacity/transient errors, and "model no longer exists" (404/NOT_FOUND)
  // — both are reasons to try the *next* model, not to fail outright.
  return /"code":\s*(404|429|500|502|503|504)|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|NOT_FOUND|GEMINI_TIMEOUT/i.test(message);
}

const GEMINI_TIMEOUT_MS = 25_000;

// Without this, a stalled call to a given model just hangs forever — the
// client's fetch has no timeout of its own, so isAnalyzing never clears and
// the capture loop stops producing any new summary/alerts until the tab is
// reloaded. Racing a timeout turns that into a fast, retryable failure that
// falls through to the next model instead.
function withGeminiTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GEMINI_TIMEOUT: no response after ${GEMINI_TIMEOUT_MS}ms`)), GEMINI_TIMEOUT_MS);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

async function generateContentWithFallback(
  models: string[],
  params: Omit<Parameters<ReturnType<typeof getAI>['models']['generateContent']>[0], 'model'>
) {
  const ai = getAI();
  let lastError: unknown;
  for (const model of models) {
    try {
      return await withGeminiTimeout(ai.models.generateContent({ ...params, model }));
    } catch (err: unknown) {
      lastError = err;
      if (!isRetryableGeminiError(err)) throw err;
      console.warn(`[GEMINI] Model "${model}" unavailable, falling back to next model:`, err instanceof Error ? err.message : err);
    }
  }
  throw lastError;
}

// Every upstream fetch to a camera CDN below routes through this instead of
// calling fetch() directly. Without a timeout, one dead/slow camera hangs
// its request indefinitely — and since browsers cap concurrent connections
// per origin at ~6, one stuck request occupies a slot that every other
// camera queued behind this proxy is waiting on, so the whole grid stalls
// behind a single bad camera. A short timeout plus a couple of retries
// turns that into "this one camera fails fast" instead.
async function fetchUpstream(url: string, options: RequestInit = {}, { timeoutMs = 20_000, retries = 1 }: { timeoutMs?: number; retries?: number } = {}): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function writeRegistryAudit(
  db: Firestore,
  entry: { cameraId: string; cameraName: string; action: 'create' | 'update' | 'delete'; source: 'api'; userId: string }
) {
  await db.collection('registryAudit').add({
    ...entry,
    performedBy: 'registry-api',
    timestamp: FieldValue.serverTimestamp(),
  });
}

interface FrameAnalysisInput {
  imageBase64: string;
  knownFaces?: Array<{ name: string; imageData: string }>;
  watchlist?: string[];
  camera?: {
    name?: string;
    sensitivity?: number;
    peopleThreshold?: number;
    vehicleThreshold?: number;
    suspiciousRules?: string;
  };
}

// Shared by the browser-driven /api/gemini/analyze-frame route and the
// server-side analysis worker, so both produce identical results.
async function analyzeFrame({ imageBase64, knownFaces, watchlist, camera }: FrameAnalysisInput) {
  const faces = (knownFaces || []).slice(0, 6);
  const faceDataParts = faces.map((face) => ({
    inlineData: {
      mimeType: 'image/jpeg',
      data: face.imageData.includes(',') ? face.imageData.split(',')[1] : face.imageData,
    },
  }));

  const knownFacesContext = faces.length > 0
    ? `\nREFERENCE DATA: I have provided ${faceDataParts.length} images of known people as reference.
       Their names are: ${faces.map((f) => f.name).join(', ')}.
       If you see a person in the MAIN FEED FRAME, compare them visually to these reference images.
       - If they match a reference image, identify them by that name.
       - If they do NOT match any reference image, label them as "Unknown Person".`
    : '';

  console.log(`[GEMINI VISION] Analyzing frame for camera: "${camera?.name ?? 'Unknown'}"`);

  // Plate reading goes to the dedicated ANPR service in parallel with the
  // Gemini call; a failure there must never fail the whole analysis.
  const anprPromise = anprClient
    ? anprClient.detect(Buffer.from(imageBase64, 'base64')).then((reads) => ({ reads })).catch((error: unknown) => {
        console.warn(`[ANPR] Service call failed, falling back to Gemini plates:`, error instanceof Error ? error.message : error);
        return { error };
      })
    : Promise.resolve(null);

  const response = await generateContentWithFallback(VISION_MODELS, {
    contents: {
      parts: [
        { text: 'KNOWN INDIVIDUALS REFERENCE IMAGES (If provided):' },
        ...faceDataParts,
        { text: 'MAIN CAMERA FEED FRAME TO ANALYZE:' },
        { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
        {
          text: `Act as a security AI monitoring a camera feed.
          Objective: Provide a real-time summary, count objects, identify people, and detect brands.

          Current System Configuration:
          - Camera Name: ${camera?.name ?? 'Unknown'}
          - Anomaly Sensitivity: ${camera?.sensitivity ?? 5}/10
          - People count (informational, for the trend chart only — NOT grounds for an alert on its own): ${camera?.peopleThreshold ?? 5}
          - Vehicle count (informational, for the trend chart only — NOT grounds for an alert on its own): ${camera?.vehicleThreshold ?? 2}
          ${camera?.suspiciousRules ? `- CUSTOM SUSPICIOUS RULES: ${camera.suspiciousRules}` : ''}
          ${knownFacesContext}

          Tasks:
          1. A brief summary of events. IMPORTANT: Mention identified people by their names in the summary.
          2. Count people, vehicles, and notable objects.
          3. Identify any visible brands on products, clothing, or environment.
          4. Check for genuinely malicious, harmful, or suspicious activity — weapons, forced entry,
             vandalism, trespassing, loitering with intent, an unknown person behaving suspiciously, or
             anything matching the custom suspicious rules above. A busy or crowded scene is NOT by
             itself unusual — do not flag isUnusual or write an alert merely because a lot of people or
             vehicles are present. Only raise isUnusual/alerts for content that would actually warrant a
             human operator's attention for security reasons.
          5. Read any vehicle license/number plates that are legible in the frame.
          6. Rate the overall mood/threat level of the scene as one of: "calm" (ordinary, nothing of
             note), "neutral" (unremarkable activity), "tense" (something worth watching but not yet
             alarming), "critical" (matches an alert-worthy situation from task 4).

          Output MUST be strict JSON:
          {
            "summary": "Short 1-sentence summary mentioning names if identified",
            "counts": { "people": number, "vehicles": number, "other": number },
            "brands": ["List of identified brands"],
            "people_identified": ["Names of identified known members or 'Unknown Person'"],
            "alerts": ["List of specific malicious/harmful/suspicious warnings only — do NOT include plain crowd/traffic-count observations here"],
            "isUnusual": boolean,
            "isUnusualReason": "Explain WHY it was marked unusual — must be a malicious/harmful/suspicious reason, never just a headcount",
            "detected_plates": ["Any legible vehicle plate numbers, uppercase, no spaces"],
            "sentiment": "calm" | "neutral" | "tense" | "critical"
          }`,
        },
      ],
    },
    config: { responseMimeType: 'application/json' },
  });

  const responseText = response.text || '{}';
  const data = JSON.parse(responseText) as { detected_plates?: string[]; [key: string]: unknown };

  // Tier-1 stand-in: match detected plates against the caller's watchlist
  // server-side, so the client never has to trust its own comparison.
  const merged = mergePlates((data.detected_plates || []).map(String), await anprPromise);
  const detectedPlates = merged.plates;
  const watchlistSet = new Set((watchlist || []).map((p) => String(p).toUpperCase().replace(/[^A-Z0-9]/g, '')));
  const watchlistMatches = detectedPlates.filter((p) => watchlistSet.has(p));

  if (watchlistMatches.length > 0) {
    console.warn(`[WATCHLIST MATCH] Camera "${camera?.name ?? 'Unknown'}" — plates: ${watchlistMatches.join(', ')} (source: ${merged.source})`);
  }

  return { ...data, detected_plates: detectedPlates, watchlistMatches, plate_reads: merged.reads, plate_source: merged.source };
}

async function startServer() {
  const app = express();
  // Port 3000 is the hardcoded entry point for AI Studio proxy
  const PORT = 3000;

  // Default 100kb limit is far too small: a captured frame plus up to 6
  // base64-encoded known-face reference images easily runs several MB.
  app.use(express.json({ limit: '25mb' }));

  // API routes
  app.post('/api/alerts', (req, res) => {
    const { alert, timestamp } = req.body;
    console.log(`[SECURITY INTEGRATION] Alert Received at ${timestamp}:`, alert);
    res.status(200).json({ status: 'received', integration: 'mock_security_v1' });
  });

  app.post('/api/proxy-webhook', async (req, res) => {
    const { url, payload } = req.body;
    if (!url) {
      return res.status(400).json({ error: "url is required" });
    }

    try {
      console.log(`[PROXY WEBHOOK] Relay payload to: ${url}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UPSTREAM_USER_AGENT
        },
        body: JSON.stringify(payload)
      });

      const text = await response.text();
      res.status(200).json({
        success: response.ok,
        status: response.status,
        responseText: text
      });
    } catch (err: unknown) {
      console.error("[PROXY WEBHOOK] Dispatch failed:", err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Failed to dispatch webhook'
      });
    }
  });

  app.get('/api/proxy-frame', async (req, res) => {
    const targetUrl = req.query.url as string;
    if (!targetUrl) {
      res.status(400).send("Parameter 'url' is required");
      return;
    }

    try {
      console.log(`[PROXY FRAME] Fetching from: ${targetUrl}`);
      const response = await fetchUpstream(targetUrl, {
        method: 'GET',
        headers: {
          'ngrok-skip-browser-warning': 'true',
          'User-Agent': UPSTREAM_USER_AGENT
        }
      });

      if (!response.ok) {
        let errMsg = `Failed to fetch remote frame. Status: ${response.status}`;
        try {
          const bodyText = await response.text();
          if (bodyText) {
            errMsg += ` - ${bodyText.slice(0, 150)}`;
          }
        } catch {
          // ignore
        }
        if (response.status === 500) {
          errMsg += " [Hint: go2rtc returned 500. Ensure the 'src' parameter in your URL is correct, your RTSP source is online, and there are no connection timeouts in go2rtc]";
        }
        throw new Error(errMsg);
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.status(200).send(buffer);
    } catch (err: unknown) {
      console.warn("[PROXY FRAME] Error proxying frame:", err instanceof Error ? err.message : String(err));
      res.status(502).send(err instanceof Error ? err.message : 'Error retrieving remote frame');
    }
  });

  // Some camera CDNs (confirmed against the corp8.cloud grid) gate access
  // with a plain server-rendered login form (POST /auth/login, field name
  // "password") rather than a header/query-param scheme, setting a
  // long-lived session cookie on success.
  // CRITICAL: Upstream strictly enforces ONE SESSION PER IP.
  // Multiple concurrent logins or uncoordinated requests will invalidate the
  // active session and return "403: one session per IP".
  // We use a singleton promise mutex per host to serialize logins and share
  // the resulting valid session cookie across all camera feeds.
  const sessionCookieCache = new Map<string, string>();
  const activeLoginPromises = new Map<string, Promise<string | null>>();
  const manifestCache = new Map<string, { content: string; cachedAt: number }>();

  async function loginForSessionCookie(targetUrl: string, password: string, email?: string, forceFresh = false): Promise<string | null> {
    const host = new URL(targetUrl).host;
    const cacheKey = `${host}|${email || ''}|${password}`;
    
    if (!forceFresh && sessionCookieCache.has(cacheKey)) {
      return sessionCookieCache.get(cacheKey)!;
    }

    if (activeLoginPromises.has(cacheKey)) {
      return activeLoginPromises.get(cacheKey)!;
    }

    const promise = (async () => {
      try {
        const oldCookie = sessionCookieCache.get(cacheKey);
        sessionCookieCache.delete(cacheKey);

        // If replacing an existing session or force-fresh, notify upstream logout first
        // so it clears its single-session-per-IP lock before we establish a new one.
        if (oldCookie || forceFresh) {
          try {
            const logoutUrl = new URL('/auth/logout', targetUrl).toString();
            await fetchUpstream(logoutUrl, {
              method: 'GET',
              headers: {
                'User-Agent': UPSTREAM_USER_AGENT,
                ...(oldCookie ? { 'Cookie': oldCookie } : {})
              },
              redirect: 'manual'
            }, { timeoutMs: 5_000, retries: 0 });
          } catch {}
          // Short backoff to allow upstream Redis/session store to settle
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        const loginUrl = new URL('/auth/login', targetUrl).toString();
        const body = email
          ? `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`
          : `password=${encodeURIComponent(password)}`;

        const res = await fetchUpstream(loginUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': UPSTREAM_USER_AGENT,
            'Referer': new URL('/', targetUrl).toString()
          },
          body,
          redirect: 'manual',
        }, { timeoutMs: 12_000, retries: 0 });

        const setCookie = res.headers.get('set-cookie');
        const match = setCookie?.match(/([a-zA-Z0-9_]+=[^;]+)/);
        if (match) {
          sessionCookieCache.set(cacheKey, match[1]);
          console.log(`[PROXY HLS] Successfully authenticated new session on ${host}`);
          return match[1];
        } else {
          console.warn(`[PROXY HLS] Login responded with status ${res.status} but no set-cookie header was found`);
        }
      } catch (err) {
        console.warn('[PROXY HLS] Session login failed or timed out:', err instanceof Error ? err.message : String(err));
      } finally {
        activeLoginPromises.delete(cacheKey);
      }
      return null;
    })();

    activeLoginPromises.set(cacheKey, promise);
    return promise;
  }

  // HLS proxy — CORS is a browser-enforced policy, so a cross-origin camera
  // CDN that doesn't send Access-Control-Allow-Origin blocks hls.js (and
  // even a plain <video> load) outright, before any app code runs. Fetching
  // server-to-server sidesteps that entirely, and lets the access password
  // be forwarded without the browser ever seeing the upstream exchange.
  // Manifests are rewritten so every segment/key URI also routes back
  // through this proxy, carrying the same auth.
  app.get('/api/proxy-hls', async (req, res) => {
    const targetUrl = req.query.url as string;
    const password = (req.header('X-Stream-Password') || (req.query.password as string | undefined)) || process.env.STREAM_PASSWORD || DEFAULT_STREAM_PASSWORD;
    const email = (req.header('X-Stream-Email') || (req.query.email as string | undefined)) || process.env.STREAM_EMAIL || DEFAULT_STREAM_EMAIL;
    if (!targetUrl) {
      res.status(400).send("Parameter 'url' is required");
      return;
    }

    const isManifest = targetUrl.toLowerCase().includes('.m3u8');
    const isKeyFile = /\.key(\?|$)/i.test(targetUrl);
    const isTsSegment = /\.ts(\?|$)/i.test(targetUrl);

    // If this is a manifest and we have a cached version that is under 5 minutes old, serve immediately!
    const manifestCacheKey = `${targetUrl}|${email || ''}|${password || ''}`;
    if (isManifest && manifestCache.has(manifestCacheKey)) {
      const cached = manifestCache.get(manifestCacheKey)!;
      if (Date.now() - cached.cachedAt < 300_000) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Cache', 'HIT');
        res.status(200).send(cached.content);
        return;
      }
    }

    try {
      const buildHeaders = (cookie?: string | null): Record<string, string> => {
        const headers: Record<string, string> = {
          'User-Agent': UPSTREAM_USER_AGENT,
          'Referer': new URL('/', targetUrl).toString()
        };
        if (password) headers['Authorization'] = 'Basic ' + Buffer.from(`${email || ''}:${password}`).toString('base64');
        if (cookie) headers['Cookie'] = cookie;
        return headers;
      };

      const fetchOpts = { timeoutMs: 35_000, retries: 0 };
      const cacheKey = password ? `${new URL(targetUrl).host}|${email || ''}|${password}` : null;

      let upstream: Response;
      if (password && cacheKey) {
        let cachedCookie = await loginForSessionCookie(targetUrl, password, email);
        upstream = await fetchUpstream(targetUrl, { headers: buildHeaders(cachedCookie), redirect: 'manual' }, fetchOpts);

        const upstreamBodyPreview = (!upstream.ok) ? await upstream.clone().text().catch(() => '') : '';
        const isAuthOrSessionError = (upstream.status >= 300 && upstream.status < 400) ||
          upstream.status === 401 ||
          (upstream.status === 403 && /one session per IP|browser required/i.test(upstreamBodyPreview));

        if (isAuthOrSessionError) {
          console.warn(`[PROXY HLS] Upstream session invalid (${upstream.status}: ${upstreamBodyPreview.slice(0, 80)}). Re-authenticating...`);
          const freshCookie = await loginForSessionCookie(targetUrl, password, email, true);
          upstream = await fetchUpstream(targetUrl, { headers: buildHeaders(freshCookie), redirect: 'manual' }, fetchOpts);
        }
      } else {
        upstream = await fetchUpstream(targetUrl, { headers: buildHeaders(), redirect: 'manual' }, fetchOpts);
      }

      if (!upstream.ok) {
        const bodyText = await upstream.text().catch(() => '');
        console.warn(`[PROXY HLS] Upstream rejected ${targetUrl} -> ${upstream.status} ${upstream.statusText}. Body: ${bodyText.slice(0, 200)}`);
        res.status(upstream.status >= 300 && upstream.status < 400 ? 401 : upstream.status).send(
          upstream.status >= 300 && upstream.status < 400
            ? 'Upstream redirected to a login page — the stream access password was rejected.'
            : `Upstream error ${upstream.status}${bodyText ? ': ' + bodyText.slice(0, 200) : ''}`
        );
        return;
      }

      if (isManifest) {
        const text = await upstream.text();
        if (!text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) {
          if (cacheKey) sessionCookieCache.delete(cacheKey);
          console.warn(`[PROXY HLS] Upstream returned non-manifest for ${targetUrl}: ${text.slice(0, 200)}`);
          res.status(502).send('Upstream returned a 2xx status but the response was not a valid HLS manifest.');
          return;
        }
        const cleanText = text.replace(/^\uFEFF/, '');
        const baseUrl = new URL(targetUrl);
        const passwordQuery = password ? `&password=${encodeURIComponent(password)}` : '';
        const emailQuery = email ? `&email=${encodeURIComponent(email)}` : '';
        const proxyLine = (uri: string) => `/api/proxy-hls?url=${encodeURIComponent(new URL(uri, baseUrl).toString())}${passwordQuery}${emailQuery}`;

        const rewritten = cleanText.split('\n').map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith('#')) {
            return trimmed.replace(/URI="([^"]+)"/, (_m, uri) => `URI="${proxyLine(uri)}"`);
          }
          return proxyLine(trimmed);
        }).join('\n');

        manifestCache.set(manifestCacheKey, { content: rewritten, cachedAt: Date.now() });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.status(200).send(rewritten);
      } else {
        const contentType = upstream.headers.get('content-type') || 'video/mp2t';
        if (!isKeyFile && /text\/html|text\/plain/i.test(contentType)) {
          if (cacheKey) sessionCookieCache.delete(cacheKey);
          const bodyText = await upstream.text().catch(() => '');
          console.warn(`[PROXY HLS] Segment returned text/html for ${targetUrl}: ${bodyText.slice(0, 200)}`);
          res.status(502).send('Upstream returned HTML/text instead of media segment.');
          return;
        }
        const arrayBuffer = await upstream.arrayBuffer();
        if (!isKeyFile && arrayBuffer.byteLength < 500) {
          if (cacheKey) sessionCookieCache.delete(cacheKey);
          res.status(502).send(`Segment body was only ${arrayBuffer.byteLength} bytes.`);
          return;
        }

        // Correct MIME types so browsers and hls.js never reject playback
        const finalContentType = isKeyFile
          ? 'application/octet-stream'
          : isTsSegment
            ? 'video/mp2t'
            : contentType;

        res.setHeader('Content-Type', finalContentType);
        res.setHeader('Cache-Control', isTsSegment || isKeyFile ? 'public, max-age=300' : 'no-store');
        res.status(200).send(Buffer.from(arrayBuffer));
      }
    } catch (err: unknown) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || /aborted due to timeout/i.test(err.message));
      console.warn(`[PROXY HLS] ${isTimeout ? 'Upstream request timed out' : 'Upstream proxy error'} for ${targetUrl}:`, err instanceof Error ? err.message : String(err));
      res.status(isTimeout ? 504 : 502).send(err instanceof Error ? err.message : 'Error proxying HLS resource');
    }
  });

  // Fast server-side snapshot endpoint: extracts a single still JPEG frame
  // Uses direct RTSP over TCP (1-3s) for grid cameras, falling back to HLS with cache.
  const snapshotCache = new Map<string, { buffer: Buffer; timestamp: number }>();
  app.get('/api/camera-snapshot', async (req, res) => {
    const targetUrl = (req.query.url as string) || '';
    const camIdParam = (req.query.camId as string) || '';
    const extractedCamId = camIdParam || (targetUrl.match(/\/(cam\d+)/i)?.[1] ?? '');
    
    if (!targetUrl && !extractedCamId) {
      res.status(400).send("Parameter 'url' or 'camId' is required");
      return;
    }
    const password = (req.header('X-Stream-Password') || (req.query.password as string | undefined)) || process.env.STREAM_PASSWORD || DEFAULT_STREAM_PASSWORD;
    const email = (req.header('X-Stream-Email') || (req.query.email as string | undefined)) || process.env.STREAM_EMAIL || DEFAULT_STREAM_EMAIL;

    const cacheKey = `${extractedCamId || targetUrl}|${email}|${password}`;
    const cached = snapshotCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < 15_000) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=10');
      res.status(200).send(cached.buffer);
      return;
    }

    const extractFromUrl = extractFrameWithFfmpeg;

    try {
      let frameBuffer: Buffer | null = null;

      // Try ultra-fast direct RTSP first if we have a camId
      if (extractedCamId) {
        const encodedEmail = encodeURIComponent(email).replace(/@/g, '%40');
        const encodedPassword = encodeURIComponent(password);
        const rtspUrl = `rtsp://${encodedEmail}:${encodedPassword}@103.250.160.189:8554/stream/${extractedCamId.toLowerCase()}`;
        frameBuffer = await extractFromUrl(rtspUrl, true, 7_000);
      }

      // If RTSP didn't yield a frame or no camId, fall back to proxied HLS
      if (!frameBuffer && targetUrl) {
        const localProxyUrl = `http://localhost:${PORT}/api/proxy-hls?url=${encodeURIComponent(targetUrl)}&password=${encodeURIComponent(password)}&email=${encodeURIComponent(email)}`;
        frameBuffer = await extractFromUrl(localProxyUrl, false, 15_000);
      }

      if (frameBuffer && frameBuffer.length > 500) {
        snapshotCache.set(cacheKey, { buffer: frameBuffer, timestamp: Date.now() });
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=10');
        res.status(200).send(frameBuffer);
      } else {
        res.status(502).send('Failed to extract snapshot frame from camera stream');
      }
    } catch (err: unknown) {
      res.status(500).send(err instanceof Error ? err.message : 'Snapshot extraction failed');
    }
  });

  // WHEP (WebRTC) signaling proxy — the grid's raw origin (bypassing
  // Cloudflare/corp8.cloud entirely) runs MediaMTX and serves each camera at
  // http://103.250.160.189:8889/stream/<camId>/whep. Confirmed directly: an
  // RTSP client hitting 103.250.160.189:8554 loaded a camera in ~5s while
  // the same camera through the Cloudflare-fronted HLS path was taking
  // 20-45s even for a 16-byte key file — a fixed per-request penalty
  // Cloudflare applies regardless of resource size, which no User-Agent
  // change can fix since its bot scoring weighs TLS fingerprint/IP
  // reputation far more than headers. WHEP is the same bypass, but
  // browser-playable (native RTCPeerConnection, no ffmpeg needed).
  //
  // This proxy only relays the SDP signaling handshake, not media: the
  // actual audio/video flows directly between the browser and the origin
  // over WebRTC (ICE/DTLS/SRTP), which isn't subject to mixed-content
  // blocking. The signaling POST/DELETE themselves ARE plain http:// and
  // WOULD be blocked as mixed content if the browser called them directly
  // from our https:// page — hence proxying just that exchange server-side.
  const SENTINEL_GRID_HOST = '103.250.160.189';
  const WHEP_ORIGIN = `http://${SENTINEL_GRID_HOST}:8889`;
  // Was /^cam\d{1,3}$/ — too narrow once camera ids started coming from the
  // live catalogue (/api/sentinel-catalogue) instead of only the old
  // hardcoded "camNN" scheme; the catalogue's real id format isn't
  // something this code has been able to observe directly. Widened to
  // "alphanumeric plus dash/underscore, reasonable length" — permissive
  // enough for an id in any plausible scheme, still tight enough to block
  // path traversal or header/URL injection through this query param.
  const CAM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

  app.post('/api/whep-proxy', express.text({ type: 'application/sdp', limit: '256kb' }), async (req, res) => {
    const camId = req.query.camId as string;
    if (!camId || !CAM_ID_RE.test(camId)) {
      res.status(400).send("Parameter 'camId' must look like camNN");
      return;
    }
    if (typeof req.body !== 'string' || !req.body.trim()) {
      res.status(400).send('Request body must be an SDP offer (Content-Type: application/sdp)');
      return;
    }
    // Per the grid's integrator guide: RTSP/WHEP on the raw origin now
    // authenticate every connection with the caller's *registered email*
    // and access password, embedded in the URL as
    // rtsp://email:password@host:port/... — i.e. HTTP Basic auth with the
    // email as username, not an empty one. An earlier fix here guessed
    // empty-username Basic auth (reusing the HLS path's password-only
    // scheme) since that was the only precedent available at the time —
    // confirmed wrong once the actual guide was obtained. Only attaches
    // auth when both are present: a partial credential (email with no
    // password, or vice versa) is guaranteed-wrong per the documented
    // format, so sending nothing is more honest than sending that.
    const email = (req.header('X-Stream-Email') || (req.query.email as string | undefined) || process.env.STREAM_EMAIL || DEFAULT_STREAM_EMAIL).trim();
    const password = (req.header('X-Stream-Password') || (req.query.password as string | undefined) || process.env.STREAM_PASSWORD || DEFAULT_STREAM_PASSWORD).trim();
    const upstreamHeaders: Record<string, string> = { 'Content-Type': 'application/sdp' };
    if (email && password) upstreamHeaders['Authorization'] = 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64');

    try {
      const upstream = await fetchUpstream(`${WHEP_ORIGIN}/stream/${camId}/whep`, {
        method: 'POST',
        headers: upstreamHeaders,
        body: req.body,
      }, { timeoutMs: 15_000, retries: 0 });

      const answer = await upstream.text();
      if (!upstream.ok) {
        const isAuthError = upstream.status === 401 || upstream.status === 403;
        if (isAuthError) {
          console.info(`[WHEP PROXY] Upstream camera auth rejected for camId=${camId} -> ${upstream.status} (${email && password ? 'credentials sent' : 'no credentials sent'}). Body: ${answer.slice(0, 300)}`);
          const wwwAuth = upstream.headers.get('www-authenticate');
          if (wwwAuth) res.setHeader('WWW-Authenticate', wwwAuth);
        } else {
          console.warn(`[WHEP PROXY] Upstream rejected camId=${camId} -> ${upstream.status} (${email && password ? 'credentials sent' : 'no credentials sent'}). Body: ${answer.slice(0, 300)}`);
        }
        res.status(upstream.status).send(answer);
        return;
      }

      // MediaMTX answers with a Location header identifying this session's
      // resource (for later PATCH/DELETE) — usually a path relative to this
      // same origin. Resolve it to an absolute URL now so the client doesn't
      // need to know the upstream host, and hand it back as an opaque token
      // it can round-trip to the DELETE route below for cleanup.
      const location = upstream.headers.get('location');
      const resourceUrl = location ? new URL(location, WHEP_ORIGIN).toString() : null;
      if (resourceUrl) res.setHeader('X-Whep-Resource', encodeURIComponent(resourceUrl));
      res.setHeader('Content-Type', 'application/sdp');
      res.status(201).send(answer);
    } catch (err: unknown) {
      console.warn('[WHEP PROXY] Error negotiating session:', err instanceof Error ? err.message : String(err));
      res.status(502).send(err instanceof Error ? err.message : 'Error negotiating WHEP session');
    }
  });

  app.delete('/api/whep-proxy', async (req, res) => {
    const resourceParam = req.query.resource as string;
    if (!resourceParam) { res.status(204).end(); return; }
    try {
      const resourceUrl = new URL(decodeURIComponent(resourceParam));
      // Only ever forward this to the known camera grid origin — the token
      // round-trips through the client, so this guards against it being
      // tampered with into an SSRF vector against an arbitrary host.
      if (resourceUrl.origin !== WHEP_ORIGIN) {
        res.status(400).send('Invalid resource');
        return;
      }
      await fetchUpstream(resourceUrl.toString(), { method: 'DELETE' }, { timeoutMs: 8_000, retries: 0 });
    } catch (err) {
      // Best-effort cleanup — the origin will also time out an abandoned
      // session on its own once ICE disconnects, so a failure here isn't
      // fatal to anything.
      console.warn('[WHEP PROXY] Session cleanup failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
    res.status(204).end();
  });

  const FALLBACK_DEMO_CATALOGUE = [
    { id: 'cam01', name: '01 Chiman bhai Bridge', live: true },
    { id: 'cam02', name: '02 Janpath', live: true },
    { id: 'cam03', name: '03 O.N.G.C. Office', live: true },
    { id: 'cam04', name: '04 Paldi Circle', live: true },
    { id: 'cam05', name: '05 Visat teen Rasta', live: true },
    { id: 'cam06', name: '06 Timbavadi gate-Junagadh', live: true },
    { id: 'cam07', name: '07 hero-showroom-gir-somnath', live: true },
    { id: 'cam08', name: '08 majewadi-gate-junagadh', live: true },
    { id: 'cam09', name: '09 new-bypass-near-by-circle-junagadh-2', live: true },
    { id: 'cam10', name: '10 char-chowk-road-2-junagadh', live: true },
    { id: 'cam11', name: '11 dolatpara-junagadh', live: true },
    { id: 'cam12', name: '12 Tri Mandir Adalaj Tollnaka', live: true },
    { id: 'cam13', name: '13 CN Vidhyalaya', live: true },
    { id: 'cam14', name: '14 Delight RLVD', live: true },
    { id: 'cam15', name: '15 Suvidha park', live: true },
    { id: 'cam16', name: '16 Visat P2', live: true },
    { id: 'cam17', name: '17 Rajkot Bus Port CCTV', live: true },
    { id: 'cam18', name: '18 Rajkot CCTV', live: true },
    { id: 'cam19', name: '19 KHAPARIA GRAM PANCHAYAT , TALUKA GANDEVI, DISTRICT NAVSARI', live: true },
    { id: 'cam20', name: '20 Mohanpura', live: true },
    { id: 'cam21', name: '23 Patan Dethali Char Rasta', live: true },
    { id: 'cam22', name: '28 BK Mervada tran Rasta', live: true },
    { id: 'cam23', name: '30 kheram', live: true },
    { id: 'cam24', name: '33 dehgam', live: true },
    { id: 'cam25', name: '34 dhanori', live: true },
    { id: 'cam26', name: '35 TANKAL', live: true },
    { id: 'cam27', name: '36 bilimora', live: true },
    { id: 'cam28', name: '37 bilimora', live: true },
    { id: 'cam29', name: '38 bilimora', live: true },
    { id: 'cam30', name: 'Gandhidham Rambaugh p2', live: true },
  ];

  // The grid's own integrator guide: "Start from the catalogue rather than
  // hard-coding endpoints... camera ids and the set of available cameras
  // can change; the catalogue is the contract, the URL pattern is not."
  // It also carries each camera's own live status — reported failures for
  // a camera the origin itself already lists as down are expected, not a
  // proxy bug, and this is the only way to tell the difference.
  app.get('/api/camera-catalogue', async (req, res) => {
    const targetHost = req.query.host as string;
    const password = (req.header('X-Stream-Password') || (req.query.password as string | undefined)) || process.env.STREAM_PASSWORD || DEFAULT_STREAM_PASSWORD;
    const email = (req.header('X-Stream-Email') || (req.query.email as string | undefined)) || process.env.STREAM_EMAIL || DEFAULT_STREAM_EMAIL;
    if (!targetHost) {
      res.status(400).send("Parameter 'host' is required");
      return;
    }

    try {
      const base = `https://${targetHost}`;
      const buildHeaders = (cookie?: string | null): Record<string, string> => {
        const headers: Record<string, string> = { 'User-Agent': UPSTREAM_USER_AGENT };
        if (password) headers['Authorization'] = 'Basic ' + Buffer.from(`${email || ''}:${password}`).toString('base64');
        if (cookie) headers['Cookie'] = cookie;
        return headers;
      };

      const cacheKey = password ? `${targetHost}|${email || ''}|${password}` : null;
      const fetchCatalogue = async (path: string, forceFreshLogin = false) => {
        const cookie = password
          ? (forceFreshLogin ? null : sessionCookieCache.get(cacheKey!)) || (await loginForSessionCookie(`${base}${path}`, password, email))
          : null;
        return fetchUpstream(`${base}${path}`, { headers: buildHeaders(cookie), redirect: 'manual' }, { timeoutMs: 20_000, retries: 0 });
      };

      let upstream = await fetchCatalogue('/cameras.json');
      // A direct 401 (stale cached cookie, or loginForSessionCookie having
      // silently failed and left no cookie at all) or a 3xx redirect to a
      // login page both mean the session was invalid — retry once with a
      // guaranteed-fresh login before giving up. Same fix already applied
      // to /api/proxy-hls after a HAR showed exactly this failure mode
      // (401 on every request despite a correct password) — this route had
      // the identical gap, just never hit until the catalogue was actually
      // wired up to the right host.
      if (password && (upstream.status === 401 || (upstream.status >= 300 && upstream.status < 400))) {
        if (cacheKey) sessionCookieCache.delete(cacheKey);
        upstream = await fetchCatalogue('/cameras.json', true);
      }
      // Two documented names for the same idea across the two guide
      // revisions we were given (/api/ingest, cameras.json) — only falls
      // back to the generic one on an actual 404, not an auth failure
      // (which the retry above already handles).
      if (upstream.status === 404) upstream = await fetchCatalogue('/api/ingest');

      if (!upstream.ok) {
        console.warn(`[CAMERA CATALOGUE] Upstream returned status ${upstream.status}, serving bundled fallback catalogue`);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Catalogue-Source', 'bundled-fallback');
        res.status(200).json(FALLBACK_DEMO_CATALOGUE);
        return;
      }

      const data = await upstream.text();
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(data);
    } catch (err: unknown) {
      console.warn('[CAMERA CATALOGUE] Upstream fetch failed, serving bundled fallback catalogue:', err);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Catalogue-Source', 'bundled-fallback');
      res.status(200).json(FALLBACK_DEMO_CATALOGUE);
    }
  });

  app.post('/api/sheets/append', async (req, res) => {
    try {
      const { cameraName, summary, timestamp, counts } = req.body;
      const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

      if (!spreadsheetId || !process.env.GOOGLE_SHEETS_CREDENTIALS) {
        return res.status(501).json({ error: 'Google Sheets not configured' });
      }

      const sheets = google.sheets({ version: 'v4', auth });
      
      // Ensure a sheet exists for this camera
      const sheetName = cameraName.replace(/[^a-zA-Z0-9]/g, '_');
      
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${sheetName}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[timestamp, summary, counts.people, counts.vehicles, counts.other]],
          },
        });
      } catch (appendError: unknown) {
        // If sheet doesn't exist, create it (this is a bit more complex, simplified for now)
        // Just append to Main if target sheet fails
        console.warn(`Fallback append for ${sheetName}:`, appendError);
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: 'A1',
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[timestamp, cameraName, summary, counts.people, counts.vehicles, counts.other]],
          },
        });
      }

      res.status(200).json({ status: 'ok' });
    } catch (error) {
      console.error('Sheets append error:', error);
      res.status(500).json({ error: 'Failed to append to sheet' });
    }
  });

  // ---- Registry API (Model 1 — API-based camera onboarding) ----
  app.get('/api/registry/cameras', async (req, res) => {
    if (!requireRegistryAuth(req, res)) return;
    const userId = req.query.userId as string;
    if (!userId) return res.status(400).json({ error: "Query param 'userId' is required" });
    try {
      const snapshot = await registryDb!.collection('cameras').where('userId', '==', userId).get();
      res.status(200).json({ cameras: snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list cameras' });
    }
  });

  app.post('/api/registry/cameras', async (req, res) => {
    if (!requireRegistryAuth(req, res)) return;
    const { userId, name, ...fields } = req.body as { userId?: string; name?: string; [key: string]: unknown };
    if (!userId || !name) return res.status(400).json({ error: "'userId' and 'name' are required" });
    try {
      const docRef = await registryDb!.collection('cameras').add({
        userId, name, ...fields, onboardedVia: 'api',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await writeRegistryAudit(registryDb!, { cameraId: docRef.id, cameraName: name, action: 'create', source: 'api', userId });
      res.status(201).json({ id: docRef.id });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create camera' });
    }
  });

  app.patch('/api/registry/cameras/:id', async (req, res) => {
    if (!requireRegistryAuth(req, res)) return;
    const { userId, ...updates } = req.body as { userId?: string; [key: string]: unknown };
    if (!userId) return res.status(400).json({ error: "'userId' is required" });
    try {
      const ref = registryDb!.collection('cameras').doc(req.params.id);
      const existing = await ref.get();
      if (!existing.exists || existing.data()?.userId !== userId) return res.status(404).json({ error: 'Camera not found for this userId' });
      await ref.update({ ...updates, updatedAt: FieldValue.serverTimestamp() });
      await writeRegistryAudit(registryDb!, { cameraId: ref.id, cameraName: (updates.name as string) || existing.data()?.name || ref.id, action: 'update', source: 'api', userId });
      res.status(200).json({ status: 'ok' });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update camera' });
    }
  });

  app.delete('/api/registry/cameras/:id', async (req, res) => {
    if (!requireRegistryAuth(req, res)) return;
    const userId = req.query.userId as string;
    if (!userId) return res.status(400).json({ error: "Query param 'userId' is required" });
    try {
      const ref = registryDb!.collection('cameras').doc(req.params.id);
      const existing = await ref.get();
      if (!existing.exists || existing.data()?.userId !== userId) return res.status(404).json({ error: 'Camera not found for this userId' });
      await ref.delete();
      await writeRegistryAudit(registryDb!, { cameraId: ref.id, cameraName: existing.data()?.name || ref.id, action: 'delete', source: 'api', userId });
      res.status(200).json({ status: 'ok' });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete camera' });
    }
  });

  app.post('/api/gemini/analyze-frame', async (req, res) => {
    const { imageBase64, knownFaces, camera, watchlist } = req.body as Partial<FrameAnalysisInput>;

    if (!imageBase64) {
      res.status(400).json({ error: "Parameter 'imageBase64' is required" });
      return;
    }

    try {
      res.status(200).json(await analyzeFrame({ imageBase64, knownFaces, watchlist, camera }));
    } catch (err: unknown) {
      console.error('[GEMINI VISION ERROR]', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Frame analysis failed' });
    }
  });

  app.post('/api/gemini/chat', async (req, res) => {
    const { prompt, history, cameraLogs, frames } = req.body;
    if (!prompt) {
      res.status(400).json({ error: "Parameter 'prompt' is required" });
      return;
    }

    try {
      interface CameraLog {
        cameraName?: string;
        summary?: string;
        timestamp?: string | number | Date;
        counts?: {
          people?: number;
          vehicles?: number;
          other?: number;
        };
      }

      interface ChatMessage {
        role?: string;
        text?: string;
      }

      interface ChatFrame {
        cameraName?: string;
        imageBase64?: string;
      }

      interface ContentPart {
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }

      interface ContentItem {
        role: 'user' | 'model';
        parts: ContentPart[];
      }

      const framesList = (Array.isArray(frames) ? (frames as ChatFrame[]) : [])
        .filter((f): f is ChatFrame & { imageBase64: string } => !!f?.imageBase64)
        .slice(0, 4);

      console.log(`[GEMINI CHATBOT] Query: "${prompt}" (${framesList.length} live frame(s) attached)`);

      let contextLogsText = "No recent camera logs/summaries or observations available yet.";
      if (cameraLogs && Array.isArray(cameraLogs) && cameraLogs.length > 0) {
        contextLogsText = (cameraLogs as CameraLog[]).map((log) => {
          const timeStr = log.timestamp ? new Date(log.timestamp).toISOString() : 'Unknown';
          const cnts = log.counts ? `People: ${log.counts.people ?? 0}, Vehicles: ${log.counts.vehicles ?? 0}, Other: ${log.counts.other ?? 0}` : 'N/A';
          return `- [${timeStr}] Camera: "${log.cameraName ?? 'Unknown'}" | Analysis: ${log.summary ?? ''} | ${cnts}`;
        }).join("\n");
      }

      const systemInstruction = `You are OmniSee's AI-Vision Assistant Chatbot. Your role is to help users understand what their security cameras have detected.
You have access to the latest security surveillance summaries and detection logs below:

=== RECENT SURVEILLANCE LOGS ===
${contextLogsText}
================================
${framesList.length > 0 ? `
Live camera frame image(s) captured just now are attached to the user's latest message, one per camera, each preceded by a text label naming its camera. These are the actual current pixels of that camera's feed — use them directly to answer anything about what is literally visible right now (object counts, scenery, colors, text, anything not covered by the logs above), not just what the stored summaries happen to mention. The logs above only ever record people/vehicle/brand counts and security-relevant events, so a literal visual question (e.g. "how many trees are visible") will never be answered by them — look at the attached image instead.
` : ''}
Analyze this context to answer user queries:
- If asked about identified people, check the logs for their names (like "Jane", "John").
- If asked about vehicles, counting traffic, or specific times, analyze and calculate from public log timestamps.
- If they ask about anomalies, check logs that indicate unusual activity.
- If asked about literal visual content of a scene and a live frame is attached, describe/count directly from that image.
- If asked about something not present anywhere in the logs or attached frames, inform them kindly and offer general safety/operational tips.
- Maintain a helpful, vigilant, and highly knowledgeable security assistant persona. Be concise but descriptive.`;

      // Format history + prompt into contents
      const contentsList: ContentItem[] = [];
      if (history && Array.isArray(history)) {
        (history as ChatMessage[]).forEach((msg) => {
          contentsList.push({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.text ?? '' }]
          });
        });
      }

      const userParts: ContentPart[] = [];
      for (const frame of framesList) {
        userParts.push({ text: `Camera: "${frame.cameraName ?? 'Unknown'}"` });
        userParts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: frame.imageBase64.includes(',') ? frame.imageBase64.split(',')[1] : frame.imageBase64,
          },
        });
      }
      userParts.push({ text: prompt });
      contentsList.push({ role: 'user', parts: userParts });

      // Vision-capable models only when frames are attached — the plain
      // chat models can't accept inlineData parts at all.
      const response = await generateContentWithFallback(framesList.length > 0 ? VISION_MODELS : CHAT_MODELS, {
        contents: contentsList,
        config: {
          systemInstruction,
          temperature: 0.7,
        }
      });

      const replyText = response.text || "I was unable to analyze your request. Please try again.";
      res.status(200).json({ text: replyText });
    } catch (err: unknown) {
      console.error("[GEMINI CHATBOT ERROR]", err);
      res.status(500).json({ error: err instanceof Error ? err.message : "Internal AI engine failure" });
    }
  });

  // ---- Server-side analysis (replaces the browser-tab capture loop) ----
  // Opt-in: needs SERVER_ANALYSIS=true, the Admin SDK (FIREBASE_SERVICE_ACCOUNT)
  // and GEMINI_API_KEY. Cameras are picked up when their registry record has
  // `serverAnalysis: true`.
  let analysisWorker: AnalysisWorker | null = null;
  if (process.env.SERVER_ANALYSIS === 'true') {
    if (!registryDb || !process.env.GEMINI_API_KEY) {
      console.warn('[ANALYSIS] SERVER_ANALYSIS=true but FIREBASE_SERVICE_ACCOUNT and/or GEMINI_API_KEY is missing — worker not started.');
    } else {
      const db = registryDb;
      const creds = {
        email: process.env.STREAM_EMAIL || DEFAULT_STREAM_EMAIL,
        password: process.env.STREAM_PASSWORD || DEFAULT_STREAM_PASSWORD,
      };
      analysisWorker = createAnalysisWorker({
        now: () => Date.now(),
        log: console,
        subscribeCameras: (onChange, onError) =>
          db.collection('cameras').where('serverAnalysis', '==', true).onSnapshot((snap) => {
            const cameras: WorkerCamera[] = [];
            snap.forEach((d) => {
              const c = d.data();
              const url = typeof c.remoteStreamUrl === 'string' ? c.remoteStreamUrl : '';
              // Webcam / simulated cameras only exist in a browser, and unsafe URLs are never fetched.
              if (!c.useRemoteFeed || !url || !isSafeCameraUrl(url) || !c.userId) return;
              cameras.push({
                id: d.id, userId: c.userId, name: c.name || 'Unnamed Camera', remoteStreamUrl: url,
                interval: c.interval ?? 60, sensitivity: c.sensitivity ?? 5,
                peopleThreshold: c.peopleThreshold ?? 5, vehicleThreshold: c.vehicleThreshold ?? 2,
                suspiciousRules: c.suspiciousRules || '', webhookUrl: c.webhookUrl || '',
                department: c.department || undefined,
                location: c.location && typeof c.location.lat === 'number' && typeof c.location.lng === 'number' ? { lat: c.location.lat, lng: c.location.lng } : undefined,
              });
            });
            onChange(cameras);
          }, onError),
        loadUserContext: async (userId) => {
          const [faces, watch] = await Promise.all([
            db.collection('faces').where('userId', '==', userId).limit(6).get(),
            db.collection('watchlist').where('userId', '==', userId).get(),
          ]);
          return {
            knownFaces: faces.docs.map((f) => ({ name: f.data().name as string, imageData: f.data().imageData as string })),
            watchlist: watch.docs.map((w) => w.data().plate as string),
          };
        },
        grabFrame: (camera) => grabFrame({ url: camera.remoteStreamUrl, localBaseUrl: `http://localhost:${PORT}`, creds, gridRtspHost: `${SENTINEL_GRID_HOST}:8554` }),
        analyze: ({ imageBase64, camera, knownFaces, watchlist }) => analyzeFrame({ imageBase64, knownFaces, watchlist, camera }),
        writeLog: async (doc) => { await db.collection('logs').add(doc); },
        writeSightings: (userId, sightings) => writeSightings(db, userId, sightings),
        updateCamera: async (cameraId, patch) => { await db.collection('cameras').doc(cameraId).update(patch); },
        sendWebhook: async (url, payload) => {
          const res = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UPSTREAM_USER_AGENT },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
        },
      }, { concurrency: Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY) || 4) });
    }
  }

  // Lets the UI know whether the "Analyze on server" toggle can do anything.
  app.get('/api/analysis/config', (_req, res) => {
    res.status(200).json({ enabled: analysisWorker !== null, anpr: anprClient !== null });
  });

  app.get('/api/analysis/status', async (req, res) => {
    if (!requireRegistryAuth(req, res)) return;
    const workerStatus = analysisWorker ? analysisWorker.status() : { running: false, queue: { queued: 0, active: 0, concurrency: 0 }, cameras: [] };
    let anpr: { configured: boolean; healthy?: boolean; device?: string; error?: string } = { configured: anprClient !== null };
    if (anprClient) {
      try { const health = await anprClient.health(); await anprClient.probe(); anpr = { configured: true, healthy: true, device: health.device }; }
      catch (err) { anpr = { configured: true, healthy: false, error: err instanceof Error ? err.message : String(err) }; }
    }
    res.status(200).json({ ...workerStatus, anpr });
  });

  const server = http.createServer(app);

  // Vite middleware for development or static serving for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`OMNISEE INTEGRATION SERVER RUNNING ON PORT ${PORT}`);
    analysisWorker?.start();
  });
}

startServer();
