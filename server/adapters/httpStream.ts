/** Cameras and gateways that give an HTTP(S) address: HLS playlists, MJPEG streams, or snapshot URLs. */
import { AdapterError, type CameraRef, type EndpointProtocol, type SourceAdapter } from './types';
import { probeUrl, withCredentials } from './probeUrl';

export function httpProtocol(url: string | undefined): EndpointProtocol | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const l = url.toLowerCase().split('?')[0];
  if (l.endsWith('.m3u8')) return 'hls';
  if (/\.(jpe?g|png)$/.test(l) || l.includes('snapshot') || l.includes('/frame.')) return 'snapshot';
  if (l.includes('mjpeg') || l.includes('mjpg')) return 'mjpeg';
  return null;
}

export const httpStreamAdapter: SourceAdapter = {
  kind: 'http',
  label: 'HTTP stream (HLS / MJPEG / snapshot)',
  description: 'Browser-friendly addresses. HLS and MJPEG are measured with ffmpeg; a snapshot URL is checked for one decodable image.',
  accepts: (ref) => httpProtocol(ref.url) !== null,
  async endpoints(ref) {
    const p = httpProtocol(ref.url);
    if (!p) throw new AdapterError(`Camera '${ref.id}' has no recognisable HTTP stream URL.`, 'bad_ref');
    return [{ protocol: p, role: p === 'snapshot' ? 'snapshot' : p === 'hls' ? 'browser' : 'analysis', url: ref.url! }];
  },
  async probe(ref: CameraRef, opts) {
    if (!httpProtocol(ref.url)) throw new AdapterError(`Camera '${ref.id}' has no recognisable HTTP stream URL.`, 'bad_ref');
    const c = ref.credentials ?? opts?.credentials;
    return probeUrl(ref, withCredentials(ref.url!, c), { rtsp: false, sampleSec: opts?.sampleSec, secrets: c ? [c.pass] : [], site: ref.site ?? 'http' });
  },
};
