/**
 * firestore.rules against the Firebase Firestore emulator: department sharing of faces, the watchlist and logs (federation plan A5),
 * and that nothing that was private became readable. Skipped unless the emulator is running:
 *
 *   npm run test:rules
 *   (= firebase emulators:exec --only firestore --project demo-omnisee "node --import tsx --test tests/firestoreRules.test.ts")
 *
 * Needs Java (the emulator) and the firebase CLI.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const skip = !HOST && 'run through: npm run test:rules (needs the Firebase emulator)';

type Env = import('@firebase/rules-unit-testing').RulesTestEnvironment;
let env: Env;
let ok: (p: Promise<unknown>) => Promise<unknown>;
let denied: (p: Promise<unknown>) => Promise<unknown>;

before(async () => {
  if (!HOST) return;
  const t = await import('@firebase/rules-unit-testing');
  const [host, port] = HOST.split(':');
  env = await t.initializeTestEnvironment({ projectId: 'demo-omnisee', firestore: { rules: readFileSync('firestore.rules', 'utf8'), host, port: Number(port) } });
  ok = t.assertSucceeds as never;
  denied = t.assertFails as never;
  await env.clearFirestore();
  // The data every test reads, written with the rules switched off.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('users/legacy').set({ role: 'admin' });
    await db.doc('cameras/cam-traffic').set({ userId: 'owner', departmentId: 'Traffic', name: 'Gate' });
    await db.doc('cameras/cam-plain').set({ userId: 'owner', name: 'Lobby' });
    await db.doc('faces/f-personal').set({ userId: 'owner', name: 'Mine', imageData: 'x' });
    await db.doc('faces/f-traffic').set({ userId: 'ann', name: 'Team', imageData: 'x', departmentId: 'Traffic' });
    await db.doc('faces/f-water').set({ userId: 'wes', name: 'Pipe', imageData: 'x', departmentId: 'Water' });
    await db.doc('watchlist/w-personal').set({ userId: 'legacy', plate: 'GJ01AA0001' });
    await db.doc('watchlist/w-traffic').set({ userId: 'tadm', plate: 'GJ01BB0002', departmentId: 'Traffic' });
    await db.doc('watchlist/w-water').set({ userId: 'wadm', plate: 'GJ09ZZ9999', departmentId: 'Water' });
    await db.doc('logs/l-personal').set({ userId: 'owner', cameraId: 'cam-plain', summary: 'mine' });
    await db.doc('logs/l-traffic').set({ userId: 'owner', cameraId: 'cam-traffic', summary: 'gate', departmentId: 'Traffic' });
    await db.doc('logs/l-water').set({ userId: 'someone', cameraId: 'cam-w', summary: 'tap', departmentId: 'Water' });
  });
});
after(async () => { await env?.cleanup(); });

const as = (uid: string, claims: Record<string, unknown> = {}) => env.authenticatedContext(uid, claims).firestore();
const ann = () => as('ann', { role: 'operator', departments: ['Traffic'] });
const vic = () => as('vic', { role: 'viewer', departments: ['Traffic'] });
const wes = () => as('wes', { role: 'operator', departments: ['Water'] });
const tadm = () => as('tadm', { role: 'admin', departments: ['Traffic'] });
const root = () => as('root', { role: 'admin', departments: [] });
const owner = () => as('owner', {});
const legacy = () => as('legacy', {}); // no claims: the role comes from users/legacy (old self-set field)

// ---- faces ---------------------------------------------------------------------------------------------------------------------

test('faces: a department member reads its department\'s faces and their own, nobody else\'s', { skip }, async () => {
  await ok(ann().collection('faces').where('departmentId', '==', 'Traffic').get());
  await ok(ann().doc('faces/f-traffic').get());
  await ok(ann().collection('faces').where('userId', '==', 'ann').get());
  await denied(ann().collection('faces').where('departmentId', '==', 'Water').get());
  await denied(ann().doc('faces/f-water').get());
  await denied(ann().doc('faces/f-personal').get());
  await denied(ann().collection('faces').get(), /* an unfiltered query would read others' faces */);
  await ok(vic().doc('faces/f-traffic').get());
  await ok(owner().doc('faces/f-personal').get());
  await denied(owner().doc('faces/f-traffic').get());
});

test('faces: an operator or admin of a department adds, changes and removes its faces; a viewer, another department and a stranger cannot', { skip }, async () => {
  await ok(ann().collection('faces').add({ userId: 'ann', name: 'New', imageData: 'x', departmentId: 'Traffic' }));
  await denied(ann().collection('faces').add({ userId: 'ann', name: 'New', imageData: 'x', departmentId: 'Water' }));
  await denied(ann().collection('faces').add({ userId: 'owner', name: 'New', imageData: 'x', departmentId: 'Traffic' }));
  await denied(vic().collection('faces').add({ userId: 'vic', name: 'New', imageData: 'x', departmentId: 'Traffic' }));
  await ok(vic().collection('faces').add({ userId: 'vic', name: 'Mine', imageData: 'x' }));
  await ok(tadm().collection('faces').add({ userId: 'tadm', name: 'Boss', imageData: 'x', departmentId: 'Traffic' }));
  await ok(root().collection('faces').add({ userId: 'root', name: 'Any', imageData: 'x', departmentId: 'Water' }));
  await denied(tadm().collection('faces').add({ userId: 'tadm', name: 'Nope', imageData: 'x', departmentId: 'Water' }));

  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc('faces/f-mate').set({ userId: 'tadm', name: 'Mate', imageData: 'x', departmentId: 'Traffic' }); });
  await ok(ann().doc('faces/f-mate').update({ name: 'Mate 2' }));
  await denied(ann().doc('faces/f-mate').update({ departmentId: 'Water' }));
  await denied(ann().doc('faces/f-mate').update({ userId: 'ann' }));
  await denied(vic().doc('faces/f-mate').update({ name: 'x' }));
  await denied(wes().doc('faces/f-mate').delete());
  await denied(vic().doc('faces/f-mate').delete());
  await ok(ann().doc('faces/f-mate').delete());
  await ok(owner().doc('faces/f-personal').update({ name: 'Mine 2' }));
  await denied(owner().doc('faces/f-personal').update({ departmentId: 'Traffic' }), /* sharing is fixed at creation */);
});

