import { useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Navigation, X } from 'lucide-react';
import { CameraConfig, ConnectivityStatus, RoutePoint } from '../types';

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

export default function MapTab({ cameras, activeCameraId, onSelectCamera, routePlate, routePoints, onClearRoute, showCoverage = true, height = '65vh' }: MapPanelProps) {
  const located = cameras.filter(c => c.location);

  const center: [number, number] = useMemo(() => {
    if (routePoints.length > 0) return [routePoints[0].lat, routePoints[0].lng];
    if (located.length > 0) return [located[0].location!.lat, located[0].location!.lng];
    return [20.5937, 78.9629]; // sensible default center
  }, [located, routePoints]);

  const polyline: [number, number][] = routePoints.map(p => [p.lat, p.lng]);

  if (located.length === 0 && routePoints.length === 0) {
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
          {showCoverage && located.map(cam => (
            <Circle
              key={`cov-${cam.id}`}
              center={[cam.location!.lat, cam.location!.lng]}
              radius={250}
              pathOptions={{ color: statusColor(cam), fillColor: statusColor(cam), fillOpacity: 0.08, weight: 1, opacity: 0.35 }}
            />
          ))}
          {located.map(cam => (
            <Marker
              key={cam.id}
              position={[cam.location!.lat, cam.location!.lng]}
              icon={pinIcon(statusColor(cam), cam.id === activeCameraId)}
              eventHandlers={{ click: () => onSelectCamera(cam.id) }}
            >
              <Popup>
                <div style={{ fontFamily: 'inherit' }}>
                  <strong>{cam.name}</strong>
                  {cam.department && <div style={{ fontSize: 11, color: '#5c6572' }}>{cam.department}</div>}
                  <div style={{ fontSize: 11, color: statusColor(cam), fontWeight: 600, textTransform: 'capitalize', marginTop: 2 }}>
                    {cam.connectivityStatus || 'unknown'}
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
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
