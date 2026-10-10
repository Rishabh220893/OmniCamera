/**
 * Username + password sign-in on top of Firebase Auth (which identifies accounts by e-mail): a username `rakesh.m` is stored as the
 * account e-mail `rakesh.m@omnisee.local`. People never see or type the e-mail; the server (account creation) and the sign-in screen
 * both use these two functions, so they cannot disagree.
 */
export const USERNAME_DOMAIN = 'omnisee.local';

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** Lower-cases and trims what a person typed. Returns null when it is not a valid username. */
export function normaliseUsername(raw: string): string | null {
  const u = String(raw ?? '').trim().toLowerCase();
  return USERNAME_RE.test(u) ? u : null;
}

export const usernameToEmail = (username: string): string => `${username}@${USERNAME_DOMAIN}`;

export const emailToUsername = (email: string | null | undefined): string | null => {
  const m = String(email ?? '').toLowerCase().match(/^([^@]+)@omnisee\.local$/);
  return m ? m[1] : null;
};

/** What is wrong with a password, in words for the person setting it; null when it is fine. */
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== 'string') return 'A password is required.';
  if (p.length < PASSWORD_MIN) return `The password must be at least ${PASSWORD_MIN} characters.`;
  if (p.length > PASSWORD_MAX) return `The password must be at most ${PASSWORD_MAX} characters.`;
  return null;
}
