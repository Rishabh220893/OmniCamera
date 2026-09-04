import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Firestore } from 'firebase-admin/firestore';

// A distinctive custom UA on every upstream request to this camera grid
// (fronted by Cloudflare) is a textbook bot-throttling trigger — real
// browsers requesting the same paths don't get the ~30s-per-6s-segment
// throughput this proxy was measured at, and a plain RTSP client bypassing
// Cloudflare's HTTP layer entirely loaded the same camera in ~5s. Blending
// in as an ordinary browser is worth trying before assuming the origin
// itself just can't serve fast enough.
const UPSTREAM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

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
  params: Omit<Parameters<typeof ai.models.generateContent>[0], 'model'>
) {
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

// This grid's cameras serve HLS as one giant VOD playlist covering their
// entire recording history (observed: 7,201 segments, ~12 hours, in a
// single manifest) rather than a rolling live window. hls.js defaults to
// starting a VOD playback at segment 0 — the OLDEST segment — and on this
// origin that segment is consistently unreachable (every proxy failure
// logged during diagnosis was on seg00000.ts specifically, across five
// different cameras), almost certainly because old segments have been
// evicted from whatever hot storage/cache serves them while the manifest
// still lists them. Rewriting the manifest to only the most recent
// segments points playback at data that's actually likely to still exist.
const VOD_TAIL_SEGMENTS = 12;

// Tags that describe the playlist as a whole rather than one specific
// segment — always kept verbatim regardless of truncation. Anything else
// starting with '#' (EXTINF, DISCONTINUITY, PROGRAM-DATE-TIME, BYTERANGE...)
// is segment-scoped and travels with whichever segment follows it.
const PLAYLIST_LEVEL_TAG_PREFIXES = [
  '#EXTM3U', '#EXT-X-VERSION', '#EXT-X-TARGETDURATION', '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-DISCONTINUITY-SEQUENCE', '#EXT-X-KEY', '#EXT-X-START',
];

// Always rewrites (never returns the input unchanged) — even a manifest
// short enough to need no tail-trimming still needs ENDLIST/PLAYLIST-TYPE
// stripped, see below.
function truncateVodManifestToTail(text: string, maxSegments: number): string {
  const lines = text.split('\n');
  const prefixLines: string[] = [];
  const segments: { tags: string[]; uri: string }[] = [];
  let pendingTags: string[] = [];
  let mediaSequence = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
      continue; // re-emitted below, adjusted for the new starting point
    }
    // #EXT-X-ENDLIST and #EXT-X-PLAYLIST-TYPE:VOD are deliberately dropped
    // entirely, not just carried through — the origin serves this as a
    // single static list covering the camera's entire history, but the
    // intent is a live camera. Forwarding those tags verbatim tells
    // hls.js "this is the whole clip, nothing more is coming," so it
    // plays through our truncated window and then simply stops (looks
    // exactly like a frozen feed). Omitting them makes it a playlist
    // hls.js keeps reloading, which is what actually picks up new
    // segments as the source grows.
    if (line.startsWith('#EXT-X-ENDLIST')) continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) continue;
      if (PLAYLIST_LEVEL_TAG_PREFIXES.some((p) => line.startsWith(p))) prefixLines.push(line);
      else pendingTags.push(line); // e.g. #EXTINF — belongs to the segment named next
    } else {
      segments.push({ tags: pendingTags, uri: line });
      pendingTags = [];
    }
  }

  const kept = segments.length <= maxSegments ? segments : segments.slice(-maxSegments);
  const newMediaSequence = mediaSequence + (segments.length - kept.length);

  return [
    ...prefixLines,
    `#EXT-X-MEDIA-SEQUENCE:${newMediaSequence}`,
    ...kept.flatMap((seg) => [...seg.tags, seg.uri]),
  ].join('\n');
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

