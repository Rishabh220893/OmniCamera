/**
 * Compares AI models on your own camera frames, using the app's real prompts (the scene analyzer and the plate / rule checks).
 *
 *   npm run ai:bench -- --frames ./bench-frames --targets "gemini:gemini-3.6-flash,anthropic:claude-haiku-5-5,openai:qwen-vl-max@https://dashscope-intl.aliyuncs.com/compatible-mode/v1#DASHSCOPE_API_KEY"
 *
 * --frames   folder of .jpg/.png frames (grab ~100 real ones, busy and quiet, day and night, some with plates)
 * --targets  comma list of provider:model[@baseUrl][#KEY_ENV_VAR]
 *              provider is gemini | anthropic | openai (any OpenAI-compatible endpoint)
 *              the key is read from GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY unless #KEY_ENV_VAR names another variable
 *              default: every provider whose key is set, with the app's default model
 * --rules    optional suspicious-activity rules text; adds the rule check to every frame
 * --runs     repeat each frame N times (default 1)
 * --limit    use only the first N frames
 * --prices   "model=inUSD,outUSD;model2=..." USD per 1M tokens, to get a cost per 1,000 scene calls. Take them from each provider's price page.
 * --out      report folder (default ./ai-benchmark-report/<timestamp>)
 *
 * Optional ground truth: next to frame1.jpg put frame1.json, e.g. { "plates": ["MH12AB1234"], "people": 3, "vehicles": 2, "unusual": false, "rule": false }.
 * Any of the keys may be left out. Without it the report still shows speed, cost and JSON reliability, and how far each model's
 * answers are from the first target's.
 *
 * Keys are read from the environment, or from ./.env if it exists.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateOnce } from '../server/gemini';
import { KEY_VAR, type Provider, type Target, type Usage } from '../server/llm';
import { createGeminiSceneAnalyzer } from '../server/analytics/builtin';
import { createGeminiChecks } from '../server/trackingRoutes';

if (existsSync('.env')) { try { process.loadEnvFile('.env'); } catch { /* the environment may already have everything */ } }

// ---- Arguments ------------------------------------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DEFAULT_MODEL: Record<Provider, string> = { gemini: 'gemini-3.6-flash', anthropic: 'claude-haiku-5-5', openai: '' };

interface Spec { label: string; target: Target }

