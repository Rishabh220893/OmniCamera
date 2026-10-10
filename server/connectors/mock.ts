/**
 * Mock connectors for VAHAN (vehicle registration), SARTHI (driving licences) and eGujCop (wanted vehicles). They answer from a small
 * table in memory (a built-in demo set, or your own passed to the factory) in the shape the contract describes, so alert rules, the
 * enrichment and the screens can be built and tested without access to the real systems. They never invent a record: a subject not in
 * the table is simply `found: false` with no flags.
 *
 * Not modelled: the real systems' authentication, rate limits, field names, state-by-state differences, or any biometric matching
 * (AFIS/NAFIS need fingerprint or face templates, which a camera frame does not provide).
 */
import { ConnectorError, normalisePlate, type Connector, type ConnectorQuery, type ConnectorResult, type Flag } from './types';

export interface MockVehicle {
  plate: string;
  /** Registered class, e.g. "Motor Car". */
  vehicleClass: string;
  makeModel: string;
  /** Owner as the registry would show a verifier: masked. */
  ownerMasked: string;
  registeredOn: string;
  insuranceValidTo: string;
  fitnessValidTo: string;
  stolen?: boolean;
  blacklisted?: boolean;
}
export interface MockLicence { number: string; holderMasked: string; validTo: string; classes: string[]; suspended?: boolean }
export interface MockWanted { plate: string; firNumber: string; station: string; reason: string }

export interface MockData { vehicles: MockVehicle[]; licences: MockLicence[]; wanted: MockWanted[] }

/** Obviously fake records, so demo output cannot be mistaken for real people or vehicles. */
export const DEMO_DATA: MockData = {
  vehicles: [
    { plate: 'GJ01AB1234', vehicleClass: 'Motor Car', makeModel: 'DEMO Hatch', ownerMasked: 'D*** O***', registeredOn: '2021-04-12', insuranceValidTo: '2027-04-11', fitnessValidTo: '2036-04-11' },
    { plate: 'GJ05CD5678', vehicleClass: 'Motor Cycle', makeModel: 'DEMO 150', ownerMasked: 'T*** U***', registeredOn: '2019-01-20', insuranceValidTo: '2024-01-19', fitnessValidTo: '2034-01-19' },
    { plate: 'GJ18EF9012', vehicleClass: 'Light Goods Vehicle', makeModel: 'DEMO Pickup', ownerMasked: 'M*** K***', registeredOn: '2020-07-02', insuranceValidTo: '2027-07-01', fitnessValidTo: '2025-07-01' },
    { plate: 'GJ27GH3456', vehicleClass: 'Motor Car', makeModel: 'DEMO Sedan', ownerMasked: 'S*** R***', registeredOn: '2022-09-30', insuranceValidTo: '2027-09-29', fitnessValidTo: '2037-09-29', stolen: true },
    { plate: 'GJ03JK7890', vehicleClass: 'Motor Car', makeModel: 'DEMO SUV', ownerMasked: 'A*** P***', registeredOn: '2018-03-05', insuranceValidTo: '2027-03-04', fitnessValidTo: '2033-03-04', blacklisted: true },
  ],
  licences: [
    { number: 'GJ0120210001234', holderMasked: 'D*** O***', validTo: '2041-05-01', classes: ['LMV', 'MCWG'] },
    { number: 'GJ0520150004321', holderMasked: 'T*** U***', validTo: '2023-02-01', classes: ['MCWG'] },
    { number: 'GJ1820190009999', holderMasked: 'M*** K***', validTo: '2039-08-01', classes: ['LMV'], suspended: true },
  ],
  wanted: [
    { plate: 'GJ27GH3456', firNumber: 'DEMO-FIR-0001/2026', station: 'Demo Station', reason: 'Vehicle theft' },
    { plate: 'GJ09XY0001', firNumber: 'DEMO-FIR-0002/2026', station: 'Demo Station', reason: 'Hit and run' },
  ],
};

const today = (now: () => Date) => now().toISOString().slice(0, 10);
const expired = (date: string, now: () => Date) => date < today(now);

export interface MockOptions { data?: MockData; now?: () => Date; delayMs?: number; failWith?: string }

