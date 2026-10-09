/**
 * Probes one camera on a site (docs/camera-onboarding-plan.md section 2, stages 1-3) and returns its ProbeReport.
 * Shared by scripts/probe-cameras.ts and the server's "probe cameras" action. Talks to the source directly.
 */
import net from 'node:net';
import { PROBE_VERSION, deriveFlags, type FailureStage, type ProbeReport } from './cameraProfile';
import { probeSource } from './cameraProbe';
import { urlEncode, type Credentials, type SiteSource } from './mediaPaths';

export interface ProbeTarget {
  site: string;
  source: SiteSource;
  /** The WebRTC (WHEP) port on the same host. */
  whepPort: number;
  credentials: (cameraId: string) => Credentials;
  sampleSec?: number;
}

function tcpReachable(host: string, port: number, ms = 5000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: ms });
    s.once('connect', () => { s.destroy(); resolve({ ok: true }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, error: 'timed out' }); });
    s.once('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, error: e.code || String(e) }));
  });
}

async function whep(host: string, port: number, id: string, prefix: string) {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://${host}:${port}/${prefix}/${id}/whep`, { method: 'OPTIONS', signal: AbortSignal.timeout(8000) });
    return { ok: r.status < 500, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as { cause?: { code?: string }; name?: string };
    return { ok: false, status: 0, ms: Date.now() - t0, error: err.cause?.code || err.name || String(e) };
  }
}

export async function probeCamera(id: string, t: ProbeTarget): Promise<ProbeReport> {
  const transport = 'tcp' as const; // the integrator guide requires TCP; UDP is not offered
  const sampleSec = t.sampleSec ?? 30;
  const cred = t.credentials(id);
  const redact = (s: string) => s.replace(/\r/g, '').split(cred.pass).join('***').split(urlEncode(cred.pass)).join('***').replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***@');
  const report: ProbeReport = {
    cameraId: id, site: t.site, transport, probedAt: new Date().toISOString(), probeVersion: PROBE_VERSION,
    reachable: false, failure: null, failureDetail: null, describe: null, sample: null, whep: null, flags: [],
  };
  const fail = (stage: FailureStage, detail: string) => { report.failure = stage; report.failureDetail = redact(detail); };
  report.whep = await whep(t.source.host, t.whepPort, id, t.source.pathPrefix);

  // Stage 1: reachability
  const tcp = await tcpReachable(t.source.host, t.source.rtspPort);
  if (!tcp.ok) { fail('unreachable', `RTSP port ${t.source.rtspPort}: ${tcp.error}`); return report; }
  report.reachable = true;

  // Stages 2 and 3: describe and sample
  const url = `rtsp://${urlEncode(cred.user)}:${urlEncode(cred.pass)}@${t.source.host}:${t.source.rtspPort}/${t.source.pathPrefix}/${id}`;
  const r = await probeSource({ url, rtsp: true, transport, sampleSec, redact });
  report.describe = r.describe;
  report.sample = r.sample.elapsedSec > 0 ? r.sample : null; // null when the describe stage already failed the camera
  if (r.notes.length) report.notes = r.notes;
  if (r.failure) fail(r.failure.stage, r.failure.detail);
  report.flags = deriveFlags(report.describe, report.sample);
  return report;
}
