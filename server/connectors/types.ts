/**
 * The contract between OmniSee and an outside system that knows something about what a camera saw (docs/connectors.md):
 * a vehicle registry, a driving-licence register, a police record. Live access to the real systems (VAHAN, SARTHI, eGujCop,
 * AFIS/NAFIS) is restricted, so what ships here is the contract, a hub that makes calling one safe, and mock connectors that
 * behave as the contract says. A real connector replaces a mock by implementing the same `Connector` and registering under
 * the same id.
 */
export type Severity = 'info' | 'notice' | 'warning' | 'critical';

/** What can be asked. Each query type has one meaning across connectors, so a rule never depends on which system answered. */
export type ConnectorQuery =
  | { type: 'vehicle'; plate: string }
  | { type: 'licence'; number: string }
  | { type: 'wanted_vehicle'; plate: string };

export type QueryType = ConnectorQuery['type'];

/** One thing worth acting on in an answer. `code` is stable and machine-readable; rules and derived events use it. */
export interface Flag {
  code: string;
  severity: Severity;
  text: string;
}

export interface ConnectorResult {
  connector: string;
  query: QueryType;
  /** True when the system has a record for the subject. */
  found: boolean;
  flags: Flag[];
  /** What the system reported, already limited to what OmniSee needs (no full personal records). */
  data: Record<string, unknown>;
  queriedAt: string;
  /** True for every answer from a mock. Carried into derived events so nobody mistakes a test answer for a real one. */
  mock: boolean;
  /** Whether this answer was served from the hub's cache rather than the system. */
  cached?: boolean;
}

export interface Connector {
  /** Stable name: `vahan`, `sarthi`, `egujcop`. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The query types it answers. */
  readonly queries: readonly QueryType[];
  readonly mock: boolean;
  lookup(query: ConnectorQuery, signal: AbortSignal): Promise<ConnectorResult>;
}

export class ConnectorError extends Error {
  constructor(message: string, readonly code: 'unknown_connector' | 'unsupported_query' | 'bad_query' | 'unavailable' | 'timeout' | 'circuit_open' | 'upstream') {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** Plates are compared without spaces or punctuation, in upper case (`GJ 01 AB 1234` = `gj01ab1234`). */
export const normalisePlate = (p: string): string => String(p).toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Validates and normalises a query from outside (an API body). Throws ConnectorError('bad_query'). */
export function parseQuery(raw: unknown): ConnectorQuery {
  const q = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (q.type === 'vehicle' || q.type === 'wanted_vehicle') {
    const plate = normalisePlate(str(q.plate));
    if (plate.length < 4 || plate.length > 12) throw new ConnectorError('A plate is 4 to 12 letters and digits.', 'bad_query');
    return { type: q.type, plate };
  }
  if (q.type === 'licence') {
    const number = str(q.number).toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z0-9]{8,20}$/.test(number)) throw new ConnectorError('A licence number is 8 to 20 letters and digits.', 'bad_query');
    return { type: 'licence', number };
  }
  throw new ConnectorError("'query.type' must be vehicle, licence or wanted_vehicle.", 'bad_query');
}
