import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BayConfig } from './StationConfig.js';

/** The wire shape: ordinals only, no labels. */
export interface DeclaredBay {
  bayNumber: number;
  programNumbers: number[];
}

interface StoredTopology {
  stationId: string;
  declaredAt: string;
  bays: DeclaredBay[];
}

/**
 * The station's own memory of the topology it declared.
 *
 * spec v0.11.0 boot-notification-request.schema.json:50 — "The declaration MUST
 * be STABLE between boots while the hardware is unchanged; how firmware achieves
 * that — NVS, a compiled-in table, a hardware scan — is its own business, and the
 * contract is the stability, not the mechanism."
 *
 * The simulator persisted nothing but certificates and rebuilt its bays from the
 * config file on every run, so "stable across boots" held only because the config
 * happened not to change. The station was not the source of its own declaration —
 * the scenario was — and a boot-re-declaration proof resting on that proves the
 * config file rather than the station.
 *
 * First boot writes; every later boot reads and re-declares the SAME thing even
 * if the config now says otherwise. §05-state-machines.md:126 is the reason: "A
 * station MUST NOT alter its declaration to match what the server expected. The
 * declaration describes hardware; silently agreeing would hide a real hardware
 * change." A station that re-derives from config each boot is doing exactly that
 * silent agreeing, one step earlier.
 *
 * `forget()` is the re-provisioning path and is deliberately explicit. Nothing in
 * the boot path may reach it, or the station is self-correcting again.
 */
export class TopologyStore {
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly stationId: string,
  ) {
    this.file = join(dir, `${stationId}-topology.json`);
  }

  /**
   * Return the topology this station declares, writing it on first call.
   *
   * `fromConfig` is used ONLY when nothing has been declared yet. After that it
   * is ignored — that is the whole point.
   */
  async declare(fromConfig: BayConfig[]): Promise<DeclaredBay[]> {
    const existing = await this.read();
    if (existing !== null) {
      return existing.bays;
    }

    const bays = TopologyStore.toWireShape(fromConfig);
    const record: StoredTopology = {
      stationId: this.stationId,
      declaredAt: new Date().toISOString(),
      bays,
    };

    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

    return bays;
  }

  /** Re-provisioning. The only thing that may change a declared topology. */
  async forget(): Promise<void> {
    try {
      await unlink(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private async read(): Promise<StoredTopology | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    try {
      const parsed = JSON.parse(raw) as StoredTopology;
      if (!Array.isArray(parsed.bays)) {
        throw new Error('missing bays[]');
      }

      return parsed;
    } catch (err) {
      // Refused, never silently re-derived from config. Falling back would
      // reintroduce the defect this store exists to remove, and would do it
      // invisibly — the station would look stable while declaring whatever the
      // config happened to say that run.
      throw new Error(
        `Stored topology at ${this.file} is unreadable and will NOT be re-derived from config: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'Re-provision the station if its hardware changed; repair or delete the file otherwise.',
      );
    }
  }

  /**
   * Ordinals only, sorted. Labels are omitted structurally — they are
   * descriptive, are never compared, and "a corrected typo in a firmware
   * constant MUST NOT put a station into Pending". Sorting keeps the file from
   * churning when config order changes, and order carries no meaning on the wire.
   */
  static toWireShape(bays: BayConfig[]): DeclaredBay[] {
    return bays
      .map(b => ({
        bayNumber: b.bayNumber,
        programNumbers: b.programs.map(p => p.programNumber).sort((x, y) => x - y),
      }))
      .sort((a, b) => a.bayNumber - b.bayNumber);
  }
}
