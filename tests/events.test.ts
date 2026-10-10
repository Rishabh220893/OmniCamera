import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EVENT_CATALOGUE, EventError, eventsFromLog, makeEvent, type EventCamera, type PlatformEvent } from '../server/events/schema.ts';
import { REDACTED, RuleError, inSchedule, redactRule, ruleMatches, throttleKey, validateRule, type AlertRule } from '../server/events/rules.ts';
import { createChannelRegistry, createLogChannel, createWebhookChannel, signBody, type Channel, type DeliveryContext } from '../server/events/channels.ts';
import { createMemoryAlertStore, createPostgresAlertStore } from '../server/events/store.ts';
import { AlertError, createAlertEngine } from '../server/events/alertEngine.ts';

const CAM: EventCamera = { id: 'cam01', name: 'Gate', userId: 'u1', department: 'Traffic', location: { lat: 23, lng: 72 } };
const T0 = new Date('2026-10-10T10:00:00.000Z');
const ev = (over: Partial<PlatformEvent> & { type?: string } = {}, camera: EventCamera = CAM, ts: Date = T0): PlatformEvent =>
  makeEvent({ type: over.type ?? 'plate.read', summary: over.summary ?? 'Plate GJ05AB1234 read', severity: over.severity, data: over.data ?? { plate: 'GJ05AB1234' }, tags: over.tags, confidence: over.confidence, dedupeKey: (over.data?.plate as string | undefined) }, { source: over.source ?? 'anpr', camera, ts });

const mkRule = (over: Record<string, unknown> = {}, userId = 'u1'): AlertRule =>
  validateRule({ name: 'r', match: {}, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['camera', 'type'] }, ...over }, { userId, id: String(over.id ?? 'rule1'), now: T0 });

// ---- schema -------------------------------------------------------------------------------------------------------

test('events: contract is enforced and ids are stable', () => {
  const a = ev();
  assert.equal(a.severity, 'info', 'plate.read defaults to info');
  assert.equal(ev({ type: 'plate.watchlist_match' }).severity, 'critical');
  assert.equal(ev({ type: 'custom.thing' }).severity, 'info', 'an unknown type defaults to info');
  assert.equal(ev({ type: 'custom.thing', severity: 'warning' }).severity, 'warning');
  assert.equal(ev().id, a.id, 'same inputs, same id');
  assert.notEqual(ev({ data: { plate: 'OTHER1' }, summary: 'x' }).id, a.id);
  assert.notEqual(ev({}, { ...CAM, id: 'cam02' }).id, a.id);
  assert.notEqual(ev({}, CAM, new Date(T0.getTime() + 1)).id, a.id);
  assert.equal(a.department, 'Traffic');
  assert.deepEqual(a.location, { lat: 23, lng: 72 });
  for (const type of ['plate', 'Plate.read', 'plate.', '.read', 'plate read', 'plate.read!', '1plate.read']) {
    assert.throws(() => makeEvent({ type, summary: 's' }, { source: 's', camera: CAM, ts: T0 }), EventError, type);
  }
  assert.throws(() => makeEvent({ type: 'a.b', summary: '' }, { source: 's', camera: CAM, ts: T0 }), /summary/);
  assert.throws(() => makeEvent({ type: 'a.b', summary: 's' }, { source: 's', camera: CAM, ts: new Date('nope') }), /valid date/);
  assert.throws(() => makeEvent({ type: 'a.b', summary: 's', severity: 'loud' as never }, { source: 's', camera: CAM, ts: T0 }), /severity/);
});

test('events: data is made safe for JSON, confidence is clamped, tags are tidy', () => {
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.deepEqual(makeEvent({ type: 'a.b', summary: 's', data: circular }, { source: 's', camera: CAM, ts: T0 }).data, { unserialisable: true });
  assert.deepEqual(makeEvent({ type: 'a.b', summary: 's', data: { big: 'x'.repeat(30_000) } }, { source: 's', camera: CAM, ts: T0 }).data, { truncated: true });
  assert.deepEqual(makeEvent({ type: 'a.b', summary: 's', data: { f: () => 1, u: undefined, n: 1 } }, { source: 's', camera: CAM, ts: T0 }).data, { n: 1 });
  const e = makeEvent({ type: 'a.b', summary: 's'.repeat(900), confidence: 7, tags: ['x', 'x', ...Array.from({ length: 40 }, (_, i) => `t${i}`)] }, { source: 's', camera: CAM, ts: T0 });
  assert.equal(e.confidence, 1);
  assert.equal(e.summary.length, 500);
  assert.equal(e.tags.length, 20);
  assert.equal(makeEvent({ type: 'a.b', summary: 's', confidence: -3 }, { source: 's', camera: CAM, ts: T0 }).confidence, 0);
  assert.equal('confidence' in makeEvent({ type: 'a.b', summary: 's', confidence: Number.NaN }, { source: 's', camera: CAM, ts: T0 }), false);
});

