/**
 * Checks the registry's PostGIS mirror against a REAL database (the unit tests only use a fake one).
 *
 *   DATABASE_URL=postgres://... [DATABASE_SSL=true] npm run registry-postgis-check -- --yes
 *
 * What it changes: it may run CREATE EXTENSION IF NOT EXISTS postgis (needs a role that may; Neon allows it), creates a scratch schema
 * `registry_check_<random>` with the registry table inside it, writes 5 sample cameras there, reads them back through the same code the
 * server uses, and DROPS the scratch schema at the end (also when a check fails). It does not touch any other table.
 * Without --yes it only says what it would do.
 */
import { randomBytes } from 'node:crypto';
import { createRegistryMirror } from '../server/registry/postgis.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL.'); process.exit(2); }
if (!process.argv.includes('--yes')) {
  console.log('Dry run. With --yes this would: CREATE EXTENSION IF NOT EXISTS postgis; create a scratch schema with the registry table; insert 5 sample cameras; query them; drop the scratch schema.');
  process.exit(0);
}

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: url, max: 1, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
const schema = `registry_check_${randomBytes(4).toString('hex')}`;
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` ${detail}`}`); if (!cond) failed++; };

const client = await pool.connect();
try {
  await client.query('CREATE EXTENSION IF NOT EXISTS postgis');   // in the default schema, before the search path changes
  const ver = await client.query('SELECT postgis_full_version() AS v');
  console.log(`PostGIS: ${String(ver.rows[0].v).split(' ').slice(0, 2).join(' ')}`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  const mirror = createRegistryMirror(client as never, (m) => console.log(m));
  check('init creates the table and indexes', await mirror.init());
  mirror.markReady();

  const doc = (name: string, lat: number | null, lng: number | null, extra: Record<string, unknown> = {}) => ({ id: name.replace(/\W+/g, '-').toLowerCase(), data: { userId: 'check-user', name, department: 'Traffic', ...(lat === null ? {} : { location: { lat, lng } }), ...extra } });
  await mirror.apply([
    doc('MG Road', 12.9716, 77.5946, { connectivityStatus: 'online', installDate: '2023-06-15', cameraType: 'ptz' }),
    doc('Bus Gate', 12.9767, 77.5713, { connectivityStatus: 'offline', installDate: '2015-01-02', cameraType: 'dome', department: 'Transport' }),
    doc('Ring Road', 13.04, 77.59, { connectivityStatus: 'online', cameraType: 'fixed' }),
    doc('Old Fort', 12.93, 77.61, { connectivityStatus: 'degraded', department: 'Municipal' }),
    doc('No Location', null, null),
  ], []);

  const all = await mirror.list('check-user', {});
  check('all 5 cameras are listed', all?.length === 5, JSON.stringify(all?.map((c) => c.id)));
  check('a camera without coordinates has no location', all?.find((c) => c.id === 'no-location')?.location === undefined);
  check('longitude and latitude come back the right way round', all?.find((c) => c.id === 'mg-road')?.location?.lat === 12.9716 && all?.find((c) => c.id === 'mg-road')?.location?.lng === 77.5946);
  check('filter by status', (await mirror.list('check-user', { status: 'offline' }))?.map((c) => c.id).join() === 'bus-gate');
  check('filter by department (any case)', (await mirror.list('check-user', { department: 'transport' }))?.length === 1);
  check('filter by installedBefore', (await mirror.list('check-user', { installedBefore: '2020-01-01' }))?.map((c) => c.id).join() === 'bus-gate');
  check('bounding box', (await mirror.list('check-user', { bbox: [77.5, 12.9, 77.65, 13.0] }))?.length === 3, 'MG Road, Bus Gate and Old Fort are inside; Ring Road (13.04) is not');
  check('text search', (await mirror.list('check-user', { q: 'road' }))?.length === 2);
  check('another user sees nothing', (await mirror.list('someone-else', {}))?.length === 0);

  await mirror.apply([doc('MG Road', 12.9716, 77.5946, { name: 'MG Road Junction', connectivityStatus: 'offline' })], ['bus-gate']);
  const after = await mirror.list('check-user', {});
  check('update and delete are applied', after?.length === 4 && after.find((c) => c.id === 'mg-road')?.connectivityStatus === 'offline' && !after.some((c) => c.id === 'bus-gate'));

  const g = await mirror.gaps('check-user', { radiusMeters: 300 });
  check('gap analysis runs in the database', !!g && g.located === 3 && g.cellsChecked > 0 && g.uncoveredTotal > 0, JSON.stringify(g && { located: g.located, cells: g.cellsChecked, uncovered: g.uncoveredTotal }));
  if (g) console.log(`     ${g.cellsChecked} squares of ${g.cellMeters} m; ${g.uncoveredTotal} uncovered; emptiest at ${g.zones[0]?.lat}, ${g.zones[0]?.lng} (${g.zones[0]?.nearestMeters} m from a camera)`);
  const st = mirror.status();
  check('status is healthy', st.ready && st.errors === 0, JSON.stringify(st));
} catch (e) {
  failed++;
  console.error('FAIL', e instanceof Error ? e.message : e);
} finally {
  try { await client.query('SET search_path TO public'); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); console.log(`Scratch schema ${schema} dropped.`); } catch (e) { console.error(`Could not drop ${schema}:`, e instanceof Error ? e.message : e); }
  client.release();
  await pool.end();
}
console.log(failed ? `${failed} check(s) failed.` : 'All checks passed.');
process.exit(failed ? 1 : 0);