function parseTarget(spec: string): Spec {
  const colon = spec.indexOf(':');
  const provider = spec.slice(0, colon) as Provider;
  if (colon < 0 || !(provider in KEY_VAR)) throw new Error(`Bad target "${spec}": expected provider:model[@baseUrl][#KEY_ENV_VAR] with provider gemini, anthropic or openai.`);
  let rest = spec.slice(colon + 1), keyVar = KEY_VAR[provider], baseUrl: string | undefined;
  const hash = rest.lastIndexOf('#');
  if (hash >= 0) { keyVar = rest.slice(hash + 1); rest = rest.slice(0, hash); }
  const at = rest.indexOf('@');
  if (at >= 0) { baseUrl = rest.slice(at + 1); rest = rest.slice(0, at); }
  if (!rest) throw new Error(`Bad target "${spec}": no model name.`);
  const apiKey = process.env[keyVar];
  if (!apiKey && !(provider === 'openai' && baseUrl)) throw new Error(`Target "${spec}" needs ${keyVar} to be set.`);
  return { label: spec.replace(/[@#].*$/, '') + (baseUrl ? ` @${new URL(baseUrl).host}` : ''), target: { provider, model: rest, apiKey, baseUrl } };
}

function targetsFromArgs(): Spec[] {
  const given = arg('targets');
  if (given) return given.split(',').map((s) => s.trim()).filter(Boolean).map(parseTarget);
  const out: Spec[] = [];
  for (const p of ['gemini', 'anthropic'] as Provider[]) if (process.env[KEY_VAR[p]]) out.push(parseTarget(`${p}:${DEFAULT_MODEL[p]}`));
  return out;
}

function parsePrices(s: string | undefined): Map<string, [number, number]> {
  const m = new Map<string, [number, number]>();
  for (const part of (s || '').split(';').map((x) => x.trim()).filter(Boolean)) {
    const [model, nums] = part.split('=');
    const [i, o] = (nums || '').split(',').map(Number);
    if (model && Number.isFinite(i) && Number.isFinite(o)) m.set(model.trim(), [i, o]);
  }
  return m;
}

// ---- Measuring ------------------------------------------------------------------------------------------------------

interface Truth { plates?: string[]; people?: number; vehicles?: number; unusual?: boolean; rule?: boolean }
interface Call {
  frame: string; target: string; task: 'scene' | 'plates' | 'rules'; run: number;
  ms: number; ok: boolean; error?: string; usage: Usage; output?: Record<string, unknown>;
}

const normPlate = (p: unknown) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const quantile = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '-');

async function runCall(spec: Spec, frame: string, jpeg: Buffer, task: Call['task'], run: number, rules: string): Promise<Call> {
  const usage: Usage = {};
  // The app's own code builds the prompts; this only forwards its request to the model under test and tallies the tokens.
  const generate = async (params: { contents: unknown; config?: Record<string, unknown> }) => {
    const r = await generateOnce(spec.target, params as never);
    usage.inputTokens = (usage.inputTokens ?? 0) + (r.usage?.inputTokens ?? 0);
    usage.outputTokens = (usage.outputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
    return { text: r.text };
  };
  const t0 = performance.now();
  try {
    let output: Record<string, unknown>;
    if (task === 'scene') {
      const analyzer = createGeminiSceneAnalyzer({ generate: generate as never, log: { log() {} } });
      const out = await analyzer.analyze({
        camera: { id: 'bench', name: 'Benchmark camera', suspiciousRules: rules || undefined },
        frame: { jpeg, base64: jpeg.toString('base64') },
        user: { knownFaces: [], watchlist: [] },
        now: new Date(), signal: new AbortController().signal,
      });
      output = (out.fields ?? {}) as Record<string, unknown>;
      // Parsing succeeded; also require the fields the app relies on, a model that answers `{}` is not "valid".
      if (typeof output.summary !== 'string' || typeof output.counts !== 'object' || output.counts === null) throw new Error('Answer is JSON but lacks summary / counts');
    } else if (task === 'plates') {
      output = { plates: (await createGeminiChecks(generate as never).readPlates(jpeg)).map((p) => p.text) };
    } else {
      output = { ...(await createGeminiChecks(generate as never).checkRules(jpeg, rules, 'Benchmark camera')) };
    }
    return { frame, target: spec.label, task, run, ms: performance.now() - t0, ok: true, usage, output };
  } catch (e) {
    return { frame, target: spec.label, task, run, ms: performance.now() - t0, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), usage };
  }
}

// ---- Scoring --------------------------------------------------------------------------------------------------------

function sceneCount(c: Call, key: 'people' | 'vehicles'): number | undefined {
  const v = Number((c.output?.counts as Record<string, unknown> | undefined)?.[key]);
  return Number.isFinite(v) ? v : undefined;
}

function summarize(calls: Call[], specs: Spec[], truth: Map<string, Truth>, prices: Map<string, [number, number]>, rules: string) {
  const rows = specs.map((spec) => {
    const mine = calls.filter((c) => c.target === spec.label);
    const ok = mine.filter((c) => c.ok);
    const scene = mine.filter((c) => c.task === 'scene');
    const plates = mine.filter((c) => c.task === 'plates' && c.ok);
    const rule = mine.filter((c) => c.task === 'rules' && c.ok);

    let tp = 0, fp = 0, fn = 0;
    for (const c of plates) {
      const t = truth.get(c.frame)?.plates; if (!t) continue;
      const want = new Set(t.map(normPlate)), got = new Set((c.output!.plates as string[]).map(normPlate));
      for (const g of got) want.has(g) ? tp++ : fp++;
      for (const w of want) if (!got.has(w)) fn++;
    }
    const countErr: number[] = [], unusualHits: boolean[] = [];
    for (const c of scene.filter((x) => x.ok)) {
      const t = truth.get(c.frame); if (!t) continue;
      for (const k of ['people', 'vehicles'] as const) { const g = sceneCount(c, k); if (t[k] !== undefined && g !== undefined) countErr.push(Math.abs(g - t[k]!)); }
      if (t.unusual !== undefined) unusualHits.push((c.output!.isUnusual === true) === t.unusual);
    }
    const ruleHits = rule.filter((c) => truth.get(c.frame)?.rule !== undefined).map((c) => (c.output!.violated === true) === truth.get(c.frame)!.rule);

    const price = prices.get(spec.target.model);
    const sceneOk = scene.filter((c) => c.ok);
    const inTok = mean(sceneOk.map((c) => c.usage.inputTokens ?? NaN).filter(Number.isFinite));
    const outTok = mean(sceneOk.map((c) => c.usage.outputTokens ?? NaN).filter(Number.isFinite));
    return {
      target: spec.label,
      calls: mine.length,
      failed: mine.length - ok.length,
      'json ok': pct(scene.filter((c) => c.ok).length, scene.length),
      'p50 ms': fmt(quantile(ok.map((c) => c.ms), 0.5)),
      'p95 ms': fmt(quantile(ok.map((c) => c.ms), 0.95)),
      'scene in tok': fmt(inTok),
      'scene out tok': fmt(outTok),
      '$ / 1k scene calls': price && Number.isFinite(inTok) ? fmt(((inTok * price[0] + outTok * price[1]) / 1e6) * 1000, 2) : '(no --prices)',
      'plate recall': pct(tp, tp + fn), 'plate precision': pct(tp, tp + fp),
      'count error (mean)': fmt(mean(countErr), 2),
      'unusual acc': pct(unusualHits.filter(Boolean).length, unusualHits.length),
      ...(rules ? { 'rule acc': pct(ruleHits.filter(Boolean).length, ruleHits.length) } : {}),
    };
  });

  // Without ground truth: how far each model is from the first one, frame by frame.
  const base = specs[0]?.label;
  const drift = specs.slice(1).map((spec) => {
    const diffs: number[] = []; let plateSame = 0, plateBoth = 0;
    for (const c of calls.filter((x) => x.target === spec.label && x.ok)) {
      const b = calls.find((x) => x.target === base && x.frame === c.frame && x.run === c.run && x.task === c.task && x.ok);
      if (!b) continue;
      if (c.task === 'scene') for (const k of ['people', 'vehicles'] as const) { const x = sceneCount(c, k), y = sceneCount(b, k); if (x !== undefined && y !== undefined) diffs.push(Math.abs(x - y)); }
      if (c.task === 'plates') { plateBoth++; const x = (c.output!.plates as string[]).map(normPlate).sort().join('|'), y = (b.output!.plates as string[]).map(normPlate).sort().join('|'); if (x === y) plateSame++; }
    }
    return { target: spec.label, [`vs ${base}: mean count diff`]: fmt(mean(diffs), 2), [`vs ${base}: same plates`]: pct(plateSame, plateBoth) };
  });
  return { rows, drift };
}

// ---- Main -----------------------------------------------------------------------------------------------------------

async function main() {
  const framesDir = arg('frames');
  const specs = targetsFromArgs();
  if (!framesDir || !specs.length) {
    console.error('Usage: npm run ai:bench -- --frames <folder> [--targets "provider:model,..."] [--rules "..."] [--runs N] [--limit N] [--prices "model=in,out;..."]');
    console.error(specs.length ? '' : 'No target: set GEMINI_API_KEY and/or ANTHROPIC_API_KEY (in the environment or .env), or pass --targets.');
    process.exit(1);
  }
  const rules = arg('rules') || '';
  const runs = Math.max(1, Number(arg('runs')) || 1);
  const frames = readdirSync(framesDir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().slice(0, Number(arg('limit')) || Infinity);
  if (!frames.length) { console.error(`No .jpg/.png frames in ${framesDir}`); process.exit(1); }
  const prices = parsePrices(arg('prices'));
  const truth = new Map<string, Truth>();
  for (const f of frames) {
    const tf = path.join(framesDir, f.replace(/\.[^.]+$/, '.json'));
    if (existsSync(tf)) truth.set(f, JSON.parse(readFileSync(tf, 'utf8')) as Truth);
  }
  console.log(`${frames.length} frame(s) x ${runs} run(s) x ${specs.length} model(s)${truth.size ? `, ground truth for ${truth.size}` : ', no ground truth'}${rules ? ', with rule check' : ''}`);
  console.log('Targets:', specs.map((s) => s.label).join('  |  '));

  const tasks: Call['task'][] = rules ? ['scene', 'plates', 'rules'] : ['scene', 'plates'];
  const calls: Call[] = [];
  for (const [i, frame] of frames.entries()) {
    const jpeg = readFileSync(path.join(framesDir, frame));
    for (let run = 1; run <= runs; run++) for (const task of tasks) {
      // All models see the same frame at the same time; each model's own calls stay in order.
      calls.push(...(await Promise.all(specs.map((spec) => runCall(spec, frame, jpeg, task, run, rules)))));
    }
    process.stdout.write(`\r${i + 1}/${frames.length} frames`);
  }
  process.stdout.write('\n\n');

  const { rows, drift } = summarize(calls, specs, truth, prices, rules);
  console.table(rows);
  if (drift.length) console.table(drift);
  const errors = new Map<string, number>();
  for (const c of calls.filter((x) => !x.ok)) { const k = `${c.target}: ${c.error}`; errors.set(k, (errors.get(k) ?? 0) + 1); }
  if (errors.size) { console.log('Errors:'); for (const [k, n] of errors) console.log(` ${n}x ${k}`); }

  const out = arg('out') || path.join('ai-benchmark-report', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ rows, drift, calls }, null, 2));
  const md = (t: Record<string, unknown>[]) => t.length ? `| ${Object.keys(t[0]).join(' | ')} |\n|${Object.keys(t[0]).map(() => '---').join('|')}|\n${t.map((r) => `| ${Object.values(r).join(' | ')} |`).join('\n')}\n` : '';
  writeFileSync(path.join(out, 'report.md'), `# AI model benchmark\n\n${frames.length} frames x ${runs} run(s).\n\n${md(rows)}\n${md(drift)}\n${errors.size ? '## Errors\n' + [...errors].map(([k, n]) => `- ${n}x ${k}`).join('\n') : ''}\n`);
  console.log(`\nReport: ${path.join(out, 'report.md')} (raw calls in results.json)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
