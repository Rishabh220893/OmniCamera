import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Eye, X } from 'lucide-react';
import type { TrackAlert } from '../lib/tracking';
import { fetchAlertFrame } from '../lib/tracking';

interface Props {
  alert: TrackAlert | null;
  onOpen: (alert: TrackAlert) => void;
  onDismiss: () => void;
}

/** A short two-tone alarm. Browsers only allow sound after the user has clicked something, so a failure here is silent. */
function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 660, 880].forEach((hz, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = hz; osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      osc.start(ctx.currentTime + i * 0.18); osc.stop(ctx.currentTime + i * 0.18 + 0.17);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1000);
  } catch { /* no sound */ }
}

/** The red alert shown over whatever tab is open when tracking finds the plate, the face or a rule match. */
export default function TrackingAlertBanner({ alert, onOpen, onDismiss }: Props) {
  const [frame, setFrame] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Publish the banner's height, so a full-screen camera opened by the alert sits below it instead of under it.
  useEffect(() => {
    const root = document.documentElement;
    const el = boxRef.current;
    if (!alert || !el) { root.style.removeProperty('--alert-h'); return; }
    const set = () => root.style.setProperty('--alert-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty('--alert-h'); };
  }, [alert?.id]);
  useEffect(() => {
    if (!alert) { setFrame(null); return; }
    let alive = true, url: string | null = null;
    beep();
    fetchAlertFrame(alert.id).then((u) => { url = u; if (alive) setFrame(u); else if (u) URL.revokeObjectURL(u); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [alert?.id]);

  if (!alert) return null;
  const possible = alert.certainty === 'possible';
  return (
    <div ref={boxRef} role="alert" aria-live="assertive" data-testid="tracking-alert" className="fixed top-0 inset-x-0 z-[100] bg-red-600 text-white shadow-2xl border-b-4 border-red-900 animate-pulse-slow">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
        {frame && <img src={frame} alt={`Frame from ${alert.cameraName}`} className="hidden sm:block w-28 h-16 object-cover rounded-md border-2 border-white/60 shrink-0" />}
        <AlertTriangle className="w-7 h-7 shrink-0 animate-bounce" strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <p className="text-base font-extrabold uppercase tracking-wide truncate">{possible ? 'Possible match: ' : 'Alert: '}{alert.title}</p>
          <p className="text-sm opacity-95 truncate" title={alert.detail}>{alert.cameraName} · {alert.detail}</p>
          <p className="text-[11px] opacity-80">{new Date(alert.at).toLocaleTimeString()}{alert.confidence !== null ? ` · ${Math.round(alert.confidence * 100)}% sure` : ''} · {alert.source === 'anpr' ? 'plate reader' : alert.source === 'gemini-fallback' ? 'Gemini (unverified plate read)' : 'Gemini'}</p>
        </div>
        <button onClick={() => onOpen(alert)} className="h-10 px-4 rounded-lg bg-white text-red-700 text-sm font-bold flex items-center gap-2 hover:bg-red-50 active:scale-95 shrink-0"><Eye className="w-4 h-4" /> View camera</button>
        <button onClick={onDismiss} aria-label="Dismiss alert" className="w-10 h-10 rounded-lg bg-red-800/70 hover:bg-red-800 flex items-center justify-center shrink-0"><X className="w-5 h-5" /></button>
      </div>
    </div>
  );
}
