import crypto from 'node:crypto';
import type { StationId, BayId, ServiceId } from '@ospp/protocol';

export interface StationConfig {
  stationId: StationId;
  firmwareVersion: string;
  stationModel: string;
  stationVendor: string;
  serialNumber: string;
  bayCount: number;
  timezone: string;
  bays: BayConfig[];
  behavior: BehaviorConfig;
}

export interface BayConfig {
  bayId: BayId;
  bayNumber: number;
  /**
   * The PROGRAMS this bay can run — physical operations the hardware performs,
   * and firmware constants the station owns (spec 01-architecture.md:234).
   *
   * Declared at provisioning and re-declared, ordinals only, at every boot. This
   * is what StatusNotification reports: a station cannot originate knowledge of a
   * SERVICE, only echo one the server pushed, and at first boot it has been told
   * none — which is why the old `services` shape made a conforming first boot
   * impossible.
   */
  programs: ProgramConfig[];
  /**
   * The commercial offers the SERVER minted and pushed in the catalog. Retained
   * because the simulator answers StartService by serviceId, but NEVER put on the
   * wire in a StatusNotification.
   */
  services: ServiceConfig[];
}

export interface ProgramConfig {
  /** 1..32, unique within the bay, need not be dense. */
  programNumber: number;
  /** Printable ASCII 1..32. Descriptive: declared, never compared at boot. */
  label: string;
  available: boolean;
}

export interface ServiceConfig {
  serviceId: ServiceId;
  serviceName: string;
  available: boolean;
}

export interface BehaviorConfig {
  acceptRate: number;                  // 0.0 - 1.0, probability of accepting requests
  responseDelayMs: [number, number];   // [min, max] random delay range
  heartbeatIntervalSec: number;
  meterValuesIntervalSec: number;
  autoRetryBoot: boolean;              // true = handler auto-retries on Rejected/Pending
}

export function generateStationId(): StationId {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `stn_${hex}`;
}

export function generateBayId(): BayId {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `bay_${hex}`;
}

export function generateServiceId(name: string): ServiceId {
  return `svc_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

export function generateSerialNumber(): string {
  return `SN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}
