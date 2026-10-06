/**
 * A browser opens at most 6 connections per host over HTTP/1.1, and a local media server (plain http://localhost)
 * speaks nothing newer. Ten cameras each polling a playlist and fetching a segment every second queue behind those
 * 6 connections: the cameras that started first keep them busy and the rest wait (a HAR showed waits of up to
 * 37 s, then aborted requests). `<name>.localhost` resolves to this machine in every major browser, so giving each
 * camera its own such host gives each camera its own set of 6 connections, with no change to the server.
 * Other addresses (an https media server behind a proxy speaks HTTP/2 and has no such limit) are left alone.
 */
export function shardedMediaBase(hlsUrl: string, camId: string): string {
  const base = (hlsUrl || '').replace(/\/+$/, '');
  try {
    const u = new URL(base);
    if (u.hostname === 'localhost' && /^[a-z0-9_-]{1,64}$/i.test(camId)) {
      u.hostname = `${camId.toLowerCase()}.localhost`;
      return u.toString().replace(/\/+$/, '');
    }
  } catch { /* not a URL: use it as given */ }
  return base;
}
