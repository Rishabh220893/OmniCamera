/**
 * Provider adapter: lets the app (and scripts/ai-benchmark.ts) talk to Gemini, Anthropic Claude, or any OpenAI-compatible
 * endpoint (OpenAI, Qwen-VL on DashScope/Together/Fireworks/OpenRouter, a local vLLM) through the one Gemini-shaped call the
 * rest of the code already makes: { contents, config: { systemInstruction, temperature, responseMimeType } } -> { text }.
 * Gemini itself is still called through the SDK in server/gemini.ts; this file holds the other two and the settings.
 *
 * Settings (all env):
 *   AI_PROVIDER        gemini (default) | anthropic | openai
 *   GEMINI_API_KEY     for gemini
 *   ANTHROPIC_API_KEY  for anthropic
 *   OPENAI_API_KEY     for openai (optional for a local server that needs none)
 *   OPENAI_BASE_URL    openai only; default https://api.openai.com/v1. Set to the Qwen/Together/vLLM endpoint.
 *   AI_VISION_MODELS   comma list tried in order, overrides the defaults (frames attached)
 *   AI_CHAT_MODELS     same, for text-only chat
 */
export type Provider = 'gemini' | 'anthropic' | 'openai';

export interface Usage { inputTokens?: number; outputTokens?: number }
export interface LlmResult { text: string; usage?: Usage }

/** The subset of the Gemini request shape the app uses. */
export interface LooseParams {
  contents: unknown;
  config?: { systemInstruction?: unknown; temperature?: number; responseMimeType?: string; [k: string]: unknown };
}

export interface Target {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

type Env = Record<string, string | undefined>;

export function activeProvider(env: Env = process.env): Provider {
  const p = (env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  if (p === 'gemini' || p === 'anthropic' || p === 'openai') return p;
  throw new Error(`AI_PROVIDER must be gemini, anthropic or openai (got "${env.AI_PROVIDER}")`);
}

export const KEY_VAR: Record<Provider, string> = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

/** Name of the key variable the active provider needs, for error messages. */
export function aiKeyVar(env: Env = process.env): string { return KEY_VAR[activeProvider(env)]; }

/** Is the active provider usable? A local OpenAI-compatible server may run without a key, so a base URL is enough there. */
export function aiConfigured(env: Env = process.env): boolean {
  const p = activeProvider(env);
  if (p === 'openai') return !!(env.OPENAI_API_KEY || env.OPENAI_BASE_URL);
  return !!env[KEY_VAR[p]];
}

const DEFAULT_MODELS: Record<Provider, { vision: string[]; chat: string[] }> = {
  gemini: { vision: ['gemini-3-flash-preview', 'gemini-3.6-flash'], chat: ['gemini-3.5-flash', 'gemini-3.6-flash'] },
  anthropic: { vision: ['claude-haiku-5-5'], chat: ['claude-haiku-5-5'] },
  // There is no sensible default for "an OpenAI-compatible endpoint": the model name depends on who hosts it.
  openai: { vision: [], chat: [] },
};

export function modelChain(kind: 'vision' | 'chat', env: Env = process.env): string[] {
  const override = (kind === 'vision' ? env.AI_VISION_MODELS : env.AI_CHAT_MODELS)?.split(',').map((m) => m.trim()).filter(Boolean);
  return override?.length ? override : DEFAULT_MODELS[activeProvider(env)][kind];
}

export function targetFromEnv(model: string, env: Env = process.env): Target {
  const provider = activeProvider(env);
  return { provider, model, apiKey: env[KEY_VAR[provider]], baseUrl: provider === 'openai' ? env.OPENAI_BASE_URL : undefined };
}

// ---- Shape helpers --------------------------------------------------------------------------------------------------

interface Part { text?: string; inlineData?: { mimeType: string; data: string } }
interface Turn { role: 'user' | 'assistant'; parts: Part[] }

function toParts(raw: unknown): Part[] {
  if (typeof raw === 'string') return [{ text: raw }];
  if (Array.isArray(raw)) return raw.flatMap(toParts);
  if (raw && typeof raw === 'object') {
    const o = raw as { parts?: unknown; text?: unknown; inlineData?: unknown };
    if (Array.isArray(o.parts)) return o.parts.flatMap(toParts);
    const out: Part = {};
    if (typeof o.text === 'string') out.text = o.text;
    if (o.inlineData && typeof o.inlineData === 'object') out.inlineData = o.inlineData as Part['inlineData'];
    return out.text !== undefined || out.inlineData ? [out] : [];
  }
  return [];
}

/** Gemini `contents` (one object with parts, or a list of {role, parts}) -> alternating user/assistant turns. */
export function toTurns(contents: unknown): Turn[] {
  const items = Array.isArray(contents) && contents.every((c) => c && typeof c === 'object' && 'role' in (c as object)) ? (contents as Array<{ role?: string; parts?: unknown }>) : [{ role: 'user', parts: contents }];
  const turns: Turn[] = [];
  for (const it of items) {
    const role: Turn['role'] = it.role === 'model' || it.role === 'assistant' ? 'assistant' : 'user';
    const parts = toParts(it.parts);
    if (!parts.length) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else turns.push({ role, parts });
  }
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return turns;
}

function systemText(v: unknown): string {
  return toParts(v).map((p) => p.text ?? '').join('\n').trim();
}

const wantsJson = (p: LooseParams) => p.config?.responseMimeType === 'application/json';
const JSON_HINT = 'Reply with the JSON object only: no prose before or after it and no markdown code fence.';

/** Models without a strict JSON mode sometimes wrap the answer in a fence or a sentence; keep the outermost object. */
export function extractJson(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const raw = await res.text();
    // The status is put in the message in the same `"code": N` form the Gemini SDK uses, so the fallback chain's retry test matches it.
    if (!res.ok) throw new Error(`{"error":{"code": ${res.status}, "message": ${JSON.stringify(raw.slice(0, 500))}}}`);
    try { return JSON.parse(raw); } catch { throw new Error(`Provider answered something that is not JSON: ${raw.slice(0, 200)}`); }
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`GEMINI_TIMEOUT: no response after ${timeoutMs}ms`);
    throw e;
  } finally { clearTimeout(timer); }
}

