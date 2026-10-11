/**
 * Health probes and metrics for an orchestrator (gap A23, deploy/k8s).
 *
 *   GET /healthz   the process is up and its event loop answers (liveness). Never touches a dependency: a database outage must not get pods killed.
 *   GET /readyz    200 once start-up finished, 503 before and while shutting down (readiness): the load balancer sends traffic only to ready pods.
 *   GET /metrics   Prometheus text format, only when METRICS_ENABLED=true; with METRICS_TOKEN set it needs `Authorization: Bearer <token>`.
 *                  Restrict it with a network policy as well (it names internals).
 *
 * Gauges are supplied by the caller as functions, so this module knows nothing about the rest of the server and the figures are read when asked.
 */
import type { Express, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

export interface OpsOptions {
  /** Called when /readyz is asked: true once the server can take traffic. */
  ready: () => boolean;
  metrics?: { enabled: boolean; token?: string };
  /** Named values for /metrics: `{ name: () => number | Record<label, number> }`. A name is `[a-z_:][a-z0-9_:]*`. */
  gauges?: Record<string, { help: string; value: () => number | Record<string, number> }>;
  now?: () => number;
}

const NAME_RE = /^[a-z_:][a-z0-9_:]*$/;
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** The Prometheus exposition text for a set of gauges (a number, or one number per `label` value). Non-finite values are left out. */
export function renderMetrics(gauges: NonNullable<OpsOptions['gauges']>): string {
  const lines: string[] = [];
  for (const [name, g] of Object.entries(gauges)) {
    if (!NAME_RE.test(name)) continue;
    let v: number | Record<string, number>;
    try { v = g.value(); } catch { continue; }
    const rows = typeof v === 'number' ? [['', v] as const] : Object.entries(v).map(([k, n]) => [`{label="${esc(k)}"}`, n] as const);
    const ok = rows.filter(([, n]) => Number.isFinite(n));
    if (!ok.length) continue;
    lines.push(`# HELP ${name} ${g.help.replace(/\n/g, ' ')}`, `# TYPE ${name} gauge`);
    for (const [l, n] of ok) lines.push(`${name}${l} ${n}`);
  }
  return lines.join('\n') + '\n';
}

export function registerOps(app: Express, o: OpsOptions): void {
  const started = (o.now ?? Date.now)();
  app.get('/healthz', (_req: Request, res: Response) => { res.setHeader('Cache-Control', 'no-store'); res.json({ status: 'ok' }); });
  app.get('/readyz', (_req: Request, res: Response) => { res.setHeader('Cache-Control', 'no-store'); if (o.ready()) res.json({ status: 'ready' }); else res.status(503).json({ status: 'starting' }); });
  if (!o.metrics?.enabled) return;
  const want = o.metrics.token ? Buffer.from(o.metrics.token) : null;
  app.get('/metrics', (req: Request, res: Response) => {
    if (want) {
      const given = Buffer.from((req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
      if (given.length !== want.length || !timingSafeEqual(given, want)) { res.status(401).type('text/plain').send('unauthorized\n'); return; }
    }
    const mem = process.memoryUsage();
    const base: NonNullable<OpsOptions['gauges']> = {
      omnisee_uptime_seconds: { help: 'Seconds since the server started.', value: () => Math.round(((o.now ?? Date.now)() - started) / 1000) },
      omnisee_process_resident_bytes: { help: 'Resident memory of the process.', value: () => mem.rss },
      omnisee_process_heap_used_bytes: { help: 'Node heap in use.', value: () => mem.heapUsed },
      omnisee_ready: { help: '1 when the server is ready for traffic.', value: () => (o.ready() ? 1 : 0) },
    };
    res.type('text/plain; version=0.0.4; charset=utf-8').setHeader('Cache-Control', 'no-store');
    res.send(renderMetrics({ ...base, ...(o.gauges ?? {}) }));
  });
}