test('events: the catalogue is valid and covers what eventsFromLog produces', () => {
  for (const c of EVENT_CATALOGUE) assert.doesNotThrow(() => makeEvent({ type: c.type, summary: 's' }, { source: 's', camera: CAM, ts: T0 }), c.type);
  const log = {
    detectedPlates: ['GJ05AB1234', 'MH12XY9999'], plateReads: [{ plate: 'GJ05AB1234', confidence: 0.91, formatValid: true, corrected: false }],
    plateSource: 'anpr', detectedItems: ['Unknown Person', 'Jane', 'N/A'], isUnusual: true, unusualReason: 'Fence climbing', sentiment: 'tense' as const,
    alerts: ['Watchlist match: GJ05AB1234', 'Person near gate'], isWatchlistMatch: true,
  };
  const drafts = eventsFromLog(log, ['gj 05-ab 1234']);
  assert.deepEqual(drafts.map((d) => d.type), ['plate.read', 'plate.watchlist_match', 'plate.read', 'person.unknown', 'person.known', 'scene.unusual', 'scene.alert']);
  assert.deepEqual(drafts[0].tags, ['watchlist']);
  assert.equal(drafts[0].confidence, 0.91);
  assert.equal(drafts[2].data!.confidence, null, 'a plate without a read record has no confidence');
  assert.equal(drafts[4].data!.name, 'Jane');
  assert.equal(drafts[6].summary, 'Person near gate', 'the watchlist alert text is not repeated as a scene alert');
  assert.deepEqual(eventsFromLog({ ...log, detectedPlates: [], plateReads: [], detectedItems: [], isUnusual: false, alerts: [] }), []);
  const events = drafts.map((d) => makeEvent(d, { source: 'scene', camera: CAM, ts: T0 }));
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, 'every event in a frame has its own id');
});

// ---- rules: validation --------------------------------------------------------------------------------------------

test('rules: a good rule is normalised; bad ones list every problem', () => {
  const r = validateRule({
    name: '  Watchlist  ', match: { types: ['plate.*', 'scene.unusual'], minSeverity: 'warning', cameraIds: ['cam01'], where: [{ field: 'data.plate', op: 'startsWith', value: 'GJ' }, { field: 'confidence', op: 'gte', value: 0.8 }] },
    schedule: { days: [5, 1, 1], from: '22:00', to: '06:00', tzOffsetMin: 330 }, throttle: { windowMs: 0, by: ['event', 'event'] },
    channels: [{ type: 'webhook', url: 'https://hooks.example.org/x', secret: 's3' }, { type: 'log' }], junk: 1,
  }, { userId: 'u1', id: 'r1', now: T0 });
  assert.equal(r.name, 'Watchlist');
  assert.deepEqual(r.schedule, { days: [1, 5], from: '22:00', to: '06:00', tzOffsetMin: 330 });
  assert.deepEqual(r.throttle, { windowMs: 0, by: ['event'] });
  assert.equal(r.enabled, true);
  assert.ok(!('junk' in r));
  const bad = (input: unknown) => { try { validateRule(input, { userId: 'u1', id: 'x', now: T0 }); return []; } catch (e) { return (e as RuleError).problems; } };
  assert.equal(bad(null).length, 1);
  assert.equal(bad([]).length, 1);
  const many = bad({ name: '', match: { types: ['Bad Type', 'plate'], minSeverity: 'loud', cameraIds: 'cam01', where: [{ field: 'secret', op: 'eq', value: 1 }, { field: 'data.x', op: 'weird', value: 1 }, { field: 'data.x', op: 'gt', value: 'a' }, { field: 'data.x', op: 'in', value: 3 }, { field: 'data.x', op: 'eq' }] }, schedule: { days: [9], from: '25:00' }, throttle: { windowMs: -1, by: ['nope'] }, channels: [] });
  assert.ok(many.length >= 12, `reported ${many.length} problems: ${many.join(' | ')}`);
  assert.ok(bad({ name: 'n', channels: [{ type: 'sms' }] }).some((p) => /channels\[0\]\.type/.test(p)));
  assert.ok(bad({ name: 'n', channels: [{ type: 'webhook', url: 'ftp://x' }] }).some((p) => /http/.test(p)));
  assert.ok(bad({ name: 'n', channels: Array.from({ length: 6 }, () => ({ type: 'log' })) }).length === 1);
  assert.ok(bad({ name: 'n', schedule: { from: '10:00' }, channels: [{ type: 'log' }] }).some((p) => /both/.test(p)));
  assert.ok(bad({ name: 'n', match: { where: Array.from({ length: 21 }, () => ({ field: 'data.a', op: 'exists' })) }, channels: [{ type: 'log' }] }).length === 1);
  assert.deepEqual(validateRule({ name: 'n', channels: [{ type: 'log' }] }, { userId: 'u', id: 'i', now: T0 }).throttle, { windowMs: 300_000, by: ['camera', 'type'] }, 'defaults');
  assert.equal(validateRule({ name: 'n', enabled: false, channels: [{ type: 'log' }] }, { userId: 'u', id: 'i', now: T0 }).enabled, false);
  assert.equal(bad({ name: 'n', channels: [{ type: 'webhook', url: 'https://a.example' }] }).length, 0);
  assert.throws(() => validateRule({ name: 'n', channels: [{ type: 'webhook', url: 'https://a.example' }] }, { userId: 'u', id: 'i', now: T0, allowChannel: () => 'not allowed here' }), (e) => e instanceof RuleError && e.message.includes('channels[0]: not allowed here'));
});

test('rules: secrets are redacted for display and kept when an edit sends the placeholder back', () => {
  const body = { name: 'n', channels: [{ type: 'webhook', url: 'https://a.example/h', secret: 'topsecret' }] };
  const first = validateRule(body, { userId: 'u', id: 'i', now: T0 });
  assert.equal(JSON.stringify(redactRule(first)).includes('topsecret'), false);
  assert.equal((redactRule(first).channels[0] as { secret: string }).secret, REDACTED);
  const edited = validateRule({ ...body, name: 'renamed', channels: [{ type: 'webhook', url: 'https://a.example/h', secret: REDACTED }] }, { userId: 'u', id: 'i', now: new Date(T0.getTime() + 1000), existing: first });
  assert.equal((edited.channels[0] as { secret: string }).secret, 'topsecret');
  assert.equal(edited.createdAt, first.createdAt);
  assert.notEqual(edited.updatedAt, first.updatedAt);
  const changedUrl = validateRule({ ...body, channels: [{ type: 'webhook', url: 'https://other.example/h', secret: REDACTED }] }, { userId: 'u', id: 'i', now: T0, existing: first });
  assert.equal((changedUrl.channels[0] as { secret?: string }).secret, undefined, 'the placeholder is not carried to a different address');
});

