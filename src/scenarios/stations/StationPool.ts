import crypto from 'node:crypto';

export interface PoolEntry {
  stationId: string;
  bayIds: string[];
  /**
   * The EXPLICIT {bayId, bayNumber} pairs from the provisioning response.
   *
   * `bayIds` above is a convenience ordering (sorted by bayNumber) and CANNOT express which
   * number a bay actually carries: a station declaring bays {1,3} yields two ids whose
   * indices are 0 and 1, and anything reconstructing `bayNumber: i + 1` from that labels
   * bay 3 as bay 2. The pairs are what provisioning-response.schema.json goes out of its
   * way to provide; they are carried here so no reader has to guess.
   */
  bays?: { bayId: string; bayNumber: number }[];
  certPath?: string;
  keyPath?: string;
  chainPath?: string;
  brokerCaPath?: string;
  /**
   * Per-station ECDSA-P256 receipt-signing private key (PKCS8 PEM) persisted
   * during provisioning. Read by SendStep when emitting TransactionEvent to
   * sign the receipt per spec §6.2 (canonical form + SHA-256-then-ECDSA over
   * the canonical JSON bytes; the verifier in csms-server hashes the decoded
   * canonical form, not the base64 wire form — implementation matches that).
   */
  receiptKeyPath?: string;
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
  /**
   * The EXPLICIT {bayId, bayNumber} pairs from the provisioning response.
   *
   * `bayIds` above is a convenience ordering (sorted by bayNumber) and CANNOT express which
   * number a bay actually carries: a station declaring bays {1,3} yields two ids whose
   * indices are 0 and 1, and anything reconstructing `bayNumber: i + 1` from that labels
   * bay 3 as bay 2. The pairs are what provisioning-response.schema.json goes out of its
   * way to provide; they are carried here so no reader has to guess.
   */
  bays?: { bayId: string; bayNumber: number }[];
  certPath?: string;
  keyPath?: string;
  chainPath?: string;
  brokerCaPath?: string;
  receiptKeyPath?: string;
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
      bays: input.bays ? input.bays.map((b) => ({ ...b })) : undefined,
      certPath: input.certPath,
      keyPath: input.keyPath,
      chainPath: input.chainPath,
      brokerCaPath: input.brokerCaPath,
      receiptKeyPath: input.receiptKeyPath,
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
