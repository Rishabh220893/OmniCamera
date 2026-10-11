/**
 * A tiny SMTP server and a tiny SMS gateway that only record what they are sent, for tests and for `npm run alert-sandbox`
 * (trying the e-mail and SMS alert channels without a real provider). The SMTP server speaks just enough of the protocol for nodemailer
 * (no TLS, no login); the SMS gateway has the shape the platform's SMS channel expects: POST { to, from?, message } with a Bearer token.
 */
import net from 'node:net';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenMail { from: string; to: string[]; subject: string; text: string }
export interface SeenSms { to: string; from?: string; message: string }

export async function startFakeSmtp(port = 0): Promise<{ port: number; mails: SeenMail[]; close(): Promise<void> }> {
  const mails: SeenMail[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock); sock.on('close', () => sockets.delete(sock)); sock.on('error', () => {});
    let from = '', rcpt: string[] = [], inData = false, data = '', buf = '';
    const say = (s: string) => sock.write(s + '\r\n');
    say('220 fake-smtp ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return; // keep buffering until the end-of-data marker has arrived
          data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
          const [head, ...rest] = data.split('\r\n\r\n');
          const h = (n: string) => new RegExp(`^${n}:\\s*(.*)$`, 'im').exec(head)?.[1]?.trim() ?? '';
          const rawBody = rest.join('\r\n\r\n');
          // nodemailer may send the text quoted-printable or base64; decode the two common cases.
          const enc = h('Content-Transfer-Encoding').toLowerCase();
          const text = enc === 'base64' ? Buffer.from(rawBody.replace(/\s+/g, ''), 'base64').toString('utf8') : enc === 'quoted-printable' ? rawBody.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))) : rawBody;
          mails.push({ from, to: rcpt, subject: decodeHeader(h('Subject')), text: text.replace(/\r\n/g, '\n').trim() });
          data = ''; rcpt = []; say('250 queued'); continue;
        }
        const nl = buf.indexOf('\r\n'); if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') { sock.write('250-fake-smtp\r\n250 8BITMIME\r\n'); }
        else if (cmd === 'MAIL') { from = /<([^>]*)>/.exec(line)?.[1] ?? ''; say('250 ok'); }
        else if (cmd === 'RCPT') { rcpt.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); say('250 ok'); }
        else if (cmd === 'DATA') { inData = true; data = ''; say('354 go ahead'); }
        else if (cmd === 'RSET' || cmd === 'NOOP') say('250 ok');
        else if (cmd === 'QUIT') { say('221 bye'); sock.end(); return; }
        else say('250 ok');
      }
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, mails, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

function decodeHeader(v: string): string {
  return v.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, kind: string, body: string) => kind.toLowerCase() === 'b' ? Buffer.from(body, 'base64').toString('utf8') : body.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/g, (_m, x) => String.fromCharCode(parseInt(x, 16))));
}

export async function startFakeSmsGateway(token = 'test-token', port = 0): Promise<{ url: string; messages: SeenSms[]; refused: number; close(): Promise<void> }> {
  const messages: SeenSms[] = [];
  const state = { refused: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) { state.refused++; res.writeHead(401).end('{"error":"bad token"}'); return; }
      try { const j = JSON.parse(body); if (typeof j.to !== 'string' || typeof j.message !== 'string') throw new Error('shape'); messages.push({ to: j.to, from: j.from, message: j.message }); res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"queued"}'); }
      catch { state.refused++; res.writeHead(400).end('{"error":"bad body"}'); }
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const p = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${p}/sms`, messages, get refused() { return state.refused; }, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
