import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from './firebase';
import type { TrackAlert, TrackMode, TrackStatus } from '../../server/tracking';

export type { TrackAlert, TrackMode, TrackStatus };

/** What /api/tracking/status returns: the job's progress plus which plate reader is in use. */
export interface TrackingStatus extends TrackStatus { plateReader: 'anpr' | 'gemini' }

export interface StartTrackingInput {
  mode: TrackMode;
  plate?: string;
  /** A data URL (jpeg/png/webp) of the person to find. */
  faceImage?: string;
  faceLabel?: string;
  rules?: string;
  cameras: Array<{ id: string; name: string; url: string }>;
}

export interface Credentials { email: string; password: string }

async function call<T>(path: string, creds: Credentials, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(creds.email ? { 'X-Stream-Email': creds.email } : {}),
      ...(creds.password ? { 'X-Stream-Password': creds.password } : {}),
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `The server answered ${res.status}.`);
  return data as T;
}

/** The frame an alert was raised on, as an object URL (an <img src> cannot send the sign-in header). */
export async function fetchAlertFrame(id: number): Promise<string | null> {
  try {
    const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
    const res = await fetch(`/api/tracking/alerts/${id}/frame.jpg`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch { return null; }
}

export const trackingApi = {
  start: (input: StartTrackingInput, creds: Credentials) =>
    call<{ started: boolean; cameras: number; rejected: Array<{ id: string; why: string }>; plateReader: 'anpr' | 'gemini' | null; status: TrackingStatus }>('/api/tracking/start', creds, { method: 'POST', body: input }),
  stop: (creds: Credentials) => call<{ stopped: boolean }>('/api/tracking/stop', creds, { method: 'POST', body: {} }),
  status: (after: number, creds: Credentials) => call<TrackingStatus>(`/api/tracking/status?after=${after}`, creds),
};

const POLL_MS = 2000;

export interface TrackingController {
  status: TrackingStatus | null;
  /** Every alert since this job started, newest first. */
  alerts: TrackAlert[];
  busy: boolean;
  error: string | null;
  rejected: Array<{ id: string; why: string }>;
  start: (input: StartTrackingInput) => Promise<boolean>;
  stop: () => Promise<void>;
  clearError: () => void;
}

/**
 * Starts, stops and follows the server's background tracking job. Lives in App so an alert reaches the screen whichever tab is open.
 * `onAlert` is called once for each new alert as it arrives.
 */
export function useTracking(creds: Credentials, onAlert: (alert: TrackAlert) => void): TrackingController {
  const [status, setStatus] = useState<TrackingStatus | null>(null);
  const [alerts, setAlerts] = useState<TrackAlert[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Array<{ id: string; why: string }>>([]);
  const afterRef = useRef(0);
  const credsRef = useRef(creds);
  credsRef.current = creds;
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;
  const active = status?.active === true;

  const apply = useCallback((s: TrackingStatus, announce: boolean) => {
    // A restarted server numbers alerts from 1 again.
    if (s.lastAlertId < afterRef.current) { afterRef.current = 0; setAlerts([]); }
    setStatus(s);
    if (s.alerts.length > 0) {
      afterRef.current = Math.max(afterRef.current, ...s.alerts.map((a) => a.id));
      setAlerts((prev) => [...[...s.alerts].reverse(), ...prev].slice(0, 100));
      if (announce) for (const a of s.alerts) onAlertRef.current(a);
    }
  }, []);

  // Pick up a job that is already running (the page was reloaded, or another tab started it).
  useEffect(() => {
    let alive = true;
    trackingApi.status(0, credsRef.current).then((s) => { if (alive) apply(s, false); }).catch(() => { /* not available: stays idle */ });
    return () => { alive = false; };
  }, [apply]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const t = setInterval(() => {
      trackingApi.status(afterRef.current, credsRef.current)
        .then((s) => { if (alive) { apply(s, true); setError(null); } })
        .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Lost contact with the server.'); });
    }, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [active, apply]);

  const start = useCallback(async (input: StartTrackingInput) => {
    setBusy(true); setError(null);
    try {
      const r = await trackingApi.start(input, credsRef.current);
      afterRef.current = 0; setAlerts([]); setRejected(r.rejected);
      apply({ ...r.status, plateReader: r.plateReader ?? r.status.plateReader ?? 'gemini' }, false);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start tracking.'); return false; }
    finally { setBusy(false); }
  }, [apply]);

  const stop = useCallback(async () => {
    setBusy(true);
    try { await trackingApi.stop(credsRef.current); setStatus((s) => (s ? { ...s, active: false } : s)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not stop tracking.'); }
    finally { setBusy(false); }
  }, []);

  return { status, alerts, busy, error, rejected, start, stop, clearError: () => setError(null) };
}
