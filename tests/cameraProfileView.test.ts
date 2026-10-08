import test from 'node:test';
import assert from 'node:assert/strict';
import { ageLabel, filterViews, measuredLine, recipeTone, type ProfileView } from '../src/lib/cameraProfileView.ts';
import { profileView } from '../server/profileService.ts';
import { GRID_REPORTS } from './fixtures/grid-2026-10-08.ts';

const views: ProfileView[] = GRID_REPORTS.map((report) => profileView({ report, override: report.cameraId === 'cam01' ? 'B' : null, overrideReason: report.cameraId === 'cam01' ? 'demo' : null }, 'qsv'));
const v = (id: string) => views.find((x) => x.cameraId === id)!;

test('measured line: codec, size, first picture, keyframe gap and damage, in words', () => {
  assert.equal(measuredLine(v('cam06')), 'H.265 · 1920×1080 · first picture 3.4 s · keyframes up to 6.2 s apart · 88 decoder errors per 100 frames');
  assert.equal(measuredLine(v('cam03')), 'H.264 · 1280×720 · first picture 3.1 s · keyframes up to 1.2 s apart');
  assert.equal(measuredLine(v('cam22')), 'H.265 · 1920×1080', 'a camera that never gave a frame shows only what was described');
});

test('recipe tones: direct is good, a re-encode is a cost, snapshots a warning, unsupported a problem', () => {
  assert.deepEqual(['A', 'B', 'C', 'D', 'F', 'G'].map((c) => recipeTone(c as 'A')), ['badge-success', 'badge-accent', 'badge-accent', 'badge-accent', 'badge-warning', 'badge-critical']);
});

test('filter by recipe, by override, and by text (camera, codec, problem or reason)', () => {
  assert.equal(filterViews(views, { recipe: 'all', query: '' }).length, 30);
  assert.deepEqual(filterViews(views, { recipe: 'G', query: '' }).map((x) => x.cameraId), ['cam21', 'cam22']);
  assert.deepEqual(filterViews(views, { recipe: 'override', query: '' }).map((x) => x.cameraId), ['cam01']);
  assert.deepEqual(filterViews(views, { recipe: 'all', query: 'cam26' }).map((x) => x.cameraId), ['cam26']);
  assert.ok(filterViews(views, { recipe: 'all', query: 'above 1080p' }).some((x) => x.cameraId === 'cam26'), 'matches the label shown, not just the code');
  assert.ok(filterViews(views, { recipe: 'B', query: 'hevc' }).length === 0);
  assert.equal(filterViews(views, { recipe: 'all', query: '  CAM2  ' }).every((x) => /cam2/i.test(x.cameraId + x.reason)), true);
});

test('age label', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(ageLabel(null, now), 'never');
  assert.equal(ageLabel('2026-10-09T11:59:30Z', now), 'just now');
  assert.equal(ageLabel('2026-10-09T11:30:00Z', now), '30 min ago');
  assert.equal(ageLabel('2026-10-09T06:00:00Z', now), '6 h ago');
  assert.equal(ageLabel('2026-10-05T12:00:00Z', now), '4 days ago');
  assert.equal(ageLabel('garbage', now), 'unknown');
});
