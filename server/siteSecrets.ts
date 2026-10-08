/**
 * Where a site's camera login comes from (docs/camera-onboarding-plan.md decision 4): one secret per site, with an optional
 * override per camera. Nothing secret is stored in a profile or a camera record; this only names environment variables.
 *
 *   site "grid":  GRID_EMAIL / GRID_PASSWORD            (STREAM_EMAIL / STREAM_PASSWORD are accepted for the grid, as elsewhere)
 *   one camera:   GRID_CAM07_EMAIL / GRID_CAM07_PASSWORD   (site name, camera id upper-cased, other characters become _)
 */
import type { Credentials } from './mediaPaths';

const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '_');

export function credentialNames(site: string, cameraId?: string): { user: string; pass: string } {
  const prefix = cameraId ? `${key(site)}_${key(cameraId)}` : key(site);
  return { user: `${prefix}_EMAIL`, pass: `${prefix}_PASSWORD` };
}

export function credentialResolver(site: string, env: Record<string, string | undefined>): (cameraId: string) => Credentials {
  const pick = (names: { user: string; pass: string }): Credentials | null => {
    const user = env[names.user], pass = env[names.pass];
    return user && pass ? { user, pass } : null;
  };
  const siteWide = pick(credentialNames(site)) ?? (site === 'grid' ? pick({ user: 'STREAM_EMAIL', pass: 'STREAM_PASSWORD' }) : null);
  return (cameraId) => {
    const found = pick(credentialNames(site, cameraId)) ?? siteWide;
    if (!found) {
      const n = credentialNames(site);
      throw new Error(`No login for site '${site}': set ${n.user} and ${n.pass} (or ${credentialNames(site, cameraId).user} for just ${cameraId}).`);
    }
    return found;
  };
}
