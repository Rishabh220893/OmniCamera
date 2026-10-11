/**
 * E-mail, SMS and recording-hold channels, the rule checks for them, and incident announcements (an incident becomes an `incident.opened` event
 * that ordinary rules and channels handle). Delivery is against fakes: no mail server or SMS gateway was used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertText, createChannelRegistry, createEmailChannel, createLogChannel, createRecordingHoldChannel, createSmsChannel, hourlyLimiter, type Alert, type DeliveryContext, type EmailMessage } from '../server/events/channels.ts';
import { validateRule, RuleError } from '../server/events/rules.ts';
import { createHoldStore } from '../server/recording/retention.ts';
import { announceIncidents, incidentOpenedEvents } from '../server/incidents/notify.ts';
import { createMemoryIncidentStore, type Incident } from '../server/incidents/store.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { makeEvent } from '../server/events/schema.ts';

const NOW = new Date('2026-10-11T10:00:00Z');
const mkRule = (channels: unknown[], over: Record<string, unknown> = {}) => validateRule({ name: 'r', match: { types: ['plate.*'] }, channels, ...over }, { userId: 'u', id: 'r1', now: NOW });
const ev = makeEvent({ type: 'plate.watchlist_match', summary: 'Watchlist plate GJ05AB1234 seen', severity: 'critical', data: { plate: 'GJ05AB1234' } }, { source: 'anpr', camera: { id: 'cam7', name: 'Gate 7', userId: 'u', department: 'Traffic' }, ts: new Date('2026-10-11T09:58:30Z') });
const alert: Alert = { id: 'al1', userId: 'u', ruleId: 'r1', ruleName: 'Watchlist', key: 'k', state: 'open', severity: 'critical', title: 'Watchlist plate GJ05AB1234 seen', cameraId: 'cam7', cameraName: 'Gate 7', department: 'Traffic', firstEventId: ev.id, lastEventId: ev.id, eventCount: 2, createdAt: NOW.toISOString(), lastEventAt: NOW.toISOString(), deliveries: [] };
const ctx: DeliveryContext = { alert, event: ev, rule: { id: 'r1', name: 'Watchlist' } };

test('rules: e-mail and SMS need 1 to 5 valid recipients; the hold needs sensible minutes; anything else is refused with a sentence', () => {
  assert.deepEqual(mkRule([{ type: 'email', to: ['a@x.gov.in', 'a@x.gov.in', ' b@y.org '] }]).channels, [{ type: 'email', to: ['a@x.gov.in', 'b@y.org'] }], 'duplicates are dropped and spaces trimmed');
  assert.deepEqual(mkRule([{ type: 'sms', to: ['+919876543210'] }]).channels, [{ type: 'sms', to: ['+919876543210'] }]);
  assert.deepEqual(mkRule([{ type: 'recording-hold' }]).channels, [{ type: 'recording-hold', beforeMinutes: 5, afterMinutes: 10 }], 'defaults');
  assert.deepEqual(mkRule([{ type: 'recording-hold', beforeMinutes: 0, afterMinutes: 30 }, { type: 'log' }]).channels.length, 2);
  const bad: Array<[unknown[], RegExp]> = [
    [[{ type: 'email', to: [] }], /1 to 5 e-mail/], [[{ type: 'email', to: ['not-an-address'] }], /e-mail addresses/], [[{ type: 'email', to: Array.from({ length: 6 }, (_, i) => `a${i}@x.org`) }], /1 to 5/],
    [[{ type: 'email' }], /1 to 5/], [[{ type: 'sms', to: ['9876543210'] }], /international form/], [[{ type: 'sms', to: ['+0123456789'] }], /international form/],
    [[{ type: 'recording-hold', beforeMinutes: 0, afterMinutes: 0 }], /not both zero/], [[{ type: 'recording-hold', beforeMinutes: -1 }], /whole minutes/], [[{ type: 'recording-hold', afterMinutes: 999 }], /whole minutes/],
    [[{ type: 'fax' }], /must be 'webhook', 'email', 'sms', 'recording-hold' or 'log'/],
  ];
  for (const [ch, re] of bad) assert.throws(() => mkRule(ch), (e) => e instanceof RuleError && re.test(e.message), JSON.stringify(ch));
});

test('registry: a rule can only name a channel this server has; the e-mail domain list is enforced when the rule is saved', () => {
  const sent: EmailMessage[] = [];
  const reg = createChannelRegistry([createLogChannel(), createEmailChannel({ send: async (m) => { sent.push(m); }, from: 'x@y', allowedDomains: ['police.gov.in'] })]);
  assert.match(reg.check({ type: 'sms', to: ['+919876543210'] })!, /not available on this server/);
  assert.equal(reg.check({ type: 'email', to: ['chief@police.gov.in'] }), null);
  assert.match(reg.check({ type: 'email', to: ['chief@police.gov.in', 'spy@gmail.com'] })!, /gmail\.com is not allowed/);
  assert.throws(() => validateRule({ name: 'r', match: {}, channels: [{ type: 'email', to: ['spy@gmail.com'] }] }, { userId: 'u', id: 'r', now: NOW, allowChannel: (c) => reg.check(c) }), /not allowed/);
});

test('e-mail channel: sends the alert as plain text to the recipients; a limit per hour protects against a loop; a refusal by the mail server is a failed delivery', async () => {
  const sent: EmailMessage[] = [];
  let t = NOW.getTime(), fail = false;
  const ch = createEmailChannel({ send: async (m) => { if (fail) throw new Error('550 mailbox unavailable'); sent.push(m); }, from: 'OmniSee <alerts@x>', maxPerHour: 2, now: () => t });
  await ch.deliver({ type: 'email', to: ['a@x.org', 'b@x.org'] }, ctx);
  assert.deepEqual([sent[0].from, sent[0].to, sent[0].subject], ['OmniSee <alerts@x>', ['a@x.org', 'b@x.org'], '[CRITICAL] Watchlist plate GJ05AB1234 seen']);
  assert.match(sent[0].text, /Camera: Gate 7 \(Traffic\)/);
  assert.match(sent[0].text, /When: 2026-10-11 09:58:30 UTC/);
  assert.match(sent[0].text, /Alert id: al1/);
  await ch.deliver({ type: 'email', to: ['a@x.org'] }, ctx);
  await assert.rejects(ch.deliver({ type: 'email', to: ['a@x.org'] }, ctx), /limit for this hour/);
  t += 3_600_001;
  fail = true;
  await assert.rejects(ch.deliver({ type: 'email', to: ['a@x.org'] }, ctx), /550 mailbox unavailable/);
});

test('SMS channel: one short message per number through the gateway with a bearer token; a number that fails is named (shortened) in the error', async () => {
  const calls: Array<{ url: string; auth: string; body: any }> = [];
  const f = (async (url: string, init: any) => { const body = JSON.parse(init.body); calls.push({ url, auth: init.headers.Authorization, body }); return new Response('', { status: body.to === '+911111111111' ? 500 : 200 }); }) as unknown as typeof fetch;
  const ch = createSmsChannel({ gatewayUrl: 'https://sms.example/send', token: 'TOK', from: 'OMNISEE', fetchImpl: f });
  await ch.deliver({ type: 'sms', to: ['+919876543210'] }, ctx);
  assert.deepEqual([calls[0].url, calls[0].auth, calls[0].body.to, calls[0].body.from], ['https://sms.example/send', 'Bearer TOK', '+919876543210', 'OMNISEE']);
  assert.equal(calls[0].body.message.length <= 300, true);
  assert.match(calls[0].body.message, /^\[CRITICAL\] Watchlist plate GJ05AB1234 seen - Gate 7, 09:58 UTC$/);
  await assert.rejects(ch.deliver({ type: 'sms', to: ['+919876543210', '+911111111111'] }, ctx), /SMS not sent to 1 of 2: \+9111\.\.\.: HTTP 500/);
  assert.match(createSmsChannel({ gatewayUrl: 'http://insecure', token: 't' }).check!({ type: 'sms', to: [] })!, /https/);
  assert.equal(alertText(ctx, true).body.includes('When:'), false, 'the short form has no long lines');
});

test('hourlyLimiter: allows up to the maximum, then refuses until the oldest use is an hour old', () => {
  let t = 0;
  const take = hourlyLimiter(2, () => t);
  assert.deepEqual([take(), take(), take()], [true, true, false]);
  t = 3_600_001;
  assert.equal(take(), true);
});

test('recording-hold channel: the alert holds the footage from before to after the event, in the real hold store, and says so', async () => {
  const holds = createHoldStore(join(mkdtempSync(join(tmpdir(), 'hold-')), 'holds.json'), () => NOW);
  const emitted: any[] = [];
  const ch = createRecordingHoldChannel({ holds, emit: (h) => { emitted.push(h); } });
  await ch.deliver({ type: 'recording-hold', beforeMinutes: 5, afterMinutes: 15 }, ctx);
  const [h] = await holds.list('cam7');
  assert.deepEqual([h.from, h.to, h.by], ['2026-10-11T09:53:30.000Z', '2026-10-11T10:13:30.000Z', 'alert-rule:r1']);
  assert.match(h.reason, /^Alert al1: Watchlist plate/);
  assert.deepEqual([emitted[0].holdId, emitted[0].alertId], [h.id, 'al1']);
});

test('engine end to end: a matching event raises an alert whose channels all run; one failing channel does not stop the others', async () => {
  const sent: EmailMessage[] = [], holdsDir = mkdtempSync(join(tmpdir(), 'hold2-'));
  const holds = createHoldStore(join(holdsDir, 'holds.json'));
  const store = createMemoryAlertStore();
  const channels = createChannelRegistry([
    createLogChannel({ warn() {} }), createEmailChannel({ send: async (m) => { sent.push(m); }, from: 'a@b' }), createRecordingHoldChannel({ holds }),
    createSmsChannel({ gatewayUrl: 'https://sms.example', token: 't', fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch }),
  ]);
  const engine = createAlertEngine({ store, channels });
  await store.saveRule(mkRule([{ type: 'email', to: ['chief@x.org'] }, { type: 'sms', to: ['+919876543210'] }, { type: 'recording-hold', beforeMinutes: 2, afterMinutes: 3 }]));
  const r = await engine.ingest([ev]);
  assert.equal(sent.length, 1);
  assert.equal((await holds.list('cam7')).length, 1);
  const al = (await store.listAlerts({ userId: 'u' }))[0];
  assert.deepEqual(al.deliveries.map((d) => [d.channel, d.ok]), [['email', true], ['sms', false], ['recording-hold', true]]);
  assert.match(al.deliveries[1].error ?? '', /SMS not sent/);
  assert.deepEqual([r.stored, r.alerts.length, r.alerts[0].opened], [1, 1, true]);
});

// ---- incidents ---------------------------------------------------------------------------------------------------------------------

const incident = (over: Partial<Incident> = {}): Incident => ({
  id: 'inc1', kind: 'plate_trail', key: 'trail:GJ05AB1234', title: 'GJ05AB1234 seen on 3 cameras', severity: 'warning', state: 'open', eventIds: ['e1'], eventCount: 3,
  cameraIds: ['a', 'b'], cameraNames: ['Cam A', 'Cam B'], departments: ['Traffic', 'Police'], userIds: ['u1'], crossDepartment: true,
  firstAt: '2026-10-11T09:00:00Z', lastAt: '2026-10-11T09:30:00Z', createdAt: '2026-10-11T09:30:00Z', notes: [], ...over,
});

test('incident announcements: one event per department involved, so each department\'s rules can see it; one for the owner when there is no department', () => {
  const two = incidentOpenedEvents(incident());
  assert.deepEqual(two.map((e) => [e.type, e.department, e.severity, e.data.incidentId]), [['incident.opened', 'Traffic', 'warning', 'inc1'], ['incident.opened', 'Police', 'warning', 'inc1']]);
  assert.match(two[0].summary, /more than one department/);
  assert.equal(new Set(two.map((e) => e.id)).size, 2, 'each has its own id');
  const none = incidentOpenedEvents(incident({ departments: [], crossDepartment: false }));
  assert.deepEqual([none.length, none[0].department, none[0].userId], [1, undefined, 'u1']);
  assert.equal(incidentOpenedEvents(incident({ departments: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).length, 5, 'at most 5 departments');
});

test('announceIncidents: each open incident is announced once and marked; closed or already announced ones are not; a failure leaves it for the next try', async () => {
  const store = createMemoryIncidentStore();
  await store.save(incident()); await store.save(incident({ id: 'inc2', key: 'k2', notifiedAt: '2026-10-11T09:31:00Z' })); await store.save(incident({ id: 'inc3', key: 'k3', state: 'closed' }));
  const got: string[] = [];
  const n = await announceIncidents({ store, incidents: await store.list({ all: true }), emit: async (e) => { got.push(...e.map((x) => `${x.data.incidentId}@${x.department}`)); }, now: () => NOW });
  assert.equal(n, 1);
  assert.deepEqual(got, ['inc1@Traffic', 'inc1@Police']);
  assert.equal((await store.get('inc1'))!.notifiedAt, NOW.toISOString());
  assert.equal(await announceIncidents({ store, incidents: await store.list({ all: true }), emit: async () => { throw new Error('should not run'); } }), 0, 'announced once');
  const warned: string[] = [];
  const s2 = createMemoryIncidentStore(); await s2.save(incident({ id: 'x' }));
  assert.equal(await announceIncidents({ store: s2, incidents: await s2.list({ all: true }), emit: async () => { throw new Error('bus down'); }, log: { warn: (m: string) => { warned.push(m); } } }), 0);
  assert.match(warned[0], /could not announce x: bus down/);
});

test('rule test: sends through the real channels but never places a real hold; the registry lists its channel types', async () => {
  const holds = createHoldStore(join(mkdtempSync(join(tmpdir(), 'hold3-')), 'holds.json'));
  const sent: EmailMessage[] = [];
  const channels = createChannelRegistry([createLogChannel({ warn() {} }), createEmailChannel({ send: async (m) => { sent.push(m); }, from: 'a@b' }), createRecordingHoldChannel({ holds })]);
  assert.deepEqual(channels.types().sort(), ['email', 'log', 'recording-hold']);
  const engine = createAlertEngine({ store: createMemoryAlertStore(), channels });
  const rule = mkRule([{ type: 'email', to: ['chief@x.org'] }, { type: 'recording-hold', beforeMinutes: 1, afterMinutes: 1 }]);
  const d = await engine.test(rule, { id: 'cam7', name: 'Gate 7' });
  assert.equal(sent.length, 1, 'the e-mail was really sent');
  assert.equal((await holds.list()).length, 0, 'no footage was held by a test');
  assert.deepEqual(d.map((x) => [x.channel, x.ok]), [['email', true], ['recording-hold', true]]);
  assert.match(d[1].error ?? '', /not tested/);
});

// ---- the real transports, against local fakes: nodemailer over a real socket, fetch over real HTTP --------------------------------------

test('real transports: e-mail goes out through nodemailer to an SMTP server and arrives with the right sender, recipients, subject and text; SMS reaches the gateway with the bearer token, one message per number', async () => {
  const { startFakeSmtp, startFakeSmsGateway } = await import('./lab/fakeMessaging.ts');
  const { createSmtpSender } = await import('../server/events/channels.ts');
  const smtp = await startFakeSmtp();
  const sms = await startFakeSmsGateway('SECRET');
  try {
    const mail = createEmailChannel({ send: createSmtpSender(`smtp://127.0.0.1:${smtp.port}`), from: 'OmniSee <alerts@omnisee.test>' });
    await mail.deliver({ type: 'email', to: ['chief@police.test', 'duty@police.test'] }, ctx);
    assert.equal(smtp.mails.length, 1);
    const m = smtp.mails[0];
    assert.equal(m.from, 'alerts@omnisee.test');
    assert.deepEqual(m.to, ['chief@police.test', 'duty@police.test']);
    assert.equal(m.subject, '[CRITICAL] Watchlist plate GJ05AB1234 seen');
    assert.match(m.text, /Camera: Gate 7 \(Traffic\)/);
    assert.match(m.text, /What: Watchlist plate GJ05AB1234 seen/);
    assert.equal(m.text, alertText(ctx).body, 'the message body arrives exactly as written, with no corruption from the transport');

    const text = createSmsChannel({ gatewayUrl: sms.url, token: 'SECRET', from: 'OMNISEE' });
    assert.equal(text.check!({ type: 'sms', to: [] }), null, 'a gateway on this machine may be plain http');
    await text.deliver({ type: 'sms', to: ['+919876543210', '+919812345678'] }, ctx);
    assert.deepEqual(sms.messages.map((x) => x.to), ['+919876543210', '+919812345678']);
    assert.equal(sms.messages[0].from, 'OMNISEE');
    assert.ok(sms.messages[0].message.length <= 300 && sms.messages[0].message.includes('Gate 7'));

    const wrong = createSmsChannel({ gatewayUrl: sms.url, token: 'WRONG' });
    await assert.rejects(wrong.deliver({ type: 'sms', to: ['+919876543210'] }, ctx), /HTTP 401/);
    assert.equal(sms.refused, 1);
    assert.match(createSmsChannel({ gatewayUrl: 'http://sms.example.com/send', token: 't' }).check!({ type: 'sms', to: [] })!, /https/, 'a remote gateway still has to be https');
  } finally { await smtp.close(); await sms.close(); }
});
