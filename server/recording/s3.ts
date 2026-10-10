/**
 * A small S3-compatible client (federation plan A15): AWS Signature V4, path-style or virtual-host addressing, and only the calls the
 * cold tier needs: put (streamed from a file), head, list (with continuation and delimiter), get (streamed to a file), delete.
 * It speaks the S3 protocol, so it works against Ceph RGW, MinIO and AWS S3. No SDK is used so the dependency stays out of the server.
 *
 * Verified: the signer reproduces the example in AWS's own Signature V4 documentation (tests/s3.test.ts) and the client runs against
 * an in-process S3 server that recomputes every signature (tests/lab/fakeS3.ts). NOT verified: a real Ceph/MinIO/AWS endpoint, TLS,
 * multipart upload (objects above 5 GB are refused here; a 10-minute segment is a few hundred megabytes), server-side encryption headers.
 */
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket in the path (`http://host/bucket/key`), which Ceph and MinIO expect. Default true. */
  pathStyle?: boolean;
  /** Prefix for every key, e.g. `recordings/`. */
  prefix?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export class S3Error extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'S3Error'; }
}

const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
export const EMPTY_SHA256 = sha256hex('');

/** RFC 3986 encoding as AWS wants it (`/` kept only in paths). */
export const awsEncode = (s: string, keepSlash = false) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%2F/g, keepSlash ? '/' : '%2F');

export interface SignInput {
  method: string;
  host: string;
  /** The URI path, already encoded as it will be sent. */
  path: string;
  query?: Record<string, string>;
  /** Extra headers to sign (lower-case names). `host`, `x-amz-date` and `x-amz-content-sha256` are added. */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

export function signV4(i: SignInput): { authorization: string; amzDate: string; signedHeaders: string; signature: string; headers: Record<string, string> } {
  const amzDate = i.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const service = i.service ?? 's3';
  const headers: Record<string, string> = { ...(i.headers ?? {}), host: i.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': i.payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.entries(i.query ?? {}).map(([k, v]) => [awsEncode(k), awsEncode(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [i.method, i.path, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadHash].join('\n');
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, amzDate, signedHeaders, signature, headers: lower };
}

export interface S3Object { key: string; size: number; lastModified: Date }
export interface S3Head { size: number; metadata: Record<string, string>; lastModified: Date | null }

const MAX_PUT = 5 * 1024 ** 3;

export function createS3Client(c: S3Config) {
  const f = c.fetch ?? fetch;
  const now = c.now ?? (() => new Date());
  const pathStyle = c.pathStyle ?? true;
  const base = new URL(c.endpoint);
  const prefix = c.prefix ?? '';
  const timeout = c.timeoutMs ?? 60_000;

  const host = pathStyle ? base.host : `${c.bucket}.${base.host}`;
  const objectPath = (key: string) => (pathStyle ? `/${awsEncode(c.bucket)}/${awsEncode(prefix + key, true)}` : `/${awsEncode(prefix + key, true)}`);
  const bucketPath = () => (pathStyle ? `/${awsEncode(c.bucket)}` : '/');

  async function call(method: string, path: string, o: { query?: Record<string, string>; headers?: Record<string, string>; payloadHash?: string; body?: BodyInit | null; length?: number; timeoutMs?: number } = {}) {
    const payloadHash = o.payloadHash ?? EMPTY_SHA256;
    const s = signV4({ method, host, path, query: o.query, headers: o.headers, payloadHash, region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, date: now() });
    const q = Object.entries(o.query ?? {}).map(([k, v]) => `${awsEncode(k)}=${awsEncode(v)}`).join('&');
    const url = `${base.protocol}//${base.host}${path}${q ? `?${q}` : ''}`;
    const headers: Record<string, string> = { ...s.headers, Authorization: s.authorization };
    delete headers.host; // set by fetch from the URL
    if (o.length !== undefined) headers['content-length'] = String(o.length);
    let res: Response;
    try { res = await f(url, { method, headers, body: o.body ?? undefined, signal: AbortSignal.timeout(o.timeoutMs ?? timeout), ...(o.body ? { duplex: 'half' } : {}) } as RequestInit); }
    catch (e) { throw new S3Error(`Could not reach the object store (${e instanceof Error ? (e.cause as Error | undefined)?.message ?? e.message : e}).`, 0); }
    return res;
  }

  async function fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = text.match(/<Code>([^<]*)<\/Code>/)?.[1];
    throw new S3Error(`${what} failed: HTTP ${res.status}${code ? ` ${code}` : ''}.`, res.status, code);
  }

