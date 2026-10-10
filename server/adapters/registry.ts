import { AdapterError, type CameraRef, type SourceAdapter } from './types';

export interface AdapterRegistry {
  register(adapter: SourceAdapter): void;
  list(): SourceAdapter[];
  get(kind: string): SourceAdapter | undefined;
  /** The adapter named by `ref.adapter`, or else the first registered one that accepts the camera. */
  resolve(ref: CameraRef): SourceAdapter;
}

export function createAdapterRegistry(initial: SourceAdapter[] = []): AdapterRegistry {
  const adapters = new Map<string, SourceAdapter>();
  const registry: AdapterRegistry = {
    register(a) {
      if (adapters.has(a.kind)) throw new Error(`An adapter named '${a.kind}' is already registered.`);
      adapters.set(a.kind, a);
    },
    list: () => [...adapters.values()],
    get: (kind) => adapters.get(kind),
    resolve(ref) {
      if (ref.adapter) {
        const a = adapters.get(ref.adapter);
        if (!a) throw new AdapterError(`No adapter named '${ref.adapter}'. Available: ${[...adapters.keys()].join(', ') || 'none'}.`, 'no_adapter');
        return a;
      }
      for (const a of adapters.values()) if (a.accepts(ref)) return a;
      throw new AdapterError(`No adapter accepts camera '${ref.id}'. Set 'adapter' or give it a stream URL.`, 'no_adapter');
    },
  };
  for (const a of initial) registry.register(a);
  return registry;
}
