import crypto from 'node:crypto';

export interface PoolEntry {
  stationId: string;
  bayIds: string[];
  certPath?: string;
  keyPath?: string;
  chainPath?: string;
  brokerCaPath?: string;
  /**
   * Per-entry random suffix appended to MQTT clientId so multiple
   * pool entries (or sequential connect calls to the same stationId)
   * cannot collide on broker-side session state. The actual clientId
   * sent on connect is `${stationId}-${clientIdSuffix}`.
   */
  clientIdSuffix: string;
}

export interface PoolEntryInput {
  stationId: string;
  bayIds: string[];
  certPath?: string;
  keyPath?: string;
  chainPath?: string;
  brokerCaPath?: string;
  clientIdSuffix?: string;
}

/**
 * Per-scenario runtime registry of provisioned stations. Populated by
 * the `provision_station_pool` YAML step (or manually by tests). Scenarios
 * address entries through the `{{ pool.* }}` template namespace, e.g.
 * `{{ pool.first.bayIds[0] }}` or `{{ pool.station[2].id }}`.
 *
 * This is distinct from `TargetConfig.stationPool: string[]`, which is a
 * config-driven list of pre-allocated stationIds used by the runner's
 * one-per-scenario allocator (`StationPoolAllocator` in ScenarioRunner).
 */
export class StationPool {
  private readonly entries: PoolEntry[] = [];

  register(input: PoolEntryInput): PoolEntry {
    const existing = this.entries.findIndex((e) => e.stationId === input.stationId);
    const entry: PoolEntry = {
      stationId: input.stationId,
      bayIds: [...input.bayIds],
      certPath: input.certPath,
      keyPath: input.keyPath,
      chainPath: input.chainPath,
      brokerCaPath: input.brokerCaPath,
      clientIdSuffix: input.clientIdSuffix ?? crypto.randomUUID(),
    };
    if (existing >= 0) {
      this.entries[existing] = entry;
    } else {
      this.entries.push(entry);
    }
    return entry;
  }

  get(stationId: string): PoolEntry | undefined {
    return this.entries.find((e) => e.stationId === stationId);
  }

  first(): PoolEntry | undefined {
    return this.entries[0];
  }

  at(index: number): PoolEntry | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.entries.length) {
      return undefined;
    }
    return this.entries[index];
  }

  list(): readonly PoolEntry[] {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
