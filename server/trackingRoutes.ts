/**
 * HTTP side of background tracking (server/tracking.ts): validation of what the browser sends, the Gemini prompts for face and rule
 * checks, the choice between the ANPR service and Gemini for plates, and the four routes the Full Panel uses.
 *
 *   POST /api/tracking/start   { mode, plate | faceImage + faceLabel | rules, cameras: [{ id, name, url }] }
 *   POST /api/tracking/stop
 *   GET  /api/tracking/status?after=<alert id>       progress, per-camera state, and alerts newer than `after`
 *   GET  /api/tracking/alerts/:id/frame.jpg          the frame an alert was raised on
 *
 * The camera login is taken from the request (the same X-Stream-* headers the snapshot route uses) or from the server's environment,
 * kept only in memory for the life of the job, and never returned.
 */
import type { Express, Request, Response } from 'express';
import { createTracker, normalizeTrackedPlate, type PlateRead, type TrackCamera, type TrackDeps, type TrackOptions, type TrackSpec, type Tracker } from './tracking';
import type { FrameGate } from './frameGate';
import { isSafeCameraUrl } from '../src/lib/cameraUrl';

type GeminiParams = { contents: { parts: unknown[] }; config?: Record<string, unknown> };

export interface TrackingContext {
  /** One Gemini call (with the model fallback chain), vision models. */
  generate(params: GeminiParams): Promise<{ text?: string }>;
  /** The ANPR service, or null when it is not configured. */
  anpr: { detect(jpeg: Buffer): Promise<Array<{ text: string; confidence: number; rawText?: string }>> } | null;
  /** A frame from a camera. Replaced by a folder of images in tests (TRACKING_FAKE_FRAMES_DIR). */
  grab(camera: TrackCamera, creds: { email: string; password: string }): Promise<Buffer>;
  credentials(req: Request): { email: string; password: string };
  /** Answers false (and has already replied) when the caller may not use tracking. */
  requireUser(req: Request, res: Response): Promise<boolean>;
  env: Record<string, string | undefined>;
  gate?: FrameGate;
  now?: () => number;
  log?: Pick<Console, 'info' | 'warn'>;
}

const CAMERA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CAMERAS = 200;
const MAX_FACE_BYTES = 4 * 1024 * 1024;
const FACE_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/;

export interface StartRequest { spec: TrackSpec; cameras: TrackCamera[]; rejected: Array<{ id: string; why: string }> }

/** Validates the body of /api/tracking/start. Throws an Error whose message is safe to show the user. */
export function parseStartRequest(body: unknown, opts: { allowAnyUrl?: boolean } = {}): StartRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const mode = b.mode;
  let spec: TrackSpec;
  if (mode === 'plate') {
    const plate = normalizeTrackedPlate(typeof b.plate === 'string' ? b.plate : '');
    if (plate.length < 4 || plate.length > 12) throw new Error('Enter a licence plate of 4 to 12 letters and digits, for example GJ05AB1234.');
    spec = { mode, plate };
  } else if (mode === 'face') {
    const m = typeof b.faceImage === 'string' ? b.faceImage.match(FACE_DATA_URL) : null;
    if (!m) throw new Error('Upload a photo of the face (JPEG, PNG or WebP).');
    const image = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    if (image.length < 500) throw new Error('That image is too small to be a photo.');
    if (image.length > MAX_FACE_BYTES) throw new Error('That photo is larger than 4 MB. Use a smaller one.');
    const label = (typeof b.faceLabel === 'string' ? b.faceLabel.trim() : '').slice(0, 60) || 'Tracked person';
    spec = { mode, label, image, mimeType: m[1] };
  } else if (mode === 'rules') {
    const rules = (typeof b.rules === 'string' ? b.rules.trim() : '').slice(0, 1000);
    if (rules.length < 5) throw new Error('Describe what should raise an alert, for example "a person climbing a fence".');
    spec = { mode, rules };
  } else {
    throw new Error("'mode' must be plate, face or rules.");
  }

  if (!Array.isArray(b.cameras) || b.cameras.length === 0) throw new Error('No cameras were given to watch.');
  const cameras: TrackCamera[] = [], rejected: StartRequest['rejected'] = [], seen = new Set<string>();
  for (const raw of b.cameras.slice(0, MAX_CAMERAS)) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const id = typeof c.id === 'string' ? c.id : '';
    const url = typeof c.url === 'string' ? c.url : '';
    if (!CAMERA_ID.test(id)) { rejected.push({ id: id.slice(0, 20), why: 'camera id may only use letters, digits, - and _' }); continue; }
    if (seen.has(id)) continue;
    if (!opts.allowAnyUrl && !isSafeCameraUrl(url)) { rejected.push({ id, why: 'its address points at a private network, which the server will not fetch' }); continue; }
    seen.add(id);
    cameras.push({ id, name: (typeof c.name === 'string' && c.name.trim() ? c.name.trim() : id).slice(0, 120), url });
  }
  if (cameras.length === 0) throw new Error('None of the cameras can be watched from the server' + (rejected[0] ? `: ${rejected[0].why}.` : '.'));
  return { spec, cameras, rejected };
}

