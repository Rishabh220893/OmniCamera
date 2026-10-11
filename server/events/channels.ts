/** Where an alert goes. A channel gets the alert, its first event and the rule, and either delivers or throws. */
import { createHmac } from 'node:crypto';
import type { AlertRule, ChannelConfig } from './rules';
import type { PlatformEvent } from './schema';
import { isSafeCameraUrl } from '../../src/lib/cameraUrl';

export type AlertState = 'open' | 'acknowledged' | 'resolved';

export interface Delivery { channel: string; ok: boolean; at: string; attempts: number; error?: string }

export interface Alert {
  id: string;
  userId: string;
  ruleId: string;
  ruleName: string;
  /** Events with this key were folded into this alert. */
  key: string;
  state: AlertState;
  severity: PlatformEvent['severity'];
  title: string;
  cameraId: string;
  cameraName: string;
  /** The department of the camera when the alert was raised; department members see and handle it whoever owns the camera. */
  department?: string;
  firstEventId: string;
  lastEventId: string;
  eventCount: number;
  createdAt: string;
  lastEventAt: string;
  ackBy?: string;
  ackAt?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  deliveries: Delivery[];
}

export interface DeliveryContext { alert: Alert; event: PlatformEvent; rule: Pick<AlertRule, 'id' | 'name'> }

export interface Channel<C extends ChannelConfig = ChannelConfig> {
  readonly type: C['type'];
  /** Returns how many attempts it took. Throws when delivery failed for good. */
  deliver(cfg: C, ctx: DeliveryContext): Promise<{ attempts: number }>;
  /** Null when the config may be used, else why not (checked when a rule is saved). */
  check?(cfg: C): string | null;
}

export interface WebhookOptions {
  fetchImpl?: typeof fetch;
  /** Waits between attempts: 1 s, then 4 s (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Allow addresses on private networks (an on-premises receiver). Off by default. */
  allowPrivate?: boolean;
}

export const webhookBody = (ctx: DeliveryContext) => JSON.stringify({
  alert: { id: ctx.alert.id, state: ctx.alert.state, severity: ctx.alert.severity, title: ctx.alert.title, eventCount: ctx.alert.eventCount, createdAt: ctx.alert.createdAt },
  rule: { id: ctx.rule.id, name: ctx.rule.name },
  event: ctx.event,
});

export const signBody = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export function createWebhookChannel(o: WebhookOptions = {}): Channel<Extract<ChannelConfig, { type: 'webhook' }>> {
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = o.maxAttempts ?? 3;
  const check = (cfg: { url: string }) => {
    if (!/^https?:\/\//i.test(cfg.url)) return 'The address must start with http:// or https://.';
    if (!o.allowPrivate && !isSafeCameraUrl(cfg.url)) return 'That address is on a private network, which this server will not contact.';
    return null;
  };
  return {
    type: 'webhook',
    check,
    async deliver(cfg, ctx) {
      const bad = check(cfg);
      if (bad) throw new Error(bad);
      const body = webhookBody(ctx);
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-OmniSee-Event': ctx.event.type, 'X-OmniSee-Alert': ctx.alert.id };
      if (cfg.secret) headers['X-OmniSee-Signature'] = signBody(cfg.secret, body);
      let last = '';
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await doFetch(cfg.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000), redirect: 'error' });
          if (res.ok) return { attempts: attempt };
          last = `HTTP ${res.status}`;
          // A refusal that retrying cannot fix (bad address, rejected payload) ends here; overload and server errors are retried.
          if (res.status < 500 && res.status !== 408 && res.status !== 429) throw Object.assign(new Error(last), { final: true });
        } catch (e) {
          if ((e as { final?: boolean }).final) throw e;
          last = e instanceof Error ? e.message : String(e);
        }
        if (attempt < maxAttempts) await sleep(attempt === 1 ? 1000 : 4000);
      }
      throw new Error(`${last} after ${maxAttempts} attempts`);
    },
  };
}

