/**
 * Video walls and who controls them (gap A10).
 *
 * A **layout** is a saved arrangement (a preset or a custom grid, a camera in each cell, optionally a tour that pages through cameras).
 * A **wall** is a named display (a control-room screen, a video-wall controller): it shows one layout and has **sessions**:
 *   - viewers: any number up to `maxViewers`, they only watch;
 *   - one controller at a time: the only session that may change what the wall shows. Someone else's control can be taken only after it
 *     runs out (it needs a heartbeat every ~45 s) or, by an administrator, by force. Every change of hands and of layout is audited.
 * Sessions are leases in the federation `UsageStore`, so with Redis the caps hold across server processes (memory otherwise).
 *
 * Camera ids in a layout are just ids: a person who cannot see a camera sees an empty cell with a note. A layout does not give access to
 * video; the media server's own gate (docs/federation-service.md, A21) still applies.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALL, coversDepartment, type Principal } from '../authz/policy';
import { DEPARTMENT_NAME_RE } from '../events/rules';
import { LayoutError, validateSpec, type WallLayoutSpec } from '../../src/lib/wallLayout';
import { createMemoryUsageStore, type UsageStore } from '../federation/usageStore';

export interface WallLayout {
  id: string; name: string; ownerUserId: string;
  /** The department it belongs to; people of that department see it when `shared`. */
  department: string | null; shared: boolean;
  spec: WallLayoutSpec; createdAt: string; updatedAt: string;
}

export interface Wall {
  id: string; name: string; department: string | null;
  layoutId: string | null;
  /** A layout set directly by the controller without saving it. Wins over `layoutId` while set. */
  adHocSpec: WallLayoutSpec | null;
  maxViewers: number;
  /** Cells that play live at once on this wall (the rest show stills); a browser and the camera grid cannot sustain more. */
  maxLiveTiles: number;
  version: number; tourStartedAt: string; updatedAt: string; updatedBy: string | null;
}

export interface WallState {
  wall: Omit<Wall, 'adHocSpec'>;
  /** What the wall shows: the ad hoc layout, or the saved one, or null (empty wall). */
  spec: WallLayoutSpec | null;
  layoutName: string | null;
  controller: { uid: string; since: string } | null;
  viewers: number;
}

export interface AuditEntry { at: string; wallId: string; uid: string; action: 'attach' | 'detach' | 'take-control' | 'force-control' | 'control-expired' | 'layout' | 'config'; detail?: string }

export type AttachResult =
  | { status: 'ok'; sessionId: string; mode: 'viewer' | 'controller'; expiresAt: string }
  | { status: 'busy'; holder: string; since: string }
  | { status: 'full'; max: number }
  | { status: 'not_found' }
  | { status: 'forbidden' };

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const SESSION_MS = 45_000;
const AUDIT_KEEP = 300;

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const intIn = (v: unknown, name: string, lo: number, hi: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new LayoutError(`'${name}' must be a whole number from ${lo} to ${hi}.`);
  return n;
};

export interface WallServiceOptions {
  file: string;
  store?: UsageStore;
  now?: () => Date;
  log?: Pick<Console, 'warn' | 'info'>;
}