// ---- rules: matching ----------------------------------------------------------------------------------------------

test('rules: matching - every filter on its own and combined', () => {
  const e = ev({ type: 'plate.watchlist_match', severity: 'critical', data: { plate: 'GJ05AB1234', n: 7, tags: ['x'] }, confidence: 0.9, tags: ['watchlist'], source: 'anpr' });
  const m = (match: Record<string, unknown>) => ruleMatches(mkRule({ match }), e);
  assert.ok(m({}), 'empty match = everything');
  assert.ok(m({ types: ['plate.watchlist_match'] }) && m({ types: ['plate.*'] }) && m({ types: ['scene.x', 'plate.*'] }));
  assert.ok(!m({ types: ['scene.*'] }) && !m({ types: ['plate.read'] }) && !m({ types: ['plat.*'] }));
  assert.ok(m({ minSeverity: 'critical' }) && m({ minSeverity: 'info' }));
  assert.ok(!ruleMatches(mkRule({ match: { minSeverity: 'critical' } }), ev({ severity: 'warning' })));
  assert.ok(m({ cameraIds: ['cam01'] }) && !m({ cameraIds: ['cam02'] }));
  assert.ok(m({ departments: ['Traffic'] }) && !m({ departments: ['Water'] }));
  assert.ok(!ruleMatches(mkRule({ match: { departments: ['Traffic'] } }), ev({}, { id: 'c', name: 'c', userId: 'u1' })), 'an event without a department never matches a department filter');
  assert.ok(m({ sources: ['anpr'] }) && !m({ sources: ['gemini'] }));
  assert.ok(m({ tags: ['watchlist'] }) && !m({ tags: ['watchlist', 'vip'] }));
  const w = (where: unknown[]) => m({ where });
  assert.ok(w([{ field: 'data.plate', op: 'eq', value: 'GJ05AB1234' }]) && !w([{ field: 'data.plate', op: 'eq', value: 'x' }]));
  assert.ok(w([{ field: 'data.plate', op: 'neq', value: 'x' }]) && !w([{ field: 'data.plate', op: 'neq', value: 'GJ05AB1234' }]));
  assert.ok(w([{ field: 'data.plate', op: 'in', value: ['A', 'GJ05AB1234'] }]) && !w([{ field: 'data.plate', op: 'in', value: ['A'] }]));
  assert.ok(w([{ field: 'data.plate', op: 'contains', value: '05ab' }]) && !w([{ field: 'data.plate', op: 'contains', value: 'zz' }]), 'string contains ignores case');
  assert.ok(w([{ field: 'data.tags', op: 'contains', value: 'x' }]) && !w([{ field: 'data.tags', op: 'contains', value: 'y' }]), 'list contains');
  assert.ok(w([{ field: 'data.plate', op: 'startsWith', value: 'gj05' }]) && !w([{ field: 'data.plate', op: 'startsWith', value: 'MH' }]));
  assert.ok(w([{ field: 'data.n', op: 'gt', value: 6 }]) && !w([{ field: 'data.n', op: 'gt', value: 7 }]) && w([{ field: 'data.n', op: 'gte', value: 7 }]) && w([{ field: 'data.n', op: 'lt', value: 8 }]) && w([{ field: 'data.n', op: 'lte', value: 7 }]) && !w([{ field: 'data.n', op: 'lt', value: 7 }]));
  assert.ok(w([{ field: 'confidence', op: 'gte', value: 0.8 }]) && !w([{ field: 'confidence', op: 'gte', value: 0.95 }]));
  assert.ok(w([{ field: 'data.plate', op: 'exists' }]) && !w([{ field: 'data.missing', op: 'exists' }]) && !w([{ field: 'data.missing.deeper', op: 'eq', value: 1 }]));
  assert.ok(!w([{ field: 'data.plate', op: 'gt', value: 1 }]), 'numeric comparison on a non-number is false');
  assert.ok(w([{ field: 'severity', op: 'eq', value: 'critical' }, { field: 'cameraId', op: 'eq', value: 'cam01' }]) && !w([{ field: 'severity', op: 'eq', value: 'critical' }, { field: 'cameraId', op: 'eq', value: 'x' }]), 'all conditions must hold');
  assert.ok(m({ types: ['plate.*'], minSeverity: 'warning', cameraIds: ['cam01'], departments: ['Traffic'], sources: ['anpr'], tags: ['watchlist'], where: [{ field: 'data.n', op: 'gte', value: 1 }] }));
  assert.ok(!ruleMatches(mkRule({ enabled: false }), e), 'a disabled rule never matches');
});

