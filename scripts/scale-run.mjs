// Starts the app with the settings in scale.local, in any shell (PowerShell, cmd, Git Bash).
//
//   node scripts/scale-run.mjs all                      one process does everything (stage 1)
//   node scripts/scale-run.mjs scheduler                scheduler only, port 3000      (stage 2)
//   node scripts/scale-run.mjs worker                   worker only, port 3001         (stage 2)
//   add --no-redis and/or --no-pg to leave those out, --port 3002 to change the port,
//   --check to only report what would be used (values are never printed).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const role = args.find((a) => ['all', 'scheduler', 'worker'].includes(a));
if (!role) { console.error('Usage: node scripts/scale-run.mjs <all|scheduler|worker> [--no-redis] [--no-pg] [--port N] [--check]'); process.exit(1); }
const flag = (f) => args.includes(f);
const portIdx = args.indexOf('--port');

const file = path.join(root, 'scale.local');
if (!fs.existsSync(file)) { console.error('scale.local not found in ' + root); process.exit(1); }

const env = { ...process.env };
for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 1) continue;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) value = value.slice(1, -1);
  env[key] = value;
}

if (flag('--no-redis')) delete env.REDIS_URL;
if (flag('--no-pg')) { delete env.EVENT_STORE; delete env.DATABASE_URL; delete env.DATABASE_SSL; delete env.FIRESTORE_LOG_MODE; }
if (role !== 'all') {
  if (!env.REDIS_URL) { console.error(`Role "${role}" needs REDIS_URL (and you passed --no-redis, or it is missing from scale.local).`); process.exit(1); }
  env.ANALYSIS_ROLE = role;
} else {
  delete env.ANALYSIS_ROLE;
  delete env.REDIS_URL; // "all" runs everything in one process with the in-memory queue
}
env.PORT = portIdx >= 0 ? args[portIdx + 1] : role === 'worker' ? '3001' : '3000';

console.log(`role=${role}  port=${env.PORT}  redis=${env.REDIS_URL ? 'on' : 'off'}  events=${env.EVENT_STORE === 'postgres' ? 'postgres' : 'firestore'}`);
console.log('required: ' + ['FIREBASE_SERVICE_ACCOUNT', 'GEMINI_API_KEY', 'STREAM_EMAIL', 'STREAM_PASSWORD', 'SERVER_ANALYSIS'].map((k) => `${k}=${env[k] ? 'set' : 'MISSING'}`).join(' '));
if (flag('--check')) process.exit(0);

const child = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server.ts'], { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
