/**
 * Onboarding a camera that is not on the grid (federation plan A4): a device or recorder channel reached through an adapter
 * (ONVIF, Hikvision, Dahua, a plain RTSP address). One call does what used to be several by hand:
 *
 *   1. ask the adapter which RTSP stream the camera offers, and refuse early when a login would have to be stored and there is no key
 *   2. probe it through the adapter, and refuse a camera that is unreachable, refuses the login or sends no video (unless `force`)
 *   3. save the profile (the same one the grid's cameras have, so the recipe decision and the media paths work unchanged)
 *   4. remember the source: its address without a login, and the address the media server pulls, sealed with the login inside
 *   5. create the camera in the Registry, pointing at the media-server path, owned by the caller and given to a department if asked
 *
 * If a later step fails the earlier ones are undone, so a failed onboarding leaves nothing behind. Pure of Express and Firebase:
 * everything outside is injected.
 */
import { randomBytes } from 'node:crypto';
import { AdapterError, redactUrl, type AdapterRegistry, type CameraRef, type DeviceInfo, type NvrChannel, type StreamEndpoint } from '../adapters';
import type { ProbeReport, ProfileStore } from '../cameraProfile';
import { decide, type EncoderKind } from '../cameraRecipe';
import { saveReport } from '../profileService';
import { openSourceAddress } from './address';
import type { SecretBox } from './secretBox';
import { SOURCES_SITE, SOURCE_PATH_PREFIX, type SourceRecord, type SourceStore } from './store';

/** What the Registry needs to create the camera's document. */
export interface NewRegistryCamera {
  name: string;
  ownerUid: string;
  departmentId: string | null;
  adapter: string;
  /** The media-server path name; also the camera's id in profiles and sources. */
  sourceId: string;
  /** The camera's HLS address on the media server. Only its path is used to find the stream (the base can change). */
  streamUrl: string;
  device: DeviceInfo | null;
  location?: { lat: number; lng: number };
}

export interface RegistryWriter {
  create(cam: NewRegistryCamera): Promise<string>;
  remove(registryId: string): Promise<void>;
}

export interface OnboardDeps {
  adapters: AdapterRegistry;
  profiles: ProfileStore;
  sources: SourceStore;
  registry: RegistryWriter;
  /** null: no SOURCE_SECRET_KEY, so only cameras that need no login can be onboarded. */
  box: SecretBox | null;
  encoder: EncoderKind;
  /** The media server's public HLS base (MEDIA_SERVER_URL), '' when unknown. */
  mediaBase: () => string;
  newId?: () => string;
  now?: () => Date;
  log?: Pick<Console, 'warn' | 'info'>;
}

export interface OnboardInput {
  camera: CameraRef;
  name?: string;
  departmentId?: string | null;
  ownerUid: string;
  sampleSec?: number;
  /** Onboard although the probe failed or found no video (the camera is registered, with no playable path until it is probed again). */
  force?: boolean;
  location?: { lat: number; lng: number };
}

export type OnboardCode = 'bad_ref' | 'unsupported' | 'unreachable' | 'bad_credentials' | 'no_video' | 'no_key' | 'device' | 'store';

export type OnboardResult =
  | {
    ok: true; cameraId: string; registryId: string; adapter: string; name: string;
    recipe: string; reason: string; pathKind: 'pull' | 're-encode' | 'none'; warnings: string[]; device: DeviceInfo | null; flags: string[];
  }
  | { ok: false; code: OnboardCode; error: string; failure?: string | null; detail?: string | null };

const SECRET_KEY_NAME = /pass|secret|token|key|auth/i;

