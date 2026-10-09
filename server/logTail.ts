/**
 * Follows a log file as it grows and hands each new line to a callback. Starts at the END of the file (history is not replayed,
 * so a restart of the app does not re-judge old crashes), notices when the file is replaced or truncated and starts again from
 * its top, and never reads a half-written last line.
 */
import { open, stat } from 'node:fs/promises';

export interface LogTail {
  stop(): void;
  /** Reads what has been appended since the last poll (exposed so tests do not wait on the timer). */
  poll(): Promise<void>;
  /** The last problem reading the file, or null. */
  error(): string | null;
}

export function tailFile(file: string, onLine: (line: string) => void, intervalMs = 2000): LogTail {
  let offset: number | null = null; // null = not yet positioned at the end
  let ino: number | string | null = null;
  let carry = '';
  let lastError: string | null = null;
  let inflight: Promise<void> | null = null;

  /** One read at a time; a caller that arrives while one is running waits for it, then reads whatever arrived since. */
  async function poll(): Promise<void> {
    while (inflight) await inflight;
    inflight = read();
    try { await inflight; } finally { inflight = null; }
  }

  async function read() {
    try {
      const st = await stat(file);
      if (offset === null) { offset = st.size; ino = st.ino; lastError = null; return; }
      if (st.ino !== ino || st.size < offset) { offset = 0; ino = st.ino; carry = ''; } // replaced or truncated
      if (st.size > offset) {
        const fh = await open(file, 'r');
        try {
          const len = st.size - offset;
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, offset);
          offset += bytesRead;
          const text = carry + buf.subarray(0, bytesRead).toString('utf8');
          const lines = text.split('\n');
          carry = lines.pop() ?? '';
          for (const l of lines) if (l) onLine(l);
        } finally { await fh.close(); }
      }
      lastError = null;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      offset = null; // the file may appear later; start from its end again when it does
    }
  }

  void poll();
  const timer = setInterval(() => { void poll(); }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), poll, error: () => lastError };
}
