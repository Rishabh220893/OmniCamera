/**
 * The contract for anything that looks at a frame (docs/analytics.md). The Gemini scene description, the plate reader and a
 * future detector (YOLO, crowd counting, intrusion zones) are all Analyzers; the worker and the alerting never refer to one by name.
 */
import type { AnalysisResult } from '../logEntry';
import type { EventDraft } from '../events/schema';

export interface AnalyzerCamera {
  id: string;
  name: string;
  userId?: string;
  department?: string;
  location?: { lat: number; lng: number };
  sensitivity?: number;
  peopleThreshold?: number;
  vehicleThreshold?: number;
  suspiciousRules?: string;
  /** Free-form per-camera settings for analyzers that need them (zones, thresholds). */
  analyzers?: Record<string, unknown>;
}

export interface AnalyzerUserContext {
  knownFaces: Array<{ name: string; imageData: string }>;
  watchlist: string[];
}

export interface AnalyzerInput {
  camera: AnalyzerCamera;
  frame: { jpeg: Buffer; base64: string };
  user: AnalyzerUserContext;
  now: Date;
  /** Aborted when the analyzer's time limit passes; honour it where the work can be cancelled. */
  signal: AbortSignal;
}

export interface AnalyzerOutput {
  /** Contributions to the log entry (summary, counts, alerts, ...). Merged with the other analyzers' fields. */
  fields?: Partial<AnalysisResult>;
  /** Typed findings for alerting and search. */
  events?: EventDraft[];
  /** Data for the finalizer or for other platform code (the plate reader's raw reads). Not stored. */
  signals?: Record<string, unknown>;
}

export interface Analyzer {
  /** Stable name, used in `source` of events and in `analyzers` of a camera. Lower case, `-` allowed. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /**
   * A required analyzer failing fails the whole analysis (it is retried with back-off, as before). A failure of any other is
   * recorded and reported as an `analyzer.failed` event, and the rest of the result is kept.
   */
  readonly required?: boolean;
  /** Longest it may take, in ms. */
  readonly timeoutMs?: number;
  /** False skips it for this camera. Default: runs everywhere. */
  appliesTo?(camera: AnalyzerCamera): boolean;
  analyze(input: AnalyzerInput): Promise<AnalyzerOutput>;
}

export interface AnalyzerOutcome {
  id: string;
  ok: boolean;
  ms: number;
  /** Did not run because `appliesTo` said no. */
  skipped?: boolean;
  error?: string;
}

/** Everything the finalizer can look at to settle what the log entry says. */
export interface FinalizeContext {
  input: Omit<AnalyzerInput, 'signal'>;
  outcomes: Map<string, AnalyzerOutcome & { output?: AnalyzerOutput }>;
}

/** Last step: combines outputs that depend on each other (plates read by two engines) into the final log fields. */
export type Finalizer = (merged: AnalysisResult, ctx: FinalizeContext) => AnalysisResult;

export interface PipelineResult {
  result: AnalysisResult;
  events: EventDraft[];
  outcomes: AnalyzerOutcome[];
}
