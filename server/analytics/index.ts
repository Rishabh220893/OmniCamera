import type { PlateRead } from '../anprClient';
import { createAnprAnalyzer, createGeminiSceneAnalyzer, createSceneFinalizer, type GenerateFn } from './builtin';
import { createAnalyzerPipeline, type AnalyzerPipeline } from './pipeline';
import { createTamperAnalyzer } from './tamper';
import type { Analyzer } from './types';

export * from './types';
export { createAnalyzerPipeline, mergeFields, safeDrafts, type AnalyzerPipeline } from './pipeline';
export { createTamperAnalyzer, judgeFingerprint } from './tamper';
export { createGeminiSceneAnalyzer, createAnprAnalyzer, createSceneFinalizer } from './builtin';

export interface DefaultPipelineDeps {
  generate: GenerateFn;
  anpr: { detect(jpeg: Buffer): Promise<PlateRead[]> } | null;
  /** More analyzers to run beside the built-in ones (a detector, a custom rule engine). */
  extra?: Analyzer[];
  /** `ANALYZERS_OFF=camera-tamper,...` removes built-ins. The scene analyzer is required and cannot be removed. */
  off?: string[];
  log?: Pick<Console, 'warn' | 'log'>;
}

/** Gemini scene analysis, the plate reader when configured, camera-tamper detection, and whatever else is passed in. */
export function createDefaultPipeline(d: DefaultPipelineDeps): AnalyzerPipeline {
  const off = new Set(d.off ?? []);
  const analyzers: Analyzer[] = [createGeminiSceneAnalyzer({ generate: d.generate, log: d.log })];
  if (d.anpr && !off.has('anpr-plates')) analyzers.push(createAnprAnalyzer(d.anpr));
  if (!off.has('camera-tamper')) analyzers.push(createTamperAnalyzer());
  analyzers.push(...(d.extra ?? []));
  return createAnalyzerPipeline({ analyzers, finalize: createSceneFinalizer(d.log), log: d.log });
}
