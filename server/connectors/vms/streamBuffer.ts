/**
 * A bounded buffer that gives a PUSH-style event feed (a connection the device holds open and writes events to) the cursor semantics the
 * runner expects from `VmsConnector.events(cursor, limit)`. The connector pushes events in; the runner reads them out page by page.
 *
 * Cursors look like `<epoch>:<seq>`. `epoch` is chosen when the buffer is created, so a cursor saved before a server restart is recognised as
 * from another life of the buffer: a push feed has no history to replay, so the reader simply starts from now (events during the downtime were
 * never delivered to anyone; this is the nature of such feeds and is stated in docs/connectors-vms.md). Within one life, a reader that falls
 * more than `capacity` events behind loses the oldest ones; `dropped` counts them so it is visible, not silent.
 */
import { randomUUID } from 'node:crypto';
import type { EventPage, VmsEvent } from './types';

export interface StreamBuffer {
  push(ev: VmsEvent): void;
  read(cursor: string | null, limit: number): EventPage;
  /** Events thrown away because nobody read them in time. */
  dropped(): number;
  size(): number;
}

export function createStreamBuffer(o: { capacity?: number; epoch?: string } = {}): StreamBuffer {
  const capacity = Math.max(10, o.capacity ?? 5000);
  const epoch = o.epoch ?? randomUUID().slice(0, 8);
  const items: Array<{ seq: number; ev: VmsEvent }> = [];
  let seq = 0, dropped = 0;
  const cursorAt = (n: number) => `${epoch}:${n}`;

  return {
    push(ev) {
      items.push({ seq: ++seq, ev });
      while (items.length > capacity) { items.shift(); dropped++; }
    },
    read(cursor, limit) {
      const m = cursor?.match(/^([^:]+):(\d+)$/);
      // No cursor (first time) or one from an earlier life of the buffer: nothing before now was ever delivered to this reader.
      if (!m || m[1] !== epoch) return { events: [], cursor: cursorAt(seq), more: false };
      const after = Number(m[2]);
      const out = items.filter((i) => i.seq > after).slice(0, Math.max(1, limit));
      const last = out.length ? out[out.length - 1].seq : Math.max(after, 0);
      return { events: out.map((i) => i.ev), cursor: cursorAt(Math.max(last, after)), more: items.length > 0 && items[items.length - 1].seq > last };
    },
    dropped: () => dropped,
    size: () => items.length,
  };
}
