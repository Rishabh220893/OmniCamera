// Live-grid verification script — run this locally (not in a sandboxed CI
// environment), since it needs real network access to the camera origin.
//
// What it does: launches a real Chromium via Playwright, logs into the
// deployed app as a guest, loads the demo grid, enters the stream access
// credentials, and then watches the grid for a few minutes — sampling
// every tile's on-screen status on an interval, capturing console errors,
// and recording a full network HAR — before writing out a structured
// report. This automates the exact manual loop (open the app, watch it,
// export a HAR, describe what's stuck) that's been driving this whole
// debugging thread, so it can be re-run in seconds after each deploy
// instead of a multi-minute manual capture.
//
// Setup (once):
//   npm install --no-save playwright
//   npx playwright install chromium
//
// Run:
//   node scripts/verify-live-grid.mjs
//
// Optional environment variables (all have sensible defaults):
//   BASE_URL             app URL to test                  (default: the deployed app)
//   STREAM_EMAIL           Settings > Access email          (required — no default; keep real credentials out of source)
//   STREAM_PASSWORD        Settings > Access password       (required — no default; keep real credentials out of source)
//   DURATION_MS           how long to watch the grid       (default: 180000 = 3 min)
//   SAMPLE_INTERVAL_MS     how often to sample tile status  (default: 10000 = 10s)
//   HEADLESS               'true' to run without a visible window (default: false — you watch it live)
//   OUT_DIR                 report output directory          (default: ./live-grid-report-<timestamp>)

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL || 'https://omnicamera.onrender.com/';
const STREAM_EMAIL = process.env.STREAM_EMAIL;
const STREAM_PASSWORD = process.env.STREAM_PASSWORD;
if (!STREAM_EMAIL || !STREAM_PASSWORD) {
  console.error('Set STREAM_EMAIL and STREAM_PASSWORD (the Settings > Access email/password credentials) as environment variables before running this — intentionally not hardcoded here.');
  process.exit(1);
}
const DURATION_MS = Number(process.env.DURATION_MS || 180_000);
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS || 10_000);
const HEADLESS = (process.env.HEADLESS || 'false').toLowerCase() === 'true';
const OUT_DIR = process.env.OUT_DIR || `./live-grid-report-${new Date().toISOString().replace(/[:.]/g, '-')}`;

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(OUT_DIR, 'screenshots'), { recursive: true });

const consoleIssues = [];
const pageErrors = [];
const proxyResponses = []; // { time, path, camId/url, status }
const samples = []; // { t, tiles: [{ name, state, blank? }] }

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  writeFileSync(join(OUT_DIR, 'run.log'), line + '\n', { flag: 'a' });
}

// Reads a grid tile's visible status straight from the DOM, matching the
// exact states CameraTile (MonitorTab.tsx) renders: the "Connecting…"
// spinner, "Connection failed" + Retry, "Scroll into view to connect" for
// an off-screen tile, or — when none of those overlays are present — a
// live tile, which is either an <img> (rotating snapshot) or a <video>
// (the one focused/live camera). For an <img> tile it also does the same
// blank-frame check the app itself does (see src/lib/frameCapture.ts) so
// this independently verifies that fix, not just trusts the app's own
// "I captured something" signal.
const SAMPLE_TILES_FN = () => {
  const tiles = Array.from(document.querySelectorAll('div[role="button"].aspect-video'))
    .filter((el) => el.getBoundingClientRect().width > 0);

  return tiles.map((tile) => {
    // Scoped to the bottom name bar specifically — a plain
    // "span.uppercase.tracking-wide" also matches the "AI" analysis-toggle
    // badge elsewhere in the same tile, which sits earlier in the DOM and
    // would otherwise win the match.
    const nameEl = tile.querySelector('.inset-x-0.bottom-0 span');
    const name = nameEl ? nameEl.textContent.trim() : '(unknown)';
    const text = tile.textContent || '';

    let state;
    if (text.includes('Scroll into view to connect')) state = 'offscreen';
    else if (text.includes('Connection failed')) state = 'error';
    else if (text.includes('Connecting')) state = 'connecting';
    else state = 'live';

    let blank = null;
    if (state === 'live') {
      const media = tile.querySelector('img, video');
      if (media) {
        try {
          const canvas = document.createElement('canvas');
          const w = media.naturalWidth || media.videoWidth || 0;
          const h = media.naturalHeight || media.videoHeight || 0;
          if (w > 0 && h > 0) {
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(media, 0, 0);
            let maxChannel = 0;
            const cols = 8, rows = 8;
            outer:
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const x = Math.min(w - 1, Math.floor((c + 0.5) * w / cols));
                const y = Math.min(h - 1, Math.floor((r + 0.5) * h / rows));
                const d = ctx.getImageData(x, y, 1, 1).data;
                maxChannel = Math.max(maxChannel, d[0], d[1], d[2]);
                if (maxChannel > 4) break outer;
              }
            }
            blank = maxChannel <= 4;
          } else {
            blank = 'no-dimensions';
          }
        } catch {
          blank = 'unreadable'; // cross-origin canvas taint or similar — not itself a bug signal
        }
      } else {
        blank = 'no-media-element';
      }
    }
    return { name, state, blank };
  });
};

