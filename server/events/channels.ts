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

export interface ChannelRegistry {
  get(type: string): Channel | undefined;
  /** Why a channel config cannot be used, or null. */
  check(cfg: ChannelConfig): string | null;
}

export function createChannelRegistry(channels: Channel[]): ChannelRegistry {
  const byType = new Map<string, Channel>(channels.map((c) => [c.type, c as unknown as Channel]));
  return {
    get: (t) => byType.get(t),
    check(cfg) {
      const c = byType.get(cfg.type);
      return c ? c.check?.(cfg) ?? null : `Channel '${cfg.type}' is not available on this server.`;
    },
  };
}
