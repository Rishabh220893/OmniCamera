import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, Loader2, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { projectPoints, trailApi, type PlateSummary, type Trail } from '../../lib/trailApi';
import { ErrorBox, ago, errText } from './shared';

const PERIODS = [{ days: 1, label: '24 hours' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }];
const FLAG_TEXT = { implausible_speed: 'No vehicle goes this fast: a misread or two vehicles', simultaneous: 'Two distant cameras at the same moment', no_location: 'A camera has no position, distance unknown' } as const;
const dur = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const hhmm = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

/** Statewide vehicle trail (gap A18): search a plate, see every camera and department that read it, in order, with the legs between them. */
export default function TrailView() {
  const [days, setDays] = useState(7);
  const [query, setQuery] = useState('');
  const [plates, setPlates] = useState<PlateSummary[] | null>(null);
  const [plate, setPlate] = useState('');
  const [also, setAlso] = useState<string[]>([]);
  const [trail, setTrail] = useState<Trail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadPlates = useCallback(async () => {
    try { setPlates((await trailApi.plates(days, query.trim())).plates); setError(null); } catch (e) { setError(errText(e)); }
  }, [days, query]);
  useEffect(() => { const t = setTimeout(() => void loadPlates(), 250); return () => clearTimeout(t); }, [loadPlates]);

  const open = useCallback(async (p: string, extra: string[]) => {
    setLoading(true);
    try { setTrail(await trailApi.trail(p, days, extra)); setError(null); } catch (e) { setError(errText(e)); setTrail(null); } finally { setLoading(false); }
  }, [days]);
  useEffect(() => { if (plate) void open(plate, also); }, [plate, also, open]);

  const choose = (p: string) => { setPlate(p); setAlso([]); };
  const submit = (e: React.FormEvent) => { e.preventDefault(); const p = query.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); if (p.length >= 4) choose(p); };

  const placed = useMemo(() => (trail?.route.segments ?? []).filter((s) => s.location), [trail]);
  const pts = useMemo(() => projectPoints(placed.map((s) => s.location!), 560, 280), [placed]);
  const flagged = new Set((trail?.route.legs ?? []).filter((l) => l.flags.length).map((l) => l.toIndex));

  return (
    <div className="space-y-5" data-testid="trail-view">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={(e) => setQuery(e.target.value.toUpperCase())} placeholder="Plate, e.g. GJ05AB1234" className="input !py-2 !pl-9 text-sm font-mono w-64" aria-label="Plate" />
        </div>
        <button type="submit" className="btn-primary !py-2 !px-4 text-xs" disabled={query.replace(/[^A-Za-z0-9]/g, '').length < 4}>Trace this plate</button>
        <label className="text-xs flex items-center gap-2"><span className="text-ink-muted font-semibold">Period</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input !py-1.5 text-xs w-auto" aria-label="Period">{PERIODS.map((p) => <option key={p.days} value={p.days}>Last {p.label}</option>)}</select></label>
      </form>

      {error && <ErrorBox title="The trail could not be shown" error={error} />}

      <div className="grid lg:grid-cols-3 gap-5">
        <section className="card p-3 space-y-2 lg:col-span-1 max-h-[34rem] overflow-auto" aria-label="Plates seen">
          <h3 className="text-sm font-bold text-ink px-1">Plates seen</h3>
          {plates === null && <p className="text-xs text-ink-muted px-1">Loading…</p>}
          {plates?.length === 0 && <p className="text-xs text-ink-muted px-1">No plate reads in this period{query ? ' match that' : ''}.</p>}
          <ul className="space-y-0.5">
            {plates?.map((p) => (
              <li key={p.plate}>
                <button onClick={() => choose(p.plate)} className={cn('w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-surface-hover', plate === p.plate && 'bg-surface-hover')}>
                  <span className="font-mono font-semibold">{p.plate}</span>
                  <span className="text-ink-muted"> · {p.reads} read{p.reads === 1 ? '' : 's'} · {p.cameras} camera{p.cameras === 1 ? '' : 's'}{p.departments.length > 1 ? ` · ${p.departments.length} departments` : ''} · {ago(p.lastSeen)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="lg:col-span-2 space-y-4">
          {!plate && <p className="text-xs text-ink-muted">Choose a plate from the list, or type one and press Trace.</p>}
          {loading && <p className="text-xs text-ink-muted flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Building the trail…</p>}
          {trail && (<>
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-lg font-bold font-mono text-ink">{trail.plate}</h3>
              <span className="text-xs text-ink-muted">{trail.reads} read{trail.reads === 1 ? '' : 's'} · {trail.route.segments.length} stop{trail.route.segments.length === 1 ? '' : 's'} · {trail.route.totalDistanceKm.toFixed(1)} km{trail.departments.length ? ` · ${trail.departments.join(', ')}` : ''}</span>
              <button className="btn-ghost !py-1.5 !px-3 text-xs flex items-center gap-1.5 ml-auto" onClick={() => void trailApi.downloadCsv(trail.plate, days, also).catch((e) => setError(errText(e)))} disabled={trail.reads === 0}><Download className="w-3.5 h-3.5" />Download evidence (CSV)</button>
            </div>

            {trail.reads === 0 && <p className="text-xs text-ink-muted">No reads of this plate in your view in this period.</p>}

            {placed.length > 0 && (
              <svg viewBox="0 0 560 280" className="w-full max-w-2xl rounded-xl bg-surface-muted border border-border" role="img" aria-label="Route of the vehicle" data-testid="trail-map">
                {pts.map((p, i) => i > 0 && (
                  <line key={i} x1={pts[i - 1].x} y1={pts[i - 1].y} x2={p.x} y2={p.y} stroke={flagged.has(placed[i].index) ? '#dc2626' : '#2f5fdd'} strokeWidth="2" strokeDasharray={flagged.has(placed[i].index) ? '6 4' : undefined} />
                ))}
                {pts.map((p, i) => (
                  <g key={i}><circle cx={p.x} cy={p.y} r="9" fill="#2f5fdd" /><text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">{placed[i].index + 1}</text>
                    <title>{`${placed[i].index + 1}. ${placed[i].cameraName}`}</title></g>
                ))}
              </svg>
            )}

            {trail.route.segments.length > 0 && (
              <ol className="card divide-y divide-border text-xs">
                {trail.route.segments.map((s) => {
                  const leg = trail.route.legs.find((l) => l.toIndex === s.index);
                  return (
                    <li key={s.index} className="p-3 space-y-1">
                      {leg && (
                        <p className={cn('text-[11px]', leg.flags.length ? 'text-critical font-semibold' : 'text-ink-muted')}>
                          {leg.flags.length > 0 && <AlertTriangle className="w-3 h-3 inline mr-1" />}
                          {leg.distanceKm !== null ? `${leg.distanceKm.toFixed(1)} km` : 'distance unknown'} in {dur(leg.seconds)}{leg.speedKmh !== null ? ` · about ${Math.round(leg.speedKmh)} km/h` : ''}
                          {leg.flags.length > 0 && ` — ${leg.flags.map((f) => FLAG_TEXT[f]).join('; ')}`}
                        </p>
                      )}
                      <p><b>{s.index + 1}. {s.cameraName}</b>{s.department ? <span className="text-ink-muted"> · {s.department}</span> : null}</p>
                      <p className="text-ink-muted">{hhmm(s.start)}{s.sightings.length > 1 ? ` to ${hhmm(s.end)} · ${s.sightings.length} reads` : ''}{s.bestConfidence !== null ? ` · best confidence ${Math.round(s.bestConfidence * 100)}%` : ''}{s.sightings.some((x) => x.matchedAs === 'confirmed') ? ` · includes look-alike ${[...new Set(s.sightings.filter((x) => x.matchedAs === 'confirmed').map((x) => x.plate))].join(', ')}` : ''}</p>
                    </li>
                  );
                })}
              </ol>
            )}

            {trail.elsewhere.length > 0 && (
              <p className="text-xs card p-3">This plate was also read in {trail.elsewhere.map((e) => `${e.department} (${e.reads})`).join(', ')}: departments you do not cover. You can see how many reads, not where or when.</p>
            )}

            {(trail.possible.length > 0 || trail.confirmed.length > 0) && (
              <div className="card p-3 space-y-2 text-xs">
                <p className="font-bold text-ink">Possible look-alikes (the same plate misread?)</p>
                {trail.confirmed.map((p) => (<p key={p}><span className="font-mono">{p}</span> added to this trail <button className="underline ml-2" onClick={() => setAlso(also.filter((x) => x !== p))}>Remove</button></p>))}
                {trail.possible.map((p) => (<p key={p.plate}><span className="font-mono">{p.plate}</span> <span className="text-ink-muted">· {p.count} read{p.count === 1 ? '' : 's'}</span> <button className="underline ml-2" onClick={() => setAlso([...also, p.plate])}>Same vehicle: add to trail</button></p>))}
                <p className="text-ink-muted">A person decides: only add a plate you believe is the same vehicle.</p>
              </div>
            )}

            <section className="space-y-1">
              <h4 className="text-xs font-bold text-ink">What this trail cannot say</h4>
              <ul className="text-xs text-ink-muted list-disc pl-5 space-y-0.5">{trail.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </section>
          </>)}
        </section>
      </div>
    </div>
  );
}
