// Checks a running ANPR service (anpr-service/) from the machine that runs the main app.
//
//   ANPR_SERVICE_URL=https://your-gpu-host:8000 ANPR_API_KEY=... \
//     node scripts/check-anpr.mjs [frame.jpg] [--runs 20] [--cameras 50] [--interval 60]
//
// It reports: is the service reachable, which device it is really using (cuda/cpu),
// does it accept your API key, and — if you pass a real frame — how fast it is and
// whether that is enough for your camera count. Needs Node 18+, no dependencies.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : fallback; };
const framePath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const runs = flag('runs', 20), cameras = flag('cameras', 50), interval = flag('interval', 60);

const base = (process.env.ANPR_SERVICE_URL || '').replace(/\/+$/, '');
const key = process.env.ANPR_API_KEY || '';
if (!base) { console.error('Set ANPR_SERVICE_URL (e.g. https://your-host:8000).'); process.exit(2); }

const headers = (extra = {}) => ({ ...extra, ...(key ? { 'X-ANPR-Key': key } : {}) });
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

console.log(`Checking ${base}\n`);

let health;
try {
  const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) fail(`/healthz answered ${res.status}. Is this the ANPR service's address and port?`);
  health = await res.json();
} catch (err) {
  fail(`Can't reach the service (${err.cause?.code || err.cause?.errors?.[0]?.code || err.message}). Check the URL, that the port is open / tunnel is up, and that the service has finished loading its models.`);
}
console.log(`✓ reachable        device: ${health.device}   providers: ${(health.providers || []).join(', ') || 'n/a'}`);
if (health.device !== 'cuda') console.log('  note: running on CPU. That can be fine — see the speed result below.');
console.log(`  auth required on the service: ${health.auth_required ? 'yes' : 'NO — anyone who finds this URL can use it'}`);

// A 16x16 grey JPEG, same idea as the app's own probe.
const tinyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAAQABABAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=', 'base64');
async function post(body) {
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/anpr`, { method: 'POST', headers: headers({ 'Content-Type': 'image/jpeg' }), body, signal: AbortSignal.timeout(60_000) });
  return { res, wallMs: performance.now() - t0 };
}

{
  const { res } = await post(tinyJpeg).catch((e) => fail(`Request failed: ${e.message}`));
  if (res.status === 401) fail('The service rejected the API key. ANPR_API_KEY here must match the key the service was started with.');
  if (!res.ok) fail(`Test request answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log('✓ API key accepted');
}

if (!framePath) {
  console.log('\nPass a real frame (a JPEG from one of your cameras) to measure speed:\n  node scripts/check-anpr.mjs frame.jpg');
  process.exit(0);
}

const frame = readFileSync(framePath);
const server = [], wall = [];
let sample;
for (let i = 0; i < runs; i++) {
  const { res, wallMs } = await post(frame);
  if (!res.ok) fail(`Run ${i + 1} answered ${res.status}`);
  const body = await res.json();
  if (i === 0) sample = body;       // first call includes warm-up; excluded from the stats below
  else { server.push(body.elapsed_ms); wall.push(wallMs); }
}
server.sort((a, b) => a - b); wall.sort((a, b) => a - b);
const plates = sample.plates.map((p) => `${p.text} (${Math.round(p.confidence * 100)}%)`).join(', ') || 'none found';
console.log(`\nPlates in that frame: ${plates}`);
console.log(`Image ${sample.image.width}x${sample.image.height}, ${runs - 1} timed runs after warm-up`);
console.log(`  inference on the service : median ${pct(server, 50)} ms, p95 ${pct(server, 95)} ms`);
console.log(`  round trip from here     : median ${Math.round(pct(wall, 50))} ms, p95 ${Math.round(pct(wall, 95))} ms (includes network)`);

const medianSeconds = pct(wall, 50) / 1000;
const needed = cameras / interval;              // frames per second the grid will send
const capacity = 1 / medianSeconds;             // frames per second one request-at-a-time can sustain
console.log(`\nYour load: ${cameras} cameras every ${interval} s ≈ ${needed.toFixed(2)} frames/s`);
console.log(`This host, one request at a time: ≈ ${capacity.toFixed(1)} frames/s`);
if (capacity >= needed * 2) console.log(`✓ Plenty of headroom (${(capacity / needed).toFixed(0)}x). ${health.device === 'cpu' ? 'CPU is enough for this load — a GPU is not needed.' : ''}`);
else if (capacity >= needed) console.log('~ Enough, but with little headroom. Allow for bursts and for the other work on the host.');
else console.log('✗ Too slow for this load. Use a faster/GPU host, shorten the camera count, or lengthen the interval.');
console.log('\nNote: this measures the plate service only. Capturing frames and the Gemini call are separate costs (see docs/onboarding.md).');
