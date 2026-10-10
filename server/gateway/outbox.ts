/**
 * The gateway's store-and-forward queue: everything it wants the centre to record is appended here first, on disk, and removed only
 * after the centre confirms it. A dead link, a restart or a crash loses nothing; at worst items are sent twice, and the centre ignores
 * repeats because each item has a permanent unique id.
 *
 * Layout in `dir`: `state.json` ({ epoch, nextSeq }) and segment files `seg-00000001.jsonl` (one JSON item per line, at most `segmentBytes` each).
 * A closed segment whose items are all confirmed is deleted. Confirmations are not written to disk; after a restart, unconfirmed items in an
 * open segment are simply sent again.
 *
 * Limits: `maxBytes` and `maxAgeMs`. Over a limit the oldest closed segments are dropped (counted in `dropped`) so a long outage cannot fill the disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OutboxItem, OutboxKind } from './protocol';

export interface OutboxOptions {
  dir: string;
  segmentBytes?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
}

interface Entry { id: string; seg: number; offset: number; length: number; at: number; acked: boolean }
interface Segment { n: number; file: string; bytes: number; entries: Entry[]; open: boolean; acked: number }

export interface OutboxStats { pending: number; bytes: number; oldestAgeS: number; dropped: number; segments: number }

export interface Outbox {
  /** Adds an item; returns its id. Never throws for a full disk: the item is counted as dropped instead. */
  append(kind: OutboxKind, payload: unknown): string;
  /** The oldest unconfirmed items, up to `maxItems` and about `maxBytes` of JSON. */
  peek(maxItems: number, maxBytes?: number): OutboxItem[];
  /** Forgets confirmed (or permanently rejected) items. */
  ack(ids: string[]): void;
  stats(): OutboxStats;
  /** The id prefix of this outbox; changes only if the directory is wiped. */
  readonly epoch: string;
}

const pad = (n: number) => String(n).padStart(8, '0');

