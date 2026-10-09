#!/usr/bin/env node
/**
 * A pretend camera grid for testing Feed > Full Panel tracking without the real cameras.
 *
 *   node scripts/fake-grid.mjs                         make 30 pictures (cam01.jpg ... cam30.jpg) in .demo-logs/fake-grid
 *   node scripts/fake-grid.mjs put cam21 plate GJ05AB1234   change ONE camera's picture while tracking runs
 *   node scripts/fake-grid.mjs put cam21 face a             (a, b or c: three different pretend people)
 *   node scripts/fake-grid.mjs put cam21 climb              a person climbing a fence
 *   node scripts/fake-grid.mjs put cam21 bag                an unattended bag
 *   node scripts/fake-grid.mjs put cam21 calm               an ordinary street
 *   node scripts/fake-grid.mjs reference a                  the photo to upload for "Track Face" (face-a.jpg)
 *
 * Then start the app with TRACKING_FAKE_FRAMES_DIR=.demo-logs/fake-grid: the tracker reads these pictures instead of the cameras.
 * Everything is drawn: the plates are text on a white box, the "people" are emoji glyphs. They are fakes by design, so nobody real is
 * pictured; they test the pipeline (capture, plate reader / Gemini, matching, alert, focus), not recognition accuracy on real footage.
 *
 * What the 30 pictures contain, so a test knows what to expect:
 *   cam07 a car with plate GJ05AB1234          cam11 a car with GJO5AB1234 (letter O for the 0: a look-alike)
 *   cam03 a car with MH12DE1433                cam15 a car with GJ05AB1235 (one digit different: a different car)
 *   cam19 pretend person A                     cam23 person B     cam09 person C
 *   cam26 a person climbing a fence            cam13 an unattended bag      everything else: an ordinary street
 *
 * Needs ffmpeg, and on Windows the Segoe UI Emoji and Arial fonts (Linux: DejaVu and Noto Emoji if installed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.env.FAKE_GRID_DIR || '.demo-logs/fake-grid');
const find = (...c) => c.find((f) => existsSync(f));
const BOLD = find('C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf');
const EMOJI = find('C:/Windows/Fonts/seguiemj.ttf', '/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf', '/System/Library/Fonts/Apple Color Emoji.ttc');
const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');
const PEOPLE = { a: '🧔', b: '👩', c: '🧓' };

const NAMES = {
  1: 'Chiman bhai Bridge', 2: 'Janpath', 3: 'O.N.G.C. Office', 4: 'Paldi Circle', 5: 'Visat teen Rasta', 6: 'Timbavadi gate', 7: 'Hero showroom', 8: 'Majewadi gate',
  9: 'New bypass', 10: 'Char chowk road', 11: 'Dolatpara', 12: 'Tri Mandir Adalaj', 13: 'CN Vidhyalaya', 14: 'Delight RLVD', 15: 'Suvidha park',
};
const nameOf = (n) => NAMES[n] || `Road ${n}`;

function ffmpeg(filter, out, bg = '0x30343c', size = '1280x720') {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${bg}:s=${size}`, '-vf', filter, '-frames:v', '1', '-q:v', '3', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${out}: ${(r.stderr || r.error?.message || '').slice(-300)}`);
}
const text = (t, size, x, y, color = 'white', font = BOLD) =>
  `drawtext=fontfile='${esc(font)}':text='${t.replace(/[':\\]/g, '')}':fontsize=${size}:x=${x}:y=${y}:fontcolor=${color}`;
const glyph = (g, size, x, y, color = 'white') => (EMOJI ? `drawtext=fontfile='${esc(EMOJI)}':text='${g}':fontsize=${size}:x=${x}:y=${y}:fontcolor=${color}` : `drawbox=x=${x}:y=${y}:w=${Math.round(size / 3)}:h=${size}:color=${color}:t=fill`);
const box = (x, y, w, h, color) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill`;

function street(n) {
  const shade = 0x20 + ((n * 37) % 40);
  const sky = `0x${(shade + 8).toString(16)}${(shade + 12).toString(16)}${(shade + 20).toString(16)}`;
  return [box(0, 0, 1280, 480, sky), box(60 + (n % 5) * 40, 110, 300, 370, '0x4a5260'), box(900, 160 + (n % 3) * 20, 260, 320, '0x3f4650'), box(0, 480, 1280, 240, '0x22252b'),
    ...[0, 1, 2, 3, 4].map((i) => box(80 + i * 260, 590, 120, 10, '0x8a8d94'))];
}
const label = (n) => [text(`CAM${String(n).padStart(2, '0')}  ${nameOf(n)}`, 26, 24, 24), text('2026-10-09  LIVE', 22, 1020, 26, '0xb7bcc7')];

function scene(n, kind, value) {
  const base = [...street(n), ...label(n)];
  if (kind === 'plate') {
    return [...base, box(300, 330, 680, 270, '0x8c2f2f'), box(360, 350, 560, 90, '0x9fb7c9'), box(330, 560, 130, 80, '0x101010'), box(820, 560, 130, 80, '0x101010'),
      box(450, 505, 380, 82, 'white'), box(454, 509, 372, 74, '0x1a1a1a'), box(458, 513, 364, 66, 'white'), text(value, 56, 470, 520, 'black')];
  }
  if (kind === 'face') return [...base, glyph(PEOPLE[value] || PEOPLE.a, 280, 700, 290)];
  if (kind === 'climb') return [...base, box(200, 300, 760, 14, '0xaaaaaa'), box(200, 300, 14, 240, '0xaaaaaa'), box(500, 300, 14, 240, '0xaaaaaa'), box(800, 300, 14, 240, '0xaaaaaa'), glyph('🧗', 230, 520, 110)];
  if (kind === 'bag') return [...base, glyph('🎒', 200, 560, 400)];
  return [...base, ...(n % 2 === 0 ? [glyph('🚶', 150, 300 + (n % 7) * 90, 380)] : [])];
}

const SCENES = { 7: ['plate', 'GJ05AB1234'], 11: ['plate', 'GJO5AB1234'], 3: ['plate', 'MH12DE1433'], 15: ['plate', 'GJ05AB1235'], 19: ['face', 'a'], 23: ['face', 'b'], 9: ['face', 'c'], 26: ['climb'], 13: ['bag'] };
const num = (id) => Number(String(id).replace(/\D/g, ''));
const file = (id) => path.join(OUT, `${String(id).toLowerCase()}.jpg`);

function render(id, kind, value) {
  if (!BOLD) throw new Error('No bold font found for the labels (Arial on Windows, DejaVu on Linux).');
  ffmpeg(scene(num(id), kind, value).join(','), file(id));
}
function reference(who) {
  if (!EMOJI) throw new Error('No emoji font found, so no pretend face can be drawn.');
  ffmpeg(glyph(PEOPLE[who] || PEOPLE.a, 520, 60, 40, 'black'), path.join(OUT, `face-${who}.jpg`), 'white', '640x640');
  console.log(`wrote ${path.join(OUT, `face-${who}.jpg`)}`);
}

const [cmd, ...args] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
if (cmd === 'put') {
  const [id, kind, value] = args;
  if (!id || !kind) { console.error('usage: put <camNN> plate <TEXT> | face <a|b|c> | climb | bag | calm'); process.exit(2); }
  render(id, kind, value);
  console.log(`${file(id)} now shows: ${kind}${value ? ' ' + value : ''}`);
} else if (cmd === 'reference') {
  reference(args[0] || 'a');
} else {
  for (let n = 1; n <= 30; n++) { const [kind, value] = SCENES[n] || ['calm']; render(`cam${String(n).padStart(2, '0')}`, kind, value); }
  copyFileSync(file('cam01'), path.join(OUT, 'default.jpg'));
  for (const who of ['a', 'b', 'c']) reference(who);
  console.log(`wrote 30 pictures and 3 face photos to ${OUT}`);
  console.log(`Start the app with TRACKING_FAKE_FRAMES_DIR=${path.relative(process.cwd(), OUT) || '.'}`);
}