// ---- watchlist -----------------------------------------------------------------------------------------------------------------

test('watchlist: members of a department read its plates; only an administrator who covers the department writes them', { skip }, async () => {
  await ok(ann().collection('watchlist').where('departmentId', '==', 'Traffic').get());
  await ok(vic().doc('watchlist/w-traffic').get());
  await denied(ann().doc('watchlist/w-water').get());
  await denied(ann().doc('watchlist/w-personal').get());

  await denied(ann().collection('watchlist').add({ userId: 'ann', plate: 'GJ01CC0003', departmentId: 'Traffic' }), /* an operator is not enough */);
  await ok(tadm().collection('watchlist').add({ userId: 'tadm', plate: 'GJ01CC0003', departmentId: 'Traffic' }));
  await denied(tadm().collection('watchlist').add({ userId: 'tadm', plate: 'GJ01CC0003', departmentId: 'Water' }));
  await ok(root().collection('watchlist').add({ userId: 'root', plate: 'GJ01CC0004', departmentId: 'Water' }));
  await ok(tadm().doc('watchlist/w-traffic').update({ reason: 'edited by another admin' }));
  await denied(tadm().doc('watchlist/w-traffic').update({ departmentId: 'Water' }));
  await denied(ann().doc('watchlist/w-traffic').delete());
  await denied(wes().doc('watchlist/w-traffic').delete());
  await ok(tadm().doc('watchlist/w-traffic').delete());
});

test('watchlist: as before for personal plates - only an Admin-role account writes its own; an old self-set admin cannot write a department\'s', { skip }, async () => {
  await ok(legacy().collection('watchlist').add({ userId: 'legacy', plate: 'GJ01DD0005' }));
  await denied(legacy().collection('watchlist').add({ userId: 'legacy', plate: 'GJ01DD0006', departmentId: 'Traffic' }), /* self-set admin has no say in a department */);
  await denied(ann().collection('watchlist').add({ userId: 'ann', plate: 'GJ01DD0007' }), /* an operator was never allowed */);
  await ok(legacy().doc('watchlist/w-personal').get());
  await denied(owner().doc('watchlist/w-personal').get());
});

// ---- logs ----------------------------------------------------------------------------------------------------------------------

test('logs: a department\'s members read the logs of its cameras, and only those; nobody can tag a log into a department its camera is not in', { skip }, async () => {
  await ok(ann().collection('logs').where('departmentId', '==', 'Traffic').get());
  await ok(vic().doc('logs/l-traffic').get());
  await denied(ann().doc('logs/l-water').get());
  await denied(ann().doc('logs/l-personal').get());
  await ok(owner().doc('logs/l-personal').get());

  // The camera's owner (who is not in the department) writes the log with the camera's own department.
  await ok(owner().collection('logs').add({ userId: 'owner', cameraId: 'cam-traffic', summary: 's', departmentId: 'Traffic' }));
  await denied(owner().collection('logs').add({ userId: 'owner', cameraId: 'cam-traffic', summary: 's', departmentId: 'Water' }), /* not the camera's department */);
  await denied(owner().collection('logs').add({ userId: 'owner', cameraId: 'cam-plain', summary: 's', departmentId: 'Traffic' }), /* the camera has none */);
  await denied(owner().collection('logs').add({ userId: 'owner', cameraId: 'no-such-camera', summary: 's', departmentId: 'Traffic' }));
  await ok(owner().collection('logs').add({ userId: 'owner', cameraId: 'cam-plain', summary: 's' }), /* untagged logs as before */);
  await denied(ann().collection('logs').add({ userId: 'owner', cameraId: 'cam-traffic', summary: 's', departmentId: 'Traffic' }), /* not as someone else */);
  await denied(owner().doc('logs/l-traffic').update({ departmentId: 'Water' }));
  await ok(owner().doc('logs/l-traffic').update({ summary: 'edited' }));
  await denied(ann().doc('logs/l-traffic').delete(), /* department members read, they do not delete */);
});

// ---- what stays as it was ---------------------------------------------------------------------------------------------------------

test('unchanged: strangers and signed-out callers see nothing; cameras and the user document keep their rules', { skip }, async () => {
  const anon = env.unauthenticatedContext().firestore();
  for (const p of ['faces/f-traffic', 'watchlist/w-traffic', 'logs/l-traffic', 'cameras/cam-traffic']) await denied(anon.doc(p).get());
  await ok(ann().doc('cameras/cam-traffic').get());
  await denied(wes().doc('cameras/cam-traffic').get());
  await ok(owner().doc('cameras/cam-traffic').get());
  await denied(as('owner', {}).doc('users/legacy').get());
  await ok(as('legacy', {}).doc('users/legacy').get());
  await denied(as('legacy', {}).doc('users/legacy').update({ role: 'admin', managed: true }));
  await ok(ann().collection('cameras').where('departmentId', '==', 'Traffic').get());
  await ok(root().collection('cameras').get());
  assert.ok(true);
});
