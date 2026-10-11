/**
 * Security headers and HTTPS (gap A21, docs/security-architecture.md). Before this the server sent none of them.
 *
 *   - `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` (camera and microphone only for this origin: the app uses a webcam),
 *     `X-Frame-Options: SAMEORIGIN`, and a `Cross-Origin-Opener-Policy` that keeps the Google sign-in pop-up working.
 *   - `Strict-Transport-Security` when the request really came over HTTPS (directly, or as the reverse proxy says in `X-Forwarded-Proto` when TRUST_PROXY).
 *   - `FORCE_HTTPS=true`: a plain-HTTP request is redirected (308) to HTTPS, except a health check and requests from loopback.
 *   - A Content-Security-Policy. It is sent as **report-only** by default (`SECURITY_CSP=report`): the app uses Firebase, Google Fonts, the media server
 *     and map tiles, and an enforced policy written without watching a real session would break one of them. Violations are posted to
 *     `/api/csp-report` and logged (rate-limited), so the policy can be tightened from evidence; `SECURITY_CSP=enforce` then turns it on, `off` removes it.
 *
 * The CSP's allowed origins are the ones the code is known to use; `SECURITY_CSP_EXTRA` (comma separated origins) adds more (a media server, a map tile host).
 */
import type { Express, NextFunction, Request, Response } from 'express';

export interface SecurityOptions {
  /** `report` (default), `enforce` or `off`. */
  csp?: 'report' | 'enforce' | 'off';
  /** Extra allowed origins for connections, images and media (comma separated in the environment). */
  extraOrigins?: string[];
  forceHttps?: boolean;
  /** Believe `X-Forwarded-Proto` (the server is behind a reverse proxy that sets it). */
  trustProxy?: boolean;
  hstsMaxAgeS?: number;
  log?: Pick<Console, 'warn'>;
}

const FIREBASE = ['https://*.googleapis.com', 'https://*.firebaseio.com', 'https://*.firebaseapp.com', 'https://*.gstatic.com', 'https://accounts.google.com', 'wss://*.firebaseio.com'];
/** Where the browser fetches TURN credentials for WebRTC video (src/lib/whepClient.ts); without it an enforced policy would break live video behind NAT. */
const TURN = ['https://turn.elixir-webrtc.org'];

export function cspFor(extra: string[] = []): string {
  const ex = extra.filter((o) => /^(https?|wss?):\/\/[^\s;,]+$/i.test(o));
  const connect = ["'self'", ...FIREBASE, ...TURN, ...ex, 'ws:', 'wss:'];
  return [
    "default-src 'self'",
    // The built app and the font stylesheet; Vite's dev server and some libraries inject inline styles.
    `script-src 'self' 'unsafe-inline' https://*.gstatic.com https://apis.google.com https://accounts.google.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src 'self' data: blob: https: ${ex.join(' ')}`.trim(),
    `media-src 'self' blob: data: ${ex.join(' ')}`.trim(),
    `connect-src ${connect.join(' ')}`,
    "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'report-uri /api/csp-report',
  ].join('; ');
}

const isLoopback = (ip: string | undefined) => !!ip && /^(::1|127\.|::ffff:127\.)/.test(ip);

export function isHttps(req: Pick<Request, 'secure' | 'headers'>, trustProxy: boolean): boolean {
  if (req.secure) return true;
  if (!trustProxy) return false;
  const p = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return p === 'https';
}

export function securityMiddleware(o: SecurityOptions = {}) {
  const csp = o.csp ?? 'report';
  const cspValue = cspFor(o.extraOrigins);
  const hsts = `max-age=${o.hstsMaxAgeS ?? 31_536_000}; includeSubDomains`;
  return (req: Request, res: Response, next: NextFunction) => {
    const https = isHttps(req, !!o.trustProxy);
    if (o.forceHttps && !https && !isLoopback(req.ip) && req.path !== '/api/health' && req.path !== '/healthz') {
      const host = req.headers.host;
      if (host && /^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) { res.redirect(308, `https://${host.replace(/:\d+$/, '')}${req.originalUrl}`); return; }
      res.status(400).type('text/plain').send('HTTPS is required.');
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    if (https) res.setHeader('Strict-Transport-Security', hsts);
    if (csp !== 'off') res.setHeader(csp === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', cspValue);
    next();
  };
}

/** Receives CSP violation reports (browsers post them as `application/csp-report` or `application/reports+json`), logs a few, and never trusts them. */
export function registerCspReport(app: Express, o: { log?: Pick<Console, 'warn'>; perMinute?: number; now?: () => number } = {}): void {
  const log = o.log ?? console;
  const limit = o.perMinute ?? 30, now = o.now ?? Date.now;
  let windowStart = 0, count = 0, dropped = 0;
  app.post('/api/csp-report', (req: Request, res: Response) => {
    const t = now();
    if (t - windowStart > 60_000) { if (dropped) log.warn(`[CSP] ${dropped} more report(s) in the last minute were not logged.`); windowStart = t; count = 0; dropped = 0; }
    if (count >= limit) { dropped++; res.status(204).end(); return; }
    count++;
    const raw = (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>)['csp-report'] ?? (Array.isArray(req.body) ? (req.body as Array<{ body?: unknown }>)[0]?.body : req.body) : null) as Record<string, unknown> | null;
    const f = (k: string) => (typeof raw?.[k] === 'string' ? String(raw[k]).slice(0, 200) : '');
    log.warn(`[CSP] ${f('effective-directive') || f('violated-directive') || f('effectiveDirective')} blocked ${f('blocked-uri') || f('blockedURL')} on ${f('document-uri') || f('documentURL')}`);
    res.status(204).end();
  });
}