test('rules: schedule - days, overnight windows, time zones and edges', () => {
  const at = (iso: string) => new Date(iso);
  assert.equal(inSchedule(undefined, T0), true);
  // Sat 2026-10-10 is day 6. Window 09:00-17:00 UTC.
  const day = { from: '09:00', to: '17:00' };
  assert.ok(inSchedule(day, at('2026-10-10T09:00:00Z')) && inSchedule(day, at('2026-10-10T16:59:59Z')));
  assert.ok(!inSchedule(day, at('2026-10-10T17:00:00Z')) && !inSchedule(day, at('2026-10-10T08:59:59Z')));
  // overnight 22:00-06:00, days = [5] (Friday) means windows that START on Friday
  const night = { from: '22:00', to: '06:00', days: [5] };
  assert.ok(inSchedule(night, at('2026-10-09T23:00:00Z')), 'Friday 23:00');
  assert.ok(inSchedule(night, at('2026-10-10T05:59:00Z')), 'Saturday 05:59 belongs to the Friday window');
  assert.ok(!inSchedule(night, at('2026-10-10T06:00:00Z')));
  assert.ok(!inSchedule(night, at('2026-10-10T23:00:00Z')), 'Saturday night is a Saturday window');
  assert.ok(!inSchedule(night, at('2026-10-09T12:00:00Z')));
  // India: UTC+5:30. 09:00 IST = 03:30 UTC
  const ist = { from: '09:00', to: '10:00', tzOffsetMin: 330 };
  assert.ok(inSchedule(ist, at('2026-10-10T03:30:00Z')) && !inSchedule(ist, at('2026-10-10T04:30:00Z')));
  // the local day can differ from the UTC day
  assert.ok(inSchedule({ days: [0], tzOffsetMin: 330 }, at('2026-10-10T19:00:00Z')), '00:30 Sunday in IST while still Saturday in UTC');
  assert.ok(!inSchedule({ days: [6], tzOffsetMin: 330 }, at('2026-10-10T19:00:00Z')));
  assert.ok(!inSchedule({ from: '10:00', to: '10:00' }, at('2026-10-10T10:00:00Z')), 'an empty window never matches');
  assert.ok(ruleMatches(mkRule({ schedule: day }), ev({}, CAM, at('2026-10-10T10:00:00Z'))));
  assert.ok(!ruleMatches(mkRule({ schedule: day }), ev({}, CAM, at('2026-10-10T20:00:00Z'))), 'the schedule uses when the event happened, not when it was processed');
});

test('rules: throttle keys group what they should', () => {
  const r = (by: string[]) => mkRule({ throttle: { windowMs: 1000, by } });
  const a = ev({ data: { plate: 'AAA111' }, summary: 'a' }), b = ev({ data: { plate: 'BBB222' }, summary: 'b' });
  const otherCam = ev({ data: { plate: 'AAA111' }, summary: 'a' }, { ...CAM, id: 'cam02' });
  const otherType = ev({ type: 'plate.watchlist_match', data: { plate: 'AAA111' }, summary: 'a' });
  assert.equal(throttleKey(r(['camera', 'type']), a), throttleKey(r(['camera', 'type']), b));
  assert.notEqual(throttleKey(r(['camera', 'type']), a), throttleKey(r(['camera', 'type']), otherCam));
  assert.notEqual(throttleKey(r(['camera', 'type']), a), throttleKey(r(['camera', 'type']), otherType));
  assert.notEqual(throttleKey(r(['event']), a), throttleKey(r(['event']), b), 'by event: different plates are different');
  assert.equal(throttleKey(r(['event']), a), throttleKey(r(['event']), otherCam), 'by event alone ignores the camera');
  assert.equal(throttleKey(r(['rule']), a), throttleKey(r(['rule']), otherCam));
  assert.equal(throttleKey(r(['type', 'camera']), a), throttleKey(r(['camera', 'type']), a), 'order does not matter');
  assert.notEqual(throttleKey(mkRule({ id: 'x' }), a), throttleKey(mkRule({ id: 'y' }), a), 'rules never share a key');
});

// ---- channels -----------------------------------------------------------------------------------------------------

const ctxFor = (e: PlatformEvent): DeliveryContext => ({
  alert: { id: 'a1', userId: 'u1', ruleId: 'rule1', ruleName: 'r', key: 'k', state: 'open', severity: e.severity, title: 't', cameraId: e.cameraId, cameraName: e.cameraName, firstEventId: e.id, lastEventId: e.id, eventCount: 1, createdAt: e.ts, lastEventAt: e.ts, deliveries: [] },
  event: e, rule: { id: 'rule1', name: 'r' },
});

