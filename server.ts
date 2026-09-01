import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Firestore } from 'firebase-admin/firestore';

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
async function fetchUpstream(url: string, options: RequestInit = {}, { timeoutMs = 8_000, retries = 2 }: { timeoutMs?: number; retries?: number } = {}): Promise<Response> {
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
          'User-Agent': 'OmniSee-AI-Vision-Server/1.0'
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
          'User-Agent': 'OmniSee-AI-Vision-Server/1.0'
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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'OmniSee-AI-Vision-Server/1.0' },
        body: `password=${encodeURIComponent(password)}`,
        redirect: 'manual',
      }, { timeoutMs: 8_000, retries: 1 });
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
        const headers: Record<string, string> = { 'User-Agent': 'OmniSee-AI-Vision-Server/1.0' };
        if (password) headers['Authorization'] = 'Basic ' + Buffer.from(':' + password).toString('base64');
        if (cookie) headers['Cookie'] = cookie;
        return headers;
      };

      // Manifests should fail fast (a stuck manifest fetch blocks playback from
      // even starting); segments get a slightly longer budget since they're
      // bigger, but both are far short of "hang indefinitely."
      const isManifestUrl = targetUrl.toLowerCase().includes('.m3u8');
      const fetchOpts = { timeoutMs: isManifestUrl ? 8_000 : 12_000, retries: 2 };

      let upstream: Response;
      if (password) {
        const cacheKey = `${new URL(targetUrl).host}|${password}`;
        const cachedCookie = sessionCookieCache.get(cacheKey) || (await loginForSessionCookie(targetUrl, password));
        upstream = await fetchUpstream(targetUrl, { headers: buildHeaders(cachedCookie), redirect: 'manual' }, fetchOpts);
        // A redirect with a password set means the session was invalid/expired
        // (or this is the first request and there was nothing cached) — log
        // in fresh and retry exactly once before giving up.
        if (upstream.status >= 300 && upstream.status < 400) {
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
        const baseUrl = new URL(targetUrl);
        const passwordQuery = password ? `&password=${encodeURIComponent(password)}` : '';
        const proxyLine = (uri: string) => `/api/proxy-hls?url=${encodeURIComponent(new URL(uri, baseUrl).toString())}${passwordQuery}`;

        const rewritten = text.split('\n').map((line) => {
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
        const arrayBuffer = await upstream.arrayBuffer();
        const contentType = upstream.headers.get('content-type') || 'video/mp2t';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(Buffer.from(arrayBuffer));
      }
    } catch (err: unknown) {
      console.error('[PROXY HLS] Error:', err);
      res.status(502).send(err instanceof Error ? err.message : 'Error proxying HLS resource');
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
              - People Threshold: ${camera?.peopleThreshold ?? 5}
              - Vehicle Threshold: ${camera?.vehicleThreshold ?? 2}
              ${camera?.suspiciousRules ? `- CUSTOM SUSPICIOUS RULES: ${camera.suspiciousRules}` : ''}
              ${knownFacesContext}

              Tasks:
              1. A brief summary of events. IMPORTANT: Mention identified people by their names in the summary.
              2. Count people, vehicles, and notable objects.
              3. Identify any visible brands on products, clothing, or environment.
              4. Check for unusual activity (unknown people, exceeding thresholds, matching custom suspicious rules, suspicious behavior).
              5. Read any vehicle license/number plates that are legible in the frame.

              Output MUST be strict JSON:
              {
                "summary": "Short 1-sentence summary mentioning names if identified",
                "counts": { "people": number, "vehicles": number, "other": number },
                "brands": ["List of identified brands"],
                "people_identified": ["Names of identified known members or 'Unknown Person'"],
                "alerts": ["List of specific warnings"],
                "isUnusual": boolean,
                "isUnusualReason": "Explain WHY it was marked unusual based on thresholds or custom rules",
                "detected_plates": ["Any legible vehicle plate numbers, uppercase, no spaces"]
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
    const { prompt, history, cameraLogs } = req.body;
    if (!prompt) {
      res.status(400).json({ error: "Parameter 'prompt' is required" });
      return;
    }

    try {
      console.log(`[GEMINI CHATBOT] Query: "${prompt}"`);
      
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

      interface ContentPart {
        text: string;
      }

      interface ContentItem {
        role: 'user' | 'model';
        parts: ContentPart[];
      }

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

Analyze this context to answer user queries:
- If asked about identified people, check the logs for their names (like "Jane", "John").
- If asked about vehicles, counting traffic, or specific times, analyze and calculate from public log timestamps.
- If they ask about anomalies, check logs that indicate unusual activity.
- If asked about something not present anywhere in the logs, inform them kindly and offer general safety/operational tips.
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
      contentsList.push({
        role: 'user',
        parts: [{ text: prompt }]
      });

      const response = await generateContentWithFallback(CHAT_MODELS, {
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
