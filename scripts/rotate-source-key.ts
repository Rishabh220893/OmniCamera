/**
 * Rotates SOURCE_SECRET_KEY: re-seals every stored camera login and department-system login with a new key.
 *
 *   1. Make a new key:   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. In the environment (scale.local / .env.local): SOURCE_SECRET_KEY=<new>   SOURCE_SECRET_KEY_PREVIOUS=<old>
 *   3. Dry run (changes nothing, prints counts):   npm run rotate-source-key
 *   4. Do it (stop nothing: the server can keep running):   npm run rotate-source-key -- --yes
 *   5. Restart the server, check the sources still play, then remove SOURCE_SECRET_KEY_PREVIOUS.
 *
 * Needs DATABASE_URL (camera sources); the systems file is read from VMS_SYSTEMS_FILE or <VMS_DATA_DIR or .data>/vms-systems.json.
 * Prints counts and camera ids, never a login or a key. Back up the old key until step 5 is done: a value no key opens is reported, not changed.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createPostgresSourceStore } from '../server/sources/store';
import { rotateSources, rotateSystemsFile } from '../server/sources/rotate';
import { secretBoxFromEnv } from '../server/sources/secretBox';

for (const f of ['.env.local', 'demo.local', 'scale.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

async function main() {
  const apply = process.argv.includes('--yes');
  const box = secretBoxFromEnv(process.env);
  if (!box) { console.error('SOURCE_SECRET_KEY is not set.'); process.exit(2); }
  if (!process.env.SOURCE_SECRET_KEY_PREVIOUS) console.warn('Note: SOURCE_SECRET_KEY_PREVIOUS is not set, so only values already sealed with the current key (and clear-text logins) can be handled.');
  console.log(apply ? 'Re-sealing...' : 'Dry run (nothing is changed). Add --yes to apply.');

  const file = process.env.VMS_SYSTEMS_FILE || path.join(process.env.VMS_DATA_DIR || path.join(process.cwd(), '.data'), 'vms-systems.json');
  const sys = await rotateSystemsFile({ file, box, dryRun: !apply });
  console.log(`Department systems (${file}): ${sys.checked} login(s), ${sys.resealed} ${apply ? 're-sealed' : 'to re-seal'}, ${sys.alreadyCurrent} already current${sys.unreadable.length ? `, UNREADABLE: ${sys.unreadable.join(', ')}` : ''}`);

  if (process.env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
    try {
      const store = createPostgresSourceStore(pool);
      await store.ensureSchema();
      const src = await rotateSources({ sources: store, box, dryRun: !apply });
      console.log(`Camera sources: ${src.checked} login(s), ${src.resealed} ${apply ? 're-sealed' : 'to re-seal'}, ${src.alreadyCurrent} already current${src.unreadable.length ? `, UNREADABLE: ${src.unreadable.join(', ')}` : ''}`);
      if (src.unreadable.length) process.exitCode = 1;
    } finally { await pool.end(); }
  } else console.log('Camera sources: DATABASE_URL is not set, skipped.');
  if (sys.unreadable.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
