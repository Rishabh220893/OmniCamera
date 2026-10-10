/**
 * The contract between OmniSee and a kind of camera source (docs/adapters.md).
 * An adapter knows how to find devices of its kind, work out which streams a camera offers, and probe one. Everything
 * else (profiles, recipes, media-server config, analysis) works from the ProbeReport and endpoints it returns, so a new
 * source type is one new file that registers itself in `server/adapters/index.ts`.
 */
import type { ProbeReport } from '../cameraProfile';

export type EndpointProtocol = 'rtsp' | 'whep' | 'hls' | 'mjpeg' | 'snapshot';

/** What a stream is for: `analysis` is pulled by the server (needs a real decoder path), `browser` is shown to people. */
export type EndpointRole = 'analysis' | 'browser' | 'snapshot';

export interface StreamEndpoint {
  protocol: EndpointProtocol;
  role: EndpointRole;
  /** May contain credentials when it is an RTSP URL built for the server; never store or log it as is (use `redactUrl`). */
  url: string;
  /** Adapter-specific label, e.g. an ONVIF profile name. */
  label?: string;
  width?: number | null;
  height?: number | null;
  codec?: string | null;
}

export interface Credentials { user: string; pass: string }

/** How a camera is addressed. Only `id` is always set; each adapter reads the fields it understands. */
export interface CameraRef {
  id: string;
  name?: string;
  /** Names the adapter explicitly (`onvif`, `grid-rtsp`, ...). Without it the first adapter whose `accepts` is true is used. */
  adapter?: string;
  /** A stream URL (rtsp://, http(s)://...m3u8, ...mjpeg) or, for ONVIF, the device service address. */
  url?: string;
  host?: string;
  port?: number;
  credentials?: Credentials;
  /** The site this camera belongs to; goes into its ProbeReport. */
  site?: string;
  /** Adapter-specific settings (e.g. the grid's RTSP path prefix). */
  options?: Record<string, unknown>;
}

export interface DiscoveredDevice {
  adapter: string;
  /** IP address the device answered from. */
  address: string;
  /** Where to talk to it (ONVIF device service URLs). */
  serviceUrls: string[];
  name?: string;
  hardware?: string;
  manufacturer?: string;
  /** Raw scope or type strings the device announced, kept so the Registry can show what it said. */
  scopes: string[];
}

export interface DeviceInfo {
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  serial: string | null;
  hardwareId: string | null;
}

/** One camera input on a recorder (NVR/DVR/encoder). `channel` is the number the recorder uses in its stream addresses. */
export interface NvrChannel {
  channel: number;
  name: string | null;
  /** True/false when the recorder reports the camera as connected; null when it does not say (analog inputs, older firmware). */
  online: boolean | null;
  /** The IP address of the camera behind an NVR channel, when the recorder reports one. */
  address: string | null;
}

export interface ProbeOptions {
  sampleSec?: number;
  /** Fallback for cameras that carry no credentials of their own. */
  credentials?: Credentials;
}

export interface DiscoverOptions {
  timeoutMs?: number;
  /** Network interface address to send from; default is the system's choice. */
  iface?: string;
}

export interface SourceAdapter {
  /** Stable machine name, stored on camera records. */
  readonly kind: string;
  readonly label: string;
  /** Short statement of what it can and cannot do, shown in the Registry. */
  readonly description: string;
  /** True when this adapter can handle the camera (used only when `ref.adapter` is unset). */
  accepts(ref: CameraRef): boolean;
  /** Finds devices on the local network or from a directory. Optional: not every source type can be discovered. */
  discover?(opts?: DiscoverOptions): Promise<DiscoveredDevice[]>;
  /** Reads make, model and firmware from the device. Optional. */
  deviceInfo?(ref: CameraRef): Promise<DeviceInfo>;
  /** Lists the cameras behind a recorder so a whole NVR can be onboarded at once. Optional: only recorder adapters have it. */
  channels?(ref: CameraRef): Promise<NvrChannel[]>;
  /** The streams this camera offers. */
  endpoints(ref: CameraRef): Promise<StreamEndpoint[]>;
  /** Measures the camera; the result goes through the same profile, recipe and media-plan code as every other source. */
  probe(ref: CameraRef, opts?: ProbeOptions): Promise<ProbeReport>;
}

export class AdapterError extends Error {
  constructor(message: string, readonly code: 'no_adapter' | 'bad_ref' | 'unsupported' | 'device' = 'device') {
    super(message);
    this.name = 'AdapterError';
  }
}

/** Removes the user and password from a URL so it can be logged or stored. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1***@');
}