test('webhook channel: signed body, retries for server errors and overload, not for a refusal, private addresses refused', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  const script = (statuses: Array<number | Error>): typeof fetch => (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const s = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (s instanceof Error) throw s;
    return new Response('', { status: s });
  }) as never;
  const mk = (statuses: Array<number | Error>) => { calls.length = 0; sleeps.length = 0; return createWebhookChannel({ fetchImpl: script(statuses), sleep: async (ms) => { sleeps.push(ms); } }); };
  const cfg = { type: 'webhook' as const, url: 'https://hooks.example.org/x', secret: 'k' };
  const c = ctxFor(ev());

  const ok = await mk([200]).deliver(cfg, c);
  assert.equal(ok.attempts, 1);
  const body = String(calls[0].init.body);
  assert.equal((calls[0].init.headers as Record<string, string>)['X-OmniSee-Signature'], `sha256=${createHmac('sha256', 'k').update(body).digest('hex')}`);
  assert.equal(signBody('k', body), (calls[0].init.headers as Record<string, string>)['X-OmniSee-Signature']);
  assert.equal(JSON.parse(body).event.type, 'plate.read');
  assert.equal(JSON.parse(body).alert.id, 'a1');
  assert.equal((calls[0].init.headers as Record<string, string>)['X-OmniSee-Event'], 'plate.read');
  await mk([200]).deliver({ ...cfg, secret: undefined }, c);
  assert.equal('X-OmniSee-Signature' in (calls[0].init.headers as Record<string, string>), false, 'no secret, no signature');

  assert.equal((await mk([500, 503, 200]).deliver(cfg, c)).attempts, 3);
  assert.deepEqual(sleeps, [1000, 4000]);
  assert.equal((await mk([429, 200]).deliver(cfg, c)).attempts, 2);
  assert.equal((await mk([408, 200]).deliver(cfg, c)).attempts, 2);
  assert.equal((await mk([new Error('ECONNRESET'), 200]).deliver(cfg, c)).attempts, 2);
  await assert.rejects(mk([404]).deliver(cfg, c), /HTTP 404/);
  assert.equal(calls.length, 1, 'a 404 is not retried');
  await assert.rejects(mk([400]).deliver(cfg, c), /HTTP 400/);
  await assert.rejects(mk([500]).deliver(cfg, c), /HTTP 500 after 3 attempts/);
  assert.equal(calls.length, 3);
  await assert.rejects(mk([new Error('boom')]).deliver(cfg, c), /boom after 3 attempts/);
  await assert.rejects(mk([200]).deliver({ ...cfg, url: 'http://192.168.1.5/x' }, c), /private network/);
  assert.equal(calls.length, 0, 'nothing was sent to a private address');
  assert.equal(createWebhookChannel({ allowPrivate: true }).check!({ type: 'webhook', url: 'http://192.168.1.5/x' }), null);
  assert.match(createWebhookChannel().check!({ type: 'webhook', url: 'http://localhost/x' })!, /private/);
  assert.equal(calls.every((x) => (x.init as { redirect?: string }).redirect === 'error') || calls.length === 0, true, 'redirects are not followed');
});

test('channel registry: unknown channel types are explained', () => {
  const r = createChannelRegistry([createLogChannel({ warn: () => {} }), createWebhookChannel()]);
  assert.equal(r.check({ type: 'log' }), null);
  assert.match(r.check({ type: 'webhook', url: 'http://10.0.0.1/' })!, /private/);
  assert.match(createChannelRegistry([]).check({ type: 'log' })!, /not available/);
});

// ---- the engine ---------------------------------------------------------------------------------------------------

function engineWith(rules: AlertRule[], o: { channel?: Channel; start?: Date } = {}) {
  const store = createMemoryAlertStore();
  let clock = (o.start ?? T0).getTime();
  const delivered: Array<{ alert: string; event: string; rule: string }> = [];
  const hook: Channel = o.channel ?? { type: 'log', deliver: async (_c, ctx) => { delivered.push({ alert: ctx.alert.id, event: ctx.event.id, rule: ctx.rule.id }); return { attempts: 1 }; } };
  let n = 0;
  const engine = createAlertEngine({ store, channels: createChannelRegistry([hook as never]), now: () => new Date(clock), newId: () => `alert-${++n}`, log: { warn: () => {}, info: () => {} }, ruleCacheMs: 0 });
  return { store, engine, delivered, advance: (ms: number) => { clock += ms; }, ready: Promise.all(rules.map((r) => store.saveRule(r))) };
}

const at = (ms: number) => new Date(T0.getTime() + ms);

test('engine: an event is stored once; a retried job does not alert twice', async () => {
  const x = engineWith([mkRule()]); await x.ready;
  const e = ev();
  const first = await x.engine.ingest([e]);
  assert.equal(first.stored, 1);
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].opened, true);
  const again = await x.engine.ingest([e]);
  assert.equal(again.stored, 0);
  assert.equal(again.alerts.length, 0);
  assert.equal(x.delivered.length, 1);
  assert.equal((await x.store.queryEvents({ userId: 'u1' })).length, 1);
});

test('engine: repeats fold into one alert for the window, then a new alert opens', async () => {
  const x = engineWith([mkRule({ throttle: { windowMs: 60_000, by: ['camera', 'type'] } })]); await x.ready;
  await x.engine.ingest([ev({}, CAM, at(0))]);
  const r2 = await x.engine.ingest([ev({ data: { plate: 'ZZ99' }, summary: 'other' }, CAM, at(30_000))]);
  assert.equal(r2.alerts[0].opened, false);
  assert.equal(r2.alerts[0].alert.eventCount, 2);
  const r3 = await x.engine.ingest([ev({ data: { plate: 'YY88' }, summary: 'third' }, CAM, at(80_000))]);
  assert.equal(r3.alerts[0].opened, false, 'the window runs from the last event, so 50 s after the second still folds');
  assert.equal(r3.alerts[0].alert.eventCount, 3);
  const r4 = await x.engine.ingest([ev({ summary: 'late' , data: { plate: 'LATE1' } }, CAM, at(80_000 + 61_000))]);
  assert.equal(r4.alerts[0].opened, true, 'quiet for longer than the window: a new alert');
  assert.equal(x.delivered.length, 2);
  assert.equal((await x.store.listAlerts({ userId: 'u1' })).length, 2);
});