export function openOutbox(o: OutboxOptions): Outbox {
  const segmentBytes = o.segmentBytes ?? 1_000_000;
  const maxBytes = o.maxBytes ?? 200_000_000;
  const maxAgeMs = o.maxAgeMs ?? 7 * 24 * 3_600_000;
  const now = o.now ?? (() => Date.now());
  fs.mkdirSync(o.dir, { recursive: true });

  const statePath = path.join(o.dir, 'state.json');
  let state: { epoch: string; nextSeq: number } = { epoch: randomBytes(5).toString('hex'), nextSeq: 1 };
  try { const s = JSON.parse(fs.readFileSync(statePath, 'utf8')); if (typeof s.epoch === 'string' && Number.isInteger(s.nextSeq)) state = s; } catch { /* first start, or a damaged file: a new epoch keeps ids unique */ }
  const saveState = () => { try { fs.writeFileSync(statePath, JSON.stringify(state)); } catch { /* the next append retries */ } };

  const segments: Segment[] = [];
  const byId = new Map<string, Entry>();
  let dropped = 0;

  // ---- recovery: rebuild the index from the files left behind
  const files = fs.readdirSync(o.dir).filter((f) => /^seg-\d{8}\.jsonl$/.test(f)).sort();
  for (const f of files) {
    const n = Number(f.slice(4, 12));
    const file = path.join(o.dir, f);
    const buf = fs.readFileSync(file);
    const seg: Segment = { n, file, bytes: 0, entries: [], open: false, acked: 0 };
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break; // a last line without its newline is a write the crash cut short: ignore it
      try {
        const it = JSON.parse(buf.subarray(pos, nl).toString('utf8')) as OutboxItem;
        if (typeof it.id === 'string' && typeof it.at === 'number') { const e: Entry = { id: it.id, seg: n, offset: pos, length: nl - pos + 1, at: it.at, acked: false }; seg.entries.push(e); byId.set(it.id, e); }
      } catch { /* a damaged line is skipped, the rest of the file is still good */ }
      pos = nl + 1;
    }
    seg.bytes = buf.length;
    if (pos < buf.length) { try { fs.truncateSync(file, pos); seg.bytes = pos; } catch { /* leave it */ } } // drop the torn tail so new lines start cleanly
    segments.push(seg);
  }
  if (segments.length) segments[segments.length - 1].open = true;
  // Ids must never repeat, or the centre would discard a new item as one it has already applied. The saved counter can be a few hundred
  // appends behind after a crash, so continue from the highest id seen on disk or the saved counter, whichever is larger, plus a margin.
  const SAVE_EVERY = 500;
  const highest = Math.max(0, ...[...byId.keys()].map((id) => Number(id.slice(id.lastIndexOf('-') + 1))).filter(Number.isFinite));
  state.nextSeq = Math.max(state.nextSeq, highest + 1) + 2 * SAVE_EVERY;
  saveState();
  const nextSegNumber = () => (segments.length ? segments[segments.length - 1].n + 1 : 1);

  const totalBytes = () => segments.reduce((a, s) => a + s.bytes, 0);
  const pendingCount = () => segments.reduce((a, s) => a + s.entries.length - s.acked, 0);

  function dropSegment(seg: Segment, count: boolean) {
    if (count) dropped += seg.entries.length - seg.acked;
    for (const e of seg.entries) byId.delete(e.id);
    try { fs.unlinkSync(seg.file); } catch { /* already gone */ }
    segments.splice(segments.indexOf(seg), 1);
  }

  function enforceLimits() {
    // Oldest first, never the segment being written to.
    while (segments.length > 1 && (totalBytes() > maxBytes || (segments[0].entries.length && now() - segments[0].entries[0].at > maxAgeMs))) dropSegment(segments[0], true);
  }

  return {
    epoch: state.epoch,
    append(kind, payload) {
      const id = `${state.epoch}-${state.nextSeq++}`;
      const item: OutboxItem = { id, kind, at: now(), payload };
      const line = JSON.stringify(item) + '\n';
      const bytes = Buffer.byteLength(line);
      try {
        let seg = segments[segments.length - 1];
        if (!seg || seg.bytes + bytes > segmentBytes) {
          if (seg) seg.open = false;
          const n = nextSegNumber();
          seg = { n, file: path.join(o.dir, `seg-${pad(n)}.jsonl`), bytes: 0, entries: [], open: true, acked: 0 };
          segments.push(seg);
          saveState();
        }
        const offset = seg.bytes;
        fs.appendFileSync(seg.file, line);
        const e: Entry = { id, seg: seg.n, offset, length: bytes, at: item.at, acked: false };
        seg.entries.push(e); seg.bytes += bytes; byId.set(id, e);
        if (state.nextSeq % SAVE_EVERY === 0) saveState();
        enforceLimits();
      } catch {
        dropped++; // disk full or unwritable: the gateway keeps running, and the heartbeat reports the loss
      }
      return id;
    },

    peek(maxItems, maxBytesToRead = 512_000) {
      const out: OutboxItem[] = [];
      let size = 0;
      for (const seg of segments) {
        if (seg.acked === seg.entries.length) continue;
        let fd: number | null = null;
        try {
          for (const e of seg.entries) {
            if (e.acked) continue;
            if (out.length >= maxItems || (out.length > 0 && size + e.length > maxBytesToRead)) return out;
            fd ??= fs.openSync(seg.file, 'r');
            const buf = Buffer.alloc(e.length);
            fs.readSync(fd, buf, 0, e.length, e.offset);
            out.push(JSON.parse(buf.toString('utf8')) as OutboxItem);
            size += e.length;
          }
        } catch { /* a segment that cannot be read is skipped for now */ }
        finally { if (fd !== null) fs.closeSync(fd); }
      }
      return out;
    },

    ack(ids) {
      const touched = new Set<Segment>();
      for (const id of ids) {
        const e = byId.get(id);
        if (!e || e.acked) continue;
        e.acked = true;
        const seg = segments.find((s) => s.n === e.seg);
        if (seg) { seg.acked++; touched.add(seg); }
      }
      for (const seg of touched) if (!seg.open && seg.acked === seg.entries.length) dropSegment(seg, false);
      // An open segment that is fully confirmed and large is closed so it can be removed once the next one starts.
      const last = segments[segments.length - 1];
      if (last && last.acked === last.entries.length && last.entries.length > 0 && last.bytes >= segmentBytes / 2) { last.open = false; dropSegment(last, false); }
    },

    stats() {
      let first: Entry | undefined;
      for (const sg of segments) { if (sg.acked < sg.entries.length) { first = sg.entries.find((e) => !e.acked); break; } }
      return { pending: pendingCount(), bytes: totalBytes(), oldestAgeS: first ? Math.max(0, Math.round((now() - first.at) / 1000)) : 0, dropped, segments: segments.length };
    },
  };
}
