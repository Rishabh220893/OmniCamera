export interface NotificationPrefs {
  criticalAlerts: boolean;
  systemStatus: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

export interface UserPreferences {
  theme: 'light' | 'dark';
  notificationPrefs: NotificationPrefs;
  googleSheetsId?: string;
  /** Shared CDN/stream access password sent (HTTP Basic Auth) to
   *  password-protected remote feed hosts. This is used directly by the
   *  browser to reach the camera CDN — it is not, and cannot be, proxied
   *  through the server the way other secrets in this app are. */
  streamAccessPassword?: string;
  /** Registered email for grids whose direct RTSP/WebRTC endpoints
   *  authenticate as email:password (HTTP Basic auth, email as username) —
   *  a separate credential from streamAccessPassword's password-only HLS
   *  scheme. */
  streamAccessEmail?: string;
  /** Pilot-scale RBAC stand-in — a Firestore field checked by firestore.rules,
   *  not a real custom-claims/OIDC role. See Sentinel Mesh roadmap for the
   *  production version of this. */
  department?: string;
  role?: 'operator' | 'admin';
}

export type ConnectivityStatus = 'online' | 'offline' | 'degraded' | 'unknown';
export type MaintenanceStatus = 'operational' | 'needs_maintenance' | 'decommissioned';
export type CameraType = 'fixed' | 'ptz' | 'dome' | 'bullet' | 'other';

export interface CameraConfig {
  id: string;
  name: string;
  peopleThreshold: number;
  vehicleThreshold: number;
  sensitivity: number;
  interval: number;
  webhookUrl: string;
  useRemoteFeed: boolean;
  remoteStreamUrl: string;
  facingMode: "user" | "environment";
  lastAnalysisTime?: Date;
  suspiciousRules: string;
  useSimulatedFeed?: boolean;

  /** Central Registry fields (Sentinel Mesh Model 1 — mandatory foundation).
   *  Each camera is its own document in the top-level `cameras` collection,
   *  not an array field on the user doc, so it can be onboarded in bulk,
   *  via the registry API, and audited independently of the live app. */
  location?: { lat: number; lng: number };
  department?: string;
  ownership?: string;
  cameraType?: CameraType;
  connectivityStatus?: ConnectivityStatus;
  maintenanceStatus?: MaintenanceStatus;
  installDate?: string; // ISO date string, e.g. "2022-04-01"
  storageDetails?: string;
  /** How the record entered the registry — surfaced in the audit trail. */
  onboardedVia?: 'manual' | 'bulk_import' | 'api';
}

export type LogSentiment = 'calm' | 'neutral' | 'tense' | 'critical';

export interface LogEntry {
  id: string;
  cameraId: string;
  cameraName: string;
  timestamp: Date;
  summary: string;
  counts: { people: number; vehicles: number; other: number };
  isUnusual: boolean;
  unusualReason?: string;
  alerts: string[];
  /** Overall mood/threat read of the scene, from Gemini — display-only,
   *  independent of isUnusual/alerts (a calm scene can still cross a count
   *  threshold, which is no longer itself grounds for an alert). */
  sentiment?: LogSentiment;
  /** Plate-tracking fields (Sentinel Mesh Model 4 pull, single-tier stand-in). */
  detectedPlates?: string[];
  isWatchlistMatch?: boolean;
}

export interface KnownFace {
  id: string;
  name: string;
  imageData: string; // base64
}

export interface WatchlistEntry {
  id: string;
  plate: string;
  reason: string;
  addedBy: string;
  createdAt: Date;
}

export type AuditAction = 'create' | 'update' | 'delete';

export interface RegistryAuditEntry {
  id: string;
  cameraId: string;
  cameraName: string;
  action: AuditAction;
  source: 'manual' | 'bulk_import' | 'api';
  performedBy: string;
  timestamp: Date;
}

export interface RoutePoint { lat: number; lng: number; label: string; timestamp: Date; }

export type TabId = 'monitor' | 'analytics' | 'settings' | 'map' | 'guide';

/** DOM nodes a focused CameraFeed instance exposes so the capture/analysis
 *  loop in App.tsx can draw the current frame without owning the refs itself. */
export interface CameraMediaRefs {
  video: HTMLVideoElement | null;
  img: HTMLImageElement | null;
  canvas: HTMLCanvasElement | null;
}
