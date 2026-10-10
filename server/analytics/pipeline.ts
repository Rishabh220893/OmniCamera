/**
 * Runs the analyzers that apply to a camera side by side, isolates their failures, and merges what they return.
 *
 * Merge rules (so adding an analyzer never needs a change here):
 *   lists (alerts, brands, people_identified, detected_plates, watchlistMatches): joined, duplicates removed, order kept
 *   counts: the larger number per key (an object detector may see more than a scene description)
 *   isUnusual: true if any says so, with the reasons joined
 *   sentiment: the most severe
 *   anything else (summary, ...): the first analyzer that gives a non-empty value, in registration order
 */
import { EventError, type EventDraft } from '../events/schema';
import type { AnalysisResult } from '../logEntry';
import type { Analyzer, AnalyzerCamera, AnalyzerInput, AnalyzerOutcome, AnalyzerOutput, FinalizeContext, Finalizer, PipelineResult } from './types';

const SENTIMENT_RANK: Record<string, number> = { calm: 0, neutral: 1, tense: 2, critical: 3 };
const LIST_KEYS = ['alerts', 'brands', 'people_identified', 'detected_plates', 'watchlistMatches'] as const;

export function mergeFields(list: Array<Partial<AnalysisResult> | undefined>): AnalysisResult {
  const out: Record<string, unknown> = {};
  const parts = list.filter((x): x is Partial<AnalysisResult> => !!x);
  for (const key of LIST_KEYS) {
    const joined = [...new Set(parts.flatMap((p) => (Array.isArray(p[key]) ? (p[key] as unknown[]).map(String) : [])))];
    if (parts.some((p) => Array.isArray(p[key]))) out[key] = joined;
  }
  const counts = parts.map((p) => p.counts).filter((c): c is NonNullable<AnalysisResult['counts']> => !!c);
  if (counts.length) out.counts = { people: Math.max(...counts.map((c) => c.people || 0)), vehicles: Math.max(...counts.map((c) => c.vehicles || 0)), other: Math.max(...counts.map((c) => c.other || 0)) };
  if (parts.some((p) => p.isUnusual)) {
    out.isUnusual = true;
    out.isUnusualReason = [...new Set(parts.filter((p) => p.isUnusual).map((p) => p.isUnusualReason).filter(Boolean))].join('; ');
  } else {
    if (parts.some((p) => p.isUnusual === false)) out.isUnusual = false;
    const reason = parts.find((p) => typeof p.isUnusualReason === 'string')?.isUnusualReason;
    if (reason !== undefined) out.isUnusualReason = reason;
  }
  const sentiments = parts.map((p) => p.sentiment).filter((s): s is string => typeof s === 'string' && s in SENTIMENT_RANK);
  if (sentiments.length) out.sentiment = sentiments.reduce((a, b) => (SENTIMENT_RANK[b] > SENTIMENT_RANK[a] ? b : a));
  for (const p of parts) {
    for (const [k, v] of Object.entries(p)) {
      if ((LIST_KEYS as readonly string[]).includes(k) || k === 'counts' || k === 'isUnusual' || k === 'isUnusualReason' || k === 'sentiment') continue;
      // The first non-empty value wins; if every analyzer gave an empty one, that empty value is kept (a single analyzer's output passes through unchanged).
      if (out[k] === undefined || ((out[k] === '' || out[k] === null) && v !== undefined && v !== '' && v !== null)) out[k] = v;
    }
  }
  return out as AnalysisResult;
}

export interface PipelineOptions {
  analyzers: Analyzer[];
  finalize?: Finalizer;
  log?: Pick<Console, 'warn'>;
  /** Minimum time between two `analyzer.failed` events from the same analyzer. */
  failureEventCooldownMs?: number;
  now?: () => number;
}

export interface AnalyzerPipeline {
  readonly analyzers: readonly Analyzer[];
  analyze(input: Omit<AnalyzerInput, 'signal'>): Promise<PipelineResult>;
  /** The analyzers that would run for this camera. */
  applicable(camera: AnalyzerCamera): Analyzer[];
}