// ---- OpenAI-compatible ----------------------------------------------------------------------------------------------

export async function callOpenAI(t: Target, params: LooseParams, timeoutMs: number, env: Env = process.env): Promise<LlmResult> {
  const json = wantsJson(params);
  const system = [systemText(params.config?.systemInstruction), json ? JSON_HINT : ''].filter(Boolean).join('\n\n');
  const messages: unknown[] = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const turn of toTurns(params.contents)) {
    if (turn.role === 'assistant') { messages.push({ role: 'assistant', content: turn.parts.map((p) => p.text ?? '').join('\n') }); continue; }
    messages.push({
      role: 'user',
      content: turn.parts.map((p) => p.inlineData
        ? { type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } }
        : { type: 'text', text: p.text ?? '' }),
    });
  }
  const body: Record<string, unknown> = { model: t.model, messages };
  // Some newer models accept only their default temperature; OPENAI_OMIT_TEMPERATURE=true leaves it out.
  if (params.config?.temperature !== undefined && env.OPENAI_OMIT_TEMPERATURE !== 'true') body.temperature = params.config.temperature;
  // OPENAI_JSON_MODE=false for an endpoint that rejects response_format; the prompt still asks for JSON.
  if (json && env.OPENAI_JSON_MODE !== 'false') body.response_format = { type: 'json_object' };
  if (env.AI_MAX_OUTPUT_TOKENS) body.max_tokens = Number(env.AI_MAX_OUTPUT_TOKENS);

  const base = (t.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const out = await postJson(`${base}/chat/completions`, t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {}, body, timeoutMs);
  const msg = out?.choices?.[0]?.message?.content;
  const text = Array.isArray(msg) ? msg.map((c: { text?: string }) => c.text ?? '').join('') : String(msg ?? '');
  return { text: json ? extractJson(text) : text, usage: { inputTokens: out?.usage?.prompt_tokens, outputTokens: out?.usage?.completion_tokens } };
}

// ---- Anthropic Claude -----------------------------------------------------------------------------------------------

export async function callAnthropic(t: Target, params: LooseParams, timeoutMs: number, env: Env = process.env): Promise<LlmResult> {
  if (!t.apiKey) throw new Error('ANTHROPIC_API_KEY is required');
  const json = wantsJson(params);
  const system = [systemText(params.config?.systemInstruction), json ? JSON_HINT : ''].filter(Boolean).join('\n\n');
  const messages = toTurns(params.contents).map((turn) => ({
    role: turn.role,
    content: turn.parts.map((p) => p.inlineData
      ? { type: 'image', source: { type: 'base64', media_type: p.inlineData.mimeType, data: p.inlineData.data } }
      : { type: 'text', text: p.text ?? '' }).filter((c) => c.type === 'image' || (c as { text: string }).text !== ''),
  }));
  const body: Record<string, unknown> = { model: t.model, max_tokens: Number(env.AI_MAX_OUTPUT_TOKENS) || 1024, messages };
  if (system) body.system = system;
  if (params.config?.temperature !== undefined) body.temperature = params.config.temperature;

  const base = (t.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const out = await postJson(`${base}/v1/messages`, { 'x-api-key': t.apiKey, 'anthropic-version': '2023-06-01' }, body, timeoutMs);
  const text = (Array.isArray(out?.content) ? out.content : []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
  return { text: json ? extractJson(text) : text, usage: { inputTokens: out?.usage?.input_tokens, outputTokens: out?.usage?.output_tokens } };
}
