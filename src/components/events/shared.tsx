import { useEffect, useRef } from 'react';
import type { Severity } from '../../lib/eventsApi';

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const SEVERITY_BADGE: Record<Severity, string> = { info: 'badge-neutral', notice: 'badge-accent', warning: 'badge-warning', critical: 'badge-critical' };
export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge ${SEVERITY_BADGE[severity] ?? 'badge-neutral'} !text-[10px]`}>{severity}</span>;
}

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'never');

export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Runs `fn` every `ms` while the component is mounted; the latest `fn` is always used. */
export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => { const id = setInterval(() => ref.current(), ms); return () => clearInterval(id); }, [ms]);
}

export function ErrorBox({ title, error, hint }: { title: string; error: string; hint?: string }) {
  return (
    <div className="badge-critical rounded-2xl p-4 !inline-block w-full !normal-case text-xs" role="alert">
      <p className="font-bold text-critical">{title}</p>
      <p className="text-ink-muted mt-1">{error}</p>
      {hint && <p className="text-ink-muted mt-1">{hint}</p>}
    </div>
  );
}
