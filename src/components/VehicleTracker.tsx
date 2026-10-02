import { useCallback, useMemo, useState } from 'react';
import { Search, Navigation, Download, AlertTriangle, Check, X, Undo2, Loader2, ArrowDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { downloadCsv } from '../lib/csv';
import { RoutePoint } from '../types';
import {
  buildRoute, describeEdit, findPossibleMatches, LegFlag, normalizePlate, PlateCandidate, PlateEdit, PlateSighting, routeToCsv,
} from '../lib/plateTracking';
import { clearDecision, fetchDecisions, fetchPlateIndex, fetchSightingsForPlate, MatchDecision, saveDecision, StoredDecision } from '../lib/plateStore';

interface VehicleTrackerProps {
  /** Signed-in user's id; null in guest mode, where only `localSightings` exist. */
  userId: string | null;
  decidedBy: string;
  /** Guest-mode sightings, derived from the in-memory event log. */
  localSightings: PlateSighting[];
  activeRoutePlate: string | null;
  onShowRoute: (plate: string, points: RoutePoint[]) => void;
}

interface Loaded {
  query: string;
  exact: PlateSighting[];
  aliases: PlateSighting[];
  index: PlateCandidate[];
  decisions: StoredDecision[];
}

const FLAG_LABEL: Record<LegFlag, string> = {
  implausible_speed: 'Implausible speed — misread or a different vehicle?',
  simultaneous: 'Seen at two distant cameras at once — misread or a different vehicle?',
  no_location: 'Camera location missing — distance unknown',
};

const fmtDuration = (seconds: number) => {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
};
const fmtConf = (c: number | null) => (c === null ? '—' : `${Math.round(c * 100)}%`);

const buildRouteFor = (l: Loaded) => buildRoute([
  ...l.exact.map(s => ({ ...s, matchedAs: 'exact' as const })),
  ...l.aliases.map(s => ({ ...s, matchedAs: 'confirmed' as const })),
]);

/** The candidate plate with the characters that differ from the search marked, since 0/O and 1/I look alike. */
function HighlightedPlate({ plate, edits }: { plate: string; edits: PlateEdit[] }) {
  const marked = new Set(edits.map(e => e.candidatePosition).filter((n): n is number => n !== undefined));
  return (
    <span aria-label={plate}>
      {[...plate].map((ch, i) => marked.has(i + 1)
        ? <mark key={i} className="bg-warning-soft text-warning rounded px-0.5 underline">{ch}</mark>
        : <span key={i}>{ch}</span>)}
    </span>
  );
}

const pairOf = (d: StoredDecision, plate: string) => (d.plates[0] === plate ? d.plates[1] : d.plates[0]);

export default function VehicleTracker({ userId, decidedBy, localSightings, activeRoutePlate, onShowRoute }: VehicleTrackerProps) {
  const [input, setInput] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const load = useCallback(async (raw: string): Promise<Loaded | null> => {
    const q = normalizePlate(raw);
    if (!q) return null;
    setLoading(true); setError(null);
    try {
      let result: Loaded;
      if (userId) {
        const [exact, index, decisions] = await Promise.all([fetchSightingsForPlate(userId, q), fetchPlateIndex(userId), fetchDecisions(userId)]);
        const confirmed = decisions.filter(d => d.decision === 'confirmed' && d.plates.includes(q)).map(d => pairOf(d, q));
        const aliasLists = await Promise.all(confirmed.map(p => fetchSightingsForPlate(userId, p)));
        result = { query: q, exact, aliases: aliasLists.flat(), index, decisions };
      } else {
        // Guest mode: no database, so decisions live only for this session.
        const counts = new Map<string, PlateCandidate>();
        for (const s of localSightings) {
          const c = counts.get(s.plate) ?? { plate: s.plate, count: 0, lastSeen: s.timestamp };
          c.count++;
          if (!c.lastSeen || s.timestamp > c.lastSeen) c.lastSeen = s.timestamp;
          counts.set(s.plate, c);
        }
        const prior = loaded?.query === q ? loaded.decisions : [];
        const confirmed = new Set(prior.filter(d => d.decision === 'confirmed').map(d => pairOf(d, q)));
        result = {
          query: q, exact: localSightings.filter(s => s.plate === q),
          aliases: localSightings.filter(s => confirmed.has(s.plate)), index: [...counts.values()], decisions: prior,
        };
      }
      setLoaded(result);
      return result;
    } catch (err) {
      console.error('Vehicle search failed:', err);
      setError(err instanceof Error ? err.message : 'Search failed');
      return null;
    } finally { setLoading(false); }
  }, [userId, localSightings, loaded]);

  const route = useMemo(() => (loaded ? buildRouteFor(loaded) : null), [loaded]);

  const decidedPlates = useMemo(() => new Set((loaded?.decisions ?? []).filter(d => d.plates.includes(loaded!.query)).map(d => pairOf(d, loaded!.query))), [loaded]);
  const possible = useMemo(
    () => (loaded ? findPossibleMatches(loaded.query, loaded.index).filter(m => !decidedPlates.has(m.plate)) : []),
    [loaded, decidedPlates],
  );
  const confirmed = useMemo(() => (loaded?.decisions ?? []).filter(d => d.decision === 'confirmed' && d.plates.includes(loaded!.query)), [loaded]);
  const rejected = useMemo(() => (loaded?.decisions ?? []).filter(d => d.decision === 'rejected' && d.plates.includes(loaded!.query)), [loaded]);

  const pointsOf = useCallback((r: NonNullable<typeof route>): RoutePoint[] =>
    r.segments.filter(s => s.location).map(s => ({ lat: s.location!.lat, lng: s.location!.lng, label: s.cameraName, timestamp: s.start })), []);

  const search = () => { void load(input); };

  const decide = async (candidate: string, decision: MatchDecision) => {
    if (!loaded) return;
    const q = loaded.query;
    const next: StoredDecision = { pair: '', plates: [q, candidate], decision };
    try {
      if (userId) {
        await saveDecision(userId, q, candidate, decision, decidedBy);
        const fresh = await load(q);
        if (fresh && activeRoutePlate === q) onShowRoute(q, pointsOf(buildRouteFor(fresh)));
      } else {
        const decisions = [...loaded.decisions.filter(d => !(d.plates.includes(candidate))), next];
        setLoaded({ ...loaded, decisions, aliases: decision === 'confirmed' ? [...loaded.aliases, ...localSightings.filter(s => s.plate === candidate)] : loaded.aliases.filter(s => s.plate !== candidate) });
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save the decision'); }
  };

  const undo = async (candidate: string) => {
    if (!loaded) return;
    const q = loaded.query;
    try {
      if (userId) {
        await clearDecision(userId, q, candidate);
        const fresh = await load(q);
        if (fresh && activeRoutePlate === q) onShowRoute(q, pointsOf(buildRouteFor(fresh)));
      } else {
        setLoaded({ ...loaded, decisions: loaded.decisions.filter(d => !d.plates.includes(candidate)), aliases: loaded.aliases.filter(s => s.plate !== candidate) });
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not undo the decision'); }
  };

  return (
    <section className="card p-8 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-soft flex items-center justify-center text-accent"><Search className="w-5 h-5" strokeWidth={1.75} /></div>
          <div>
            <h3 className="text-base font-bold font-display text-ink">Vehicle tracking</h3>
            <p className="text-xs text-ink-muted">Exact matches build the route. Look-alike plates are suggested for you to confirm.</p>
          </div>
        </div>
        <form className="flex gap-2 w-full sm:w-auto" onSubmit={(e) => { e.preventDefault(); search(); }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. GJ01AB1234" className="input !py-2.5 !px-4 text-sm font-mono uppercase sm:w-56" aria-label="Plate number" />
          <button type="submit" className="btn-secondary !py-2 !px-4 text-xs" disabled={loading || !normalizePlate(input)}>
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" strokeWidth={1.75} />} Search
          </button>
        </form>
      </div>

      {error && <p className="text-xs text-critical">{error}</p>}

      {loaded && route && (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-ink-muted">
              <span className="font-mono font-bold text-ink">{loaded.query}</span>:{' '}
              {loaded.exact.length} exact sighting{loaded.exact.length !== 1 ? 's' : ''}
              {loaded.aliases.length > 0 && <> + {loaded.aliases.length} from confirmed look-alikes</>}
              {route.segments.length > 0 && <> · {route.segments.length} stop{route.segments.length !== 1 ? 's' : ''}{route.totalDistanceKm > 0 && <> · {route.totalDistanceKm.toFixed(1)} km</>}</>}
            </p>
            {route.segments.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {activeRoutePlate === loaded.query
                  ? <span className="badge badge-accent whitespace-nowrap">Route shown on Map</span>
                  : <button onClick={() => onShowRoute(loaded.query, pointsOf(route))} className="btn-secondary !py-2 !px-4 text-xs whitespace-nowrap"><Navigation className="w-3.5 h-3.5" strokeWidth={1.75} /> Show route on map</button>}
                <button onClick={() => downloadCsv(`route-${loaded.query}.csv`, routeToCsv(loaded.query, route))} className="btn-secondary !py-2 !px-4 text-xs whitespace-nowrap"><Download className="w-3.5 h-3.5" strokeWidth={1.75} /> Export route CSV</button>
              </div>
            )}
          </div>

          {route.segments.length === 0 ? (
            <p className="text-xs text-ink-muted py-4 text-center">No exact sightings of "{loaded.query}"{possible.length > 0 ? ' — but see the possible matches below.' : '.'}</p>
          ) : (
            <ol className="space-y-1.5">
              {route.segments.map((seg, i) => {
                const leg = route.legs[i - 1];
                return (
                  <li key={seg.index}>
                    {leg && (
                      <div className={cn('flex items-center gap-2 pl-4 py-1.5 text-[10px] flex-wrap', leg.flags.some(f => f !== 'no_location') ? 'text-warning' : 'text-ink-muted')}>
                        <ArrowDown className="w-3 h-3 shrink-0" strokeWidth={1.75} />
                        <span>
                          {leg.distanceKm !== null ? `${leg.distanceKm.toFixed(1)} km` : 'distance unknown'} in {fmtDuration(leg.seconds)}
                          {leg.speedKmh !== null && ` (${Math.round(leg.speedKmh)} km/h)`}
                        </span>
                        {leg.flags.map(f => <span key={f} className="badge badge-warning !normal-case !whitespace-normal inline-flex items-center gap-1 max-w-full" title={FLAG_LABEL[f]}><AlertTriangle className="w-3 h-3" strokeWidth={1.75} />{FLAG_LABEL[f]}</span>)}
                      </div>
                    )}
                    <div className="panel p-3.5 flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-6 h-6 rounded-full bg-accent text-white text-[11px] font-bold flex items-center justify-center shrink-0">{seg.index + 1}</span>
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-ink truncate">{seg.cameraName}{seg.department ? <span className="font-normal text-ink-muted"> · {seg.department}</span> : null}</p>
                          <p className="text-[10px] font-mono text-ink-muted">
                            {seg.start.toLocaleString()}{seg.end.getTime() !== seg.start.getTime() && ` → ${seg.end.toLocaleTimeString()}`}
                            {!seg.location && ' · no map location'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-ink-muted">
                        <span>{seg.sightings.length} read{seg.sightings.length !== 1 ? 's' : ''}</span>
                        <span>best {fmtConf(seg.bestConfidence)}</span>
                        {seg.sightings.some(s => s.matchedAs === 'confirmed') && <span className="badge badge-neutral">includes look-alike</span>}
                        {seg.sightings.some(s => s.source !== 'anpr') && <span className="badge badge-warning" title="Read by the general vision model, not the dedicated plate reader — less reliable">unverified read</span>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {confirmed.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Confirmed as the same vehicle</p>
              <div className="flex flex-wrap gap-2">
                {confirmed.map(d => { const other = pairOf(d, loaded.query); return (
                  <span key={d.pair} className="badge badge-success !normal-case inline-flex items-center gap-2 font-mono">
                    {other}
                    <button onClick={() => undo(other)} title="Undo — no longer treat as the same vehicle" aria-label={`Undo confirmation of ${other}`}><Undo2 className="w-3 h-3" strokeWidth={2} /></button>
                  </span>
                ); })}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Possible matches — not in the route until you confirm</p>
            {possible.length === 0 ? (
              <p className="text-xs text-ink-muted">No look-alike plates found.</p>
            ) : possible.map(m => (
              <div key={m.plate} className="panel p-3.5 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-mono font-bold text-ink"><HighlightedPlate plate={m.plate} edits={m.edits} /></p>
                  <p className="text-[10px] text-ink-muted">
                    {m.edits.map(describeEdit).join('; ')} · {m.count} sighting{m.count !== 1 ? 's' : ''}{m.lastSeen ? ` · last ${m.lastSeen.toLocaleString()}` : ''}
                  </p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => decide(m.plate, 'confirmed')} className="btn-secondary !py-1.5 !px-3 text-xs"><Check className="w-3.5 h-3.5" strokeWidth={2} /> Same vehicle</button>
                  <button onClick={() => decide(m.plate, 'rejected')} className="btn-secondary !py-1.5 !px-3 text-xs"><X className="w-3.5 h-3.5" strokeWidth={2} /> Different</button>
                </div>
              </div>
            ))}
            {rejected.length > 0 && (
              <div>
                <button onClick={() => setShowRejected(v => !v)} className="text-[10px] font-bold text-accent uppercase">{showRejected ? 'Hide' : 'Show'} {rejected.length} rejected</button>
                {showRejected && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {rejected.map(d => { const other = pairOf(d, loaded.query); return (
                      <span key={d.pair} className="badge badge-neutral !normal-case inline-flex items-center gap-2 font-mono">
                        {other}
                        <button onClick={() => undo(other)} title="Undo rejection" aria-label={`Undo rejection of ${other}`}><Undo2 className="w-3 h-3" strokeWidth={2} /></button>
                      </span>
                    ); })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