async function startServer() {
  const app = express();
  // Render (and most Node hosts) assign the listen port dynamically via
  // process.env.PORT — a hardcoded port fails deployment there.
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

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
      console.error("[PROXY FRAME] Error proxying frame:", err);
      res.status(502).send(err instanceof Error ? err.message : 'Error retrieving remote frame');
    }
  });

  // Some camera CDNs (confirmed against the corp8.cloud grid) gate access
  // with a plain server-rendered login form (POST /auth/login, field name
  // "password") rather than a header/query-param scheme, setting a
  // long-lived session cookie on success. Cache that cookie per-password so
  // we only log in once, and re-login automatically if a request comes back
  // redirected (session expired/invalid) instead of served.
  const sessionCookieCache = new Map<string, string>();

  async function loginForSessionCookie(targetUrl: string, password: string): Promise<string | null> {
    // Keyed by host+password, not password alone — a shared password across
    // multiple camera hosts (common on a bulk-onboarded test grid) would
    // otherwise reuse host A's session cookie against host B and get
    // rejected as an invalid session there.
    const cacheKey = `${new URL(targetUrl).host}|${password}`;
    try {
      const loginUrl = new URL('/auth/login', targetUrl).toString();
      const res = await fetchUpstream(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UPSTREAM_USER_AGENT },
        body: `password=${encodeURIComponent(password)}`,
        redirect: 'manual',
      }, { timeoutMs: 20_000, retries: 1 });
      const setCookie = res.headers.get('set-cookie');
      const match = setCookie?.match(/([a-zA-Z0-9_]+=[^;]+)/);
      if (match) {
        sessionCookieCache.set(cacheKey, match[1]);
        return match[1];
      }
    } catch (err) {
      console.error('[PROXY HLS] Session login failed:', err);
    }
    return null;
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
    const password = (req.header('X-Stream-Password') || (req.query.password as string | undefined));
    if (!targetUrl) {
      res.status(400).send("Parameter 'url' is required");
      return;
    }

    try {
      const buildHeaders = (cookie?: string | null): Record<string, string> => {
        const headers: Record<string, string> = { 'User-Agent': UPSTREAM_USER_AGENT };
        if (password) headers['Authorization'] = 'Basic ' + Buffer.from(':' + password).toString('base64');
        if (cookie) headers['Cookie'] = cookie;
        return headers;
      };

      // This grid's origin (corp8.cloud) is evidently slow to respond even
      // when a request eventually succeeds — an early build of this timeout
      // used 8-12s and it aborted every single request. A HAR capture later
      // showed 100% of segment requests dying at ~20s regardless of camera
      // count (even a single camera failed identically) — this origin
      // apparently needs as long to serve one segment as a whole manifest,
      // so both get the same generous, no-retry budget now (retrying a
      // systemically slow origin just triples the wait for no benefit).
      const fetchOpts = { timeoutMs: 45_000, retries: 0 };

      const cacheKey = password ? `${new URL(targetUrl).host}|${password}` : null;

      let upstream: Response;
      if (password && cacheKey) {
        const cachedCookie = sessionCookieCache.get(cacheKey) || (await loginForSessionCookie(targetUrl, password));
        upstream = await fetchUpstream(targetUrl, { headers: buildHeaders(cachedCookie), redirect: 'manual' }, fetchOpts);
        // A redirect with a password set means the session was invalid/expired
        // (or this is the first request and there was nothing cached) — log
        // in fresh and retry exactly once before giving up. Also retry on a
        // direct 401 (not just a 3xx redirect to a login page): a stale
        // cached cookie, or loginForSessionCookie having silently failed and
        // left `cachedCookie` null, both surface as the upstream flatly
        // rejecting the request rather than redirecting it — a real HAR
        // capture showed exactly this (401 on every request despite a
        // correct password being sent), which the redirect-only check here
        // previously had no retry path for at all.
        if ((upstream.status >= 300 && upstream.status < 400) || upstream.status === 401) {
          sessionCookieCache.delete(cacheKey);
          const freshCookie = await loginForSessionCookie(targetUrl, password);
          upstream = await fetchUpstream(targetUrl, { headers: buildHeaders(freshCookie), redirect: 'manual' }, fetchOpts);
        }
      } else {
        upstream = await fetchUpstream(targetUrl, { headers: buildHeaders(), redirect: 'manual' }, fetchOpts);
      }

      if (!upstream.ok) {
        const bodyText = await upstream.text().catch(() => '');
        console.error(`[PROXY HLS] Upstream rejected ${targetUrl} -> ${upstream.status} ${upstream.statusText} (${password ? 'password sent' : 'no password sent'}). Body: ${bodyText.slice(0, 300)}`);
        res.status(upstream.status >= 300 && upstream.status < 400 ? 401 : upstream.status).send(
          upstream.status >= 300 && upstream.status < 400
            ? 'Upstream redirected to a login page — the stream access password was rejected.'
            : `Upstream error ${upstream.status}${bodyText ? ': ' + bodyText.slice(0, 200) : ''}`
        );
        return;
      }

      const isManifest = targetUrl.toLowerCase().includes('.m3u8');
      if (isManifest) {
        const text = await upstream.text();
        // A 2xx status doesn't guarantee the body is actually a manifest —
        // some servers answer an expired/invalid session with 200 + an HTML
        // login page instead of a proper redirect. Forwarding that as if it
        // were real HLS content leaves hls.js parsing zero segments out of
        // an unrecognized file forever, with no fatal error to ever surface
        // to the UI — it just looks like a permanently "loading" tile.
        // Strip a possible UTF-8 BOM before checking — some Windows-based
        // NVR/encoder software emits one, and trimStart() alone doesn't
        // remove it, which would make this reject every single otherwise-
        // valid manifest from an origin that does this.
        if (!text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) {
          if (cacheKey) sessionCookieCache.delete(cacheKey);
          console.error(`[PROXY HLS] Upstream returned ${upstream.status} for ${targetUrl} but the body isn't a valid HLS manifest. First 200 chars: ${text.slice(0, 200)}`);
          res.status(502).send('Upstream returned a 2xx status but the response was not a valid HLS manifest — likely an expired session or wrong password serving a login page instead of the stream.');
          return;
        }
        const cleanText = text.replace(/^\uFEFF/, '');
        // Always run every manifest through this \u2014 besides tail-truncating
        // an oversized VOD list, it also strips ENDLIST/PLAYLIST-TYPE so
        // hls.js treats the feed as ongoing rather than a finished clip (see
        // the function's own comment). It's a no-op for a manifest that
        // already looks like a normal rolling live playlist.
        const sourceText = truncateVodManifestToTail(cleanText, VOD_TAIL_SEGMENTS);

        const baseUrl = new URL(targetUrl);
        const passwordQuery = password ? `&password=${encodeURIComponent(password)}` : '';
        const proxyLine = (uri: string) => `/api/proxy-hls?url=${encodeURIComponent(new URL(uri, baseUrl).toString())}${passwordQuery}`;

        const rewritten = sourceText.split('\n').map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith('#')) {
            // Rewrite URI="..." attributes on tags like EXT-X-KEY / EXT-X-MAP
            // (a no-op .replace on tags without one, e.g. #EXTINF:10.0,).
            return trimmed.replace(/URI="([^"]+)"/, (_m, uri) => `URI="${proxyLine(uri)}"`);
          }
          return proxyLine(trimmed);
        }).join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(rewritten);
      } else {
        const contentType = upstream.headers.get('content-type') || 'video/mp2t';
        if (/text\/html|text\/plain/i.test(contentType)) {
          if (cacheKey) sessionCookieCache.delete(cacheKey);
          const bodyText = await upstream.text().catch(() => '');
          console.error(`[PROXY HLS] Upstream returned ${upstream.status} for segment ${targetUrl} but content-type is "${contentType}" (expected binary media). First 200 chars: ${bodyText.slice(0, 200)}`);
          res.status(502).send('Upstream returned a 2xx status but the response was HTML/text, not a media segment — likely an expired session serving a login page.');
          return;
        }
        const arrayBuffer = await upstream.arrayBuffer();
        // Our own code defaults a missing content-type to 'video/mp2t' above,
        // which lets a tiny error/placeholder body slide past the check just
        // done — a real multi-second .ts segment is virtually always many KB.
        // (AES-128 key files legitimately are this small — a 16-byte key —
        // so they're exempted by URL.)
        const isKeyFile = /\.key(\?|$)/i.test(targetUrl);
        if (!isKeyFile && arrayBuffer.byteLength < 500) {
          if (cacheKey) sessionCookieCache.delete(cacheKey);
          const preview = Buffer.from(arrayBuffer).toString('utf8').slice(0, 200);
          console.error(`[PROXY HLS] Upstream returned ${upstream.status} for segment ${targetUrl} but body is only ${arrayBuffer.byteLength} bytes (expected a real media segment). Content: ${preview}`);
          res.status(502).send(`Upstream returned a 2xx status but the segment body was only ${arrayBuffer.byteLength} bytes — likely an expired session or error response, not real video data.`);
          return;
        }
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(Buffer.from(arrayBuffer));
      }
    } catch (err: unknown) {
      console.error('[PROXY HLS] Error:', err);
      res.status(502).send(err instanceof Error ? err.message : 'Error proxying HLS resource');
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
    // Was previously never forwarded at all — this proxy signaled every
    // camera unauthenticated, which worked while the origin allowed it, but
    // a HAR capture showed it now uniformly rejecting every camId with
    // {"status":"error","error":"authentication error"} (MediaMTX's own
    // auth-failure body), including cameras that used to negotiate
    // successfully with no credentials. Forward the same Stream Access
    // Password already used for the HLS path as HTTP Basic auth (empty
    // username), MediaMTX's standard scheme for a single shared password —
    // matching the pattern already proven against this grid's other paths.
    const password = req.header('X-Stream-Password') || (req.query.password as string | undefined);
    const upstreamHeaders: Record<string, string> = { 'Content-Type': 'application/sdp' };
    if (password) upstreamHeaders['Authorization'] = 'Basic ' + Buffer.from(':' + password).toString('base64');

    try {
      const upstream = await fetchUpstream(`${WHEP_ORIGIN}/stream/${camId}/whep`, {
        method: 'POST',
        headers: upstreamHeaders,
        body: req.body,
      }, { timeoutMs: 15_000, retries: 0 });

      const answer = await upstream.text();
      if (!upstream.ok) {
        console.error(`[WHEP PROXY] Upstream rejected camId=${camId} -> ${upstream.status} (${password ? 'password sent' : 'no password sent'}). Body: ${answer.slice(0, 300)}`);
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
      console.error('[WHEP PROXY] Error negotiating session:', err);
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
      console.error('[WHEP PROXY] Session cleanup failed (non-fatal):', err);
    }
    res.status(204).end();
  });

  // Dedicated catalogue fetch for the specific Sentinel grid this app's
  // demo data points at (same host as WHEP_ORIGIN above) — separate from
  // the generic /api/camera-catalogue below, which targets an
  // arbitrary caller-supplied HTTPS host with optional Cloudflare-style
  // password auth (built for the corp8.cloud vanity/proxy layer this grid
  // used to be fronted by). The Sentinel integrator guide is explicit that
  // RTSP/WHEP/HLS *and* this catalogue are plain, unauthenticated endpoints
  // on the raw origin — no password, no Cloudflare — so this hits that
  // origin directly rather than assuming either.
  //
  // Every camera failing identically, all at once, on the exact same day
  // the app's hardcoded demo grid — 30 camera ids/URLs baked into
  // demoGridCameras.ts, pointed at a *different* host pattern
  // (cctv.corp8.cloud/camNN/index.m3u8) than this guide documents
  // (<host>/live/stream/<id>/index.m3u8) — is much better explained by
  // "the grid's real camera ids/URLs moved and our hardcoded copy is
  // stale" than by "every credential we have is suddenly wrong." The guide
  // itself says as much: "the catalogue is the contract, the URL pattern
  // is not." This route lets the client ask the grid directly instead of
  // guessing.
  app.get('/api/sentinel-catalogue', async (req, res) => {
    try {
      const upstream = await fetchUpstream(`http://${SENTINEL_GRID_HOST}/api/ingest`, {}, { timeoutMs: 15_000, retries: 1 });
      const text = await upstream.text();
      if (!upstream.ok) {
        console.error(`[SENTINEL CATALOGUE] Upstream rejected -> ${upstream.status}. Body: ${text.slice(0, 500)}`);
        res.status(upstream.status).send(text);
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(text);
    } catch (err: unknown) {
      console.error('[SENTINEL CATALOGUE] Error:', err);
      res.status(502).send(err instanceof Error ? err.message : 'Error fetching Sentinel camera catalogue');
    }
  });

  // The grid's own integrator guide: "Start from the catalogue rather than
  // hard-coding endpoints... camera ids and the set of available cameras
  // can change; the catalogue is the contract, the URL pattern is not."
  // It also carries each camera's own live status — reported failures for
  // a camera the origin itself already lists as down are expected, not a
  // proxy bug, and this is the only way to tell the difference.
  app.get('/api/camera-catalogue', async (req, res) => {
    const targetHost = req.query.host as string;
    const password = req.query.password as string | undefined;
    if (!targetHost) {
      res.status(400).send("Parameter 'host' is required");
      return;
    }

    try {
      const base = `https://${targetHost}`;
      const buildHeaders = (cookie?: string | null): Record<string, string> => {
        const headers: Record<string, string> = { 'User-Agent': UPSTREAM_USER_AGENT };
        if (password) headers['Authorization'] = 'Basic ' + Buffer.from(':' + password).toString('base64');
        if (cookie) headers['Cookie'] = cookie;
        return headers;
      };

      const cacheKey = password ? `${targetHost}|${password}` : null;
      const fetchCatalogue = async (path: string) => {
        const cookie = password
          ? sessionCookieCache.get(cacheKey!) || (await loginForSessionCookie(`${base}${path}`, password))
          : null;
        return fetchUpstream(`${base}${path}`, { headers: buildHeaders(cookie), redirect: 'manual' }, { timeoutMs: 20_000, retries: 0 });
      };

      // Two documented names for the same idea across the two guide
      // revisions we were given (/api/ingest, cameras.json) — try the
      // grid-specific one first, fall back to the generic one.
      let upstream = await fetchCatalogue('/cameras.json');
      if (upstream.status >= 300 && upstream.status < 400) upstream = await fetchCatalogue('/api/ingest');

      if (!upstream.ok) {
        res.status(upstream.status >= 300 && upstream.status < 400 ? 401 : upstream.status)
          .send('Could not load the camera catalogue — the stream access password may be wrong.');
        return;
      }

      const data = await upstream.text();
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(data);
    } catch (err: unknown) {
      console.error('[CAMERA CATALOGUE] Error:', err);
      res.status(502).send(err instanceof Error ? err.message : 'Error fetching camera catalogue');
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
    const { imageBase64, knownFaces, camera, watchlist } = req.body as {
      imageBase64?: string;
      knownFaces?: Array<{ name: string; imageData: string }>;
      watchlist?: string[];
      camera?: {
        name?: string;
        sensitivity?: number;
        peopleThreshold?: number;
        vehicleThreshold?: number;
        suspiciousRules?: string;
      };
    };

    if (!imageBase64) {
      res.status(400).json({ error: "Parameter 'imageBase64' is required" });
      return;
    }

    try {
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
      const detectedPlates = (data.detected_plates || []).map((p) => String(p).toUpperCase().replace(/\s+/g, ''));
      const watchlistSet = new Set((watchlist || []).map((p) => String(p).toUpperCase().replace(/\s+/g, '')));
      const watchlistMatches = detectedPlates.filter((p) => watchlistSet.has(p));

      if (watchlistMatches.length > 0) {
        console.warn(`[WATCHLIST MATCH] Camera "${camera?.name ?? 'Unknown'}" — plates: ${watchlistMatches.join(', ')}`);
      }

      res.status(200).json({ ...data, detected_plates: detectedPlates, watchlistMatches });
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

  // Vite middleware for development or static serving for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`OMNISEE INTEGRATION SERVER RUNNING ON PORT ${PORT}`);
  });
}

startServer();
