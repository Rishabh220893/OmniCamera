/**
 * Puts the analysis worker on a gateway. It is the same worker, pipeline and analyzers as at the centre; only where its inputs come from and
 * where its results go is different:
 *   cameras         the centre's assignment for this gateway (polled by the agent), not Firestore
 *   user context    fetched from the centre (known faces, watchlist), cached by the worker
 *   frames          captured here, next to the cameras
 *   logs, sightings, events, camera status     written to the outbox, sent to the centre when the link allows
 *   per-camera webhooks                        sent from here, directly
 */
import { createAnalysisWorker, type AnalysisWorker, type WorkerCamera, type WorkerDeps, type WorkerOptions } from '../analysisWorker';
import type { AnalyzerPipeline } from '../analytics';
import type { FrameGate } from '../frameGate';
import type { Agent } from './agent';
import type { Outbox } from './outbox';

export interface GatewayRuntimeDeps {
  agent: Agent;
  outbox: Outbox;
  pipeline: AnalyzerPipeline;
  /** Skips model calls for scenes that have not changed (optional). */
  gate?: FrameGate;
  grabFrame(camera: WorkerCamera): Promise<Buffer>;
  sendWebhook(url: string, payload: unknown): Promise<void>;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
  workerOptions?: Partial<WorkerOptions>;
  now?: () => number;
}

export interface GatewayRuntime {
  worker: AnalysisWorker;
  start(): void;
  stop(): void;
  /** For the heartbeat: how many cameras this gateway runs and how many are failing right now. */
  cameraCounts(): { assigned: number; failing: number };
}

export function createGatewayRuntime(d: GatewayRuntimeDeps): GatewayRuntime {
  const deps: WorkerDeps = {
    now: d.now ?? (() => Date.now()),
    subscribeCameras: (onChange) => d.agent.onCameras((cams) => onChange(cams as WorkerCamera[])),
    loadUserContext: (userId, departmentId) => d.agent.userContext(userId, departmentId),
    grabFrame: d.grabFrame,
    gate: d.gate,
    analyze: async ({ imageBase64, camera, knownFaces, watchlist }) => {
      const r = await d.pipeline.analyze({
        camera: { id: camera.id, name: camera.name, userId: camera.userId, department: camera.department, location: camera.location, sensitivity: camera.sensitivity, peopleThreshold: camera.peopleThreshold, vehicleThreshold: camera.vehicleThreshold, suspiciousRules: camera.suspiciousRules },
        frame: { jpeg: Buffer.from(imageBase64, 'base64'), base64: imageBase64 }, user: { knownFaces, watchlist }, now: new Date(),
      });
      return { ...r.result, events: r.events, analyzers: r.outcomes };
    },
    writeLog: async (doc) => { d.outbox.append('log', doc); },
    writeSightings: async (userId, sightings) => { if (sightings.length) d.outbox.append('sightings', { userId, sightings }); },
    emitEvents: async (events) => { d.outbox.append('events', events); },
    updateCamera: async (cameraId, patch) => { d.outbox.append('camera', { cameraId, patch }); },
    sendWebhook: d.sendWebhook,
    log: d.log,
  };
  const worker = createAnalysisWorker(deps, d.workerOptions);
  return {
    worker,
    start() { worker.start(); },
    stop() { worker.stop(); },
    cameraCounts() {
      const cams = worker.status().cameras;
      return { assigned: cams.length, failing: cams.filter((c) => c.failures > 0).length };
    },
  };
}
