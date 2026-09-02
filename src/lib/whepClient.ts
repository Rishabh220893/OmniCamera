/**
 * Minimal WHEP (WebRTC-HTTP Egress Protocol) client for playing a MediaMTX
 * stream in a <video> element. Non-trickle: waits for ICE gathering to
 * finish and sends one offer with every candidate already attached, rather
 * than exchanging candidates incrementally over PATCH — simpler, and the
 * origin here answers in well under a second so there's no latency reason
 * to trickle.
 *
 * The SDP offer/answer exchange goes through our own server
 * (/api/whep-proxy), not directly to the camera origin: that origin is
 * plain http:// and our app is served over https://, so a direct fetch from
 * the browser would be blocked as mixed content. The actual media
 * (ICE/DTLS/SRTP) still flows straight from the browser to the origin —
 * only the signaling handshake is relayed.
 */
export interface WhepSession {
  pc: RTCPeerConnection;
  /** Resolves once negotiation completes, or rejects if it fails. Ignore
   *  rejection after close() — that just means cleanup won the race. */
  ready: Promise<void>;
  close: () => void;
}

const ICE_GATHERING_TIMEOUT_MS = 4_000;

/**
 * The RTCPeerConnection is created synchronously (not inside the async
 * negotiate() below) so a caller can close() it immediately on cleanup,
 * before negotiation ever reaches setRemoteDescription/ontrack. This
 * matters under React StrictMode's dev-only double-invoke of effects: the
 * first (throwaway) effect run's connection must never be allowed to win a
 * race and attach its stream to the <video> element only to be closed a
 * moment later — closing synchronously before negotiation starts prevents
 * it from ever reaching that point at all.
 */
export function startWhep(
  camId: string,
  video: HTMLVideoElement,
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void,
): WhepSession {
  const pc = new RTCPeerConnection();
  const abortController = new AbortController();
  let resourceUrl: string | null = null;
  let closed = false;

  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (event) => {
    if (video.srcObject !== event.streams[0]) video.srcObject = event.streams[0];
  };
  if (onConnectionStateChange) {
    pc.onconnectionstatechange = () => onConnectionStateChange(pc.connectionState);
  }

  const close = () => {
    if (closed) return;
    closed = true;
    abortController.abort();
    if (resourceUrl) {
      fetch(`/api/whep-proxy?resource=${encodeURIComponent(resourceUrl)}`, { method: 'DELETE' }).catch(() => {
        // best-effort cleanup, origin also reaps abandoned sessions itself
      });
    }
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    pc.close();
  };

  const negotiate = async () => {
    const offer = await pc.createOffer();
    if (closed) return;
    await pc.setLocalDescription(offer);

    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ICE_GATHERING_TIMEOUT_MS);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            pc.onicegatheringstatechange = null;
            resolve();
          }
        };
      });
    }
    if (closed) return;

    const finalOffer = pc.localDescription;
    if (!finalOffer?.sdp) throw new Error('Failed to build a local SDP offer');

    const res = await fetch(`/api/whep-proxy?camId=${encodeURIComponent(camId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: finalOffer.sdp,
      signal: abortController.signal,
    });

    const answerSdp = await res.text();
    if (closed) return;
    if (!res.ok) {
      throw new Error(`WHEP negotiation failed (${res.status}): ${answerSdp.slice(0, 200)}`);
    }

    const resourceHeader = res.headers.get('x-whep-resource');
    resourceUrl = resourceHeader ? decodeURIComponent(resourceHeader) : null;
    if (closed) return;

    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  };

  const ready = negotiate().catch((err) => {
    if (closed) return; // cleanup already won the race — not a real failure
    close();
    throw err;
  });

  return { pc, ready, close };
}
