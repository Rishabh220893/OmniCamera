import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiCallsPerMinute, plannedRecipes, tileSubtitle, tileTitle } from '../src/lib/panelTiles.ts';
import { gridCamId } from '../src/lib/gridCamId.ts';

const url = (id: string) => `https://cctv.corp8.cloud/${id}/index.m3u8`;
const base = { camId: 'cam07', url: url('cam07'), hlsSupported: true, media: null, hasLogin: true };

test('recipes: every way that applies is tried, cheapest for the grid first', () => {
  assert.deepEqual(plannedRecipes({ ...base, media: { enabled: true } }), ['media', 'whep', 'proxy', 'stills']);
  assert.deepEqual(plannedRecipes(base), ['whep', 'proxy', 'stills'], 'no media server configured');
  assert.deepEqual(plannedRecipes({ ...base, media: { enabled: false } }), ['whep', 'proxy', 'stills']);
});

test('recipes: WebRTC is tried even though a tile only uses it when the URL opts in', () => {
  assert.ok(plannedRecipes(base).includes('whep'), 'the corp8 URL has no ?transport=whep, and WHEP is still planned');
  assert.ok(plannedRecipes({ ...base, url: 'https://103.250.160.189/live/stream/cam07/index.m3u8' }).includes('whep'));
});

test('recipes: no login means no proxy and no stills; no hls.js means no media server and no proxy', () => {
  assert.deepEqual(plannedRecipes({ ...base, hasLogin: false, media: { enabled: true } }), ['media', 'whep']);
  assert.deepEqual(plannedRecipes({ ...base, hlsSupported: false, media: { enabled: true } }), ['whep', 'stills']);
  assert.deepEqual(plannedRecipes({ ...base, hlsSupported: false, hasLogin: false }), ['whep']);
});

test('recipes: a camera that is not on the grid has nothing to try here', () => {
  assert.deepEqual(plannedRecipes({ ...base, camId: null, url: 'https://cams.example.org/lobby/index.m3u8' }), ['proxy']);
  assert.deepEqual(plannedRecipes({ ...base, camId: null, url: 'rtsp://cams.example.org/lobby', hasLogin: false }), []);
});

test('tiles: the id is the title and the rest of the name is the subtitle', () => {
  const c = (name: string, remoteStreamUrl: string, extra = {}) => ({ name, remoteStreamUrl, ...extra });
  assert.equal(tileTitle(c('CAM07 Hero showroom', url('cam07'))), 'CAM07');
  assert.equal(tileSubtitle(c('CAM07 Hero showroom', url('cam07'))), 'Hero showroom');
  assert.equal(tileSubtitle(c('cam07 - hero-showroom-gir-somnath', url('cam07'))), 'hero-showroom-gir-somnath');
  assert.equal(tileSubtitle(c('cam07: Hero', url('cam07'))), 'Hero');
  assert.equal(tileSubtitle(c('CAM07', url('cam07'), { location: { lat: 21.5, lng: 70.46 } })), '21.500, 70.460', 'a bare id falls back to the position');
  assert.equal(tileSubtitle(c('CAM07', url('cam07'), { department: 'Traffic' })), 'Traffic');
  assert.equal(tileTitle(c('Front door', 'https://cams.example.org/a.m3u8')), 'FRONT DOOR');
  assert.equal(tileSubtitle(c('Front door', 'https://cams.example.org/a.m3u8')), '');
});

test('grid camera id: both URL shapes, case-insensitive, never a partial match', () => {
  assert.equal(gridCamId('https://cctv.corp8.cloud/cam07/index.m3u8'), 'cam07');
  assert.equal(gridCamId('http://103.250.160.189/live/stream/CAM12/index.m3u8'), 'cam12');
  assert.equal(gridCamId('https://example.org/webcam07x/index.m3u8'), null);
  assert.equal(gridCamId('https://example.org/cam1234/index.m3u8'), null);
});

test('cost: ten seconds across 30 cameras is at most 180 Gemini calls a minute', () => {
  assert.equal(geminiCallsPerMinute(30), 180);
  assert.equal(geminiCallsPerMinute(30, 60), 30);
  assert.equal(geminiCallsPerMinute(1), 6);
  assert.equal(geminiCallsPerMinute(30, 0), 1800, 'a nonsense interval is treated as one second');
});
