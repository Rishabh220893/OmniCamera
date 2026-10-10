/**
 * The app's one entry point to the AI model, shared by the server and by regional gateways (server/gateway).
 * It is still called "gemini" for the many importers, but AI_PROVIDER (server/llm.ts) picks Gemini, Claude or an
 * OpenAI-compatible endpoint; the call shape stays Gemini's.
 */
import { GoogleGenAI } from '@google/genai';
import { activeProvider, callAnthropic, callOpenAI, modelChain, targetFromEnv, type LlmResult, type LooseParams, type Target } from './llm';

let aiClient: GoogleGenAI | null = null;
export function getAI(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Model fallback chain — the newest/preview model gives the best
// results but is also the one most likely to return 503 "high demand"
// under load. On a retryable error, fall through to the next model rather
// than failing the whole analysis cycle. Google retires model IDs over
// time (gemini-2.5-flash and gemini-2.0-flash are no longer available to
// new projects as of this writing — its own 404 response names the
// current replacement), so this list is deliberately short and should be
// updated from that error message if it goes stale again rather than
// guessing at names. AI_VISION_MODELS / AI_CHAT_MODELS override the defaults
// (and are required for AI_PROVIDER=openai).
export const VISION_MODELS = modelChain('vision');
export const CHAT_MODELS = modelChain('chat');

function isRetryableGeminiError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Capacity/transient errors, and "model no longer exists" (404/NOT_FOUND)
  // — both are reasons to try the *next* model, not to fail outright.
  return /"code":\s*(404|429|500|502|503|504)|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|NOT_FOUND|GEMINI_TIMEOUT|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message);
}

const GEMINI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 25_000;

// Without this, a stalled call to a given model just hangs forever — the
// client's fetch has no timeout of its own, so isAnalyzing never clears and
// the capture loop stops producing any new summary/alerts until the tab is
// reloaded. Racing a timeout turns that into a fast, retryable failure that
// falls through to the next model instead.
function withGeminiTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GEMINI_TIMEOUT: no response after ${GEMINI_TIMEOUT_MS}ms`)), GEMINI_TIMEOUT_MS);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

type GeminiParams = Omit<Parameters<ReturnType<typeof getAI>['models']['generateContent']>[0], 'model'>;

/** One call to one model of one provider. Used by the fallback chain below and by scripts/ai-benchmark.ts. */
export async function generateOnce(target: Target, params: GeminiParams | LooseParams): Promise<LlmResult> {
  if (target.provider === 'anthropic') return callAnthropic(target, params as LooseParams, GEMINI_TIMEOUT_MS);
  if (target.provider === 'openai') {
    if (!target.model) throw new Error('AI_PROVIDER=openai needs AI_VISION_MODELS (and AI_CHAT_MODELS) set to the model name your endpoint serves.');
    return callOpenAI(target, params as LooseParams, GEMINI_TIMEOUT_MS);
  }
  const res = await withGeminiTimeout(getAI().models.generateContent({ ...(params as GeminiParams), model: target.model }));
  return { text: res.text ?? '', usage: { inputTokens: res.usageMetadata?.promptTokenCount, outputTokens: res.usageMetadata?.candidatesTokenCount } };
}

export async function generateContentWithFallback(models: string[], params: GeminiParams): Promise<LlmResult> {
  let lastError: unknown = new Error(`No model is configured for AI_PROVIDER=${activeProvider()}: set AI_VISION_MODELS and AI_CHAT_MODELS.`);
  for (const model of models) {
    try {
      return await generateOnce(targetFromEnv(model), params);
    } catch (err: unknown) {
      lastError = err;
      if (!isRetryableGeminiError(err)) throw err;
      console.warn(`[AI] Model "${model}" unavailable, falling back to next model:`, err instanceof Error ? err.message : err);
    }
  }
  throw lastError;
}
