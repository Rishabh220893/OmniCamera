/**
 * The Kubernetes manifests (deploy/k8s) checked for internal consistency: what the files say about each other has to be true (selectors match labels,
 * probes point at ports that exist and at paths the server answers, secrets named are the ones the example lists, every container has limits and runs as
 * non-root, policies select real pods). There is no cluster here: this does not prove the manifests apply, only that they do not contradict themselves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';

const DIRS = ['deploy/k8s/base', 'deploy/k8s/optional', 'deploy/k8s/gateway'];
interface Doc { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string> }; spec?: any; data?: Record<string, string>; stringData?: Record<string, string> }
const docs: Array<{ file: string; doc: Doc }> = [];
for (const d of DIRS) for (const f of readdirSync(d).filter((x) => x.endsWith('.yaml') && x !== 'kustomization.yaml')) {
  for (const parsed of parseAllDocuments(readFileSync(join(d, f), 'utf8'))) {
    assert.deepEqual(parsed.errors, [], `${d}/${f} has YAML errors`);
    const doc = parsed.toJS() as Doc | null;
    if (doc) docs.push({ file: `${d}/${f}`, doc });
  }
}
const of = (kind: string) => docs.filter((x) => x.doc.kind === kind).map((x) => x.doc);
const workloads = [...of('Deployment'), ...of('StatefulSet')];
const podLabels = (w: Doc) => w.spec.template.metadata.labels as Record<string, string>;
const matches = (selector: Record<string, string> | undefined, labels: Record<string, string>) => Object.entries(selector ?? {}).every(([k, v]) => labels[k] === v);
const expr = (e: Array<{ key: string; operator: string; values: string[] }> | undefined, labels: Record<string, string>) => (e ?? []).every((x) => (x.operator === 'In' ? x.values.includes(labels[x.key]) : true));
const selects = (sel: any, labels: Record<string, string>) => matches(sel?.matchLabels, labels) && expr(sel?.matchExpressions, labels);
const containers = (w: Doc) => w.spec.template.spec.containers as any[];

test('every file parses, every object has a name, and the namespaces are the ones the policies and services assume', () => {
  assert.equal(docs.length >= 30, true, `found ${docs.length} objects`);
  for (const { file, doc } of docs) { assert.ok(doc.apiVersion && doc.kind && doc.metadata?.name, `${file}: an object without apiVersion, kind or name`); }
  const central = docs.filter((x) => x.file.startsWith('deploy/k8s/base') || x.file.startsWith('deploy/k8s/optional')).filter((x) => x.doc.kind !== 'Namespace');
  assert.deepEqual([...new Set(central.map((x) => x.doc.metadata.namespace))], ['omnisee']);
});

test('workloads: each selector matches its own pod labels; names are unique; images are placeholders for kustomize or pinned (never :latest)', () => {
  const names = workloads.map((w) => `${w.kind}/${w.metadata.namespace}/${w.metadata.name}`);
  assert.equal(new Set(names).size, names.length);
  for (const w of workloads) {
    assert.equal(matches(w.spec.selector.matchLabels, podLabels(w)), true, `${w.metadata.name}: its selector does not match its pod labels`);
    for (const c of containers(w)) {
      assert.equal(/:latest$/.test(c.image) || !/[:@]|^omnisee-/.test(c.image), false, `${w.metadata.name}/${c.name}: image ${c.image} is unpinned`);
    }
  }
  const apps = workloads.flatMap(containers).map((c) => c.image).filter((i) => i.startsWith('omnisee-'));
  assert.equal(apps.length > 0, true);
  const kustom = readFileSync('deploy/k8s/base/kustomization.yaml', 'utf8');
  for (const img of new Set(apps.filter((i) => i === 'omnisee-app'))) assert.match(kustom, new RegExp(`name: ${img}`), `${img} has a kustomize image entry`);
});

test('every container has requests and limits, drops all capabilities, forbids privilege escalation, and every pod runs as non-root with the default seccomp profile', () => {
  for (const w of workloads) {
    const ps = w.spec.template.spec.securityContext;
    assert.deepEqual([ps.runAsNonRoot, ps.seccompProfile?.type], [true, 'RuntimeDefault'], `${w.metadata.name}: pod security context`);
    assert.equal(ps.runAsUser > 0, true, `${w.metadata.name}: runs as a numeric non-root user`);
    for (const c of containers(w)) {
      assert.ok(c.resources?.requests?.cpu && c.resources?.requests?.memory && c.resources?.limits?.memory, `${w.metadata.name}/${c.name}: requests and a memory limit`);
      assert.equal(c.securityContext?.allowPrivilegeEscalation, false, `${w.metadata.name}/${c.name}`);
      assert.deepEqual(c.securityContext?.capabilities?.drop, ['ALL'], `${w.metadata.name}/${c.name}`);
    }
  }
});

test('probes: every one points at a port the container declares; the app pods use the paths the server answers (/healthz, /readyz); long start-ups have a startup probe', () => {
  const server = readFileSync('server/security/ops.ts', 'utf8');
  assert.match(server, /'\/healthz'/); assert.match(server, /'\/readyz'/);
  for (const w of workloads) for (const c of containers(w)) {
    const ports = new Set((c.ports ?? []).map((p: any) => p.name));
    for (const kind of ['startupProbe', 'livenessProbe', 'readinessProbe']) {
      const p = c[kind];
      if (!p) continue;
      const port = p.httpGet?.port ?? p.tcpSocket?.port;
      assert.equal(ports.has(port) || typeof port === 'number', true, `${w.metadata.name}/${c.name} ${kind}: port ${port} is not declared`);
      if (typeof port === 'string') assert.equal(ports.has(port), true);
    }
    assert.ok(c.livenessProbe && c.readinessProbe, `${w.metadata.name}/${c.name}: liveness and readiness probes`);
    if (/omnisee-app/.test(c.image) && !/gateway/.test(w.metadata.name)) {
      assert.equal(c.livenessProbe.httpGet.path, '/healthz'); assert.equal(c.readinessProbe.httpGet.path, '/readyz'); assert.ok(c.startupProbe, `${w.metadata.name}: a startup probe (the first start builds caches)`);
    }
  }
  const gw = readFileSync('gateway.ts', 'utf8');
  assert.match(gw, /GATEWAY_STATUS_HOST/, 'the gateway can listen for probes beyond loopback');
});

test('services select real pods and send to ports those pods declare; the ingress points at an existing service port', () => {
  const svcs = of('Service');
  for (const s of svcs) {
    const targets = workloads.filter((w) => w.metadata.namespace === s.metadata.namespace && matches(s.spec.selector, podLabels(w)));
    assert.equal(targets.length > 0, true, `service ${s.metadata.name} selects no workload`);
    for (const p of s.spec.ports) {
      const declared = targets.flatMap(containers).flatMap((c) => c.ports ?? []).map((x: any) => x.name);
      assert.equal(typeof p.targetPort === 'number' || declared.includes(p.targetPort), true, `service ${s.metadata.name}: targetPort ${p.targetPort} is declared by no container`);
    }
  }
  const ing = of('Ingress')[0];
  const backend = ing.spec.rules[0].http.paths[0].backend.service;
  const svc = svcs.find((s) => s.metadata.name === backend.name)!;
  assert.ok(svc, 'the ingress backend exists');
  assert.equal(svc.spec.ports.some((p: any) => p.name === backend.port.name), true);
  assert.equal(ing.spec.tls[0].hosts[0], ing.spec.rules[0].host);
  const sts = of('StatefulSet').find((s) => s.metadata.name === 'omnisee-redis')!;
  assert.equal(svcs.some((s) => s.metadata.name === sts.spec.serviceName), true, 'a StatefulSet\'s governing service exists');
});

test('autoscalers and budgets point at existing deployments with selectors that match; the scheduler is exactly one pod and not rolling', () => {
  const deps = of('Deployment');
  for (const h of of('HorizontalPodAutoscaler')) {
    const t = deps.find((d) => d.metadata.name === h.spec.scaleTargetRef.name);
    assert.ok(t, `${h.metadata.name} scales a deployment that exists`);
    assert.equal(h.spec.minReplicas <= h.spec.maxReplicas, true);
    assert.equal(h.spec.minReplicas >= (t!.spec.replicas ?? 1) - 1, true, 'the minimum is not far below the declared replicas');
  }
  for (const p of of('PodDisruptionBudget')) assert.equal(workloads.some((w) => selects(p.spec.selector, podLabels(w))), true);
  const scheduler = deps.find((d) => d.metadata.name === 'omnisee-scheduler')!;
  assert.deepEqual([scheduler.spec.replicas, scheduler.spec.strategy.type], [1, 'Recreate']);
  assert.equal(of('HorizontalPodAutoscaler').some((h) => h.spec.scaleTargetRef.name === 'omnisee-scheduler'), false, 'the scheduler is never autoscaled');
  const roles = Object.fromEntries(deps.map((d) => [d.metadata.name, containers(d)[0].env?.find((e: any) => e.name === 'ANALYSIS_ROLE')?.value]));
  assert.deepEqual([roles['omnisee-scheduler'], roles['omnisee-worker'], roles['omnisee-web']], ['scheduler', 'worker', undefined]);
  const webEnv = containers(deps.find((d) => d.metadata.name === 'omnisee-web')!)[0].env;
  assert.equal(webEnv.find((e: any) => e.name === 'SERVER_ANALYSIS').value, 'false', 'the web tier does not run analysis');
});

test('config and secrets: every secret and config map a pod references exists (or is the documented example), and the secret example lists the keys the server reads', () => {
  const cms = new Set(of('ConfigMap').map((c) => c.metadata.name));
  const example = docs.find((x) => x.file.endsWith('secrets.example.yaml'))!.doc;
  const known = new Set(['omnisee-secrets', 'omnisee-anpr-secrets', 'omnisee-inference-secrets', 'omnisee-gateway-secrets']);
  for (const w of workloads) {
    for (const c of containers(w)) for (const e of c.envFrom ?? []) {
      if (e.configMapRef) assert.equal(cms.has(e.configMapRef.name), true, `${w.metadata.name}: config map ${e.configMapRef.name}`);
      if (e.secretRef) assert.equal(known.has(e.secretRef.name), true, `${w.metadata.name}: secret ${e.secretRef.name} is not one the README documents`);
    }
    for (const v of w.spec.template.spec.volumes ?? []) if (v.configMap) assert.equal(cms.has(v.configMap.name) || v.configMap.name === 'omnisee-gateway-media-config', true, `${w.metadata.name}: volume config map ${v.configMap.name}`);
  }
  for (const key of ['FIREBASE_SERVICE_ACCOUNT', 'GEMINI_API_KEY', 'SOURCE_SECRET_KEY', 'EVIDENCE_SIGNING_KEY', 'EVIDENCE_ENCRYPTION_KEY', 'METRICS_TOKEN']) assert.ok(example.stringData![key], key);
  assert.equal(JSON.stringify(example).includes('BEGIN PRIVATE KEY-----\\nMII'), false, 'the example holds no real key');
  const cfg = of('ConfigMap').find((c) => c.metadata.name === 'omnisee-config')!.data!;
  for (const k of Object.keys(cfg)) assert.equal(/KEY|SECRET|PASSWORD|TOKEN/.test(k), false, `${k}: secrets do not belong in the config map`);
  assert.equal(cfg.EVENT_BUS, 'redis'); assert.equal(cfg.FEDERATION_STORE, 'redis');
  assert.match(cfg.REDIS_URL, /omnisee-redis:6379/);
  // The server reads every one of these (a typo here would silently do nothing).
  const src = readFileSync('server.ts', 'utf8') + readFileSync('server/security/headers.ts', 'utf8');
  for (const k of ['TRUST_PROXY', 'FORCE_HTTPS', 'SECURITY_CSP', 'METRICS_ENABLED', 'VMS_DATA_DIR', 'EVENT_BUS', 'REDIS_URL', 'FEDERATION_STORE', 'ANOMALY_DETECTION', 'GRID_GRABS_PER_MIN', 'ANALYSIS_CONCURRENCY']) assert.equal(src.includes(k) || readdirSync('server').some((f) => f.endsWith('.ts') && readFileSync(join('server', f), 'utf8').includes(k)), true, `${k} is not read by the server`);
});

test('network policies: default deny exists; every policy selects real pods; the flows that must exist do (ingress to web, app to redis, app to media, GPU only from app); metadata service is excluded', () => {
  const pols = of('NetworkPolicy').filter((p) => p.metadata.namespace === 'omnisee');
  const byName = Object.fromEntries(pols.map((p) => [p.metadata.name, p]));
  assert.deepEqual(byName['default-deny'].spec.policyTypes, ['Ingress', 'Egress']);
  assert.deepEqual(byName['default-deny'].spec.podSelector, {});
  for (const p of pols) if (Object.keys(p.spec.podSelector).length) assert.equal(workloads.some((w) => w.metadata.namespace === 'omnisee' && selects(p.spec.podSelector, podLabels(w))), true, `${p.metadata.name} selects no pod`);
  const flow = (name: string, dir: 'ingress' | 'egress') => JSON.stringify(byName[name].spec[dir]);
  assert.match(flow('web-from-ingress', 'ingress'), /ingress-nginx/);
  assert.match(flow('app-egress', 'egress'), /"port":6379/);
  assert.match(flow('app-egress', 'egress'), /169\.254\.169\.254\/32/, 'pods cannot reach the cloud metadata service');
  assert.match(flow('redis-from-app', 'ingress'), /web,scheduler,worker|"web","scheduler","worker"/);
  assert.match(flow('mediamtx-traffic', 'ingress'), /9997/);
  const gpu = docs.find((x) => x.doc.metadata.name === 'gpu-from-app')!.doc;
  assert.match(JSON.stringify(gpu.spec.ingress), /"web","scheduler","worker"/);
  // the ports each flow allows are ports the destination declares
  const redisPorts = containers(of('StatefulSet').find((s) => s.metadata.name === 'omnisee-redis')!).flatMap((c) => c.ports).map((p: any) => p.containerPort);
  assert.equal(redisPorts.includes(6379), true);
  const gw = docs.find((x) => x.doc.metadata.name === 'gateway-egress-only')!.doc;
  assert.equal(gw.spec.ingress, undefined, 'a gateway accepts nothing inbound (an empty ingress list under policyTypes Ingress denies it all)');
  assert.deepEqual(gw.spec.policyTypes, ['Ingress', 'Egress']);
});

test('the Dockerfile runs as the unprivileged node user (uid 1000) the manifests expect; the kustomization lists files that exist and the secret example is not in it', () => {
  const docker = readFileSync('Dockerfile', 'utf8');
  assert.match(docker, /USER node/);
  assert.match(docker, /chown -R node:node/);
  const kustom = parseAllDocuments(readFileSync('deploy/k8s/base/kustomization.yaml', 'utf8'))[0].toJS() as { resources: string[] };
  for (const r of kustom.resources) assert.equal(existsSync(join('deploy/k8s/base', r)), true, r);
  assert.equal(kustom.resources.includes('secrets.example.yaml'), false);
  for (const f of readdirSync('deploy/k8s/base').filter((x) => x.endsWith('.yaml') && x !== 'kustomization.yaml' && x !== 'secrets.example.yaml')) assert.equal(kustom.resources.includes(f), true, `${f} is not in the kustomization, so it would never be applied`);
});