test('engine: throttle choices - per camera, per plate, none', async () => {
  const perCamera = engineWith([mkRule({ throttle: { windowMs: 60_000, by: ['camera', 'type'] } })]); await perCamera.ready;
  await perCamera.engine.ingest([ev({}, CAM, at(0)), ev({}, { ...CAM, id: 'cam02', name: 'Yard' }, at(1000))]);
  assert.equal(perCamera.delivered.length, 2, 'two cameras, two alerts');

  const perPlate = engineWith([mkRule({ throttle: { windowMs: 60_000, by: ['event'] } })]); await perPlate.ready;
  await perPlate.engine.ingest([ev({ data: { plate: 'AAA111' }, summary: 'a' }, CAM, at(0)), ev({ data: { plate: 'BBB222' }, summary: 'b' }, CAM, at(1000)), ev({ data: { plate: 'AAA111' }, summary: 'a' }, CAM, at(2000))]);
  assert.equal(perPlate.delivered.length, 2, 'AAA111 folded, BBB222 separate');

  const none = engineWith([mkRule({ throttle: { windowMs: 0, by: ['camera'] } })]); await none.ready;
  await none.engine.ingest([ev({ summary: 'a' }, CAM, at(0)), ev({ summary: 'b', data: { plate: 'B' } }, CAM, at(1000)), ev({ summary: 'c', data: { plate: 'C' } }, CAM, at(2000))]);
  assert.equal(none.delivered.length, 3, 'window 0: every event alerts');
});

test('engine: rules only see their own user; non-matching and disabled rules do nothing; several rules can fire', async () => {
  const x = engineWith([
    mkRule({ id: 'a', match: { types: ['plate.*'] } }), mkRule({ id: 'b', match: { types: ['scene.*'] } }),
    mkRule({ id: 'c', enabled: false }), mkRule({ id: 'd', match: { minSeverity: 'info' } }), mkRule({ id: 'other', match: {} }, 'u2'),
  ]); await x.ready;
  const r = await x.engine.ingest([ev()]);
  assert.deepEqual(r.alerts.map((a) => a.alert.ruleId).sort(), ['a', 'd']);
  assert.equal((await x.store.listAlerts({ userId: 'u2' })).length, 0, "another user's rule is not used");
  const own = await x.engine.ingest([ev({}, { ...CAM, userId: 'u2' }, at(5000))]);
  assert.deepEqual(own.alerts.map((a) => a.alert.ruleId), ['other']);
});

test('engine: a higher-severity repeat raises the alert; a resolved alert is not reused', async () => {
  const x = engineWith([mkRule({ match: {}, throttle: { windowMs: 600_000, by: ['camera'] } })]); await x.ready;
  const a = (await x.engine.ingest([ev({ severity: 'notice', summary: 'n' }, CAM, at(0))])).alerts[0].alert;
  assert.equal(a.severity, 'notice');
  const bumped = (await x.engine.ingest([ev({ type: 'scene.unusual', severity: 'critical', summary: 'c', data: {} }, CAM, at(1000))])).alerts[0].alert;
  assert.equal(bumped.id, a.id);
  assert.equal(bumped.severity, 'critical');
  const low = (await x.engine.ingest([ev({ severity: 'info', summary: 'i', data: { plate: 'Q' } }, CAM, at(2000))])).alerts[0].alert;
  assert.equal(low.severity, 'critical', 'severity never goes down');
  await x.engine.resolve('u1', a.id, 'u1');
  const next = (await x.engine.ingest([ev({ summary: 'after', data: { plate: 'R' } }, CAM, at(3000))])).alerts[0];
  assert.equal(next.opened, true, 'after resolving, the next event is a new alert');
  assert.notEqual(next.alert.id, a.id);
});

test('engine: lifecycle - acknowledge, resolve, repeats, wrong user, unknown id', async () => {
  const x = engineWith([mkRule()]); await x.ready;
  const a = (await x.engine.ingest([ev()])).alerts[0].alert;
  const acked = await x.engine.acknowledge('u1', a.id, 'op1');
  assert.deepEqual([acked.state, acked.ackBy], ['acknowledged', 'op1']);
  const again = await x.engine.acknowledge('u1', a.id, 'op2');
  assert.equal(again.ackBy, 'op1', 'acknowledging twice changes nothing');
  const folded = (await x.engine.ingest([ev({ data: { plate: 'N' }, summary: 'n' }, CAM, at(1000))])).alerts[0];
  assert.equal(folded.alert.id, a.id);
  assert.equal(folded.alert.state, 'acknowledged', 'new events do not reopen an acknowledged alert');
  const res = await x.engine.resolve('u1', a.id, 'op1');
  assert.deepEqual([res.state, res.resolvedBy], ['resolved', 'op1']);
  assert.equal((await x.engine.resolve('u1', a.id, 'op3')).resolvedBy, 'op1');
  await assert.rejects(x.engine.acknowledge('u1', a.id, 'op1'), (e) => e instanceof AlertError && e.code === 'bad_state');
  await assert.rejects(x.engine.acknowledge('u2', a.id, 'op1'), (e) => e instanceof AlertError && e.code === 'not_found');
  await assert.rejects(x.engine.resolve('u1', 'nope', 'op1'), (e) => e instanceof AlertError && e.code === 'not_found');
  const open = await x.engine.ingest([ev({ summary: 'fresh', data: { plate: 'F' } }, CAM, at(2000))]);
  assert.equal((await x.engine.resolve('u1', open.alerts[0].alert.id, 'op1')).state, 'resolved', 'an open alert can be resolved directly');
});

test('engine: delivery problems are recorded, never lose the alert, and one bad channel does not stop the others', async () => {
  const failing: Channel = { type: 'webhook', deliver: async () => { throw new Error('receiver down'); } };
  const okLog: Channel = { type: 'log', deliver: async () => ({ attempts: 1 }) };
  const store = createMemoryAlertStore();
  const engine = createAlertEngine({ store, channels: createChannelRegistry([failing as never, okLog as never]), now: () => T0, newId: () => 'A1', log: { warn: () => {}, info: () => {} }, ruleCacheMs: 0 });
  await store.saveRule(mkRule({ channels: [{ type: 'webhook', url: 'https://a.example/h' }, { type: 'log' }] }));
  const r = await engine.ingest([ev()]);
  const saved = await store.getAlert('u1', 'A1');
  assert.deepEqual(saved!.deliveries.map((d) => [d.channel, d.ok]), [['webhook', false], ['log', true]]);
  assert.equal(saved!.deliveries[0].error, 'receiver down');
  assert.equal(r.alerts[0].opened, true);
  assert.equal((await store.queryEvents({ userId: 'u1' })).length, 1);
});

