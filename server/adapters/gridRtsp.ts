/** The integrator-guide grid: every camera is rtsp://host:port/<prefix>/<id>, with WHEP and HLS served beside it. */
import { probeCamera } from '../cameraProbeRun';
import { sourceUrl, type SiteSource } from '../mediaPaths';
import { AdapterError, type CameraRef, type SourceAdapter, type StreamEndpoint } from './types';

export interface GridRtspConfig {
  site: string;
  source: SiteSource;
  whepPort: number;
  /** Port of the HLS server, if it differs from 80. */
  hlsPort?: number;
}

export function createGridRtspAdapter(cfg: GridRtspConfig): SourceAdapter {
  const need = (ref: CameraRef) => {
    if (!ref.credentials) throw new AdapterError(`Camera '${ref.id}' needs a login for the grid.`, 'bad_ref');
    return ref.credentials;
  };
  return {
    kind: 'grid-rtsp',
    label: 'Grid RTSP (integrator guide)',
    description: 'Cameras published as rtsp://host:port/<prefix>/<id> with WHEP and HLS beside them. Pulled over TCP.',
    accepts: (ref) => !ref.url && !ref.host,
    async endpoints(ref) {
      const s = cfg.source;
      const out: StreamEndpoint[] = [
        { protocol: 'rtsp', role: 'analysis', url: sourceUrl(s, ref.id, need(ref)), label: 'grid RTSP' },
        { protocol: 'whep', role: 'browser', url: `http://${s.host}:${cfg.whepPort}/${s.pathPrefix}/${ref.id}/whep` },
        { protocol: 'hls', role: 'browser', url: `http://${s.host}${cfg.hlsPort ? `:${cfg.hlsPort}` : ''}/live/${s.pathPrefix}/${ref.id}/index.m3u8` },
      ];
      return out;
    },
    probe(ref, opts) {
      const fallback = opts?.credentials;
      return probeCamera(ref.id, {
        site: cfg.site, source: cfg.source, whepPort: cfg.whepPort, sampleSec: opts?.sampleSec,
        credentials: () => ref.credentials ?? fallback ?? { user: '', pass: '' },
      });
    },
  };
}
