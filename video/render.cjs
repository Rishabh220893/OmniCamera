#!/usr/bin/env node
/*
 * Draws the explainer's frames from explainer.html and a timeline.
 *
 *   node render.cjs <lang> [--fps 30] [--workers 4] [--out DIR]     every frame, as JPEGs in DIR (default .frames/<lang>)
 *   node render.cjs <lang> --stills 3,12.5,40 [--out DIR]           only these moments (seconds), as PNGs, to check the layout
 *
 * build.sh runs this and joins the frames with the voice-over.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const lang = args[0];
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : args[i + 1]; };
const fps = +opt('fps', 30), workers = +opt('workers', 4), stills = opt('stills', null);
const outDir = path.resolve(opt('out', path.join(__dirname, '.frames', lang)));
const timeline = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', lang, 'timeline.json'), 'utf8'));
const page_url = 'file://' + path.join(__dirname, 'explainer.html');

async function open(browser) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.goto(page_url);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((tl) => window.build(tl), timeline);
  return page;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  if (stills) {
    const page = await open(browser);
    for (const t of stills.split(',').map(Number)) {
      await page.evaluate((s) => window.seek(s), t);
      await page.screenshot({ path: path.join(outDir, `still-${lang}-${t.toFixed(1).padStart(6, '0')}.png`) });
    }
    await browser.close();
    return;
  }
  const total = Math.round(timeline.total * fps);
  let next = 0, done = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: workers }, async () => {
    const page = await open(browser);
    for (;;) {
      const f = next++;
      if (f >= total) break;
      await page.evaluate((s) => window.seek(s), f / fps);
      await page.screenshot({ path: path.join(outDir, `f${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
      if (++done % 300 === 0) console.log(`${lang}: ${done}/${total} frames, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
  }));
  await browser.close();
  console.log(`${lang}: ${total} frames in ${outDir}`);
})();
