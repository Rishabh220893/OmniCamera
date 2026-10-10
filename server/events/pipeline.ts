/**
 * Every source of events publishes to the bus, and one consumer (group `alerting`) turns them into stored events and alerts (federation plan
 * step 3). Producers do not know about alerting: the analysis worker, the department-system runners, the webhook receiver and the regional
 * gateways all call `publish`. Delivery is at-least-once; the alert engine stores an event once by its id, so a repeat opens no second alert.
 * A batch that keeps failing goes to the dead-letter topic (`platform.events.dlq`) instead of blocking the others.
 */
import type { EventBus, Subscription } from '../bus/types';
import { EVENT_TOPIC } from '../bus/topics';
import type { PlatformEvent } from './schema';

export interface EventPipeline {
  /** Puts events on the bus (keyed by camera, so one camera's events stay in order). Resolves once the bus has them, not once they are alerted on. */
  publish(events: PlatformEvent[]): Promise<void>;
  stats(): { delivered: number; failures: number; deadLettered: number };
  stop(): Promise<void>;
}

export interface EventPipelineOptions {
  bus: EventBus;
  /** Stores the events and raises alerts (the alert engine, behind the plate enricher when connectors are on). Must be safe to run twice for the same event. */
  ingest(events: PlatformEvent[]): Promise<unknown>;
  /** Where a NEW consumer group starts. Default `earliest`: nothing published before the consumer existed is lost. */
  from?: 'earliest' | 'latest';
  batch?: number;
  maxAttempts?: number;
  retryMs?: number;
}

export async function createEventPipeline(o: EventPipelineOptions): Promise<EventPipeline> {
  const sub: Subscription = await o.bus.subscribe<PlatformEvent>(
    EVENT_TOPIC, 'alerting', async (msgs) => { await o.ingest(msgs.map((m) => m.value)); },
    { from: o.from ?? 'earliest', batch: o.batch, maxAttempts: o.maxAttempts, retryMs: o.retryMs },
  );
  return {
    async publish(events) {
      if (events.length === 0) return;
      await o.bus.publish(EVENT_TOPIC, events.map((e) => ({ key: e.cameraId, value: e })));
    },
    stats: () => sub.stats(),
    stop: () => sub.stop(),
  };
}
