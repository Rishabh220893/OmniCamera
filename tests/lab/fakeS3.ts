/**
 * An in-process S3-compatible server for testing the cold tier without Ceph/MinIO/AWS. It does what a real one does that matters here:
 * checks the Signature V4 on every request (recomputed from the request, against the access key it knows), checks the body against the
 * declared payload hash, refuses a clock more than 15 minutes off, stores user metadata, lists with prefix / delimiter / paging, and can
 * be told to fail. Path-style addressing only. Not a model of any vendor's quirks.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { awsEncode, signV4 } from '../../server/recording/s3.ts';

export interface FakeS3 {
  url: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  objects: Map<string, { body: Buffer; meta: Record<string, string>; modified: Date }>;
  requests: string[];
  failNext(count: number, status?: number): void;
  setPageSize(n: number): void;
  skewClockBy(ms: number): void;
  close(): Promise<void>;
}

export async function startFakeS3(o: { bucket?: string; accessKeyId?: string; secretAccessKey?: string; region?: string } = {}): Promise<FakeS3> {
  const bucket = o.bucket ?? 'recordings', accessKeyId = o.accessKeyId ?? 'TESTKEY123', secretAccessKey = o.secretAccessKey ?? 'testsecret/with+chars', region = o.region ?? 'us-east-1';
  const objects = new Map<string, { body: Buffer; meta: Record<string, string>; modified: Date }>();
  const s = { fail: 0, status: 503, pageSize: 1000, skew: 0 };
  const fake = { url: '', bucket, accessKeyId, secretAccessKey, objects, requests: [] as string[] } as FakeS3;

  const xml = (res: http.ServerResponse, status: number, body: string) => { res.writeHead(status, { 'Content-Type': 'application/xml' }); res.end(body); };
  const err = (res: http.ServerResponse, status: number, code: string, msg: string) => xml(res, status, `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${msg}</Message></Error>`);

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    try { for await (const c of req) chunks.push(c as Buffer); } catch { return; }
    const body = Buffer.concat(chunks);
    const u = new URL(req.url ?? '/', 'http://x');
    fake.requests.push(`${req.method} ${u.pathname}${u.search}`);
    if (s.fail > 0) { s.fail--; return err(res, s.status, 'InternalError', 'injected'); }

    // ---- signature ----
    const auth = req.headers.authorization ?? '';
    const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
    if (!m) return err(res, 403, 'AccessDenied', 'missing or malformed Authorization');
    if (m[1] !== accessKeyId) return err(res, 403, 'InvalidAccessKeyId', 'unknown key');
    const amzDate = String(req.headers['x-amz-date'] ?? '');
    const when = Date.parse(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    if (Number.isNaN(when) || Math.abs(Date.now() + s.skew - when) > 15 * 60_000) return err(res, 403, 'RequestTimeTooSkewed', 'clock skew');
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    const headers: Record<string, string> = {};
    for (const h of m[4].split(';')) if (h !== 'host' && h !== 'x-amz-date' && h !== 'x-amz-content-sha256') headers[h] = String(req.headers[h] ?? '');
    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => { query[k] = v; });
    const want = signV4({ method: req.method ?? 'GET', host: String(req.headers.host), path: u.pathname, query, headers, payloadHash, region, accessKeyId, secretAccessKey, date: new Date(when) });
    if (want.signature !== m[5]) return err(res, 403, 'SignatureDoesNotMatch', 'the signature does not match');
    if (req.method === 'PUT' && createHash('sha256').update(body).digest('hex') !== payloadHash) return err(res, 400, 'XAmzContentSHA256Mismatch', 'body does not match its hash');

    // ---- routing (path style) ----
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== bucket) return err(res, 404, 'NoSuchBucket', 'no such bucket');
    const key = parts.slice(1).join('/');

    if (!key && req.method === 'GET') {
      const prefix = query.prefix ?? '', delimiter = query.delimiter;
      const start = query['continuation-token'] ? Number(Buffer.from(query['continuation-token'], 'base64').toString()) : 0;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const contents: string[] = [], prefixes = new Set<string>();
      const entries: Array<{ k: string; folder?: string }> = [];
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const i = delimiter ? rest.indexOf(delimiter) : -1;
        if (i >= 0) { const folder = prefix + rest.slice(0, i + 1); if (!prefixes.has(folder)) { prefixes.add(folder); entries.push({ k, folder }); } } else entries.push({ k });
      }
      const slice = entries.slice(start, start + s.pageSize);
      for (const e of slice) if (!e.folder) { const ob = objects.get(e.k)!; contents.push(`<Contents><Key>${e.k.replace(/&/g, '&amp;')}</Key><LastModified>${ob.modified.toISOString()}</LastModified><Size>${ob.body.length}</Size></Contents>`); }
      const folders = slice.filter((e) => e.folder).map((e) => `<CommonPrefixes><Prefix>${e.folder}</Prefix></CommonPrefixes>`);
      const more = start + s.pageSize < entries.length;
      return xml(res, 200, `<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${Buffer.from(String(start + s.pageSize)).toString('base64')}</NextContinuationToken>` : ''}${contents.join('')}${folders.join('')}</ListBucketResult>`);
    }
    if (req.method === 'PUT') {
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = String(v);
      objects.set(key, { body, meta, modified: new Date() });
      res.writeHead(200, { ETag: `"${createHash('md5').update(body).digest('hex')}"` }); return void res.end();
    }
    const ob = objects.get(key);
    if (req.method === 'HEAD') {
      if (!ob) { res.writeHead(404); return void res.end(); }
      const h: Record<string, string> = { 'Content-Length': String(ob.body.length), 'Last-Modified': ob.modified.toUTCString() };
      for (const [k, v] of Object.entries(ob.meta)) h[`x-amz-meta-${k}`] = v;
      res.writeHead(200, h); return void res.end();
    }
    if (req.method === 'GET') {
      if (!ob) return err(res, 404, 'NoSuchKey', 'no such key');
      res.writeHead(200, { 'Content-Length': String(ob.body.length), 'Content-Type': 'application/octet-stream' });
      return void res.end(ob.body);
    }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return void res.end(); }
    return err(res, 405, 'MethodNotAllowed', 'unsupported');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(fake, {
    failNext(n: number, status = 503) { s.fail = n; s.status = status; },
    setPageSize(n: number) { s.pageSize = n; },
    skewClockBy(ms: number) { s.skew = ms; },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  });
  void awsEncode;
  return fake;
}