test('engine: an unavailable channel type is recorded as a failed delivery', async () => {
  const store = createMemoryAlertStore();
  const engine = createAlertEngine({ store, channels: createChannelRegistry([]), now: () => T0, newId: () => 'A1', log: { warn: () => {}, info: () => {} }, ruleCacheMs: 0 });
  await store.saveRule(mkRule());
  await engine.ingest([ev()]);
  assert.match((await store.getAlert('u1', 'A1'))!.deliveries[0].error!, /not available/);
});

test('engine: many ingests at once for the same thing open one alert', async () => {
  const x = engineWith([mkRule()]); await x.ready;
  const events = Array.from({ length: 12 }, (_, i) => ev({ summary: `p${i}`, data: { plate: `P${i}` } }, CAM, at(i * 100)));
  await Promise.all(events.map((e) => x.engine.ingest([e])));
  const alerts = await x.store.listAlerts({ userId: 'u1' });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].eventCount, 12);
  assert.equal(x.delivered.length, 1);
});

test('engine: a new rule is seen once the cache is invalidated; a failed store read is not cached', async () => {
  const store = createMemoryAlertStore();
  let clock = T0.getTime();
  const engine = createAlertEngine({ store, channels: createChannelRegistry([createLogChannel({ warn: () => {} }) as never]), now: () => new Date(clock), log: { warn: () => {}, info: () => {} }, ruleCacheMs: 60_000 });
  assert.equal((await engine.ingest([ev({ summary: 'a' })])).alerts.length, 0);
  await store.saveRule(mkRule());
  assert.equal((await engine.ingest([ev({ summary: 'b', data: { plate: 'B' } }, CAM, at(1000))])).alerts.length, 0, 'still the cached empty list');
  engine.invalidate('u1');
  assert.equal((await engine.ingest([ev({ summary: 'c', data: { plate: 'C' } }, CAM, at(2000))])).alerts.length, 1);

  let fail = true;
  const flaky = { ...store, listRules: async (u: string) => { if (fail) throw new Error('db down'); return store.listRules(u); } };
  const e2 = createAlertEngine({ store: flaky, channels: createChannelRegistry([createLogChannel({ warn: () => {} }) as never]), now: () => new Date(clock), log: { warn: () => {}, info: () => {} }, ruleCacheMs: 60_000 });
  await assert.rejects(e2.ingest([ev({ summary: 'd', data: { plate: 'D' } }, CAM, at(3000))]), /db down/);
  fail = false;
  clock += 1;
  assert.equal((await e2.ingest([ev({ summary: 'e', data: { plate: 'E' } }, CAM, at(4000))])).alerts.length, 1, 'recovers on the next batch');
});

test('engine: test() delivers a made-up event and stores nothing', async () => {
  const x = engineWith([mkRule()]); await x.ready;
  const d = await x.engine.test((await x.store.getRule('u1', 'rule1'))!, { id: 'c', name: 'Test camera' });
  assert.deepEqual(d.map((y) => y.ok), [true]);
  assert.equal(x.delivered.length, 1);
  assert.equal((await x.store.queryEvents({ userId: 'u1' })).length, 0);
  assert.equal((await x.store.listAlerts({ userId: 'u1' })).length, 0);
});

// ---- stores -------------------------------------------------------------------------------------------------------

