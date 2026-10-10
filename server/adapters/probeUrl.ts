/** Shared by adapters that end in "a URL ffmpeg can open": measure it and return a ProbeReport like any other source. */
import { PROBE_VERSION, deriveFlags, type ProbeReport } from '../cameraProfile';
import net from 'node:net';
import { probeSource } from '../cameraProbe';
import type { CameraRef } from './types';

/** A quick look at whether anything accepts connections there, so a dead address is reported in seconds instead of after ffprobe's own time limit. */
export function tcpReachable(host: string, port: number, ms = 5000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: host.replace(/^\[|\]$/g, ''), port, timeout: ms });
    sock.once('connect', () => { sock.destroy(); resolve({ ok: true }); });
    sock.once('timeout', () => { sock.destroy(); resolve({ ok: false, error: 'timed out' }); });
    sock.once('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, error: e.code || String(e) }));
  });
}

export async function probeUrl(ref: CameraRef, url: string, o: { rtsp: boolean; sampleSec?: number; secrets?: string[]; site: string; connectTimeoutMs?: number }): Promise<ProbeReport> {
  const secrets = (o.secrets ?? []).filter((s) => s.length > 0);
  const redact = (s: string) => {
    let out = s.replace(/\r/g, '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1***@');
    for (const x of secrets) out = out.split(x).join('***').split(encodeURIComponent(x)).join('***');
    return out;
  };
  const report: ProbeReport = {
    cameraId: ref.id, site: o.site, transport: 'tcp', probedAt: new Date().toISOString(), probeVersion: PROBE_VERSION,
    reachable: false, failure: null, failureDetail: null, describe: null, sample: null, whep: null, flags: [],
  };
  const u = (() => { try { return new URL(url); } catch { return null; } })();
  if (u) {
    const port = Number(u.port) || (u.protocol === 'rtsp:' ? 554 : u.protocol === 'rtsps:' ? 322 : u.protocol === 'https:' ? 443 : 80);
    const t = await tcpReachable(u.hostname, port, o.connectTimeoutMs ?? 5000);
    if (!t.ok) { report.failure = 'unreachable'; report.failureDetail = `${u.hostname}:${port}: ${t.error}`; return report; }
  }
  const r = await probeSource({ url, rtsp: o.rtsp, transport: 'tcp', sampleSec: o.sampleSec ?? 30, redact });
  report.reachable = r.failure?.stage !== 'unreachable';
  report.describe = r.describe;
  report.sample = r.sample.elapsedSec > 0 ? r.sample : null;
  if (r.notes.length) report.notes = r.notes;
  if (r.failure) { report.failure = r.failure.stage; report.failureDetail = redact(r.failure.detail); }
  report.flags = deriveFlags(report.describe, report.sample);
  return report;
}

export function withCredentials(url: string, c: { user: string; pass: string } | undefined): string {
  if (!c || !c.user) return url;
  try {
    const u = new URL(url);
    if (u.username) return url; // the URL already carries a login
    // The URL setters leave '%' alone, so a password containing one would read back as a broken escape. Encode first.
    u.username = encodeURIComponent(c.user);
    u.password = encodeURIComponent(c.pass);
    return u.toString();
  } catch { return url; }
}