/** Gemini answers JSON; tolerate a fenced block and clamp what we rely on. */
export function parseJsonAnswer(text: string | undefined): Record<string, unknown> {
  const raw = (text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; }
  catch { throw new Error('Gemini did not answer in the expected format'); }
}
const clamp01 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };
const oneLine = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, 240) : d);

export function createGeminiChecks(generate: TrackingContext['generate']) {
  const frameParts = (frame: Buffer) => ({ inlineData: { mimeType: 'image/jpeg', data: frame.toString('base64') } });
  return {
    async matchFace(frame: Buffer, ref: { image: Buffer; mimeType: string; label: string }) {
      const res = await generate({
        contents: { parts: [
          { text: 'REFERENCE PHOTO of the person to look for:' },
          { inlineData: { mimeType: ref.mimeType, data: ref.image.toString('base64') } },
          { text: 'CCTV FRAME to search:' },
          frameParts(frame),
          { text: `You are helping a security operator find one person in CCTV footage.
Decide whether the person in the reference photo is visible in the CCTV frame.
A match needs the FACE of someone in the frame to be clearly visible and big enough to compare, and at least two distinctive features of the reference (for example hair style, facial hair, glasses, face shape) to be present on that face. Do not rely on clothing, build or colour alone.
- A silhouette, a small or distant figure, a person seen from behind or with the face hidden is NOT a match: answer match=false with confidence 0.3 or less.
- If no person is visible, answer match=false.
- Someone who only resembles the reference gets a low confidence. Be conservative: a wrong match sends a guard to the wrong person, and most frames will not contain the person at all.
Answer strict JSON: { "match": boolean, "confidence": number from 0 to 1, "reason": "one short sentence naming what you matched or why not" }` },
        ] },
        config: { responseMimeType: 'application/json' },
      });
      const a = parseJsonAnswer(res.text);
      return { match: a.match === true, confidence: clamp01(a.confidence), reason: oneLine(a.reason, ref.label + ' matched') };
    },

    async checkRules(frame: Buffer, rules: string, cameraName: string) {
      const res = await generate({
        contents: { parts: [
          frameParts(frame),
          { text: `You are a security AI watching the camera "${cameraName}". The operator wants an alert ONLY for the situations below.
SUSPICIOUS-ACTIVITY RULES:
${rules}

Decide whether the frame shows something matching any rule. A busy or crowded scene is not suspicious by itself; ordinary traffic and passers-by are not suspicious. If you are unsure, answer violated=false with a low confidence.
Answer strict JSON: { "violated": boolean, "confidence": number from 0 to 1, "reason": "one short sentence saying what you see that matches the rule" }` },
        ] },
        config: { responseMimeType: 'application/json' },
      });
      const a = parseJsonAnswer(res.text);
      return { violated: a.violated === true, confidence: clamp01(a.confidence), reason: oneLine(a.reason, 'A rule was matched') };
    },

    async readPlates(frame: Buffer): Promise<PlateRead[]> {
      const res = await generate({
        contents: { parts: [
          frameParts(frame),
          { text: 'Read every vehicle licence plate that is legible in this CCTV frame. Answer strict JSON: { "plates": [ { "text": "plate text, uppercase, no spaces", "confidence": number from 0 to 1 } ] }. If none is legible, answer { "plates": [] }.' },
        ] },
        config: { responseMimeType: 'application/json' },
      });
      const a = parseJsonAnswer(res.text);
      return (Array.isArray(a.plates) ? a.plates : []).map((p) => ({ text: normalizeTrackedPlate(String((p as { text?: unknown }).text ?? '')), confidence: clamp01((p as { confidence?: unknown }).confidence) })).filter((p) => p.text.length >= 4);
    },
  };
}

