import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CASES, runLab } from './lab/cameraLab.ts';

// The lab reads each generated stream in real time (about 8 s per case, a few at a time), so it takes about 35 s.
// Set SKIP_CAMERA_LAB=1 to leave it out of a quick run; it is skipped by itself when ffmpeg is not installed.
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = process.env.SKIP_CAMERA_LAB === '1' ? 'SKIP_CAMERA_LAB=1' : !haveFfmpeg ? 'ffmpeg is not installed' : false;

test('synthetic camera lab: each fault ends on the recipe it deserves', { skip, timeout: 240_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'camera-lab-'));
  try {
    const { results, skipped } = await runLab(dir);
    for (const r of results) {
      await t.test(`${r.case.name}: ${r.case.what} -> ${r.case.expect.recipe}`, () => {
        assert.deepEqual(r.problems, []);
      });
    }
    for (const k of skipped) await t.test(`${k.name}`, { skip: k.why }, () => {});
    assert.equal(results.length + skipped.length, CASES.length);
    assert.ok(results.length >= 12, 'most cases need only libx264, which every ffmpeg has');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
