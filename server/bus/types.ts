/**
 * The event and metadata bus (federation plan A6): connectors and analyzers publish, alerting / search / correlation subscribe, and
 * none of them know about each other. The contract is what Kafka, RabbitMQ streams and Redis Streams all offer in common:
 *
 *   - topics with a total order of messages and an offset (`id`) per message that sorts in publish order
 *   - consumer groups: each group sees every message once (at-least-once), members of a group share the work
 *   - replay: read a topic from any offset, independent of any group
 *   - bounded retention (by count and age), never unbounded memory or disk
 *   - a message that keeps failing is moved to `<topic>.dlq` after `maxAttempts`, not retried forever and not dropped silently
 *
 * `tests/busConformance.ts` is the executable form of this contract; every implementation must pass it.
 */
export interface BusMessage<T = unknown> {
  /** Offset within the topic. Compare with `compareIds`; do not parse. */
  id: string;
  topic: string;
  key?: string;
  /** ISO time it was published. */
  ts: string;
  value: T;
}

export interface Publish<T = unknown> { key?: string; value: T }

export interface SubscribeOptions {
  /** Where a NEW group starts. An existing group always continues from where it stopped. Default `latest`. */
  from?: 'earliest' | 'latest';
  /** Messages handed to the handler at once. Default 50. */
  batch?: number;
  /** Tries before a message goes to the dead-letter topic. Default 5. */
  maxAttempts?: number;
  /** First retry delay, doubled each time up to 30 s. Default 200 ms. */
  retryMs?: number;
}

export interface Subscription {
  stop(): Promise<void>;
  /** Messages delivered and acknowledged, failed attempts, and dead-lettered, since it started. */
  stats(): { delivered: number; failures: number; deadLettered: number };
}

export type Handler<T = unknown> = (messages: Array<BusMessage<T>>) => Promise<void>;

export interface EventBus {
  readonly kind: string;
  publish<T = unknown>(topic: string, messages: Array<Publish<T>>): Promise<string[]>;
  /**
   * Starts a consumer in `group`. The handler gets batches in order; resolving acknowledges the whole batch, throwing makes the batch
   * retry (so a handler must be safe to run twice for the same message).
   */
  subscribe<T = unknown>(topic: string, group: string, handler: Handler<T>, opts?: SubscribeOptions): Promise<Subscription>;
  /** Replays messages after `afterId` (null = from the oldest still kept), oldest first. */
  read<T = unknown>(topic: string, afterId: string | null, limit: number): Promise<Array<BusMessage<T>>>;
  /** How many messages the topic holds now, and how far each group is behind. */
  info(topic: string): Promise<{ length: number; oldestId: string | null; newestId: string | null; groups: Record<string, { lag: number }> }>;
  close(): Promise<void>;
}

export const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,79}$/;
export const GROUP_RE = /^[a-z][a-z0-9_.-]{0,79}$/;

export class BusError extends Error {
  constructor(message: string) { super(message); this.name = 'BusError'; }
}

export function checkNames(topic: string, group?: string): void {
  if (!TOPIC_RE.test(topic)) throw new BusError(`Topic '${topic}' must be lower case letters, digits, . _ - (up to 80).`);
  if (group !== undefined && !GROUP_RE.test(group)) throw new BusError(`Group '${group}' must be lower case letters, digits, . _ - (up to 80).`);
}

export const DLQ = (topic: string) => `${topic}.dlq`;

/** Orders two message ids from the same bus (`0000000000000012` style or Redis `1700000000000-3` style). */
export function compareIds(a: string, b: string): number {
  const split = (s: string): [bigint, bigint] => { const [x, y] = s.split('-'); return [BigInt(x || 0), BigInt(y || 0)]; };
  const [a1, a2] = split(a), [b1, b2] = split(b);
  return a1 < b1 ? -1 : a1 > b1 ? 1 : a2 < b2 ? -1 : a2 > b2 ? 1 : 0;
}
