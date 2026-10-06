#!/usr/bin/env node
/**
 * Measures every grid camera through the real pipeline (grid -> local media server -> HLS) and prints a ranked
 * list for GRID_HEALTH_ORDER in src/lib/cameraHealth.ts. Unlike a plain ffmpeg test this sees exactly what the
 * browser would: the codec the media server found, packet loss, muxer crashes ("too many reordered frames")
 * and how many segments actually arrived.
 *
 *   1. Start the demo:   bash scripts/local-demo.sh      (leave it running)
 *   2. In another terminal, from the project folder:   node scripts/check-media-health.mjs
 *
 * Cameras are tested one at a time, each for WATCH_S seconds (default 25), so a full run is about 15 minutes.
 * Every camera pulled counts against the grid account's watch time: run it once, not on demo day.
 * Options (env): CAMERAS=cam01,cam02  WATCH_S=25  MEDIA_URL=http://localhost:8888  MEDIA_VIEWER_PASSWORD=...
 */
import { readFileSync, existsSync } from 'node:fs';

// Defaults from demo.local, the same file the demo script reads.
const fileEnv = {};
if (existsSync('demo.local')) {
  for (const line of readFileSync('demo.local', 'utf8').replace(/\r/g, '').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
    if (m) fileEnv[m[1]] = m[2].trim();
  }
}
const base = (process.env.MEDIA_URL || 'http://localhost:8888').replace(/\/+$/, '');
const viewerPw = process.env.MEDIA_VIEWER_PASSWORD || fileEnv.MEDIA_VIEWER_PASSWORD || 'localdemo2026';
const watchS = Math.max(10, Number(process.env.WATCH_S) || 25);
const logFile = process.env.MEDIA_LOG || 'media-server/bin/mediamtx.log';
const ids = (process.env.CAMERAS || Array.from({ length: 30 }, (_, i) => `cam${String(i + 1).padStart(2, '0')}`).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const auth = { Authorization: 'Basic ' + Buffer.from(`viewer:${viewerPw}`).toString('base64') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** MediaMTX log lines about one camera between two moments (log timestamps are local time). */
function logEvents(id, from, to) {
  if (!existsSync(logFile)) return [];
  const out = [];
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    const m = line.match(/^(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d) (\w+) (.*)$/);
    if (!m || !new RegExp(`\\[(path|muxer) ${id}\\]`).test(m[8])) continue;
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (t >= from - 1000 && t <= to + 3000) out.push(m[8]);
  }
  return out;
}

async function measure(id) {
  const started = Date.now();
  let segments = 0, bytes = 0, e404 = 0, failure = '';
  try {
    const master = await fetch(`${base}/${id}/index.m3u8?cookieCheck=1`, { headers: auth, signal: AbortSignal.timeout(70_000) });
    if (!master.ok) throw new Error(`master ${master.status}`);
    const mediaRel = (await master.text()).split('\n').find((l) => l.trim() && !l.startsWith('#'));
    if (!mediaRel) throw new Error('no media playlist in master');
    const mediaUrl = new URL(mediaRel.trim(), `${base}/${id}/index.m3u8`).toString();
    const seen = new Set();
    const firstSegmentAt = { t: 0 };
    while (Date.now() - started < watchS * 1000) {
      const pl = await fetch(mediaUrl, { headers: auth, signal: AbortSignal.timeout(15_000) });
      if (!pl.ok) { if (pl.status === 404) e404++; await sleep(1000); continue; }
      const lines = (await pl.text()).split('\n').map((l) => l.trim());
      const uris = lines.filter((l) => l && !l.startsWith('#'));
      const init = lines.find((l) => l.startsWith('#EXT-X-MAP'))?.match(/URI="([^"]+)"/)?.[1];
      if (init && !seen.has(init)) { seen.add(init); await fetch(new URL(init, mediaUrl), { headers: auth }).then((r) => r.arrayBuffer()).catch(() => {}); }
      for (const u of uris) {
        if (seen.has(u)) continue;
        seen.add(u);
        const r = await fetch(new URL(u, mediaUrl), { headers: auth, signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (r?.ok) { bytes += (await r.arrayBuffer()).byteLength; segments++; if (!firstSegmentAt.t) firstSegmentAt.t = Date.now(); } else if (r?.status === 404) e404++;
      }
      await sleep(1000);
    }
    var firstSegS = firstSegmentAt.t ? (firstSegmentAt.t - started) / 1000 : null;
  } catch (e) { failure = e instanceof Error ? e.message : String(e); }
  const end = Date.now();
  await sleep(1500); // let the log catch up
  const ev = logEvents(id, started, end);
  const codec = (ev.join('\n').match(/1 track \((\w+)\)/) || [])[1] || '?';
  const lost = ev.reduce((a, l) => a + (Number((l.match(/(\d+) RTP packets lost/) || [])[1]) || 0), 0);
  const muxErr = ev.filter((l) => /muxer error|destroyed: muxer/.test(l)).length;
  const srcErr = ev.filter((l) => /stopped: an error/.test(l)).length;
  return { id, segments, e404, firstSegS: firstSegS ?? null, codec, lost, muxErr, srcErr, failure, kb: Math.round(bytes / 1024) };
}

const res = [];
for (const id of ids) {
  const r = await measure(id);
  // Healthy = H.264, plays right away, nearly one segment per second of watching, nothing crashed, little loss.
  r.healthy = !r.failure && r.codec === 'H264' && r.segments >= watchS * 0.5 && r.muxErr === 0 && r.srcErr === 0 && r.lost < 100;
  r.score = (r.healthy ? 1000 : 0) + (r.codec === 'H264' ? 200 : 0) + Math.min(r.segments, 100) * 2 - r.lost / 10 - r.muxErr * 100 - r.srcErr * 50 - (r.firstSegS ?? watchS);
  res.push(r);
  console.log(`${id}  ${r.healthy ? 'OK  ' : 'BAD '} codec ${r.codec}  segs ${r.segments}  first ${r.firstSegS?.toFixed(1) ?? '-'}s  lost ${r.lost}  muxErr ${r.muxErr}  srcErr ${r.srcErr}  404s ${r.e404}${r.failure ? '  ' + r.failure : ''}`);
}
res.sort((a, b) => b.score - a.score);
console.log('\nRanked best first (paste into GRID_HEALTH_ORDER in src/lib/cameraHealth.ts):\n');
console.log('[' + res.map((r) => `'${r.id}'`).join(', ') + ']');
const good = res.filter((r) => r.healthy);
console.log(`\n${good.length} healthy camera(s): ${good.map((r) => r.id).join(', ') || 'none'}${good.length < 10 ? `\nOnly ${good.length} healthy: a page of 10 cannot be fully live from this grid.` : ''}`);
