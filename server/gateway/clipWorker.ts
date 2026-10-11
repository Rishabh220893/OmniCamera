/**
 * The gateway's side of a central clip fetch (server/gateway/clips.ts): asks the centre for clip requests, cuts each from the recordings kept
 * here, and sends it. Runs next to the cameras, so a far site's video crosses the link only when someone asks for it.
 *
 * For every request it first places a **hold** here, so the originals outlive routine retention while the case is open; then it cuts the clip
 * (copied, not re-encoded), tells the centre what is in it, and uploads it. A request it cannot serve (no footage in that time, a range that is
 * too long, ffmpeg failing) is reported as failed with the reason, so the person who asked is told instead of waiting.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Agent, ClipRequestForGateway } from './agent';
import { ClipError, makeClip } from '../recording/clip';
import type { RecordingStore } from '../recording/store';

export interface ClipWorkerOptions {
  agent: Pick<Agent, 'clipRequests' | 'postClipDetails' | 'failClip' | 'uploadClip'>;
  store: RecordingStore;
  holds: { add(h: { cameraId: string; from: Date; to: Date; reason: string; by: string }): Promise<{ id: string }> };
  /** Where clips are cut before they are sent (removed afterwards). */
  workDir: string;
  /** How often to ask the centre. Default 10 s. */
  everyMs?: number;
  log?: Pick<Console, 'info' | 'warn'>;
}

export function createClipWorker(o: ClipWorkerOptions) {
  const log = o.log ?? console;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false, busy = false;
  const handled = new Set<string>();

  async function serve(r: ClipRequestForGateway): Promise<'sent' | 'failed' | 'skipped'> {
    if (handled.has(r.id)) return 'skipped';
    handled.add(r.id);
    const file = path.join(o.workDir, `${r.id}.mp4`);
    try {
      const from = new Date(r.from), to = new Date(r.to);
      const hold = await o.holds.add({ cameraId: r.cameraId, from, to, reason: `Central clip request ${r.id}: ${r.reason}`.slice(0, 300), by: `central-clip:${r.id}` });
      const clip = await makeClip(o.store, { cameraId: r.cameraId, from, to, outFile: file, maxSeconds: r.maxSeconds, hash: true });
      await o.agent.postClipDetails(r.id, { sha256: clip.sha256!, bytes: clip.bytes, actualFrom: clip.actualFrom, durationSec: clip.durationSec, segments: clip.segments, gaps: clip.gaps, holdId: hold.id });
      await o.agent.uploadClip(r.id, file, clip.sha256!, clip.bytes);
      log.info(`[GATEWAY] sent clip ${r.id} (${clip.bytes} bytes)`);
      return 'sent';
    } catch (e) {
      const message = e instanceof ClipError ? e.message : e instanceof Error ? e.message : String(e);
      log.warn(`[GATEWAY] clip ${r.id} failed: ${message}`);
      await o.agent.failClip(r.id, message).catch(() => handled.delete(r.id)); // if even that cannot be sent, a later round tries again
      return 'failed';
    } finally { await fs.unlink(file).catch(() => undefined); }
  }

  /** One round: ask, then serve what came, one at a time. Returns how many were sent. */
  async function tick(): Promise<number> {
    if (busy) return 0;
    busy = true;
    try {
      await fs.mkdir(o.workDir, { recursive: true });
      let sent = 0;
      for (const r of await o.agent.clipRequests()) if ((await serve(r)) === 'sent') sent++;
      return sent;
    } catch (e) { log.warn(`[GATEWAY] could not ask for clip requests: ${e instanceof Error ? e.message : e}`); return 0; }
    finally { busy = false; }
  }

  return {
    tick,
    start() {
      if (running) return;
      running = true;
      const loop = async () => { if (!running) return; await tick(); if (running) timer = setTimeout(loop, o.everyMs ?? 10_000); };
      timer = setTimeout(loop, 1000);
    },
    stop() { running = false; if (timer) clearTimeout(timer); },
  };
}
export type ClipWorker = ReturnType<typeof createClipWorker>;
