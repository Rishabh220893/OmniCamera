/** Any camera or NVR channel reachable as a plain rtsp:// URL (the common denominator of IP cameras and recorders). */
import { AdapterError, type CameraRef, type SourceAdapter } from './types';
import { probeUrl, withCredentials } from './probeUrl';

const isRtsp = (u?: string) => !!u && /^rtsps?:\/\//i.test(u);

export const directRtspAdapter: SourceAdapter = {
  kind: 'rtsp',
  label: 'Direct RTSP URL',
  description: 'Any camera, NVR or encoder channel that gives an rtsp:// address. Credentials come from the camera record or the URL.',
  accepts: (ref) => isRtsp(ref.url),
  async endpoints(ref) {
    if (!isRtsp(ref.url)) throw new AdapterError(`Camera '${ref.id}' has no rtsp:// URL.`, 'bad_ref');
    return [{ protocol: 'rtsp', role: 'analysis', url: withCredentials(ref.url!, ref.credentials) }];
  },
  async probe(ref, opts) {
    if (!isRtsp(ref.url)) throw new AdapterError(`Camera '${ref.id}' has no rtsp:// URL.`, 'bad_ref');
    const c = ref.credentials ?? opts?.credentials;
    return probeUrl(ref, withCredentials(ref.url!, c), { rtsp: true, sampleSec: opts?.sampleSec, secrets: c ? [c.pass] : [], site: ref.site ?? 'direct' });
  },
};
