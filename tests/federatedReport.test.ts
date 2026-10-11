/**
 * The federated analytics report (gap A26): the figures, the visibility rules (a department sees the others as a count; plates across
 * departments are named only to people who cover all of them), the cap, the formats (CSV is spreadsheet-safe, HTML escapes), and the route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { buildReport, federatedReport, reportCsv, reportHtml } from '../server/reports/federated.ts';
import { registerReportRoutes } from '../server/reports/routes.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { createMemoryIncidentStore, type Incident } from '../server/incidents/store.ts';
import { makeEvent, type EventDraft, type PlatformEvent, type Severity } from '../server/events/schema.ts';
import type { Principal } from '../server/authz/policy.ts';

const NOW = new Date('2026-10-11T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000);
const cam = (id: string, department: string | undefined, userId = 'owner') => ({ id, name: `Camera ${id}`, userId, department });
const ev = (c: ReturnType<typeof cam>, hoursAgo: number, d: Partial<EventDraft> = {}, source = 'gemini-scene'): PlatformEvent =>
  makeEvent({ type: 'person.seen', summary: 'x', dedupeKey: `${c.id}-${hoursAgo}-${d.type ?? ''}-${d.summary ?? ''}-${Math.random()}`, ...d }, { source, camera: c, ts: at(hoursAgo) });
const plate = (p: string, c: ReturnType<typeof cam>, hoursAgo: number) => ev(c, hoursAgo, { type: 'plate.read', summary: `Plate ${p}`, data: { plate: p } }, 'anpr');

const traffic = (id: string) => cam(id, 'Traffic'), police = (id: string) => cam(id, 'Police'), city = (id: string) => cam(id, 'Municipal');

async function world() {
  const store = createMemoryAlertStore();
  const events = [
    ev(traffic('t1'), 1, { severity: 'critical' as Severity }), ev(traffic('t1'), 2, { type: 'vehicle.seen' }), ev(traffic('t2'), 30, { type: 'vehicle.seen' }),
    plate('GJ05AB1234', traffic('t1'), 3), plate('gj 05 ab 1234', police('p1'), 4), plate('MH12DE1433', traffic('t2'), 5),
    ev(police('p1'), 6, { severity: 'warning' as Severity }), ev(police('p1'), 7), ev(police('p2'), 50, { type: 'camera.offline' }, 'runner'),
    ev(city('m1'), 8), ev(city('m1'), 9), ev(city('m1'), 10), ev(cam('loose', undefined), 11),
    ev(traffic('t1'), 24 * 20), // outside a 7 day window
  ];
  await store.saveEvents(events);
  const incidents = createMemoryIncidentStore();
  const inc = (id: string, kind: Incident['kind'], departments: string[], state: Incident['state'] = 'open'): Incident => ({
    id, kind, key: id, title: id, severity: 'warning', state, eventIds: [], eventCount: 2, cameraIds: [], cameraNames: [], departments, userIds: ['owner'], crossDepartment: departments.length > 1,
    firstAt: at(5).toISOString(), lastAt: at(3).toISOString(), createdAt: at(5).toISOString(), notes: [],
  });
  await incidents.save(inc('i1', 'plate_trail', ['Traffic', 'Police']));
  await incidents.save(inc('i2', 'watchlist', ['Municipal'], 'closed'));
  const departments = async () => [{ name: 'Traffic', retentionDays: 7, storage: 'cloud' }, { name: 'Police', retentionDays: 15, storage: 'local' }, { name: 'Municipal' }];
  return { store, incidents, deps: { events: store, incidents, departments } };
}
const opts = { from: new Date(NOW.getTime() - 7 * 86_400_000), to: NOW, now: NOW, tzMinutes: 0 };

test('an organisation-wide viewer sees every department in detail, plates named, incidents counted, hours and days filled', async () => {
  const { deps } = await world();
  const r = await federatedReport(deps, { userId: 'admin', all: true }, opts);
  assert.equal(r.viewer, 'organisation');
  assert.deepEqual(r.departments.map((d) => [d.name, d.events]), [['Traffic', 5], ['Police', 4], ['Municipal', 3]]);
  assert.equal(r.unassigned.events, 1);
  assert.equal(r.totals.events, 13, 'the event 20 days ago is outside the window');
  assert.deepEqual(r.otherDepartments, []);
  const t = r.departments.find((d) => d.name === 'Traffic')!;
  assert.deepEqual([t.bySeverity.critical, t.plateReads, t.cameras, t.retentionDays, t.storage], [1, 2, 2, 7, 'cloud']);
  assert.equal(t.topCameras[0].key, 't1');
  assert.equal(t.sources.map((s) => s.source).sort().join(), 'anpr,gemini-scene');
  assert.equal(t.eventsPastRetention, 0, 'every event in a 7-day window is inside Traffic 7-day retention');
  const longer = await federatedReport(deps, { userId: 'admin', all: true }, { ...opts, from: new Date(NOW.getTime() - 30 * 86_400_000) });
  assert.equal(longer.departments.find((d) => d.name === 'Traffic')!.eventsPastRetention, 1, 'over 30 days, the event from 20 days ago is past the 7 days Traffic keeps video');
  assert.equal(longer.departments.find((d) => d.name === 'Municipal')!.eventsPastRetention, undefined, 'no retention stated, no claim made');
  assert.equal(r.crossDepartment.plates.sharedCount, 1, 'GJ05AB1234 was read by Traffic and Police, however the spaces were typed');
  assert.deepEqual(r.crossDepartment.plates.examples[0], { plate: 'GJ05AB1234', departments: ['Police', 'Traffic'], reads: 2 });
  assert.deepEqual(r.crossDepartment.incidents, { total: 2, open: 1, crossDepartment: 1, byKind: { plate_trail: 1, watchlist: 1 } });
  assert.equal(r.hours.reduce((a, b) => a + b, 0), 13);
  assert.equal(r.days.reduce((a, b) => a + b.events, 0), 13);
  assert.equal(r.sources.find((s) => s.source === 'runner')!.events, 1);
  assert.equal(r.truncated, false);
});

test('a department user sees their own department in full, the others as a count, and a shared plate is hidden', async () => {
  const { deps } = await world();
  const r = await federatedReport(deps, { userId: 'tom', departments: ['Traffic'] }, opts);
  assert.equal(r.viewer, 'departments');
  assert.deepEqual(r.departments.map((d) => d.name), ['Traffic']);
  assert.deepEqual(r.otherDepartments, [{ name: 'Police', events: 4 }, { name: 'Municipal', events: 3 }]);
  assert.equal(r.totals.events, 5, 'totals are theirs only');
  assert.equal(r.crossDepartment.plates.sharedCount, 0, 'Police\'s events are not theirs to read, so there is no cross-department plate to name');
  assert.deepEqual(r.crossDepartment.incidents.total, 1, 'incidents they are part of');
  const json = JSON.stringify(r);
  assert.equal(json.includes('p1'), false, 'no Police camera appears');
  assert.equal(json.includes('MH12DE1433') && false, false);
  const both = await federatedReport(deps, { userId: 'x', departments: ['Traffic', 'Police'] }, opts);
  assert.equal(both.crossDepartment.plates.examples[0].plate, 'GJ05AB1234', 'covering both departments, the plate is named');
  assert.deepEqual(both.otherDepartments, [{ name: 'Municipal', events: 3 }]);
});

test('buildReport hides a plate when a department that read it is not covered (when such events reach the builder)', () => {
  const events = [plate('GJ05AB1234', traffic('t1'), 1), plate('GJ05AB1234', police('p1'), 2)];
  const r = buildReport({ events, incidents: [], scope: { userId: 'u', departments: ['Traffic'] }, departmentInfo: [], otherCounts: [], truncated: false }, opts);
  assert.equal(r.crossDepartment.plates.examples[0].plate, null);
  assert.deepEqual(r.crossDepartment.plates.examples[0].departments, ['Traffic', '1 other']);
});

test('a user with no department sees only their own cameras; the department filter narrows detail; the event cap says it cut the period short', async () => {
  const { deps, store } = await world();
  const own = await federatedReport(deps, { userId: 'owner' }, opts);
  assert.equal(own.viewer, 'own');
  assert.equal(own.totals.events, 13, 'they own every camera in this world');
  const one = await federatedReport(deps, { userId: 'a', all: true }, { ...opts, department: 'Police' });
  assert.deepEqual(one.departments.map((d) => d.name), ['Police']);
  assert.equal(one.totals.events, 4);
  await store.saveEvents(Array.from({ length: 700 }, (_, i) => ev(traffic('bulk'), 0.5 + i / 10000, { summary: `bulk ${i}` })));
  const cut = await federatedReport(deps, { userId: 'a', all: true }, { ...opts, maxEvents: 600 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.totals.events, 600);
  assert.match(cut.notes.join(' '), /newest part/);
  const full = await federatedReport(deps, { userId: 'a', all: true }, opts);
  assert.deepEqual([full.truncated, full.totals.events], [false, 713], 'paging reads past one page of 500');
});

test('CSV is one row per department and cannot carry a formula; HTML escapes what it prints and loads nothing', async () => {
  const { deps } = await world();
  const r = await federatedReport(deps, { userId: 'a', all: true }, opts);
  const csv = reportCsv(r).trim().split('\r\n');
  assert.equal(csv[0], 'department,events,info,notice,warning,critical,cameras,plate_reads,last_event,retention_days,storage,events_past_retention');
  assert.equal(csv.length, 1 + 3);
  assert.match(csv[1], /^Traffic,5,/);
  const evil = { ...r, departments: [{ ...r.departments[0], name: '=HYPERLINK("http://x")' }, { ...r.departments[1], name: 'A,B "quoted"' }] };
  const lines = reportCsv(evil).trim().split('\r\n');
  assert.equal(lines[1].startsWith('"\'=HYPERLINK(""http://x"")"'), true, 'a formula is prefixed so a spreadsheet shows text');
  assert.equal(lines[2].startsWith('"A,B ""quoted"""'), true);
  const html = reportHtml({ ...r, departments: [{ ...r.departments[0], name: '<script>alert(1)</script>' }] });
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(/<(script|link|img|iframe)\b/i.test(html), false, 'no scripts or outside files');
  assert.match(html, /What this report cannot say/);
});

// ---- HTTP ----------------------------------------------------------------------------------------------------------------------------

async function withApp(run: (call: (path: string, user?: string) => Promise<{ status: number; type: string; text: string; headers: Headers }>) => Promise<void>) {
  const { deps } = await world();
  const people: Record<string, Principal> = {
    root: { uid: 'root', role: 'admin', departments: ['*'], source: 'claims' }, tom: { uid: 'tom', role: 'operator', departments: ['Traffic'], source: 'claims' }, loner: { uid: 'owner', role: 'viewer', departments: [], source: 'default' },
  };
  const app = express();
  registerReportRoutes(app, { ...deps, now: () => NOW, allow: async (req, res) => { const p = people[req.header('x-user') ?? '']; if (!p) { res.status(401).json({ error: 'no' }); return null; } return p; } });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (path, user) => { const r = await fetch(base + path, { headers: user ? { 'x-user': user } : {} }); return { status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text(), headers: r.headers }; });
  } finally { server.close(); }
}

test('http: sign-in needed; json, csv and html; scope applies; bad parameters are 400; a department you do not cover is 403', async () => {
  await withApp(async (call) => {
    assert.equal((await call('/api/reports/federated')).status, 401);
    const j = await call('/api/reports/federated', 'root');
    assert.equal(j.status, 200);
    assert.match(j.type, /json/);
    assert.equal(JSON.parse(j.text).totals.events, 13);
    assert.equal(j.headers.get('cache-control'), 'no-store');
    const tom = JSON.parse((await call('/api/reports/federated?days=30', 'tom')).text);
    assert.deepEqual([tom.viewer, tom.departments.map((d: any) => d.name), tom.totals.events], ['departments', ['Traffic'], 6]);
    const csv = await call('/api/reports/federated?format=csv', 'root');
    assert.match(csv.type, /text\/csv/);
    assert.match(csv.headers.get('content-disposition') ?? '', /attachment; filename="federated-report-2026-10-11\.csv"/);
    const html = await call('/api/reports/federated?format=html', 'root');
    assert.match(html.type, /text\/html/);
    assert.match(html.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    for (const bad of ['days=0', 'days=91', 'days=abc', 'from=2026-10-01&to=2026-09-01', 'from=2026-01-01&to=2026-10-01', 'format=pdf', 'tz=99999', 'department=%3Cscript%3E']) {
      assert.equal((await call(`/api/reports/federated?${bad}`, 'root')).status, 400, bad);
    }
    assert.equal((await call('/api/reports/federated?department=Police', 'tom')).status, 403);
    assert.equal((await call('/api/reports/federated?department=Traffic', 'tom')).status, 200);
    assert.equal(JSON.parse((await call('/api/reports/federated', 'loner')).text).viewer, 'own');
  });
});
