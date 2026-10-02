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