/** The adapter options minus anything that looks like a secret, for storing beside the source. */
function publicOptions(o: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!SECRET_KEY_NAME.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/** Which of the camera's RTSP streams to serve: the one `options.profile` or `options.stream` names, else the first (the main stream). */
export function pickRtsp(endpoints: StreamEndpoint[], ref: CameraRef): StreamEndpoint | null {
  const rtsp = endpoints.filter((e) => e.protocol === 'rtsp' && e.role === 'analysis');
  if (rtsp.length === 0) return null;
  const profile = typeof ref.options?.profile === 'string' ? ref.options.profile : null;
  if (profile) return rtsp.find((e) => e.label === profile) ?? rtsp[0];
  if (ref.options?.stream === 'sub') return rtsp.find((e) => /sub/i.test(e.label ?? '')) ?? rtsp[0];
  return rtsp[0];
}

const hasLogin = (url: string) => /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(url);

export function pathKindOf(recipe: string, transcode: boolean): 'pull' | 're-encode' | 'none' {
  return recipe === 'F' || recipe === 'G' || recipe === 'E' ? 'none' : transcode ? 're-encode' : 'pull';
}

const FAILURE_TEXT: Record<string, { code: OnboardCode; text: string }> = {
  unreachable: { code: 'unreachable', text: 'The camera cannot be reached from this server' },
  bad_credentials: { code: 'bad_credentials', text: 'The camera refused the login' },
  no_describe: { code: 'no_video', text: 'The camera answered but did not describe a video stream' },
  no_frame: { code: 'no_video', text: 'The camera answered but sent no picture' },
};

export function createOnboarding(deps: OnboardDeps) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => `${SOURCE_PATH_PREFIX}${randomBytes(6).toString('hex')}`);
  const log = deps.log ?? console;

  const streamUrlFor = (id: string) => {
    const base = deps.mediaBase().replace(/\/+$/, '');
    return `${base || 'https://media.invalid'}/${id}/index.m3u8`;
  };

  async function onboardOne(input: OnboardInput): Promise<OnboardResult> {
    // 1. which stream, and can its login be kept?
    let adapter;
    let ref: CameraRef;
    let endpoint: StreamEndpoint | null;
    try {
      ref = input.camera;
      adapter = deps.adapters.resolve(ref);
      endpoint = pickRtsp(await adapter.endpoints(ref), ref);
    } catch (e) {
      if (e instanceof AdapterError) return { ok: false, code: e.code === 'bad_ref' || e.code === 'no_adapter' ? 'bad_ref' : e.code === 'unsupported' ? 'unsupported' : 'device', error: e.message };
      throw e;
    }
    if (!endpoint) return { ok: false, code: 'unsupported', error: `'${adapter.kind}' gives no RTSP stream, and the media server can only serve RTSP sources for now.` };
    const needsKey = hasLogin(endpoint.url);
    if (needsKey && !deps.box) return { ok: false, code: 'no_key', error: 'This camera needs a login, and logins are only stored when SOURCE_SECRET_KEY is set on the server. Set it (64 hex characters) and try again.' };

    // 2. probe
    const id = newId();
    let report: ProbeReport;
    try { report = await adapter.probe({ ...ref, id, site: SOURCES_SITE }, { sampleSec: input.sampleSec }); }
    catch (e) {
      if (e instanceof AdapterError) return { ok: false, code: 'device', error: e.message };
      throw e;
    }
    const decision = decide(report, { encoder: deps.encoder });
    const noVideo = decision.recipe === 'F' || decision.recipe === 'G';
    if ((report.failure || noVideo) && !input.force) {
      const f = report.failure ? FAILURE_TEXT[report.failure] : null;
      return {
        ok: false, code: f?.code ?? 'no_video', failure: report.failure, detail: report.failureDetail,
        error: `${f?.text ?? 'No usable video from this camera'}${report.failureDetail ? `: ${report.failureDetail}` : ''}. Nothing was added. Fix that, or add it anyway with "force".`,
      };
    }

    // 3-5. keep it; undo what was kept if a later step fails
    const warnings: string[] = [];
    let device: DeviceInfo | null = null;
    if (adapter.deviceInfo) { try { device = await adapter.deviceInfo(ref); } catch { warnings.push('Make and model could not be read from the device.'); } }
    const name = (input.name?.trim() || ref.name?.trim() || device?.model || id).slice(0, 120);
    const at = now().toISOString();
    const rec: SourceRecord = {
      site: SOURCES_SITE, cameraId: id, adapter: adapter.kind, name,
      ref: { host: ref.host, port: ref.port, url: ref.url ? redactUrl(ref.url) : undefined, options: publicOptions(ref.options) },
      sealed: deps.box ? deps.box.seal(JSON.stringify({ rtspUrl: endpoint.url })) : null,
      registryId: null, ownerUid: input.ownerUid, departmentId: input.departmentId ?? null, createdAt: at, updatedAt: at,
    };
    if (!deps.box) rec.sealed = JSON.stringify({ rtspUrl: endpoint.url }); // no login in it (checked above): nothing secret to protect
    let profileSaved = false, sourceSaved = false, registryId: string | null = null;
    try {
      await saveReport(deps.profiles, report, deps.encoder);
      profileSaved = true;
      await deps.sources.put(rec);
      sourceSaved = true;
      registryId = await deps.registry.create({
        name, ownerUid: input.ownerUid, departmentId: input.departmentId ?? null, adapter: adapter.kind, sourceId: id,
        streamUrl: streamUrlFor(id), device, location: input.location,
      });
      await deps.sources.put({ ...rec, registryId });
    } catch (e) {
      log.warn(`[SOURCES] onboarding ${id} failed, undoing: ${e instanceof Error ? e.message : e}`);
      if (registryId) await deps.registry.remove(registryId).catch(() => undefined);
      if (sourceSaved) await deps.sources.remove(SOURCES_SITE, id).catch(() => undefined);
      if (profileSaved) await deps.profiles.removeProfile?.(SOURCES_SITE, id).catch(() => undefined);
      return { ok: false, code: 'store', error: `The camera was reachable but could not be saved: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!deps.mediaBase()) warnings.push('MEDIA_SERVER_URL is not set, so tiles cannot play this camera until the media server is configured.');
    if (report.failure || noVideo) warnings.push('Added anyway: it has no playable path until a probe succeeds.');
    return {
      ok: true, cameraId: id, registryId, adapter: adapter.kind, name, recipe: decision.recipe, reason: decision.reason,
      pathKind: pathKindOf(decision.recipe, decision.transcode), warnings, device, flags: report.flags,
    };
  }

  /** Probes a camera again from its stored address and refreshes its profile (and so its recipe). */
  async function reprobe(cameraId: string, sampleSec?: number): Promise<{ ok: true; recipe: string; failure: string | null } | { ok: false; error: string }> {
    const rec = await deps.sources.get(SOURCES_SITE, cameraId);
    if (!rec) return { ok: false, error: 'No such source.' };
    const rtsp = deps.adapters.get('rtsp');
    if (!rtsp) return { ok: false, error: 'The rtsp adapter is not available.' };
    const url = openSourceAddress(rec, deps.box).rtspUrl;
    const report = await rtsp.probe({ id: cameraId, url, site: SOURCES_SITE }, { sampleSec });
    await saveReport(deps.profiles, report, deps.encoder);
    return { ok: true, recipe: decide(report, { encoder: deps.encoder }).recipe, failure: report.failure };
  }

  /** Lists a recorder's channels as the routes show them. */
  async function channelsOf(camera: CameraRef): Promise<{ adapter: string; channels: NvrChannel[] }> {
    const a = deps.adapters.resolve(camera);
    if (!a.channels) throw new AdapterError(`'${a.kind}' is not a recorder adapter and has no channel list.`, 'unsupported');
    return { adapter: a.kind, channels: await a.channels(camera) };
  }

  /** Takes a camera out: its Registry entry, its source and its profile. The media path goes at the next apply. */
  async function remove(cameraId: string): Promise<boolean> {
    const rec = await deps.sources.get(SOURCES_SITE, cameraId);
    if (!rec) return false;
    if (rec.registryId) await deps.registry.remove(rec.registryId);
    await deps.sources.remove(SOURCES_SITE, cameraId);
    await deps.profiles.removeProfile?.(SOURCES_SITE, cameraId);
    return true;
  }

  return { onboardOne, reprobe, channelsOf, remove };
}

export type Onboarding = ReturnType<typeof createOnboarding>;

/** The camera ref for one recorder channel, and the name the camera gets. */
export function channelCamera(recorder: CameraRef, c: NvrChannel, namePrefix?: string): { camera: CameraRef; name: string } {
  const { credentials, ...rest } = recorder;
  return {
    camera: { ...rest, credentials, id: recorder.id, options: { ...recorder.options, channel: c.channel } },
    name: `${(namePrefix ?? recorder.name ?? recorder.id).trim()} - ${c.name?.trim() || `Channel ${c.channel}`}`.slice(0, 120),
  };
}
