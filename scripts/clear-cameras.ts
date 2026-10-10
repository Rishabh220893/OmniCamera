/**
 * Deletes camera records from the registry (Firestore `cameras`) so they can be onboarded again from scratch.
 * It only touches the `cameras` collection: logs, alerts, users, departments, faces and the watchlist are left alone.
 * Dry run by default; a JSON backup of every record is written before anything is deleted.
 *
 *   npm run clear-cameras -- --all                 list what would be deleted, for every account
 *   npm run clear-cameras -- --user <uid|email>    list what would be deleted for one account
 *   npm run clear-cameras -- --all --apply         back up, then delete
 *
 * Needs FIREBASE_SERVICE_ACCOUNT in the environment (or demo.local / scale.local, like the other scripts).
 * The probe profiles in Postgres (docs/camera-onboarding-plan.md) are separate and are not touched.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Query } from 'firebase-admin/firestore';

for (const f of ['.env.local', 'demo.local', 'scale.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const all = args.includes('--all');
const userIdx = args.indexOf('--user');
const user = userIdx >= 0 ? args[userIdx + 1] : undefined;

if (args.includes('--help') || (!all && !user) || (all && user)) {
  console.log('Usage: npm run clear-cameras -- (--all | --user <uid|email>) [--apply]\nWithout --apply nothing is deleted.');
  process.exit(args.includes('--help') ? 0 : 1);
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error('FIREBASE_SERVICE_ACCOUNT is not set.'); process.exit(2); }

async function main() {
  const app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT!)) });
  const db = getFirestore(app);
  let q: Query = db.collection('cameras');
  if (user) {
    const uid = user.includes('@') ? (await getAuth(app).getUserByEmail(user)).uid : user;
    q = q.where('userId', '==', uid);
    console.log(`Account: ${user} (${uid})`);
  }
  const snap = await q.get();
  console.log(`${snap.size} camera record(s) ${user ? 'for that account' : 'in total'}.`);
  for (const d of snap.docs.slice(0, 40)) console.log(`  ${d.id}  ${String(d.data().name ?? '')}  ${String(d.data().remoteStreamUrl ?? '')}`);
  if (snap.size > 40) console.log(`  ... and ${snap.size - 40} more`);
  if (!snap.size) return;

  if (!apply) { console.log('\nDry run: nothing deleted. Add --apply to back up and delete these.'); return; }

  const file = `cameras-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(snap.docs.map((d) => ({ id: d.id, ...d.data() })), null, 2));
  console.log(`\nBackup written: ${file}`);

  let deleted = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    for (const d of snap.docs.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
    deleted += Math.min(400, snap.docs.length - i);
  }
  console.log(`Deleted ${deleted} camera record(s). Reload the app (and clear its snapshot cache) before onboarding again.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