const withTimeout = async <T,>(run: (signal: AbortSignal) => Promise<T>, ms: number | undefined, id: string): Promise<T> => {
  if (!ms) return run(new AbortController().signal);
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(`${id} took longer than ${ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`}`)); ac.abort(); }, ms); });
  try { return await Promise.race([run(ac.signal), limit]); } finally { clearTimeout(timer); }
};

export function createAnalyzerPipeline(opts: PipelineOptions): AnalyzerPipeline {
  const log = opts.log ?? console;
  const now = opts.now ?? (() => Date.now());
  const cooldown = opts.failureEventCooldownMs ?? 15 * 60_000;
  const lastFailureEvent = new Map<string, number>();
  const ids = new Set<string>();
  for (const a of opts.analyzers) {
    if (!/^[a-z][a-z0-9-]*$/.test(a.id)) throw new Error(`Analyzer id '${a.id}' must be lower case letters, digits and '-'.`);
    if (ids.has(a.id)) throw new Error(`Analyzer '${a.id}' is registered twice.`);
    ids.add(a.id);
  }

  const applicable = (camera: AnalyzerCamera) => opts.analyzers.filter((a) => { try { return a.appliesTo ? a.appliesTo(camera) : true; } catch { return false; } });

  return {
    analyzers: opts.analyzers,
    applicable,
    async analyze(input) {
      const run = new Set(applicable(input.camera));
      const outcomes = new Map<string, AnalyzerOutcome & { output?: AnalyzerOutput }>();
      const raw = new Map<string, unknown>();
      await Promise.all(opts.analyzers.map(async (a) => {
        if (!run.has(a)) { outcomes.set(a.id, { id: a.id, ok: true, ms: 0, skipped: true }); return; }
        const t0 = Date.now();
        try {
          const output = await withTimeout((signal) => a.analyze({ ...input, signal }), a.timeoutMs, a.id);
          outcomes.set(a.id, { id: a.id, ok: true, ms: Date.now() - t0, output: output ?? {} });
        } catch (e) {
          raw.set(a.id, e);
          outcomes.set(a.id, { id: a.id, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
        }
      }));

      // A required analyzer that failed fails the analysis, with its own error (the worker retries with back-off).
      for (const a of opts.analyzers) {
        const o = outcomes.get(a.id)!;
        if (a.required && !o.ok) throw raw.get(a.id) instanceof Error ? raw.get(a.id) : new Error(o.error);
      }

      const ordered = opts.analyzers.map((a) => outcomes.get(a.id)!);
      const events: EventDraft[] = [];
      for (const o of ordered) {
        if (!o.ok && !o.skipped) {
          log.warn(`[ANALYZER] ${o.id} failed: ${o.error}`);
          const last = lastFailureEvent.get(o.id) ?? -Infinity;
          if (now() - last >= cooldown) {
            lastFailureEvent.set(o.id, now());
            events.push({ source: o.id, type: 'analyzer.failed', summary: `Analyzer ${o.id} failed: ${o.error}`.slice(0, 300), data: { analyzer: o.id, error: o.error }, dedupeKey: o.id });
          }
        }
        for (const d of o.output?.events ?? []) events.push({ ...d, source: d.source ?? o.id });
      }
      let result = mergeFields(ordered.map((o) => o.output?.fields));
      if (opts.finalize) result = opts.finalize(result, { input, outcomes } as FinalizeContext);
      return { result, events, outcomes: ordered.map(({ output: _o, ...rest }) => rest) };
    },
  };
}

/** Turns drafts from analyzers into events, dropping (and reporting) any that break the contract instead of failing the frame. */
export function safeDrafts<T>(drafts: EventDraft[], build: (d: EventDraft) => T, onBad: (d: EventDraft, e: EventError) => void): T[] {
  const out: T[] = [];
  for (const d of drafts) {
    try { out.push(build(d)); } catch (e) { if (e instanceof EventError) onBad(d, e); else throw e; }
  }
  return out;
}
