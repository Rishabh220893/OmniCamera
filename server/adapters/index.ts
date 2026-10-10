import { createAdapterRegistry, type AdapterRegistry } from './registry';
import { directRtspAdapter } from './directRtsp';
import { httpStreamAdapter } from './httpStream';
import { createOnvifAdapter } from './onvif';
import { createHikvisionAdapter, createDahuaAdapter } from './vendorNvr';
import { createGridRtspAdapter, type GridRtspConfig } from './gridRtsp';

export * from './types';
export { createAdapterRegistry, type AdapterRegistry } from './registry';

/** The adapters this server ships with. The grid adapter is only present when the server knows a grid site. */
export function createDefaultAdapters(grid?: GridRtspConfig): AdapterRegistry {
  const r = createAdapterRegistry();
  if (grid) r.register(createGridRtspAdapter(grid));
  r.register(createOnvifAdapter());
  r.register(createHikvisionAdapter());
  r.register(createDahuaAdapter());
  r.register(directRtspAdapter);
  r.register(httpStreamAdapter);
  return r;
}