function wrap(id: string, label: string, description: string, queries: Connector['queries'], o: MockOptions, answer: (q: ConnectorQuery, now: () => Date) => Omit<ConnectorResult, 'connector' | 'queriedAt' | 'mock'>): Connector {
  const now = o.now ?? (() => new Date());
  return {
    id, label, description, queries, mock: true,
    async lookup(query, signal) {
      if (!queries.includes(query.type)) throw new ConnectorError(`${id} does not answer '${query.type}' queries.`, 'unsupported_query');
      if (o.delayMs) await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, o.delayMs);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new ConnectorError(`${id} was cancelled.`, 'timeout')); }, { once: true });
      });
      if (signal.aborted) throw new ConnectorError(`${id} was cancelled.`, 'timeout');
      if (o.failWith) throw new ConnectorError(o.failWith, 'upstream');
      return { connector: id, queriedAt: now().toISOString(), mock: true, ...answer(query, now) };
    },
  };
}

export function createMockVahan(o: MockOptions = {}): Connector {
  const vehicles = (o.data ?? DEMO_DATA).vehicles;
  return wrap('vahan', 'VAHAN (vehicle registration) - MOCK', 'Mock of the national vehicle registry: registration, insurance and fitness validity, stolen and blacklisted markers. Answers from a built-in demo table only.', ['vehicle'], o, (q, now) => {
    const plate = normalisePlate((q as { plate: string }).plate);
    const v = vehicles.find((x) => normalisePlate(x.plate) === plate);
    if (!v) return { query: 'vehicle', found: false, flags: [], data: { plate } };
    const flags: Flag[] = [];
    if (v.stolen) flags.push({ code: 'stolen', severity: 'critical', text: 'Registry marks this vehicle as stolen.' });
    if (v.blacklisted) flags.push({ code: 'blacklisted', severity: 'critical', text: 'Registry has blacklisted this registration.' });
    if (expired(v.insuranceValidTo, now)) flags.push({ code: 'insurance_expired', severity: 'warning', text: `Insurance expired on ${v.insuranceValidTo}.` });
    if (expired(v.fitnessValidTo, now)) flags.push({ code: 'fitness_expired', severity: 'warning', text: `Fitness certificate expired on ${v.fitnessValidTo}.` });
    return {
      query: 'vehicle', found: true, flags,
      data: { plate, vehicleClass: v.vehicleClass, makeModel: v.makeModel, ownerMasked: v.ownerMasked, registeredOn: v.registeredOn, insuranceValidTo: v.insuranceValidTo, fitnessValidTo: v.fitnessValidTo },
    };
  });
}

export function createMockSarthi(o: MockOptions = {}): Connector {
  const licences = (o.data ?? DEMO_DATA).licences;
  return wrap('sarthi', 'SARTHI (driving licences) - MOCK', 'Mock of the national driving-licence register: validity, classes, suspension. Looked up by licence number (a camera cannot read one, so this is for officers, not for the automatic checks).', ['licence'], o, (q, now) => {
    const number = (q as { number: string }).number.toUpperCase();
    const l = licences.find((x) => x.number.toUpperCase() === number);
    if (!l) return { query: 'licence', found: false, flags: [], data: {} };
    const flags: Flag[] = [];
    if (l.suspended) flags.push({ code: 'licence_suspended', severity: 'warning', text: 'Licence is suspended.' });
    if (expired(l.validTo, now)) flags.push({ code: 'licence_expired', severity: 'warning', text: `Licence expired on ${l.validTo}.` });
    return { query: 'licence', found: true, flags, data: { holderMasked: l.holderMasked, validTo: l.validTo, classes: l.classes } };
  });
}

export function createMockEgujcop(o: MockOptions = {}): Connector {
  const wanted = (o.data ?? DEMO_DATA).wanted;
  return wrap('egujcop', 'eGujCop (police records) - MOCK', 'Mock of the state police system: vehicles named in an open FIR. Answers from a built-in demo table only.', ['wanted_vehicle'], o, (q) => {
    const plate = normalisePlate((q as { plate: string }).plate);
    const hits = wanted.filter((w) => normalisePlate(w.plate) === plate);
    if (!hits.length) return { query: 'wanted_vehicle', found: false, flags: [], data: { plate } };
    return {
      query: 'wanted_vehicle', found: true, data: { plate, firs: hits.map((h) => ({ firNumber: h.firNumber, station: h.station, reason: h.reason })) },
      flags: hits.map((h) => ({ code: 'wanted', severity: 'critical' as const, text: `Named in ${h.firNumber} (${h.reason}), ${h.station}.` })),
    };
  });
}

export const createMockConnectors = (o: MockOptions = {}): Connector[] => [createMockVahan(o), createMockSarthi(o), createMockEgujcop(o)];