test('memory store: queries filter, order and cap; data is copied, not shared', async () => {
  const s = createMemoryAlertStore({ maxEvents: 5, maxAlerts: 2 });
  const events = Array.from({ length: 8 }, (_, i) => ev({ type: i % 2 ? 'scene.unusual' : 'plate.read', summary: `e${i}`, data: { plate: `P${i}` }, severity: i % 2 ? 'warning' : 'info' }, i < 4 ? CAM : { ...CAM, id: 'cam02' }, at(i * 1000)));
  assert.equal((await s.saveEvents(events)).length, 8);
  assert.equal((await s.saveEvents(events.slice(3))).length, 0, 'nothing new');
  const all = await s.queryEvents({ userId: 'u1' });
  assert.equal(all.length, 5, 'oldest dropped past the cap');
  assert.deepEqual(all.map((e) => e.summary), ['e7', 'e6', 'e5', 'e4', 'e3'], 'newest first');
  assert.deepEqual((await s.queryEvents({ userId: 'u1', types: ['plate.*'] })).map((e) => e.summary), ['e6', 'e4']);
  assert.deepEqual((await s.queryEvents({ userId: 'u1', types: ['scene.unusual'], cameraId: 'cam02' })).map((e) => e.summary), ['e7', 'e5']);
  assert.deepEqual((await s.queryEvents({ userId: 'u1', minSeverity: 'warning' })).map((e) => e.summary), ['e7', 'e5', 'e3']);
  assert.deepEqual((await s.queryEvents({ userId: 'u1', from: at(5000), to: at(7000) })).map((e) => e.summary), ['e6', 'e5']);
  assert.deepEqual((await s.queryEvents({ userId: 'u1', before: at(5000), limit: 1 })).map((e) => e.summary), ['e4']);
  assert.equal((await s.queryEvents({ userId: 'someone-else' })).length, 0);
  all[0].summary = 'changed';
  assert.equal((await s.queryEvents({ userId: 'u1' }))[0].summary, 'e7', 'results are copies');

  for (const id of ['a', 'b', 'c']) await s.saveAlert({ id, userId: 'u1', ruleId: 'r', ruleName: 'r', key: 'k', state: 'open', severity: 'info', title: id, cameraId: 'c', cameraName: 'c', firstEventId: 'e', lastEventId: 'e', eventCount: 1, createdAt: T0.toISOString(), lastEventAt: at(id.charCodeAt(0)).toISOString(), deliveries: [] });
  assert.deepEqual((await s.listAlerts({ userId: 'u1' })).map((a) => a.id), ['c', 'b'], 'capped, newest first');
  // finding a live alert uses the latest one per key, honours the window and resolution, and survives eviction of old alerts
  const live = async (key: string, since = 0) => (await s.findLiveAlert('u1', 'r', key, since))?.id ?? null;
  const mk = (id: string, key: string, over: Record<string, unknown> = {}) => ({ id, userId: 'u1', ruleId: 'r', ruleName: 'r', key, state: 'open' as const, severity: 'info' as const, title: id, cameraId: 'c', cameraName: 'c', firstEventId: 'e', lastEventId: 'e', eventCount: 1, createdAt: T0.toISOString(), lastEventAt: T0.toISOString(), deliveries: [], ...over });
  await s.saveAlert(mk('k1-old', 'k1', { createdAt: at(0).toISOString(), lastEventAt: at(0).toISOString() }));
  assert.equal(await live('k1'), 'k1-old');
  assert.equal(await live('k1', T0.getTime() + 1000), null, 'quiet longer than the window');
  await s.saveAlert(mk('k1-new', 'k1', { createdAt: at(5000).toISOString(), lastEventAt: at(5000).toISOString() }));
  assert.equal(await live('k1'), 'k1-new', 'the alert that saw an event most recently wins');
  await s.saveAlert(mk('k1-new', 'k1', { state: 'resolved', createdAt: at(5000).toISOString(), lastEventAt: at(5000).toISOString() }));
  assert.equal(await live('k1'), 'k1-old', 'a resolved alert is not live; the older one is, if it is inside the window');
  assert.equal(await live('k1', T0.getTime() + 1000), null, 'and not once it has been quiet for longer than the window');
  assert.equal(await s.findLiveAlert('u2', 'r', 'k1', 0), null, 'another user never sees it');
  assert.equal(await s.findLiveAlert('u1', 'other-rule', 'k1', 0), null);
  await s.saveAlert(mk('k2', 'k2', { lastEventAt: at(9000).toISOString() }));
  await s.saveAlert(mk('k3', 'k3', { lastEventAt: at(9000).toISOString() }));
  assert.equal(await live('k2'), 'k2');
  assert.equal(await live('k3'), 'k3');
  await s.saveAlert(mk('k4', 'k4', { lastEventAt: at(9000).toISOString() }));
  assert.equal(await live('k2'), null, 'k2 was the oldest and was evicted with the cap of 2; the index let go of it too');
  assert.equal(await live('k4'), 'k4');
  assert.equal(await s.deleteRule('u1', 'nope'), false);
  await s.saveRule(mkRule({ id: 'x' }));
  assert.equal(await s.deleteRule('u2', 'x'), false, 'only the owner can delete');
  assert.equal(await s.deleteRule('u1', 'x'), true);
});

test('postgres store: builds the queries it should (the SQL itself needs a real database)', async () => {
  const log: Array<{ text: string; params: unknown[] }> = [];
  let inserted: string[] = [];
  const store = createPostgresAlertStore({ query: async (text, params = []) => {
    log.push({ text, params });
    if (/INSERT INTO platform_events/.test(text)) return { rows: inserted.map((id) => ({ id })) };
    return { rows: [{ doc: { id: 'd' } }], rowCount: 1 };
  } });
  await store.ensureSchema();
  assert.match(log[0].text, /CREATE TABLE IF NOT EXISTS platform_events/);
  const e1 = ev({ summary: '1' }), e2 = ev({ summary: '2', data: { plate: 'Z' } });
  inserted = [e2.id];
  const fresh = await store.saveEvents([e1, e2]);
  assert.deepEqual(fresh.map((e) => e.id), [e2.id], 'only rows the database really inserted are new');
  assert.match(log[1].text, /ON CONFLICT \(id\) DO NOTHING RETURNING id/);
  assert.equal(log[1].params.length, 14);
  assert.deepEqual(await store.saveEvents([]), []);
  await store.queryEvents({ userId: 'u1', types: ['plate.*', 'scene.unusual'], minSeverity: 'warning', cameraId: 'c', from: T0, limit: 9999 });
  const q = log.at(-1)!;
  assert.match(q.text, /user_id = \$1/);
  assert.match(q.text, /type LIKE \$2 OR type = \$3/);
  assert.deepEqual(q.params.slice(0, 3), ['u1', 'plate.%', 'scene.unusual']);
  assert.equal(q.params.at(-1), 500, 'the page size is capped');
  assert.ok(!/u1|plate|scene/.test(q.text), 'values are parameters, never part of the SQL text');
  await store.findLiveAlert('u1', 'r', "k'; DROP TABLE alerts;--", 1000);
  assert.ok(!/DROP/.test(log.at(-1)!.text));
  assert.equal(await store.deleteRule('u1', 'r'), true);
});