export function trackingOptionsFromEnv(env: Record<string, string | undefined>): Partial<TrackOptions> {
  const n = (k: string, scale = 1) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v * scale : undefined; };
  const o: Partial<TrackOptions> = {};
  const interval = n('TRACK_INTERVAL_S', 1000); if (interval !== undefined) o.intervalMs = Math.max(5_000, interval);
  const conc = n('TRACK_CONCURRENCY'); if (conc !== undefined) o.concurrency = Math.round(conc);
  const conf = n('TRACK_MIN_CONFIDENCE'); if (conf !== undefined && conf <= 1) o.minConfidence = conf;
  const cool = n('TRACK_ALERT_COOLDOWN_S', 1000); if (cool !== undefined) o.alertCooldownMs = cool;
  return o;
}

export function registerTrackingRoutes(app: Express, ctx: TrackingContext): { tracker: Tracker } {
  const log = ctx.log ?? console;
  const gemini = createGeminiChecks(ctx.generate);
  let creds = { email: '', password: '' };
  const deps: TrackDeps = {
    now: ctx.now ?? Date.now,
    grabFrame: (camera) => ctx.grab(camera, creds),
    async readPlates(frame) {
      if (ctx.anpr) {
        try { return { plates: (await ctx.anpr.detect(frame)).map((p) => ({ text: p.text, confidence: p.confidence, rawText: p.rawText })), source: 'anpr' }; }
        catch (e) { log.warn('[TRACKING] ANPR failed, reading plates with Gemini instead:', e instanceof Error ? e.message : e); }
      }
      return { plates: await gemini.readPlates(frame), source: 'gemini-fallback' };
    },
    matchFace: gemini.matchFace,
    checkRules: gemini.checkRules,
    gate: ctx.gate,
    log,
  };
  const tracker = createTracker(deps, trackingOptionsFromEnv(ctx.env));
  const allowAnyUrl = !!ctx.env.TRACKING_FAKE_FRAMES_DIR;

  app.post('/api/tracking/start', async (req, res) => {
    if (!(await ctx.requireUser(req, res))) return;
    let parsed: StartRequest;
    try { parsed = parseStartRequest(req.body, { allowAnyUrl }); }
    catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid request.' }); return; }
    const c = ctx.credentials(req);
    if (!allowAnyUrl && (!c.email || !c.password)) { res.status(401).json({ error: 'Stream access email and password are not set. Enter them under Settings → stream access, or set STREAM_EMAIL and STREAM_PASSWORD on the server.' }); return; }
    if (parsed.spec.mode !== 'plate' && !ctx.env.GEMINI_API_KEY) { res.status(503).json({ error: 'Face and rule tracking need GEMINI_API_KEY on the server.' }); return; }
    if (parsed.spec.mode === 'plate' && !ctx.anpr && !ctx.env.GEMINI_API_KEY) { res.status(503).json({ error: 'No plate reader is available: set ANPR_SERVICE_URL (node scripts/demo.mjs up --anpr) or GEMINI_API_KEY.' }); return; }
    creds = c;
    tracker.start(parsed.spec, parsed.cameras);
    res.status(202).json({ started: true, cameras: parsed.cameras.length, rejected: parsed.rejected, plateReader: parsed.spec.mode === 'plate' ? (ctx.anpr ? 'anpr' : 'gemini') : null, status: tracker.status() });
  });

  app.post('/api/tracking/stop', async (req, res) => {
    if (!(await ctx.requireUser(req, res))) return;
    tracker.stop();
    creds = { email: '', password: '' };
    res.json({ stopped: true });
  });

  app.get('/api/tracking/status', async (req, res) => {
    if (!(await ctx.requireUser(req, res))) return;
    const after = Math.max(0, Math.floor(Number(req.query.after) || 0));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...tracker.status(after), plateReader: ctx.anpr ? 'anpr' : 'gemini' });
  });

  app.get('/api/tracking/alerts/:id/frame.jpg', async (req, res) => {
    if (!(await ctx.requireUser(req, res))) return;
    const frame = tracker.alertFrame(Math.floor(Number(req.params.id)));
    if (!frame) { res.status(404).send('No such alert.'); return; }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(frame);
  });

  return { tracker };
}
