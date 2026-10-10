/**
 * HTTP side of the connectors (docs/connectors.md).
 *   GET  /api/connectors                      what is connected, whether each is healthy, call counts
 *   POST /api/connectors/:id/lookup  { query: { type: 'vehicle', plate } | { type: 'licence', number } | { type: 'wanted_vehicle', plate } }
 * Signed-in users with the `connector.query` permission only; every lookup is in the access log, since the answers are about people.
 */
import type { Express, Request, Response } from 'express';
import type { ConnectorHub } from './hub';
import { ConnectorError, parseQuery } from './types';

export interface ConnectorRoutesContext {
  hub: ConnectorHub;
  /** Checks the caller may query connectors; replies 401/403 and returns false when not. */
  allow(req: Request, res: Response, permission: 'connector.query'): Promise<boolean>;
}

export function registerConnectorRoutes(app: Express, ctx: ConnectorRoutesContext): void {
  const fail = (res: Response, e: unknown) => {
    if (e instanceof ConnectorError) {
      const status = e.code === 'bad_query' ? 400 : e.code === 'unknown_connector' ? 404 : e.code === 'unsupported_query' ? 422
        : e.code === 'circuit_open' || e.code === 'unavailable' ? 503 : e.code === 'timeout' ? 504 : 502;
      res.status(status).json({ error: e.message, code: e.code });
      return;
    }
    console.error('[CONNECTORS]', e);
    res.status(500).json({ error: 'The lookup failed.' });
  };

  app.get('/api/connectors', async (req, res) => {
    if (!(await ctx.allow(req, res, 'connector.query'))) return;
    res.json({ connectors: ctx.hub.status() });
  });

  app.post('/api/connectors/:id/lookup', async (req, res) => {
    if (!(await ctx.allow(req, res, 'connector.query'))) return;
    try {
      if (!/^[a-z0-9_-]{1,40}$/.test(req.params.id)) throw new ConnectorError(`No connector named '${req.params.id}'.`, 'unknown_connector');
      res.json({ result: await ctx.hub.lookup(req.params.id, parseQuery((req.body as { query?: unknown } | undefined)?.query)) });
    } catch (e) { fail(res, e); }
  });
}
