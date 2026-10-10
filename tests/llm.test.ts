import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiConfigured, aiKeyVar, callAnthropic, callOpenAI, extractJson, modelChain, toTurns } from '../server/llm';

const params = {
  contents: [
    { role: 'user', parts: [{ text: 'hi' }] },
    { role: 'model', parts: [{ text: 'hello' }] },
    { role: 'user', parts: [{ text: 'Camera: "A"' }, { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }, { text: 'what is there?' }] },
  ],
  config: { systemInstruction: 'be brief', temperature: 0.7 },
};

function stubFetch(answer: unknown, status = 200) {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(answer), { status });
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

test('provider selection and key names', () => {
  assert.equal(aiKeyVar({}), 'GEMINI_API_KEY');
  assert.equal(aiKeyVar({ AI_PROVIDER: 'anthropic' }), 'ANTHROPIC_API_KEY');
  assert.equal(aiConfigured({ AI_PROVIDER: 'anthropic' }), false);
  assert.equal(aiConfigured({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }), true);
  assert.equal(aiConfigured({ AI_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:8000/v1' }), true);
  assert.throws(() => aiKeyVar({ AI_PROVIDER: 'nope' }), /AI_PROVIDER/);
  assert.deepEqual(modelChain('vision', { AI_PROVIDER: 'openai' }), []);
  assert.deepEqual(modelChain('vision', { AI_VISION_MODELS: 'a, b' }), ['a', 'b']);
});

test('turns alternate, merge and start with the user', () => {
  assert.deepEqual(toTurns(params.contents).map((t) => t.role), ['user', 'assistant', 'user']);
  assert.deepEqual(toTurns({ parts: [{ text: 'x' }] }).map((t) => t.role), ['user']);
  assert.deepEqual(toTurns([{ role: 'model', parts: [{ text: 'a' }] }, { role: 'user', parts: [{ text: 'b' }] }, { role: 'user', parts: [{ text: 'c' }] }]).map((t) => [t.role, t.parts.length]), [['user', 2]]);
});

test('extractJson strips fences and chatter', () => {
  assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('Sure! {"a":{"b":2}} hope that helps'), '{"a":{"b":2}}');
});

test('openai-compatible request and answer', async () => {
  const f = stubFetch({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  try {
    const r = await callOpenAI({ provider: 'openai', model: 'qwen-vl', apiKey: 'sk', baseUrl: 'http://h/v1/' }, { ...params, config: { ...params.config, responseMimeType: 'application/json' } }, 1000, {});
    assert.equal(r.text, '{"ok":true}');
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 3 });
    const s = f.seen[0];
    assert.equal(s.url, 'http://h/v1/chat/completions');
    assert.equal(s.headers.authorization, 'Bearer sk');
    assert.deepEqual(s.body.response_format, { type: 'json_object' });
    assert.equal(s.body.messages[0].role, 'system');
    assert.match(s.body.messages[0].content, /be brief/);
    assert.equal(s.body.messages[2].content, 'hello');
    assert.equal(s.body.messages[3].content[1].image_url.url, 'data:image/jpeg;base64,QUJD');
  } finally { f.restore(); }
});

test('anthropic request and answer', async () => {
  const f = stubFetch({ content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 5, output_tokens: 2 } });
  try {
    const r = await callAnthropic({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'ak' }, { ...params, config: { ...params.config, responseMimeType: 'application/json' } }, 1000, {});
    assert.equal(r.text, '{"a":1}');
    const s = f.seen[0];
    assert.equal(s.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(s.headers['x-api-key'], 'ak');
    assert.equal(s.body.max_tokens, 1024);
    assert.match(s.body.system, /JSON object only/);
    assert.deepEqual(s.body.messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(s.body.messages[2].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  } finally { f.restore(); }
});

test('HTTP errors carry the status in the form the fallback chain recognises', async () => {
  const f = stubFetch({ error: 'overloaded' }, 529);
  try {
    await assert.rejects(callAnthropic({ provider: 'anthropic', model: 'm', apiKey: 'k' }, params, 1000, {}), /"code": 529/);
  } finally { f.restore(); }
  const g = stubFetch({ error: 'busy' }, 503);
  try {
    await assert.rejects(callOpenAI({ provider: 'openai', model: 'm' }, params, 1000, {}), /"code": 503/);
  } finally { g.restore(); }
});
