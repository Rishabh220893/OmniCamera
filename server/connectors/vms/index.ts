import { referenceJsonConnector } from './referenceJson';
import { referenceXmlConnector } from './referenceXml';
import { hikvisionEventsConnector } from './hikvisionEvents';
import { dahuaEventsConnector } from './dahuaEvents';
import { onvifEventsConnector } from './onvifEvents';
import { VmsError, type VmsConnectorType } from './types';

export * from './types';
export { createVmsRunner, createMemoryCursorStore, type CursorStore, type VmsRunner, type RunnerStatus } from './runner';
export { platformEventFromVms, cameraStateEvent } from './mapping';
export { createEventStreamConnector, type EventStreamConnector, type StreamStatus } from './eventStream';
export { createStreamBuffer } from './streamBuffer';

/** The connector types this server knows. A new vendor is one file implementing `VmsConnectorType` plus one line here. */
export function createVmsConnectorTypes(extra: VmsConnectorType[] = []) {
  const types = new Map<string, VmsConnectorType>();
  for (const t of [referenceJsonConnector, referenceXmlConnector, hikvisionEventsConnector, dahuaEventsConnector, onvifEventsConnector, ...extra]) {
    if (types.has(t.kind)) throw new Error(`A connector type named '${t.kind}' is already registered.`);
    types.set(t.kind, t);
  }
  return {
    list: () => [...types.values()].map((t) => ({ kind: t.kind, label: t.label, description: t.description })),
    get(kind: string): VmsConnectorType {
      const t = types.get(kind);
      if (!t) throw new VmsError(`No connector type named '${kind}'. Available: ${[...types.keys()].join(', ')}.`, 'protocol');
      return t;
    },
  };
}