(async () => {
  log(`Launching Chromium (headless=${HEADLESS})...`);
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    recordHar: { path: join(OUT_DIR, 'network.har'), content: 'embed' },
  });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const entry = { t: Date.now(), type: msg.type(), text: msg.text() };
      consoleIssues.push(entry);
      log(`[console.${entry.type}] ${entry.text.slice(0, 250)}`);
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push({ t: Date.now(), message: err.message });
    log(`[pageerror] ${err.message.slice(0, 250)}`);
  });
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('/api/whep-proxy') || url.includes('/api/proxy-hls')) {
      proxyResponses.push({ t: Date.now(), url, status: res.status() });
    }
  });

  try {
    log(`Navigating to ${BASE_URL} ...`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // First-run only: a one-time "Get Started" welcome screen
    // (OnboardingScreen.tsx) precedes the actual auth screen. A plain
    // .count() check right after goto() races React's own mount/render —
    // domcontentloaded fires on raw HTML, well before the JS bundle has
    // hydrated anything — so this waits for whichever of the two screens
    // shows up first instead of sampling the DOM at one fixed instant.
    log('Waiting for the app to render (welcome screen or login)...');
    const getStartedBtn = page.getByText('Get Started', { exact: true });
    const bypassBtn = page.getByText('Bypass Login', { exact: false });
    await Promise.race([
      getStartedBtn.first().waitFor({ timeout: 30_000 }),
      bypassBtn.first().waitFor({ timeout: 30_000 }),
    ]);
    if (await getStartedBtn.count() > 0) {
      log('Dismissing "Get Started" welcome screen...');
      await getStartedBtn.first().click();
    }

    log('Looking for guest bypass...');
    await bypassBtn.first().waitFor({ timeout: 20_000 });
    await bypassBtn.first().click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(OUT_DIR, 'screenshots', '01-after-login.png') });

    const sidebar = page.locator('aside');
    log('Opening Registry tab to load the demo grid...');
    // Scoped to the desktop sidebar (<aside>), not just text — MobileNav.tsx
    // renders a second, CSS-hidden copy of the same nav labels for small
    // viewports, which a plain getByText() also matches and Playwright
    // then refuses as ambiguous ("strict mode violation").
    await sidebar.getByText('Registry', { exact: true }).click();
    await page.waitForTimeout(1000);
    const loadGridBtn = page.getByText('Load demo grid', { exact: false });
    if (await loadGridBtn.count() > 0) {
      await loadGridBtn.first().click();
      // Wait for the button to stop reading "Loading grid..."
      await page.getByText('Loading grid...', { exact: false }).waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {
        log('WARNING: "Loading grid..." never resolved within 60s — continuing anyway.');
      });
    } else {
      log('No "Load demo grid" button found — assuming cameras are already populated.');
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT_DIR, 'screenshots', '02-after-load-grid.png') });

    log('Opening Settings tab to enter stream access credentials...');
    await sidebar.getByText('Settings', { exact: true }).click();
    await page.waitForTimeout(800);
    await page.getByPlaceholder('Registered email for your camera grid access').fill(STREAM_EMAIL);
    await page.getByPlaceholder('Access password for your camera CDN').fill(STREAM_PASSWORD);
    await page.getByText('Save settings', { exact: false }).click();
    await page.getByText('Saved!', { exact: false }).waitFor({ timeout: 15_000 }).catch(() => {
      log('WARNING: never saw "Saved!" confirmation — credentials may not be persisted, but should still be live in this session.');
    });
    await page.screenshot({ path: join(OUT_DIR, 'screenshots', '03-after-settings.png') });

    log('Opening Feed (Monitor) tab...');
    await sidebar.getByText('Feed', { exact: true }).click();
    await page.waitForTimeout(2000);

    // A first-time visitor also gets a dismissible coach-mark tour
    // (FirstUseTour.tsx) over the Feed tab — skip it if present so it
    // isn't sitting on top of (or intercepting clicks meant for) the grid.
    const skipTourBtn = page.getByTitle('Skip tour');
    if (await skipTourBtn.count() > 0) {
      log('Dismissing first-use tour...');
      await skipTourBtn.first().click();
      await page.waitForTimeout(300);
    }

    // The Feed defaults to single-camera Focus view, not the grid — the
    // grid-vs-focus toggle is a pair of icon buttons (title="Focused
    // view" / title="Grid / video wall") in MonitorTab.tsx. Switch to
    // grid explicitly, since that's what this script's tile sampling
    // (SAMPLE_TILES_FN) looks for.
    log('Switching to grid view...');
    await page.getByTitle('Grid / video wall').click();
    await page.waitForTimeout(1000);

    log(`Watching the grid for ${DURATION_MS / 1000}s, sampling every ${SAMPLE_INTERVAL_MS / 1000}s...`);
    const start = Date.now();
    let sampleIndex = 0;
    while (Date.now() - start < DURATION_MS) {
      const tiles = await page.evaluate(SAMPLE_TILES_FN);
      const t = Date.now() - start;
      samples.push({ t, tiles });
      const counts = tiles.reduce((acc, x) => { acc[x.state] = (acc[x.state] || 0) + 1; return acc; }, {});
      log(`t=${(t / 1000).toFixed(0)}s: ${tiles.length} tiles visible — ${JSON.stringify(counts)}`);
      if (sampleIndex % 3 === 0) {
        await page.screenshot({ path: join(OUT_DIR, 'screenshots', `grid-t${Math.round(t / 1000)}s.png`) });
      }
      sampleIndex++;
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    }
    await page.screenshot({ path: join(OUT_DIR, 'screenshots', 'final.png') });
  } catch (err) {
    log(`FATAL: ${err.message}`);
    await page.screenshot({ path: join(OUT_DIR, 'screenshots', 'fatal-error.png') }).catch(() => {});
  } finally {
    await context.close();
    await browser.close();
  }

  // ---- Compile report ----
  const lastSample = samples[samples.length - 1] || { tiles: [] };
  const everSeen = new Map(); // name -> best state ever observed ('live' > 'error'/'connecting' > 'offscreen')
  const rank = { live: 3, error: 2, connecting: 2, offscreen: 1 };
  for (const s of samples) {
    for (const tile of s.tiles) {
      const prev = everSeen.get(tile.name);
      if (!prev || rank[tile.state] > rank[prev.state]) everSeen.set(tile.name, tile);
    }
  }
  const everLive = [...everSeen.values()].filter((t) => t.state === 'live');
  const everLiveBlank = everLive.filter((t) => t.blank === true);
  const neverLive = [...everSeen.values()].filter((t) => t.state !== 'live');
  const neverAttempted = lastSample.tiles.filter((t) => t.state === 'offscreen').map((t) => t.name);

  const proxyStatusCounts = {};
  for (const r of proxyResponses) {
    const key = `${r.url.includes('whep-proxy') ? 'whep' : 'hls'} ${r.status}`;
    proxyStatusCounts[key] = (proxyStatusCounts[key] || 0) + 1;
  }

  const report = {
    config: { BASE_URL, DURATION_MS, SAMPLE_INTERVAL_MS },
    summary: {
      distinctTilesObserved: everSeen.size,
      everReachedLive: everLive.length,
      everReachedLiveButBlank: everLiveBlank.length,
      neverReachedLive: neverLive.map((t) => t.name),
      stillOffscreenAtEnd: neverAttempted,
      finalTileStates: lastSample.tiles,
      consoleErrorCount: consoleIssues.filter((c) => c.type === 'error').length,
      consoleWarningCount: consoleIssues.filter((c) => c.type === 'warning').length,
      pageErrorCount: pageErrors.length,
      proxyResponseStatusCounts: proxyStatusCounts,
    },
    samples,
    consoleIssues,
    pageErrors,
    proxyResponses,
  };
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  const summaryLines = [
    `Live-grid verification report — ${new Date().toISOString()}`,
    `URL: ${BASE_URL}`,
    `Watched for ${DURATION_MS / 1000}s, sampled every ${SAMPLE_INTERVAL_MS / 1000}s.`,
    '',
    `Distinct tiles observed: ${report.summary.distinctTilesObserved}`,
    `Reached "live" at least once: ${report.summary.everReachedLive}${everLiveBlank.length ? ` (${everLiveBlank.length} of those were BLANK/black frames)` : ''}`,
    `Never reached "live": ${report.summary.neverReachedLive.length}${report.summary.neverReachedLive.length ? ' — ' + report.summary.neverReachedLive.join(', ') : ''}`,
    `Still off-screen (never attempted) at end: ${report.summary.stillOffscreenAtEnd.length}${report.summary.stillOffscreenAtEnd.length ? ' — ' + report.summary.stillOffscreenAtEnd.join(', ') : ''}`,
    `Console errors: ${report.summary.consoleErrorCount}, warnings: ${report.summary.consoleWarningCount}, uncaught page errors: ${report.summary.pageErrorCount}`,
    `Proxy response status counts: ${JSON.stringify(report.summary.proxyResponseStatusCounts)}`,
    '',
    `Final tile-by-tile state:`,
    ...lastSample.tiles.map((t) => `  ${t.name}: ${t.state}${t.blank === true ? ' (BLANK)' : ''}`),
    '',
    `Full detail: ${join(OUT_DIR, 'report.json')}`,
    `Network HAR: ${join(OUT_DIR, 'network.har')}`,
    `Screenshots: ${join(OUT_DIR, 'screenshots')}`,
  ];
  writeFileSync(join(OUT_DIR, 'report.txt'), summaryLines.join('\n'));
  console.log('\n' + summaryLines.join('\n'));
  console.log(`\nFull report written to ${OUT_DIR}/`);
})();
