/*
 * ONE-TIME clean-up: removes duplicate camera documents from Firestore. Paste the whole file into the browser console of the OmniSee
 * page while you are signed in as an ADMIN (it uses your own sign-in; nothing is sent anywhere except to Firestore).
 *
 *   1. Run it as is: it only REPORTS what it would remove (dry run) and changes nothing.
 *   2. Read the report. If it is right, change `const APPLY = false` to `true` and run it again.
 *      Before deleting, it downloads a backup file (cameras-removed-<time>.json) with every document it is about to delete.
 *
 * What counts as a duplicate: the same remote stream address (compared lower-case, with any login removed), the rule the app itself
 * uses to show a camera once. Cameras without a remote stream address are never touched. In each group one copy is kept:
 *   the one given to a department, then the one you own, then one with server analysis on, then one analysed most recently, then the oldest.
 * Never deleted: cameras that belong to a regional gateway; groups whose copies are given to *different* departments (reported, for you to decide).
 * Deleting a copy removes it for the account that registered it; logs and events that mention its id stay but no longer link to a camera.
 * Needs the newer firestore.rules to be deployed (an administrator may then read and delete every camera).
 */
(async () => {
  const APPLY = false; // <- change to true for the real run

  // ---- who am I (the app's own sign-in, kept by Firebase in the browser) ----
  const idb = await new Promise((res, rej) => { const r = indexedDB.open('firebaseLocalStorageDb'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const rows = await new Promise((res, rej) => { const q = idb.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const me = rows.map((r) => r.value).find((v) => v && v.stsTokenManager && v.uid);
  if (!me) { console.error('Not signed in with an account (the guest demo has no account). Sign in as an administrator and run this again.'); return; }
  if (Date.now() > me.stsTokenManager.expirationTime - 30_000) { console.error('Your sign-in token has expired. Reload the page, wait for the app to load, and run this again.'); return; }
  const token = me.stsTokenManager.accessToken;
  const project = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).aud;
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  const headers = { Authorization: `Bearer ${token}` };
  console.log(`Signed in as ${me.email || me.uid}, project ${project}. ${APPLY ? 'REAL RUN: duplicates will be deleted.' : 'DRY RUN: nothing will be changed.'}`);

  // ---- read every camera ----
  const docs = [];
  let pageToken = '';
  do {
    const r = await fetch(`${base}/cameras?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers });
    if (!r.ok) { console.error(`Could not read the cameras (HTTP ${r.status}). ${r.status === 403 ? 'The Firestore rules do not let this account read every camera: deploy firestore.rules and make sure this is an administrator.' : ''}`, await r.text()); return; }
    const j = await r.json();
    docs.push(...(j.documents || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);

  const val = (f) => (f === undefined ? undefined : f.stringValue ?? f.booleanValue ?? f.integerValue ?? f.timestampValue ?? f.doubleValue);
  const cams = docs.map((d) => {
    const f = d.fields || {};
    return {
      id: d.name.split('/').pop(), name: val(f.name) || '', owner: val(f.userId) || '', dept: val(f.departmentId) || '', gateway: val(f.gatewayId) || '',
      remote: val(f.useRemoteFeed) === true, url: String(val(f.remoteStreamUrl) || '').trim().toLowerCase().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/, '$1'),
      analysis: val(f.serverAnalysis) === true, analysed: val(f.lastAnalysisTime) || '', created: val(f.createdAt) || d.createTime || '', raw: d,
    };
  });
  console.log(`${cams.length} camera documents read.`);

  // ---- group and choose ----
  const groups = new Map();
  for (const c of cams) { if (!c.remote || !c.url) continue; (groups.get(c.url) || groups.set(c.url, []).get(c.url)).push(c); }
  const score = (c) => (c.dept ? 8 : 0) + (c.owner === me.uid ? 4 : 0) + (c.analysis ? 2 : 0) + (c.analysed ? 1 : 0);
  const remove = [], keep = [], skipped = [];
  for (const [url, list] of groups) {
    if (list.length < 2) continue;
    const depts = new Set(list.map((c) => c.dept).filter(Boolean));
    if (depts.size > 1) { skipped.push({ url, why: `copies are given to different departments (${[...depts].join(', ')})`, ids: list.map((c) => c.id).join(' ') }); continue; }
    const ranked = [...list].sort((a, b) => score(b) - score(a) || String(a.created).localeCompare(String(b.created)));
    keep.push(ranked[0]);
    for (const c of ranked.slice(1)) {
      if (c.gateway) { skipped.push({ url, why: 'belongs to a regional gateway, not deleted', ids: c.id }); continue; }
      remove.push({ c, keptId: ranked[0].id });
    }
  }
  console.log(`${groups.size} distinct remote cameras; ${keep.length} have duplicates; ${remove.length} copies to remove.`);
  if (skipped.length) console.table(skipped);
  console.table(remove.map(({ c, keptId }) => ({ remove: c.id, name: c.name, owner: c.owner === me.uid ? '(you)' : c.owner, dept: c.dept || '-', keeping: keptId })));
  if (!remove.length) { console.log('Nothing to remove.'); return; }
  if (!APPLY) { console.log('Dry run finished. If the list above is right, set APPLY to true at the top of the script and run it again.'); return; }

  // ---- backup, then delete ----
  const blob = new Blob([JSON.stringify(remove.map(({ c }) => c.raw), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cameras-removed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  await new Promise((r) => setTimeout(r, 1500));

  let done = 0;
  for (const { c } of remove) {
    const r = await fetch(`${base}/cameras/${encodeURIComponent(c.id)}`, { method: 'DELETE', headers });
    if (!r.ok) { console.error(`Stopped: could not delete ${c.id} (HTTP ${r.status}). ${done} deleted so far.`, await r.text()); return; }
    done++;
    if (done % 20 === 0) console.log(`${done}/${remove.length} deleted...`);
    await new Promise((res) => setTimeout(res, 80));
  }
  console.log(`Done: ${done} duplicate cameras deleted. Reload the page. The backup file has the removed documents.`);
})();