export function createWallService(o: WallServiceOptions) {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? console;
  const store = o.store ?? createMemoryUsageStore();
  const layouts = new Map<string, WallLayout>();
  const walls = new Map<string, Wall>();
  const audit: AuditEntry[] = [];
  const holders = new Map<string, { uid: string; since: string }>(); // who holds control of a wall, as far as this process knows
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn); chain = r.catch(() => undefined); return r; };

  const note = (e: Omit<AuditEntry, 'at'>) => { audit.push({ at: now().toISOString(), ...e }); if (audit.length > AUDIT_KEEP) audit.splice(0, audit.length - AUDIT_KEEP); };
  const viewerKey = (wallId: string) => `wallv:${wallId}`;
  const controlKey = (wallId: string) => `wallc:${wallId}`;

  async function persist() {
    await fs.mkdir(path.dirname(o.file), { recursive: true });
    const tmp = `${o.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ layouts: [...layouts.values()], walls: [...walls.values()] }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, o.file);
  }

  let loadP: Promise<void> | null = null;
  const ensureLoaded = (): Promise<void> => (loadP ??= (async () => {
    try {
      const j = JSON.parse(await fs.readFile(o.file, 'utf8')) as { layouts?: WallLayout[]; walls?: Wall[] };
      for (const l of j.layouts ?? []) if (l?.id) layouts.set(l.id, l);
      for (const w of j.walls ?? []) if (w?.id) walls.set(w.id, w);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`[WALL] could not read ${o.file}: ${e instanceof Error ? e.message : e}`); }
  })());

  const isAdmin = (p: Principal) => p.role === 'admin';
  const seesDepartment = (p: Principal, d: string | null) => d === null || coversDepartment(p, d);
  const layoutVisible = (p: Principal, l: WallLayout) => l.ownerUserId === p.uid || p.departments.includes(ALL) && isAdmin(p) || (l.shared && l.department !== null && coversDepartment(p, l.department));
  const mayEditLayout = (p: Principal, l: WallLayout) => l.ownerUserId === p.uid || (isAdmin(p) && (p.departments.includes(ALL) || (l.department !== null && coversDepartment(p, l.department))));

  const departmentOf = (raw: unknown, p: Principal): string | null => {
    const d = str(raw, 80);
    if (!d) return null;
    if (!DEPARTMENT_NAME_RE.test(d)) throw new LayoutError("'department' must be a department name.");
    if (!coversDepartment(p, d)) throw new LayoutError('You can only use your own departments.');
    return d;
  };

  const specOf = (w: Wall): { spec: WallLayoutSpec | null; name: string | null } => {
    if (w.adHocSpec) return { spec: w.adHocSpec, name: null };
    const l = w.layoutId ? layouts.get(w.layoutId) : undefined;
    return { spec: l?.spec ?? null, name: l?.name ?? null };
  };

  async function controllerOf(wallId: string): Promise<{ uid: string; since: string } | null> {
    const t = now().getTime();
    const ls = (await store.leases(t)).filter((l) => l.clientId === controlKey(wallId));
    if (ls.length === 0) { const h = holders.get(wallId); if (h) { note({ wallId, uid: h.uid, action: 'control-expired' }); holders.delete(wallId); } return null; }
    const h = holders.get(wallId);
    return { uid: ls[0].what, since: h && h.uid === ls[0].what ? h.since : ls[0].expiresAt };
  }

  async function stateOf(w: Wall): Promise<WallState> {
    const { adHocSpec: _a, ...wall } = w;
    const { spec, name } = specOf(w);
    const viewers = await store.activeSessions(viewerKey(w.id), now().getTime());
    return { wall, spec, layoutName: name, controller: await controllerOf(w.id), viewers };
  }

  return {
    load: ensureLoaded,
    audit: (wallId: string): AuditEntry[] => audit.filter((a) => a.wallId === wallId).reverse(),

    // ---- layouts ----
    async listLayouts(p: Principal): Promise<WallLayout[]> {
      await ensureLoaded();
      return [...layouts.values()].filter((l) => layoutVisible(p, l)).sort((a, b) => a.name.localeCompare(b.name));
    },

    createLayout: (raw: unknown, p: Principal) => serial(async () => {
      await ensureLoaded();
      const r = (raw ?? {}) as Record<string, unknown>;
      const name = str(r.name, 80);
      if (!name) throw new LayoutError("'name' is required.");
      const dep = departmentOf(r.department, p);
      const shared = r.shared === true;
      if (shared && !dep) throw new LayoutError('A shared layout needs a department.');
      const at = now().toISOString();
      const l: WallLayout = { id: randomBytes(9).toString('base64url'), name, ownerUserId: p.uid, department: dep, shared, spec: validateSpec(r.spec), createdAt: at, updatedAt: at };
      layouts.set(l.id, l);
      await persist();
      return l;
    }),

    updateLayout: (id: string, raw: unknown, p: Principal) => serial(async () => {
      await ensureLoaded();
      const l = layouts.get(id);
      if (!l || !layoutVisible(p, l)) return null;
      if (!mayEditLayout(p, l)) return 'forbidden' as const;
      const r = (raw ?? {}) as Record<string, unknown>;
      const dep = r.department === undefined ? l.department : departmentOf(r.department, p);
      const shared = r.shared === undefined ? l.shared : r.shared === true;
      if (shared && !dep) throw new LayoutError('A shared layout needs a department.');
      const next: WallLayout = { ...l, name: str(r.name, 80) ?? l.name, department: dep, shared, spec: r.spec === undefined ? l.spec : validateSpec(r.spec), updatedAt: now().toISOString() };
      layouts.set(id, next);
      // A wall showing this layout shows the new version at once.
      for (const [wid, w] of walls) if (w.layoutId === id && !w.adHocSpec) walls.set(wid, { ...w, version: w.version + 1 });
      await persist();
      return next;
    }),

    removeLayout: (id: string, p: Principal) => serial(async () => {
      await ensureLoaded();
      const l = layouts.get(id);
      if (!l || !layoutVisible(p, l)) return null;
      if (!mayEditLayout(p, l)) return 'forbidden' as const;
      layouts.delete(id);
      for (const [wid, w] of walls) if (w.layoutId === id) walls.set(wid, { ...w, layoutId: null, version: w.version + 1 });
      await persist();
      return 'ok' as const;
    }),

    // ---- walls (administrators) ----
    async listWalls(p: Principal): Promise<Array<WallState>> {
      await ensureLoaded();
      return Promise.all([...walls.values()].filter((w) => seesDepartment(p, w.department)).map(stateOf));
    },

    async getWall(id: string, p: Principal): Promise<WallState | null> {
      await ensureLoaded();
      const w = walls.get(id);
      return w && seesDepartment(p, w.department) ? stateOf(w) : null;
    },

    createWall: (raw: unknown, p: Principal) => serial(async () => {
      await ensureLoaded();
      const r = (raw ?? {}) as Record<string, unknown>;
      const id = str(r.id, 40);
      if (!id || !ID_RE.test(id)) throw new LayoutError("'id' must be 1-40 letters, digits, _ or -.");
      if (walls.has(id)) throw new LayoutError(`A wall named '${id}' already exists.`);
      const name = str(r.name, 80) ?? id;
      const at = now().toISOString();
      const w: Wall = {
        id, name, department: departmentOf(r.department, p), layoutId: null, adHocSpec: null,
        maxViewers: r.maxViewers === undefined ? 10 : intIn(r.maxViewers, 'maxViewers', 0, 200),
        maxLiveTiles: r.maxLiveTiles === undefined ? 12 : intIn(r.maxLiveTiles, 'maxLiveTiles', 0, 64),
        version: 1, tourStartedAt: at, updatedAt: at, updatedBy: p.uid,
      };
      walls.set(id, w);
      note({ wallId: id, uid: p.uid, action: 'config', detail: 'created' });
      await persist();
      return stateOf(w);
    }),

    updateWall: (id: string, raw: unknown, p: Principal) => serial(async () => {
      await ensureLoaded();
      const w = walls.get(id);
      if (!w || !seesDepartment(p, w.department)) return null;
      const r = (raw ?? {}) as Record<string, unknown>;
      const next: Wall = { ...w, name: str(r.name, 80) ?? w.name, updatedAt: now().toISOString(), updatedBy: p.uid, version: w.version + 1 };
      if (r.maxViewers !== undefined) next.maxViewers = intIn(r.maxViewers, 'maxViewers', 0, 200);
      if (r.maxLiveTiles !== undefined) next.maxLiveTiles = intIn(r.maxLiveTiles, 'maxLiveTiles', 0, 64);
      walls.set(id, next);
      note({ wallId: id, uid: p.uid, action: 'config' });
      await persist();
      return stateOf(next);
    }),

    removeWall: (id: string, p: Principal) => serial(async () => {
      await ensureLoaded();
      const w = walls.get(id);
      if (!w || !seesDepartment(p, w.department)) return false;
      walls.delete(id); holders.delete(id);
      await store.dropClient(viewerKey(id)); await store.dropClient(controlKey(id));
      note({ wallId: id, uid: p.uid, action: 'config', detail: 'removed' });
      await persist();
      return true;
    }),

    // ---- sessions ----
    /** Joins a wall as a viewer or as its controller. Taking control from someone whose session is alive needs `force` (administrators only). */
    async attach(wallId: string, p: Principal, mode: 'viewer' | 'controller', force = false): Promise<AttachResult> {
      await ensureLoaded();
      const w = walls.get(wallId);
      if (!w || !seesDepartment(p, w.department)) return { status: 'not_found' };
      const t = now().getTime();
      const dep = w.department ?? 'all';
      const id = randomBytes(12).toString('base64url');
      if (mode === 'viewer') {
        const r = await store.acquire({ id, clientId: viewerKey(wallId), department: dep, what: p.uid }, { client: w.maxViewers }, t, SESSION_MS);
        if (r.ok === false) return { status: 'full', max: r.max };
        note({ wallId, uid: p.uid, action: 'attach', detail: 'viewer' });
        return { status: 'ok', sessionId: id, mode, expiresAt: r.lease.expiresAt };
      }
      let r = await store.acquire({ id, clientId: controlKey(wallId), department: dep, what: p.uid }, { client: 1 }, t, SESSION_MS);
      if (r.ok === false) {
        const cur = await controllerOf(wallId);
        if (!(force && isAdmin(p)) && cur?.uid !== p.uid) return { status: 'busy', holder: cur?.uid ?? 'someone', since: cur?.since ?? now().toISOString() };
        await store.dropClient(controlKey(wallId));
        r = await store.acquire({ id, clientId: controlKey(wallId), department: dep, what: p.uid }, { client: 1 }, t, SESSION_MS);
        if (r.ok === false) return { status: 'busy', holder: cur?.uid ?? 'someone', since: cur?.since ?? now().toISOString() };
        note({ wallId, uid: p.uid, action: cur?.uid === p.uid ? 'take-control' : 'force-control', detail: cur?.uid === p.uid ? 'own earlier session replaced' : `from ${cur?.uid ?? 'unknown'}` });
      } else note({ wallId, uid: p.uid, action: 'take-control' });
      holders.set(wallId, { uid: p.uid, since: now().toISOString() });
      return { status: 'ok', sessionId: id, mode, expiresAt: r.lease.expiresAt };
    },

    /** Keeps a session alive and returns the wall's current state; null when the session has run out (or was taken over). */
    async heartbeat(wallId: string, p: Principal, sessionId: string, mode: 'viewer' | 'controller'): Promise<WallState | null> {
      await ensureLoaded();
      const w = walls.get(wallId);
      if (!w || !seesDepartment(p, w.department)) return null;
      const l = await store.renew(mode === 'viewer' ? viewerKey(wallId) : controlKey(wallId), sessionId, now().getTime(), SESSION_MS);
      if (!l || l.what !== p.uid) return null;
      return stateOf(w);
    },

    async detach(wallId: string, p: Principal, sessionId: string, mode: 'viewer' | 'controller'): Promise<boolean> {
      await ensureLoaded();
      const l = await store.renew(mode === 'viewer' ? viewerKey(wallId) : controlKey(wallId), sessionId, now().getTime(), SESSION_MS);
      if (!l || l.what !== p.uid) return false;
      const ok = await store.release(mode === 'viewer' ? viewerKey(wallId) : controlKey(wallId), sessionId);
      if (ok && mode === 'controller') holders.delete(wallId);
      if (ok) note({ wallId, uid: p.uid, action: 'detach', detail: mode });
      return ok;
    },

    /** The controller changes what the wall shows: a saved layout (`layoutId`) or one made on the spot (`spec`). Anyone else is refused. */
    setLayout: (wallId: string, p: Principal, sessionId: string, raw: unknown) => serial(async () => {
      await ensureLoaded();
      const w = walls.get(wallId);
      if (!w || !seesDepartment(p, w.department)) return { status: 'not_found' as const };
      const l = await store.renew(controlKey(wallId), sessionId, now().getTime(), SESSION_MS);
      if (!l || l.what !== p.uid) return { status: 'not_controller' as const };
      const r = (raw ?? {}) as Record<string, unknown>;
      const next: Wall = { ...w, version: w.version + 1, tourStartedAt: now().toISOString(), updatedAt: now().toISOString(), updatedBy: p.uid };
      if (typeof r.layoutId === 'string') {
        const saved = layouts.get(r.layoutId);
        if (!saved || !layoutVisible(p, saved)) throw new LayoutError('No such layout.');
        next.layoutId = saved.id; next.adHocSpec = null;
        note({ wallId, uid: p.uid, action: 'layout', detail: saved.name });
      } else if (r.spec !== undefined) {
        next.adHocSpec = validateSpec(r.spec); next.layoutId = null;
        note({ wallId, uid: p.uid, action: 'layout', detail: 'on the spot' });
      } else throw new LayoutError("Give a 'layoutId' or a 'spec'.");
      walls.set(wallId, next);
      await persist();
      return { status: 'ok' as const, state: await stateOf(next) };
    }),
  };
}
export type WallService = ReturnType<typeof createWallService>;
export { LayoutError };
