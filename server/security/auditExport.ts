/**
 * Exporting the access log for an auditor (gap A21, docs/security-architecture.md). The log records who used which permission, and every refusal
 * (server/authz). An export is a document someone else will rely on, so it is **sealed**: its entries are hashed, and with a signing key the hash and the
 * period are signed, so a changed, added or removed entry is found by anyone with the public key (the same key and checks as evidence manifests).
 *
 * The export says how many entries it holds and whether the source was complete: the in-memory log keeps the newest 2,000 and the durable one (Firestore
 * `accessLog`) has everything that was saved, so an export from memory alone says it may be incomplete.
 */
import { createHash } from 'node:crypto';
import type { AccessLogEntry } from '../authz/authz';
import { canonical, signManifest, verifyManifest, type ManifestSignature, type SigningKey } from '../recording/evidence';

export interface AuditFilter { from?: Date; to?: Date; uid?: string; allowed?: boolean }

export interface AuditExport {
  generatedAt: string;
  generatedBy: string;
  period: { from: string | null; to: string | null };
  filter: { uid?: string; allowed?: boolean };
  count: number;
  /** SHA-256 of the entries, in the order listed (oldest first), as canonical JSON. */
  entriesSha256: string;
  /** Why this may not be everything (an in-memory source, a cap). Empty when it is as complete as the source can say. */
  caveats: string[];
  signature: ManifestSignature | null;
  entries: AccessLogEntry[];
}

export const entriesHash = (entries: AccessLogEntry[]): string => createHash('sha256').update(canonical(entries)).digest('hex');

export function filterEntries(entries: AccessLogEntry[], f: AuditFilter): AccessLogEntry[] {
  const from = f.from?.getTime() ?? -Infinity, to = f.to?.getTime() ?? Infinity;
  return entries.filter((e) => { const t = Date.parse(e.at); return t >= from && t < to && (f.uid === undefined || e.uid === f.uid) && (f.allowed === undefined || e.allowed === f.allowed); });
}

/** What is signed: everything about the export except the entries themselves (their hash stands for them). */
const signedPart = (d: Omit<AuditExport, 'signature' | 'entries'>) => d;

export function buildAuditExport(entries: AccessLogEntry[], o: { filter?: AuditFilter; by: string; signing?: SigningKey | null; now?: Date; caveats?: string[] }): AuditExport {
  const f = o.filter ?? {};
  const kept = filterEntries(entries, f).sort((a, b) => a.at.localeCompare(b.at));
  const now = o.now ?? new Date();
  const head: Omit<AuditExport, 'signature' | 'entries'> = {
    generatedAt: now.toISOString(), generatedBy: o.by, period: { from: f.from?.toISOString() ?? null, to: f.to?.toISOString() ?? null },
    filter: { ...(f.uid !== undefined ? { uid: f.uid } : {}), ...(f.allowed !== undefined ? { allowed: f.allowed } : {}) },
    count: kept.length, entriesSha256: entriesHash(kept), caveats: o.caveats ?? [],
  };
  return { ...head, signature: o.signing ? signManifest(signedPart(head), o.signing, now) : null, entries: kept };
}

export type AuditCheck = { ok: true } | { ok: false; why: string };

/** Checks an export, offline: the entries against their hash and count, and the signature (when given a public key) against the rest. */
export function verifyAuditExport(doc: AuditExport, publicPem?: string): AuditCheck {
  if (!Array.isArray(doc.entries)) return { ok: false, why: 'there are no entries' };
  if (doc.entries.length !== doc.count) return { ok: false, why: `it says ${doc.count} entries but holds ${doc.entries.length}` };
  if (entriesHash(doc.entries) !== doc.entriesSha256) return { ok: false, why: 'the entries do not match their hash: one was changed, added or removed' };
  if (publicPem) {
    if (!doc.signature) return { ok: false, why: 'it is not signed' };
    const { signature: _s, entries: _e, ...head } = doc;
    if (!verifyManifest(head, doc.signature, publicPem)) return { ok: false, why: 'the signature does not match (changed, or another key)' };
  }
  return { ok: true };
}

const cell = (v: unknown) => {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The entries as CSV (a spreadsheet cannot carry the signature; use the JSON export for evidence). */
export function auditCsv(entries: AccessLogEntry[]): string {
  const head = ['at', 'uid', 'role', 'source', 'permission', 'allowed', 'reason', 'method', 'path', 'department'];
  return [head, ...entries.map((e) => [e.at, e.uid, e.role, e.source, e.permission, e.allowed, e.reason, e.method, e.path, e.department])].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
