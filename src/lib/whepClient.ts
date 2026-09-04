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

// All cameras on a grid page auto-connect on mount (see MonitorTab) — every
// RTCPeerConnection starting negotiation in the same tick is a thundering
// herd against both our own /api/whep-proxy and the origin's MediaMTX, and
// was observed causing widespread negotiation timeouts and retry storms.
// Capping how many negotiate at once and queuing the rest smooths that into
// a ramp instead of a spike; a queued connection still negotiates within a
// few seconds since each slot is held only for the signaling exchange, not
// the connection's lifetime.
//
// That original tuning (6) predates snapshot mode, when every grid tile
// held a live decode session open — 6 concurrent sustained WebRTC decodes
// was already a meaningful bandwidth/CPU commitment. Now most tiles only
// ever hold a slot for a brief connect-capture-disconnect cycle (see
// captureWhepSnapshot) that releases it the moment signaling completes, well
// before any media flows — so the real constraint this queue should be
// sized against is "how many simultaneous SDP offer/answer exchanges can be
// in flight," not "how many decodes can this browser tab sustain." With a
// full 24-50 tile page now the common case (see MonitorTab/RegistryTab
// pagination), a cap of 6 means most of a page's tiles just sit queued
// through their first several refresh cycles — read as "not rendering" even
// though nothing is actually failing. Raised well above the live-decode-era
// value to match that shift.
const MAX_CONCURRENT_NEGOTIATIONS = 16;
// A hard ceiling on how long any one negotiation is allowed to hold a slot,
// independent of whatever that negotiation is actually doing. Closing an
// RTCPeerConnection mid-operation (e.g. captureWhepSnapshot's timeout
// firing while createOffer/setLocalDescription is still pending) isn't
// guaranteed by every browser to promptly reject that pending call — if it
// doesn't, negotiate()'s own `finally` never runs and the slot leaks
// forever, permanently wedging the queue after MAX_CONCURRENT_NEGOTIATIONS
// leaks (exactly what repeated snapshot capture cycles are prone to
// triggering). releaseSlot is idempotent, so forcing it here is a safe
// no-op on the normal path where the real completion already released it.
const NEGOTIATION_SLOT_MAX_HOLD_MS = 20_000;
let activeNegotiationSlots = 0;
const negotiationQueue: Array<() => void> = [];

function acquireNegotiationSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      activeNegotiationSlots++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeNegotiationSlots--;
        const next = negotiationQueue.shift();
        if (next) next();
      };
      setTimeout(release, NEGOTIATION_SLOT_MAX_HOLD_MS);
      resolve(release);
    };
    if (activeNegotiationSlots < MAX_CONCURRENT_NEGOTIATIONS) grant();
    else negotiationQueue.push(grant);
  });
}

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
  streamAccessPassword?: string,
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
    const releaseSlot = await acquireNegotiationSlot();
    try {
      if (closed) return;
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

      const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
      if (streamAccessPassword) headers['X-Stream-Password'] = streamAccessPassword;
      const res = await fetch(`/api/whep-proxy?camId=${encodeURIComponent(camId)}`, {
        method: 'POST',
        headers,
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
    } finally {
      releaseSlot();
    }
  };

  const ready = negotiate().catch((err) => {
    if (closed) return; // cleanup already won the race — not a real failure
    close();
    throw err;
  });

  return { pc, ready, close };
}

/**
 * Grabs one still frame from a camera over WHEP and returns it as a JPEG
 * data URL, then tears the connection down — used for grid thumbnails at
 * scale (see CameraFeed's `liveVideo` prop) instead of keeping a live
 * decode running per tile. A registry of 80,000 cameras can never have
 * more than a handful genuinely live-decoding in a browser tab at once —
 * that's a hardware ceiling, not a tuning problem — but it CAN have many
 * thumbnails rotating through brief connect-capture-disconnect cycles,
 * since each one only occupies a signaling/negotiation slot (see
 * MAX_CONCURRENT_NEGOTIATIONS above) for a couple of seconds rather than
 * holding a decode session open indefinitely.
 *
 * Takes an AbortSignal because, unlike startWhep, the RTCPeerConnection
 * here is created inside this function rather than handed back to the
 * caller — without a way to reach in and close it early, a caller that
 * stops needing the result (an unmount, a camera switch, React Strict
 * Mode's double-invoke in dev) can only ignore the eventual resolution,
 * not stop the negotiation actually happening. That leaves a real
 * WHEP session running to completion for no reason, burning a
 * concurrency slot and origin resources a scrolled-away or unmounted
 * tile has no more use for.
 */
export function captureWhepSnapshot(camId: string, opts: { timeoutMs?: number; signal?: AbortSignal; streamAccessPassword?: string } = {}): Promise<string> {
  const { timeoutMs = 12_000, signal, streamAccessPassword } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Snapshot aborted')); return; }

    // A <video> that's never actually in the document doesn't reliably
    // play in every engine — 'playing' can simply never fire, autoplay
    // policies can differ for detached elements, and this was in fact
    // silently starving every capture (every attempt hit the timeout
    // fallback below, never a real frame). Kept in the render tree but
    // fully invisible and out of layout flow.
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (err?: Error, dataUrl?: string) => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      clearTimeout(overallTimeout);
      signal?.removeEventListener('abort', onAbort);
      session.close();
      video.remove();
      if (err) reject(err); else resolve(dataUrl!);
    };

    const onAbort = () => finish(new Error('Snapshot aborted'));
    signal?.addEventListener('abort', onAbort);

    const overallTimeout = setTimeout(() => finish(new Error('Snapshot timed out')), timeoutMs);

    const session = startWhep(camId, video, (state) => {
      if (state === 'failed' || state === 'closed') finish(new Error(`WebRTC connection ${state}`));
    }, streamAccessPassword);

    // The integrator guide is explicit that a join can start on a
    // corrupt/black decoder frame that self-corrects almost immediately —
    // a brief settle after 'playing' fires (rather than capturing the
    // instant a frame exists) keeps thumbnails from being a coin flip on
    // catching that exact moment.
    video.addEventListener('playing', () => {
      settleTimer = setTimeout(() => {
        if (!video.videoWidth) { finish(new Error('No frame available to capture')); return; }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) { finish(new Error('Canvas unavailable')); return; }
        ctx.drawImage(video, 0, 0);
        finish(undefined, canvas.toDataURL('image/jpeg', 0.6));
      }, 900);
    }, { once: true });

    session.ready.catch((err: unknown) => {
      finish(err instanceof Error ? err : new Error('WHEP negotiation failed'));
    });
  });
}
