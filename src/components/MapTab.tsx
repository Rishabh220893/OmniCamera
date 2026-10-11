import { Fragment, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, CircleMarker, Rectangle, LayersControl, LayerGroup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Navigation, X } from 'lucide-react';
import { CameraConfig, ConnectivityStatus, RoutePoint } from '../types';
import type { UncoveredZone } from '../lib/registryReport';

interface MapPanelProps {
  cameras: CameraConfig[];
  activeCameraId: string;
  onSelectCamera: (id: string) => void;
  routePlate: string | null;
  routePoints: RoutePoint[];
  onClearRoute: () => void;
  /** Draw a faint coverage radius around each pin (Model 1's "coverage layer"). */
  showCoverage?: boolean;
  height?: string;
  /** Squares of the map no camera reaches (gap analysis); drawn as a toggleable layer. */
  uncoveredZones?: UncoveredZone[];
  /** How far a camera is taken to cover, in metres (the coverage layer's circles). */
  coverageRadiusMeters?: number;
  /** Side of each uncovered square in metres (from the gap analysis); the squares are drawn at that size. */
  zoneCellMeters?: number;
}

const STATUS_COLOR: Record<ConnectivityStatus, string> = {
  online: '#1f8a5f',
  offline: '#c8392a',
  degraded: '#b5690a',
  unknown: '#5c6572',
};

function statusColor(cam: CameraConfig): string {
  return STATUS_COLOR[cam.connectivityStatus || 'unknown'];
}

function pinIcon(color: string, active: boolean) {
  const size = active ? 30 : 24;
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;background:${color};transform:rotate(-45deg);border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.25);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size],
  });
}

