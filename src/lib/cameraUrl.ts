const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal)$/i;

/**
 * The worker fetches URLs that users stored in their camera records, so
 * obvious internal targets are refused (loopback, link-local/metadata,
 * RFC1918 literals). Hostname-level only — it does not defend against DNS
 * that later resolves to a private address.
 */
export function isSafeCameraUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (!['http:', 'https:', 'rtsp:'].includes(url.protocol)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_RE.test(host)) return false;
  if (host === '::1' || host.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/i.test(host)) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}