export function createLogChannel(log: Pick<Console, 'warn'> = console): Channel<{ type: 'log' }> {
  return { type: 'log', async deliver(_cfg, ctx) { log.warn(`[ALERT] ${ctx.alert.severity.toUpperCase()} ${ctx.alert.title} (rule "${ctx.rule.name}", camera ${ctx.alert.cameraName})`); return { attempts: 1 }; } };
}

// ---- e-mail, SMS and recording holds ---------------------------------------------------------------------------------------------------

/** Keeps a channel from sending more than `max` messages an hour (a rule that fires in a loop must not mail or text a person without end). */
export function hourlyLimiter(max: number, now: () => number = Date.now) {
  const stamps: number[] = [];
  return (): boolean => {
    const t = now();
    while (stamps.length && t - stamps[0] > 3_600_000) stamps.shift();
    if (stamps.length >= max) return false;
    stamps.push(t);
    return true;
  };
}

const sevWord = (s: string) => s.toUpperCase();
const when = (iso: string) => iso.replace('T', ' ').slice(0, 19) + ' UTC';

/** The text of an alert, plain, for e-mail and SMS. SMS keeps it short: one message of about 160 characters. */
export function alertText(ctx: DeliveryContext, short = false): { subject: string; body: string } {
  const { alert, event } = ctx;
  const subject = `[${sevWord(alert.severity)}] ${alert.title}`;
  if (short) return { subject, body: `${subject} - ${alert.cameraName}, ${event.ts.slice(11, 16)} UTC`.slice(0, 300) };
  const lines = [subject, '', `Camera: ${alert.cameraName}${alert.department ? ` (${alert.department})` : ''}`, `When: ${when(event.ts)}`, `What: ${event.summary}`, `Rule: ${ctx.rule.name}`, `Events folded into this alert: ${alert.eventCount}`, `Alert id: ${alert.id}`, '', 'Open the Events tab to see it and handle it.'];
  return { subject, body: lines.join('\n') };
}

export interface EmailMessage { from: string; to: string[]; subject: string; text: string }
export interface EmailOptions {
  /** Sends one message or throws. Real mail is `createSmtpSender`; tests give their own. */
  send: (m: EmailMessage) => Promise<void>;
  from: string;
  /** If set, only addresses at these domains may be used in a rule. */
  allowedDomains?: string[];
  maxPerHour?: number;
  now?: () => number;
}

export function createEmailChannel(o: EmailOptions): Channel<Extract<ChannelConfig, { type: 'email' }>> {
  const allowed = (o.allowedDomains ?? []).map((d) => d.toLowerCase());
  const take = hourlyLimiter(o.maxPerHour ?? 60, o.now);
  return {
    type: 'email',
    check(cfg) {
      const bad = cfg.to.find((a) => allowed.length > 0 && !allowed.includes(a.split('@')[1]?.toLowerCase() ?? ''));
      return bad ? `E-mail to ${bad.split('@')[1]} is not allowed on this server (allowed: ${allowed.join(', ')}).` : null;
    },
    async deliver(cfg, ctx) {
      const bad = this.check?.(cfg);
      if (bad) throw new Error(bad);
      if (!take()) throw new Error('E-mail limit for this hour reached; this alert was not mailed.');
      const { subject, body } = alertText(ctx);
      await o.send({ from: o.from, to: cfg.to, subject, text: body });
      return { attempts: 1 };
    },
  };
}

/** Sends through SMTP (SMTP_URL such as smtps://user:pass@smtp.example.com:465) with nodemailer, loaded only when used. */
export function createSmtpSender(url: string): (m: EmailMessage) => Promise<void> {
  let transport: Promise<{ sendMail(m: unknown): Promise<unknown> }> | null = null;
  return async (m) => {
    transport ??= import('nodemailer').then((n) => (n.default ?? n).createTransport(url));
    await (await transport).sendMail({ from: m.from, to: m.to.join(', '), subject: m.subject, text: m.text });
  };
}

