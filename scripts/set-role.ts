/**
 * Gives an account its role and departments as Firebase custom claims (docs/authz.md). Run by whoever holds the service account;
 * a person cannot do this to themselves from the app.
 *
 *   npm run set-role -- <uid|email> <viewer|operator|admin> [department ...]
 *   npm run set-role -- --show <uid|email>
 *   npm run set-role -- --clear <uid|email>
 *   npm run set-role -- --legacy [--apply]     list (or, with --apply, remove) the old self-set `role` field from accounts that already have a claim
 *
 * An admin with no departments covers all of them. The account must sign in again (or refresh its token) before the new role
 * applies; with AUTHZ_CHECK_REVOKED=true the server also refuses tokens issued before the change.
 * Needs FIREBASE_SERVICE_ACCOUNT in the environment (or demo.local / scale.local, like the other scripts).
 */
import { readFileSync, existsSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { claimsFor } from '../server/authz/policy';

for (const f of ['.env.local', 'demo.local', 'scale.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function init() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error('FIREBASE_SERVICE_ACCOUNT is not set.'); process.exit(2); }
  return initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

/** Accounts still carrying the self-set role. With a claim the field is dead weight (and the rules ignore it), so those are safe to clear. */
async function legacy(apply: boolean) {
  const app = init(), auth = getAuth(app), db = getFirestore(app);
  const snap = await db.collection('users').get();
  let withClaim = 0, withoutClaim = 0;
  for (const d of snap.docs) {
    if (d.data().role === undefined) continue;
    const claims = (await auth.getUser(d.id).catch(() => null))?.customClaims;
    if (claims && typeof claims.role === 'string') {
      withClaim++;
      console.log(`${apply ? 'clearing' : 'would clear'} role '${d.data().role}' on ${d.id} (claim: ${claims.role})`);
      if (apply) await d.ref.update({ role: FieldValue.delete() });
    } else {
      withoutClaim++;
      console.log(`kept: ${d.id} has role '${d.data().role}' and NO claim yet`);
    }
  }
  console.log(`${withClaim} account(s) ${apply ? 'cleared' : 'could be cleared (run again with --apply)'}; ${withoutClaim} still rely on the self-set role.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--legacy') return legacy(args.includes('--apply'));
  const mode = args[0] === '--show' || args[0] === '--clear' ? args.shift()! : 'set';
  const who = args.shift();
  if (!who) { console.error('Usage: npm run set-role -- <uid|email> <viewer|operator|admin> [department ...]   (or --show / --clear <uid|email>)'); process.exit(2); }
  const auth = getAuth(init());
  const user = who.includes('@') ? await auth.getUserByEmail(who) : await auth.getUser(who);

  if (mode === '--show') { console.log(JSON.stringify({ uid: user.uid, email: user.email, claims: user.customClaims ?? null }, null, 2)); return; }
  const keep = { ...(user.customClaims ?? {}) } as Record<string, unknown>;
  delete keep.role; delete keep.departments;
  if (mode === '--clear') {
    await auth.setCustomUserClaims(user.uid, keep);
    await auth.revokeRefreshTokens(user.uid);
    console.log(`Cleared the role for ${user.email ?? user.uid}. It falls back to the legacy self-set role (or viewer when that is switched off).`);
    return;
  }
  const [role, ...departments] = args;
  if (!role) { console.error('Give a role: viewer, operator or admin.'); process.exit(2); }
  const claims = claimsFor(role, departments);
  await auth.setCustomUserClaims(user.uid, { ...keep, ...claims });
  await auth.revokeRefreshTokens(user.uid);
  console.log(`${user.email ?? user.uid} is now ${claims.role} for ${claims.departments.join(', ') || 'no department'}. They must sign in again.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
