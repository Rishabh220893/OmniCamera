import test from 'node:test';
import assert from 'node:assert/strict';
import { trimLiveManifest } from '../server/hlsManifest.ts';

const seg = (i: number) => `#EXTINF:6.003000,\nseg${String(i).padStart(5, '0')}.ts`;
const playlist = (n: number, extraHeader: string[] = [], tail: string[] = []) =>
  ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:7', ...extraHeader, ...Array.from({ length: n }, (_, i) => seg(i)), ...tail].join('\n') + '\n';

test('keeps only the newest segments and advances the media sequence', () => {
  const r = trimLiveManifest(playlist(2700), 10);
  assert.equal(r.trimmed, true);
  assert.equal(r.totalSegments, 2700);
  assert.equal(r.keptSegments, 10);
  assert.equal((r.text.match(/#EXTINF/g) || []).length, 10);
  assert.match(r.text, /#EXT-X-MEDIA-SEQUENCE:2690\n/);
  assert.ok(r.text.includes('seg02699.ts') && r.text.includes('seg02690.ts') && !r.text.includes('seg02689.ts'));
  assert.ok(r.text.startsWith('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n#EXT-X-MEDIA-SEQUENCE:2690'));
});

test('adds to an existing media sequence and drops VOD/EVENT type so players start at the live edge', () => {
  const r = trimLiveManifest(playlist(30, ['#EXT-X-MEDIA-SEQUENCE:100', '#EXT-X-PLAYLIST-TYPE:EVENT']), 5);
  assert.match(r.text, /#EXT-X-MEDIA-SEQUENCE:125\n/);
  assert.ok(!r.text.includes('PLAYLIST-TYPE'));
  assert.equal(r.hadPlaylistType, true);
});

test('leaves a short playlist untouched', () => {
  const p = playlist(4, ['#EXT-X-PLAYLIST-TYPE:EVENT']);
  const r = trimLiveManifest(p, 10);
  assert.equal(r.trimmed, false);
  assert.equal(r.text, p);
});

test('keeps the end-of-list marker when there is one', () => {
  const r = trimLiveManifest(playlist(20, [], ['#EXT-X-ENDLIST']), 5);
  assert.equal(r.hadEndList, true);
  assert.ok(r.text.trimEnd().endsWith('#EXT-X-ENDLIST'));
});

test('keeps the encryption key declared in the header and re-attaches one from a dropped segment', () => {
  const withKey = playlist(20, ['#EXT-X-KEY:METHOD=AES-128,URI="enc.key"']);
  assert.ok(trimLiveManifest(withKey, 5).text.includes('#EXT-X-KEY:METHOD=AES-128,URI="enc.key"'));

  const lines = playlist(20).split('\n');
  const idx = lines.findIndex((l) => l.includes('seg00003.ts')) - 1; // insert before that segment's EXTINF
  lines.splice(idx, 0, '#EXT-X-KEY:METHOD=AES-128,URI="rotated.key"');
  const r = trimLiveManifest(lines.join('\n'), 5);
  assert.equal((r.text.match(/#EXT-X-KEY/g) || []).length, 1);
  assert.ok(r.text.indexOf('#EXT-X-KEY') < r.text.indexOf('#EXTINF'));
});

test('counts dropped discontinuities into the discontinuity sequence', () => {
  const lines = playlist(20).split('\n');
  const idx = lines.findIndex((l) => l.includes('seg00002.ts')) - 1;
  lines.splice(idx, 0, '#EXT-X-DISCONTINUITY');
  const r = trimLiveManifest(lines.join('\n'), 5);
  assert.match(r.text, /#EXT-X-DISCONTINUITY-SEQUENCE:1\n/);
});

test('is a no-op on text that is not a segment playlist', () => {
  const r = trimLiveManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n', 10);
  assert.equal(r.trimmed, false);
});

test('live: the end-of-list marker is dropped, trimmed or not, so a player follows the live edge instead of stopping', () => {
  const trimmed = trimLiveManifest(playlist(20, [], ['#EXT-X-ENDLIST']), 5, { live: true });
  assert.equal(trimmed.trimmed, true);
  assert.equal(trimmed.hadEndList, true, 'still reported, so the log says the grid sent one');
  assert.ok(!trimmed.text.includes('#EXT-X-ENDLIST'));
  const short = trimLiveManifest(playlist(3, [], ['#EXT-X-ENDLIST']), 5, { live: true });
  assert.equal(short.trimmed, false);
  assert.ok(!short.text.includes('#EXT-X-ENDLIST'));
  assert.ok(trimLiveManifest(playlist(3, [], ['#EXT-X-ENDLIST']), 5).text.includes('#EXT-X-ENDLIST'), 'other hosts are unchanged');
});