export interface SmsOptions {
  /** An HTTPS endpoint of the SMS gateway that accepts POST { to, from?, message } with a Bearer token. Gateways with another shape need a small adapter in front. */
  gatewayUrl: string;
  token: string;
  from?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxPerHour?: number;
  now?: () => number;
}

export function createSmsChannel(o: SmsOptions): Channel<Extract<ChannelConfig, { type: 'sms' }>> {
  const doFetch = o.fetchImpl ?? fetch;
  const take = hourlyLimiter(o.maxPerHour ?? 30, o.now);
  return {
    type: 'sms',
    // https:// only, except a gateway on this machine (the local sandbox, `npm run alert-sandbox`), where no secret leaves the computer.
    check: () => (/^https:\/\//i.test(o.gatewayUrl) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(o.gatewayUrl) ? null : 'The SMS gateway address must be https://.'),
    async deliver(cfg, ctx) {
      if (!take()) throw new Error('SMS limit for this hour reached; this alert was not sent.');
      const { body } = alertText(ctx, true);
      const failed: string[] = [];
      for (const to of cfg.to) {
        try {
          const res = await doFetch(o.gatewayUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` }, body: JSON.stringify({ to, ...(o.from ? { from: o.from } : {}), message: body }), signal: AbortSignal.timeout(o.timeoutMs ?? 10_000), redirect: 'error' });
          if (!res.ok) failed.push(`${to.slice(0, 5)}...: HTTP ${res.status}`);
        } catch (e) { failed.push(`${to.slice(0, 5)}...: ${e instanceof Error ? e.message : e}`); }
      }
      if (failed.length) throw new Error(`SMS not sent to ${failed.length} of ${cfg.to.length}: ${failed.join('; ')}`);
      return { attempts: 1 };
    },
  };
}

export interface HoldTarget {
  add(h: { cameraId: string; from: Date; to: Date; reason: string; by: string }): Promise<{ id: string }>;
}

/** An alert keeps the footage around it: a hold from `beforeMinutes` before to `afterMinutes` after the event on the alert's camera. */
export function createRecordingHoldChannel(o: { holds: HoldTarget; emit?: (e: { holdId: string; cameraId: string; from: Date; to: Date; alertId: string; cameraName: string; userId: string; department?: string }) => Promise<unknown> | unknown }): Channel<Extract<ChannelConfig, { type: 'recording-hold' }>> {
  return {
    type: 'recording-hold',
    async deliver(cfg, ctx) {
      const at = new Date(ctx.event.ts).getTime();
      const from = new Date(at - cfg.beforeMinutes * 60_000), to = new Date(at + cfg.afterMinutes * 60_000);
      const hold = await o.holds.add({ cameraId: ctx.alert.cameraId, from, to, reason: `Alert ${ctx.alert.id}: ${ctx.alert.title}`.slice(0, 200), by: `alert-rule:${ctx.rule.id}` });
      await o.emit?.({ holdId: hold.id, cameraId: ctx.alert.cameraId, from, to, alertId: ctx.alert.id, cameraName: ctx.alert.cameraName, userId: ctx.alert.userId, department: ctx.alert.department });
      return { attempts: 1 };
    },
  };
}

export interface ChannelRegistry {
  get(type: string): Channel | undefined;
  /** Why a channel config cannot be used, or null. */
  check(cfg: ChannelConfig): string | null;
  /** The channel types this server can deliver through. */
  types(): string[];
}

export function createChannelRegistry(channels: Channel[]): ChannelRegistry {
  const byType = new Map<string, Channel>(channels.map((c) => [c.type, c as unknown as Channel]));
  return {
    get: (t) => byType.get(t),
    types: () => [...byType.keys()],
    check(cfg) {
      const c = byType.get(cfg.type);
      return c ? c.check?.(cfg) ?? null : `Channel '${cfg.type}' is not available on this server.`;
    },
  };
}
