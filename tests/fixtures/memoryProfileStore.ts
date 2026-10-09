import type { HealFloor, ProbeReport, ProfileRow, ProfileStore, RecipeChange } from '../../server/cameraProfile.ts';

/** An in-memory ProfileStore that behaves like the Postgres one (history, floor, change log), for testing what sits on top of it. */
export function memoryProfileStore(initial: ProbeReport[] = []) {
  const rows = new Map<string, ProfileRow & { decision?: Record<string, unknown> }>();
  const runs: ProbeReport[] = [];
  const changes: RecipeChange[] = [];
  const key = (site: string, id: string) => `${site}/${id}`;
  for (const report of initial) { rows.set(key(report.site, report.cameraId), { report, override: null, overrideReason: null, healFloor: null }); runs.push(report); }
  const store: ProfileStore = {
    ensureSchema: async () => {},
    async listProfiles(site) { return [...rows.values()].filter((r) => r.report.site === site).sort((a, b) => a.report.cameraId.localeCompare(b.report.cameraId, undefined, { numeric: true })); },
    async getProfile(site, id) { return rows.get(key(site, id)) ?? null; },
    async saveProbe(report) {
      runs.push(report);
      const prev = rows.get(key(report.site, report.cameraId));
      rows.set(key(report.site, report.cameraId), { report, override: prev?.override ?? null, overrideReason: prev?.overrideReason ?? null, healFloor: prev?.healFloor ?? null });
      return { kept: false, consecutiveFailures: report.failure ? 1 : 0 };
    },
    async saveDecision(site, id, decision) { const r = rows.get(key(site, id)); if (r) r.decision = decision; },
    async setOverride(site, id, recipe, reason) { const r = rows.get(key(site, id)); if (r) { r.override = recipe; r.overrideReason = reason; } },
    async history(site, id, limit = 20) { return runs.filter((r) => r.site === site && r.cameraId === id).sort((a, b) => b.probedAt.localeCompare(a.probedAt)).slice(0, limit); },
    async setHealFloor(site, id, floor: HealFloor | null) { const r = rows.get(key(site, id)); if (r) r.healFloor = floor; },
    async recordChange(c) { changes.push(c); },
    async changes(site, id, limit = 50) { return changes.filter((c) => c.site === site && (id === null || c.cameraId === id)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit); },
  };
  return { store, rows, runs, changes };
}
