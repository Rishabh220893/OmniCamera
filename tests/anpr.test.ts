import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnprClient } from '../server/anprClient';
import { mergePlates } from '../server/plateMerge';
import { buildLogDocument } from '../server/logEntry';

const raw = (text: string, confidence: number) => ({
  text, raw_text: text, confidence, detection_confidence: 0.9, bbox: [1, 2, 3, 4], format_valid: true, corrected: false,
});
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('client posts the JPEG with the key, filters low confidence, and de-duplicates by best read', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const client = createAnprClient({
    url: 'http://anpr.test:8000/', apiKey: 'k', minConfidence: 0.6,
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ plates: [raw('GJ01AB1234', 0.7), raw('GJ01AB1234', 0.95), raw('MH12XY9999', 0.4), raw('', 0.99)] });
    }) as unknown as typeof fetch,
  });
  const reads = await client.detect(Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal(seen!.url, 'http://anpr.test:8000/v1/anpr');
  assert.equal((seen!.init.headers as Record<string, string>)['X-ANPR-Key'], 'k');
  assert.equal((seen!.init.headers as Record<string, string>)['Content-Type'], 'image/jpeg');
  assert.deepEqual(reads.map((r) => [r.text, r.confidence]), [['GJ01AB1234', 0.95]]);
});

test('client throws on service errors so callers can fall back', async () => {
  const client = createAnprClient({ url: 'http://x', fetchImpl: (async () => jsonResponse({ detail: 'no' }, 500)) as unknown as typeof fetch });
  await assert.rejects(client.detect(Buffer.from('x')), /responded 500/);
  await assert.rejects(client.health(), /responded 500/);
});

test('client health returns the service report (device) as-is', async () => {
  const client = createAnprClient({ url: 'http://x', fetchImpl: (async () => jsonResponse({ status: 'ok', device: 'cuda' })) as unknown as typeof fetch });
  assert.equal((await client.health()).device, 'cuda');
});

const read = (text: string, confidence = 0.9) => ({ text, rawText: text, confidence, detectionConfidence: 0.9, bbox: [0, 0, 1, 1] as [number, number, number, number], formatValid: true, corrected: false });

test('ANPR answer is authoritative, including when it finds nothing', () => {
  const found = mergePlates(['AAAA0000'], { reads: [read('GJ01AB1234')] });
  assert.deepEqual(found.plates, ['GJ01AB1234']);
  assert.equal(found.source, 'anpr');
  assert.equal(found.reads[0].confidence, 0.9);
  const none = mergePlates(['HALLUCINATED1'], { reads: [] });
  assert.deepEqual(none.plates, [], "Gemini's plates are ignored when ANPR ran and saw none");
  assert.equal(none.source, 'anpr');
});

test('without ANPR configured, Gemini plates are used (cleaned, de-duplicated)', () => {
  const m = mergePlates(['gj 01-ab 1234', 'GJ01AB1234', ''], null);
  assert.deepEqual(m.plates, ['GJ01AB1234']);
  assert.equal(m.source, 'gemini');
});

test('if ANPR is configured but failed, fall back to Gemini and say so', () => {
  const m = mergePlates(['GJ01AB1234'], { error: new Error('timeout') });
  assert.deepEqual(m.plates, ['GJ01AB1234']);
  assert.equal(m.source, 'gemini-fallback');
});

test('log document carries per-plate confidence and plate source', () => {
  const doc = buildLogDocument({ id: 'c', name: 'Gate', sensitivity: 5, userId: 'u' }, {
    detected_plates: ['GJ01AB1234'], plate_reads: [{ plate: 'GJ01AB1234', confidence: 0.91, formatValid: true, corrected: false }], plate_source: 'anpr',
  }, new Date(0));
  assert.equal(doc.plateSource, 'anpr');
  assert.equal(doc.plateReads[0].confidence, 0.91);
  assert.equal(buildLogDocument({ id: 'c', name: 'G', sensitivity: 5, userId: 'u' }, {}, new Date(0)).plateSource, 'gemini');
});

test('probe distinguishes a wrong key from an outage', async () => {
  const wrongKey = createAnprClient({ url: 'http://x', apiKey: 'bad', fetchImpl: (async () => jsonResponse({ detail: 'no' }, 401)) as unknown as typeof fetch });
  await assert.rejects(wrongKey.probe(), /rejected the API key/);
  const down = createAnprClient({ url: 'http://x', fetchImpl: (async () => jsonResponse({}, 503)) as unknown as typeof fetch });
  await assert.rejects(down.probe(), /responded 503/);
  let sent: Uint8Array | undefined;
  const ok = createAnprClient({ url: 'http://x', apiKey: 'k', fetchImpl: (async (_u: string, init: RequestInit) => { sent = init.body as Uint8Array; return jsonResponse({ plates: [] }); }) as unknown as typeof fetch });
  await ok.probe();
  assert.equal(sent![0], 0xff, 'sends a real JPEG');
  assert.equal(sent![1], 0xd8);
});

test('circuit breaker: after repeated failures the service is skipped without waiting, then retried after the cool-down', async () => {
  let t = 0, calls = 0, healthy = false;
  const client = createAnprClient({
    url: 'http://x', failureThreshold: 3, cooldownMs: 60_000, now: () => t,
    fetchImpl: (async () => { calls++; if (!healthy) throw new Error('connect timeout'); return jsonResponse({ plates: [raw('GJ01AB1234', 0.9)] }); }) as unknown as typeof fetch,
  });
  for (let i = 0; i < 3; i++) await assert.rejects(client.detect(Buffer.from('x')), /connect timeout/);
  assert.equal(calls, 3);
  await assert.rejects(client.detect(Buffer.from('x')), /cool-down/);
  assert.equal(calls, 3, 'no network call (and no timeout wait) while cooling down');
  t = 59_000;
  await assert.rejects(client.detect(Buffer.from('x')), /cool-down/);
  t = 61_000; healthy = true;
  assert.equal((await client.detect(Buffer.from('x')))[0].text, 'GJ01AB1234');
  assert.equal(calls, 4, 'one request is let through after the cool-down and the service is back in use');
  await client.detect(Buffer.from('x')); assert.equal(calls, 5);
});

test('circuit breaker: a success resets the failure count; a failed retry re-opens the cool-down', async () => {
  let t = 0, fail = true, calls = 0;
  const client = createAnprClient({
    url: 'http://x', failureThreshold: 2, cooldownMs: 10_000, now: () => t,
    fetchImpl: (async () => { calls++; if (fail) throw new Error('down'); return jsonResponse({ plates: [] }); }) as unknown as typeof fetch,
  });
  await assert.rejects(client.detect(Buffer.from('x')), /down/);
  fail = false; await client.detect(Buffer.from('x'));            // success resets the count
  fail = true;  await assert.rejects(client.detect(Buffer.from('x')), /down/); // 1 failure only → still closed
  await assert.rejects(client.detect(Buffer.from('x')), /down/);               // 2nd consecutive → opens
  await assert.rejects(client.detect(Buffer.from('x')), /cool-down/);
  t = 10_001;
  await assert.rejects(client.detect(Buffer.from('x')), /down/);               // retry fails → straight back to cool-down
  await assert.rejects(client.detect(Buffer.from('x')), /cool-down/);
});
