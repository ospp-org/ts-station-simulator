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

/**
 * A per-run offline transaction id, matching common/offline-tx-id.schema.json
 * (`^otx_[a-f0-9]{8,}$`, minLength 12).
 *
 * Exists because a scenario must not hardcode one. `offline_transactions` is keyed on
 * offlineTxId and the server's Reconciler dedups on it BEFORE verify/score/debit, so a
 * fixed literal is reconciled exactly once EVER against a given database: every later run
 * gets `Duplicate` instead of `Accepted`. Measured on UAT 2026-08-10 — one row,
 * `otx_a0000000001`, reconciled 2026-08-07, still poisoning the scenario three days later.
 *
 * Teardown is not the fix. It already sweeps the table (uatPrivileged.ts, `DELETE FROM
 * offline_transactions WHERE user_id IN (...)`), and the row survived anyway because that
 * sweep is user-scoped and the poisoning run was outside its scope. Even a perfect sweep
 * would not make a fixed global id safe under two concurrent runs. 16 hex chars, so
 * collisions are not a practical concern.
 */
export function generateOfflineTxId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `otx_${hex}`;
}