  const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

  return {
    prefix,

    /** Uploads a file, streamed; the content hash is computed first because S3 wants it in the signature. */
    async put(key: string, file: string, o: { metadata?: Record<string, string>; contentType?: string } = {}): Promise<void> {
      const st = await fs.stat(file);
      if (st.size > MAX_PUT) throw new S3Error('The file is larger than a single upload allows (5 GB).', 400);
      const hash = createHash('sha256');
      await pipeline(createReadStream(file), async function* (src) { for await (const chunk of src) hash.update(chunk as Buffer); });
      const headers: Record<string, string> = { 'content-type': o.contentType ?? 'application/octet-stream' };
      for (const [k, v] of Object.entries(o.metadata ?? {})) headers[`x-amz-meta-${k.toLowerCase()}`] = v;
      const res = await call('PUT', objectPath(key), { headers, payloadHash: hash.digest('hex'), body: Readable.toWeb(createReadStream(file)) as unknown as BodyInit, length: st.size, timeoutMs: Math.max(timeout, 10 * 60_000) });
      if (!res.ok) await fail(res, `Uploading ${key}`);
      await res.arrayBuffer().catch(() => undefined);
    },

    async head(key: string): Promise<S3Head | null> {
      const res = await call('HEAD', objectPath(key));
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, `Reading ${key}`);
      const metadata: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (k.startsWith('x-amz-meta-')) metadata[k.slice('x-amz-meta-'.length)] = v; });
      const lm = res.headers.get('last-modified');
      return { size: Number(res.headers.get('content-length') ?? 0), metadata, lastModified: lm ? new Date(lm) : null };
    },

    /** Lists keys under `dir` (relative to the client's prefix), all pages. With `delimiter` also returns the sub-folders. */
    async list(dir: string, o: { delimiter?: boolean } = {}): Promise<{ objects: S3Object[]; folders: string[] }> {
      const objects: S3Object[] = [], folders: string[] = [];
      let token: string | undefined;
      for (let page = 0; page < 10_000; page++) {
        const query: Record<string, string> = { 'list-type': '2', prefix: prefix + dir };
        if (o.delimiter) query.delimiter = '/';
        if (token) query['continuation-token'] = token;
        const res = await call('GET', bucketPath(), { query });
        if (!res.ok) await fail(res, `Listing ${dir}`);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = unesc(m[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? '');
          if (!key.startsWith(prefix)) continue;
          objects.push({ key: key.slice(prefix.length), size: Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0), lastModified: new Date(m[1].match(/<LastModified>([^<]*)<\/LastModified>/)?.[1] ?? 0) });
        }
        for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>/g)) folders.push(unesc(m[1]).slice(prefix.length));
        if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) token = unesc(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? '') || undefined;
        else break;
        if (!token) break;
      }
      return { objects, folders };
    },

    /** Downloads an object to `dest` (written under a temporary name and renamed, so a broken download never looks complete). */
    async download(key: string, dest: string): Promise<number> {
      const res = await call('GET', objectPath(key), { timeoutMs: Math.max(timeout, 10 * 60_000) });
      if (res.status === 404) throw new S3Error(`${key} is not in the object store.`, 404, 'NoSuchKey');
      if (!res.ok || !res.body) await fail(res, `Downloading ${key}`);
      const tmp = `${dest}.${process.pid}.part`;
      try {
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
        const size = (await fs.stat(tmp)).size;
        const want = Number(res.headers.get('content-length') ?? size);
        if (size !== want) throw new S3Error(`Download of ${key} was cut short (${size} of ${want} bytes).`, 0);
        await fs.rename(tmp, dest);
        return size;
      } finally { await fs.unlink(tmp).catch(() => undefined); }
    },

    async remove(key: string): Promise<void> {
      const res = await call('DELETE', objectPath(key));
      if (!res.ok && res.status !== 404) await fail(res, `Deleting ${key}`);
      await res.arrayBuffer().catch(() => undefined);
    },
  };
}
export type S3Client = ReturnType<typeof createS3Client>;
