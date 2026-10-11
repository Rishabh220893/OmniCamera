import { call } from './adminApi';
import type { WallLayoutSpec } from './wallLayout';

export interface WallLayoutRow {
  id: string; name: string; ownerUserId: string; department: string | null; shared: boolean; spec: WallLayoutSpec; createdAt: string; updatedAt: string;
}
export interface WallStateRow {
  wall: { id: string; name: string; department: string | null; layoutId: string | null; maxViewers: number; maxLiveTiles: number; version: number; tourStartedAt: string; updatedAt: string; updatedBy: string | null };
  spec: WallLayoutSpec | null;
  layoutName: string | null;
  controller: { uid: string; since: string } | null;
  viewers: number;
}
export interface WallSession { sessionId: string; mode: 'viewer' | 'controller'; expiresAt: string; state: WallStateRow }
export interface WallAuditRow { at: string; wallId: string; uid: string; action: string; detail?: string }

/** A refusal that carries more than a message (who holds control, for instance). */
export class WallBusy extends Error { constructor(message: string, readonly holder: string) { super(message); this.name = 'WallBusy'; } }

const enc = encodeURIComponent;

export const wallApi = {
  walls: () => call<{ walls: WallStateRow[] }>('/api/walls').then((r) => r.walls),
  layouts: () => call<{ layouts: WallLayoutRow[] }>('/api/wall-layouts').then((r) => r.layouts),
  saveLayout: (l: { name: string; spec: WallLayoutSpec; department?: string | null; shared?: boolean }) => call<{ layout: WallLayoutRow }>('/api/wall-layouts', { method: 'POST', body: l }).then((r) => r.layout),
  removeLayout: (id: string) => call<{ status: string }>(`/api/wall-layouts/${enc(id)}`, { method: 'DELETE' }),
  createWall: (w: { id: string; name?: string; department?: string | null; maxViewers?: number; maxLiveTiles?: number }) => call<{ state: WallStateRow }>('/api/walls', { method: 'POST', body: w }).then((r) => r.state),
  attach: async (wallId: string, mode: 'viewer' | 'controller', force = false): Promise<WallSession> => {
    try { return await call<WallSession>(`/api/walls/${enc(wallId)}/sessions`, { method: 'POST', body: { mode, force } }); }
    catch (e) {
      // call() keeps only the message; the holder is the first word of "<holder> is controlling this wall."
      const m = e instanceof Error ? e.message.match(/^(.+) is controlling this wall\.$/) : null;
      if (m) throw new WallBusy(e instanceof Error ? e.message : '', m[1]);
      throw e;
    }
  },
  heartbeat: (wallId: string, sessionId: string, mode: 'viewer' | 'controller') => call<{ state: WallStateRow }>(`/api/walls/${enc(wallId)}/sessions/${enc(sessionId)}/heartbeat`, { method: 'POST', body: { mode } }).then((r) => r.state),
  detach: (wallId: string, sessionId: string, mode: 'viewer' | 'controller') => call<{ status: string }>(`/api/walls/${enc(wallId)}/sessions/${enc(sessionId)}?mode=${mode}`, { method: 'DELETE' }),
  setLayout: (wallId: string, sessionId: string, body: { layoutId: string } | { spec: WallLayoutSpec }) =>
    call<{ state: WallStateRow }>(`/api/walls/${enc(wallId)}/layout`, { method: 'PUT', body: { sessionId, ...body } }).then((r) => r.state),
  audit: (wallId: string) => call<{ audit: WallAuditRow[] }>(`/api/walls/${enc(wallId)}/audit`).then((r) => r.audit),
};
