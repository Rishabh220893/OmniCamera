/**
 * Writes the MediaMTX paths that make a regional gateway's media server record its cameras (docs/regional-gateway.md, "Recorded video").
 *
 *   npm run edge-recording-config -- cameras.json /var/recordings > mediamtx-paths.yml
 *
 * `cameras.json` is a list of { "id": "<the camera's id at the centre>", "url": "rtsp://user:pass@192.168.1.10:554/stream1" }. The path name is the
 * camera id, which is what the gateway's clip worker and the centre's requests use. Paste the output under `paths:` of the gateway's mediamtx.yml and
 * set GATEWAY_RECORDINGS_DIR to the same folder. Segments are 10 minutes of the camera's own H.264/H.265 (no re-encoding); the gateway's retention
 * (GATEWAY_RECORDINGS_KEEP_DAYS) deletes old ones, so `recordDeleteAfter` is left at 0s.
 */
import { readFileSync } from 'node:fs';
import { recordFields } from '../server/recording/policy';

const [file, dir] = process.argv.slice(2);
if (!file || !dir) { console.error('Usage: npm run edge-recording-config -- cameras.json <recordings folder>'); process.exit(2); }
const cams = JSON.parse(readFileSync(file, 'utf8')) as Array<{ id?: unknown; url?: unknown }>;
const q = (s: string) => JSON.stringify(s); // a JSON string is a valid YAML string
const rec = recordFields(dir);
const lines: string[] = [];
for (const c of cams) {
  if (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(c.id) || typeof c.url !== 'string' || !/^rtsps?:\/\//i.test(c.url)) { console.error(`Skipped a camera: it needs an id (letters, digits, _ -) and an rtsp:// url: ${JSON.stringify(c.id)}`); continue; }
  lines.push(`  ${c.id}:`, `    source: ${q(c.url)}`, '    rtspTransport: tcp', '    sourceOnDemand: no', '    record: yes', `    recordPath: ${q(rec.recordPath)}`, `    recordFormat: ${rec.recordFormat}`, `    recordPartDuration: ${rec.recordPartDuration}`, `    recordSegmentDuration: ${rec.recordSegmentDuration}`, `    recordDeleteAfter: ${rec.recordDeleteAfter}`);
}
console.log(lines.join('\n'));