function routeDotIcon(index: number) {
  return L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;border-radius:50%;background:#2f5fdd;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;font:bold 9px sans-serif;color:white;">${index + 1}</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

export default function MapTab({ cameras, activeCameraId, onSelectCamera, routePlate, routePoints, onClearRoute, showCoverage = true, height = '65vh', uncoveredZones = [], coverageRadiusMeters = 250, zoneCellMeters = 0 }: MapPanelProps) {
  // Department and camera-type layers: each can be switched off to see the rest. Status and coverage layers are in the map's own layer control.
  const [hiddenDepartments, setHiddenDepartments] = useState<Set<string>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const deptOf = (c: CameraConfig) => c.department?.trim() || 'Unassigned';
  const typeOf = (c: CameraConfig) => c.cameraType || 'unspecified';
  const allLocated = cameras.filter(c => c.location);
  const departments = useMemo(() => Array.from(new Set(allLocated.map(deptOf))).sort(), [allLocated]);
  const types = useMemo(() => Array.from(new Set(allLocated.map(typeOf))).sort(), [allLocated]);
  const located = allLocated.filter(c => !hiddenDepartments.has(deptOf(c)) && !hiddenTypes.has(typeOf(c)));
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => { const n = new Set(set); if (n.has(key)) n.delete(key); else n.add(key); setter(n); };
  const STATUSES: ConnectivityStatus[] = ['online', 'degraded', 'offline', 'unknown'];

  const center: [number, number] = useMemo(() => {
    if (routePoints.length > 0) return [routePoints[0].lat, routePoints[0].lng];
    if (located.length > 0) return [located[0].location!.lat, located[0].location!.lng];
    return [20.5937, 78.9629]; // sensible default center
  }, [located, routePoints]);

  const polyline: [number, number][] = routePoints.map(p => [p.lat, p.lng]);

  if (allLocated.length === 0 && routePoints.length === 0) {
    return (
      <div className="card p-16 flex flex-col items-center text-center gap-3">
        <div className="w-12 h-12 rounded-2xl bg-accent-soft flex items-center justify-center text-accent">
          <MapPin className="w-6 h-6" strokeWidth={1.75} />
        </div>
        <h3 className="text-sm font-bold text-ink">No cameras placed on the map yet</h3>
        <p className="text-xs text-ink-muted max-w-sm">Add coordinates to a camera in Settings, or in a bulk-import CSV, to see it plotted here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[10px] text-ink-muted">
        Pin color reflects each camera's <span className="font-semibold text-ink">registry status</span> (declared, not live) — see Feed for real-time connection state.
      </p>
      <div className="card p-3 flex flex-wrap gap-x-6 gap-y-2 text-[11px]" aria-label="Map layers">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-bold text-ink-muted uppercase tracking-wide text-[10px]">Status</span>
          {STATUSES.map(st => <span key={st} className="inline-flex items-center gap-1.5 capitalize text-ink-muted"><span style={{ background: STATUS_COLOR[st] }} className="inline-block w-2.5 h-2.5 rounded-full" />{st}</span>)}
          <span className="inline-flex items-center gap-1.5 text-ink-muted"><span className="inline-block w-2.5 h-2.5 rounded-full border border-critical" style={{ background: 'rgba(200,57,42,.15)' }} />uncovered square (layer control, top right): no camera within the coverage radius of any part of it. Squares left uncoloured are covered; at State scale the radius is small, so most of the map is red until you zoom in.</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold text-ink-muted uppercase tracking-wide text-[10px]">Departments</span>
          {departments.map(d => (
            <label key={d} className="inline-flex items-center gap-1 cursor-pointer text-ink-muted"><input type="checkbox" checked={!hiddenDepartments.has(d)} onChange={() => toggle(hiddenDepartments, setHiddenDepartments, d)} />{d}</label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold text-ink-muted uppercase tracking-wide text-[10px]">Camera types</span>
          {types.map(t => (
            <label key={t} className="inline-flex items-center gap-1 cursor-pointer text-ink-muted"><input type="checkbox" checked={!hiddenTypes.has(t)} onChange={() => toggle(hiddenTypes, setHiddenTypes, t)} />{t}</label>
          ))}
        </div>
        <span className="text-ink-muted">{located.length} of {allLocated.length} located cameras shown</span>
      </div>
      {routePlate && (
        <div className="badge badge-accent !normal-case !text-xs gap-2 inline-flex">
          <Navigation className="w-3.5 h-3.5" strokeWidth={1.75} />
          Route for <span className="font-mono font-bold">{routePlate}</span>
          <button onClick={onClearRoute} className="ml-1"><X className="w-3 h-3" strokeWidth={2} /></button>
        </div>
      )}
      <div className="card overflow-hidden" style={{ height }}>
        <MapContainer center={center} zoom={located.length || routePoints.length ? 12 : 4} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <LayersControl position="topright" collapsed>
            {STATUSES.map(st => (
              <LayersControl.Overlay key={st} checked name={`Status: ${st}`}>
                <LayerGroup>
                  {located.filter(c => (c.connectivityStatus || 'unknown') === st).map(cam => (
                    <Marker
                      key={cam.id}
                      position={[cam.location!.lat, cam.location!.lng]}
                      icon={pinIcon(statusColor(cam), cam.id === activeCameraId)}
                      eventHandlers={{ click: () => onSelectCamera(cam.id) }}
                    >
                      <Popup>
                        <div style={{ fontFamily: 'inherit' }}>
                          <strong>{cam.name}</strong>
                          <div style={{ fontSize: 11, color: '#5c6572' }}>{deptOf(cam)} · {typeOf(cam)}</div>
                          {cam.ownership && <div style={{ fontSize: 11, color: '#5c6572' }}>Owner: {cam.ownership}</div>}
                          <div style={{ fontSize: 11, color: statusColor(cam), fontWeight: 600, textTransform: 'capitalize', marginTop: 2 }}>
                            {cam.connectivityStatus || 'unknown'}{cam.maintenanceStatus ? ` · ${cam.maintenanceStatus.replace('_', ' ')}` : ''}
                          </div>
                        </div>
                      </Popup>
                    </Marker>
                  ))}
                </LayerGroup>
              </LayersControl.Overlay>
            ))}
            <LayersControl.Overlay checked={showCoverage} name={`Coverage (${coverageRadiusMeters} m)`}>
              <LayerGroup>
                {located.map(cam => (
                  <Fragment key={`cov-${cam.id}`}>
                    <Circle
                      center={[cam.location!.lat, cam.location!.lng]}
                      radius={coverageRadiusMeters}
                      pathOptions={{ color: statusColor(cam), fillColor: statusColor(cam), fillOpacity: 0.08, weight: 1, opacity: 0.35 }}
                    />
                    {/* The real radius is a dot on a State-wide view; this ring keeps the coverage layer visible at any zoom. */}
                    <CircleMarker center={[cam.location!.lat, cam.location!.lng]} radius={9} pathOptions={{ color: '#1f8a5f', fillColor: '#1f8a5f', fillOpacity: 0.15, weight: 2, opacity: 0.9 }} />
                  </Fragment>
                ))}
              </LayerGroup>
            </LayersControl.Overlay>
            <LayersControl.Overlay name={`Uncovered zones (${uncoveredZones.length})`}>
              <LayerGroup>
                {uncoveredZones.map((z, i) => {
                  // A square of the size the analysis used, so it is as big on the map as the gap it stands for.
                  const half = Math.max(zoneCellMeters, coverageRadiusMeters) / 2;
                  const dLat = half / 111_320, dLng = half / (111_320 * Math.max(0.1, Math.cos((z.lat * Math.PI) / 180)));
                  return <Rectangle key={`gap-${i}`} bounds={[[z.lat - dLat, z.lng - dLng], [z.lat + dLat, z.lng + dLng]]} pathOptions={{ color: '#c8392a', fillColor: '#c8392a', fillOpacity: 0.28, weight: 1, opacity: 0.6 }} />;
                })}
              </LayerGroup>
            </LayersControl.Overlay>
          </LayersControl>
          {routePoints.map((p, idx) => (
            <Marker key={`${p.label}-${idx}`} position={[p.lat, p.lng]} icon={routeDotIcon(idx)}>
              <Popup>
                <div style={{ fontFamily: 'inherit' }}>
                  <strong>{p.label}</strong>
                  <div style={{ fontSize: 11, color: '#5c6572' }}>{p.timestamp.toLocaleString()}</div>
                </div>
              </Popup>
            </Marker>
          ))}
          {polyline.length >= 2 && <Polyline positions={polyline} pathOptions={{ color: '#2f5fdd', weight: 3, dashArray: '6 6' }} />}
        </MapContainer>
      </div>
    </div>
  );
}
