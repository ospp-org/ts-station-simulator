import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigKey, CONFIG_KEY_REGISTRY, OsppErrorCode } from '@ospp/protocol';

/**
 * THE CONFIGURATION KEYS THIS STATION HOLDS - the spec's key-value store (08-configuration.md §1.1),
 * as distinct from `StationConfig`, which is how the simulator was built.
 *
 * Two keys, both Transaction profile, RW, Dynamic (08 §3): `MeterValuesInterval`, the cadence of
 * MeterValues during a wash (meter-values.md §5), and `MeterValuesSampleInterval`, how often a live
 * session's delivered time is persisted (05-state-machines.md §3.5 rule 3). Each starts at its
 * factory value - the spec default unless the station was built with another (`simulator connect
 * --meter-values-interval`) - and moves when the server sets it: by ChangeConfiguration, validated
 * and atomic over the batch (08 §8.2), or by an Accepted boot's `configuration`, validated entry by
 * entry and never failing the boot (08 §8.3). GetConfiguration reports both by name.
 *
 * They replace `behavior.meterValuesIntervalSec` (30), which no code read: GetConfiguration reported
 * it under a name the spec does not have, a ChangeConfiguration of the real key was answered
 * `Accepted` and ignored, and connect mode sent no MeterValues at all.
 *
 * EVERY KEY OF THE REGISTRY, SINCE 2026-10-21. The two keys above drive the meter; the station holds
 * every other key the SDK's CONFIG_KEY_REGISTRY registers too, under its spec name, and judges a write
 * of each as change-configuration.md §6 says (StationConfiguration.judge): unknown - NotSupported;
 * ReadOnly - Rejected 5108; a value of the wrong type or out of its range - Rejected 5109; valid -
 * Accepted for a Dynamic key, in force at once, or RebootRequired for a Static one, in force from the
 * next boot (08 §8.2). It answered every other key Accepted and held none (RevocationEpoch excepted),
 * and GetConfiguration reported names no spec version has. A key the simulator has no behaviour for is
 * held and reported, not acted on (docs/CONFORMANCE-GAPS.md names which).
 *
 * KEPT ON DISK, beside the station's certificates, when the station keeps its state there (`connect`,
 * StationConfig.persistConfiguration): `<stationId>-configuration.json`, written whole and renamed into
 * place on every change, read at construction - so a new process starts from the values the server set,
 * as 08 §8.4 asks of NVS. Without a directory it lives in memory and survives restart() alone.
 */
export type HeldConfigKey = ConfigKey.METER_VALUES_INTERVAL | ConfigKey.METER_VALUES_SAMPLE_INTERVAL;

/**
 * The range of each, from the registry (08 §3: 10-3600 and 1-60). The SDK's CONFIG_KEY_REGISTRY carries
 * the type, the default, the access and the mutability, and no range, so the range is stated here.
 */
const RANGES: Readonly<Record<HeldConfigKey, { min: number; max: number }>> = {
  [ConfigKey.METER_VALUES_INTERVAL]: { min: 10, max: 3600 },
  [ConfigKey.METER_VALUES_SAMPLE_INTERVAL]: { min: 1, max: 60 },
};

export const HELD_CONFIG_KEYS: readonly HeldConfigKey[] = [
  ConfigKey.METER_VALUES_INTERVAL,
  ConfigKey.METER_VALUES_SAMPLE_INTERVAL,
];

/** The factory values a station is built with; a key left out takes the spec default. */
export type FactoryConfiguration = Partial<Record<HeldConfigKey, number>>;

export function isHeldConfigKey(key: string): key is HeldConfigKey {
  return (HELD_CONFIG_KEYS as readonly string[]).includes(key);
}

/** The spec default (08 §3), read from the SDK's registry rather than restated. */
export function defaultConfigValue(key: HeldConfigKey): number {
  return Number(CONFIG_KEY_REGISTRY[key].defaultValue);
}

/** `10-3600`, for a message that says why a value was refused. */
export function describeConfigRange(key: HeldConfigKey): string {
  return `${RANGES[key].min}-${RANGES[key].max}`;
}

/**
 * A value as 08 §8.2 rule 1 validates it: the wire carries a string, and an integer key takes decimal
 * digits only - no sign, no fraction, no exponent, no spaces - within the key's range. Null when the
 * value fails either: the station answers `Rejected` with `5109 INVALID_CONFIGURATION_VALUE`
 * (change-configuration.md §6 rule 6).
 */
export function parseConfigValue(key: HeldConfigKey, raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw)) return null;
  const value = Number(raw);
  const { min, max } = RANGES[key];
  return value >= min && value <= max ? value : null;
}

/** What a write of one key is answered (change-configuration.md §6, 08-configuration.md §8.2). */
export interface ConfigVerdict {
  status: 'Accepted' | 'RebootRequired' | 'Rejected' | 'NotSupported';
  errorCode?: OsppErrorCode;
}

/**
 * The integer ranges of 08-configuration.md §3 for every integer key the registry carries - the SDK
 * states type, default, access and mutability, and no range.
 */
const INTEGER_RANGES: Readonly<Record<string, { min: number; max: number }>> = {
  ...RANGES,
  [ConfigKey.HEARTBEAT_INTERVAL_SECONDS]: { min: 10, max: 3600 },
  [ConfigKey.CONNECTION_TIMEOUT]: { min: 10, max: 300 },
  [ConfigKey.RECONNECT_BACKOFF_MAX]: { min: 30, max: 3600 },
  [ConfigKey.BOOT_RETRY_INTERVAL]: { min: 10, max: 600 },
  [ConfigKey.CONNECTION_LOST_GRACE_PERIOD]: { min: 60, max: 600 },
  [ConfigKey.MAX_SESSION_DURATION_SECONDS]: { min: 60, max: 3600 },
  [ConfigKey.SESSION_TIMEOUT]: { min: 0, max: 600 },
  [ConfigKey.RESERVATION_DEFAULT_TTL]: { min: 60, max: 1800 },
  [ConfigKey.DEFAULT_CREDITS_PER_SESSION]: { min: 1, max: 10000 },
  [ConfigKey.CERTIFICATE_RENEWAL_THRESHOLD_DAYS]: { min: 7, max: 90 },
  [ConfigKey.MAX_OFFLINE_TRANSACTIONS]: { min: 1000, max: 10000 },
  [ConfigKey.OFFLINE_PASS_MAX_AGE]: { min: 300, max: 864000 },
  [ConfigKey.REVOCATION_EPOCH]: { min: 0, max: 2147483647 },
};

const LOG_LEVELS: ReadonlySet<string> = new Set(['Debug', 'Info', 'Warn', 'Error']);

/** Whether `raw` is a value 08 §3 allows for `key`, read as its type and its range. */
function valid(key: string, raw: string): boolean {
  const entry = CONFIG_KEY_REGISTRY[key as ConfigKey];
  if (entry.valueType === 'integer') {
    const range = INTEGER_RANGES[key];
    if (!/^\d{1,10}$/.test(raw) || range === undefined) return false;
    const value = Number(raw);
    return value >= range.min && value <= range.max;
  }
  if (entry.valueType === 'boolean') return raw === 'true' || raw === 'false';
  switch (key) {
    case ConfigKey.STATION_NAME: return [...raw].length <= 100;
    case ConfigKey.LOG_LEVEL: return LOG_LEVELS.has(raw);
    case ConfigKey.TIME_ZONE:
      try {
        new Intl.DateTimeFormat('en', { timeZone: raw });
        return raw !== '';
      } catch {
        return false;
      }
    // 08 §3: the whole key set, each key its DER SubjectPublicKeyInfo in Base64, 124 characters,
    // separated by commas.
    case ConfigKey.OFFLINE_PASS_PUBLIC_KEY: return raw.split(',').every((k) => /^[A-Za-z0-9+/]{122}==$|^[A-Za-z0-9+/]{123}=$|^[A-Za-z0-9+/]{124}$/.test(k));
    default: return true;
  }
}

/** The stored form: the values in force, and the Static ones set to take effect at the next boot. */
interface StoredConfiguration {
  values: Record<string, string>;
  pending: Record<string, string>;
}

export class StationConfiguration {
  /** Every registry key the station holds a value for, as its wire string. */
  private readonly values = new Map<string, string>();
  /** Static keys a ChangeConfiguration set: RebootRequired, in force from the next boot (08 §8.2). */
  private readonly pending = new Map<string, string>();

  /**
   * `identity` names what the station is built as - its firmware version and time zone - which the
   * registry has no default for; `file` is where the configuration is kept, or none (memory only).
   */
  constructor(
    factory: FactoryConfiguration = {},
    identity: { firmwareVersion?: string; timezone?: string; protocolVersion?: string } = {},
    private readonly file: string | null = null,
  ) {
    for (const [key, entry] of Object.entries(CONFIG_KEY_REGISTRY)) {
      if (entry.defaultValue !== null) this.values.set(key, entry.defaultValue);
    }
    if (identity.firmwareVersion !== undefined) this.values.set(ConfigKey.FIRMWARE_VERSION, identity.firmwareVersion);
    if (identity.timezone !== undefined) this.values.set(ConfigKey.TIME_ZONE, identity.timezone);
    if (identity.protocolVersion !== undefined) this.values.set(ConfigKey.PROTOCOL_VERSION, identity.protocolVersion);
    for (const key of HELD_CONFIG_KEYS) {
      const given = factory[key];
      if (given === undefined) continue;
      if (parseConfigValue(key, String(given)) === null) {
        throw new Error(`${key} ${given} is not an integer in ${describeConfigRange(key)} (08-configuration.md §3)`);
      }
      this.values.set(key, String(given));
    }
    this.load();
  }

  get(key: HeldConfigKey): number {
    const held = this.values.get(key);
    return held === undefined ? defaultConfigValue(key) : Number(held);
  }

  /** A value already validated (parseConfigValue). */
  set(key: HeldConfigKey, value: number): void {
    this.values.set(key, String(value));
    this.save();
  }

  /** The value in force for any key the station holds, as its wire string; undefined for any other. */
  value(key: string): string | undefined {
    return this.values.get(key);
  }

  /** change-configuration.md §6 rules 4-6 and 08 §8.2, for one key. */
  judge(key: string, raw: string): ConfigVerdict {
    const entry = (CONFIG_KEY_REGISTRY as Record<string, (typeof CONFIG_KEY_REGISTRY)[ConfigKey] | undefined>)[key];
    if (entry === undefined) return { status: 'NotSupported' };
    if (entry.access === 'R') return { status: 'Rejected', errorCode: OsppErrorCode.CONFIGURATION_KEY_READONLY };
    if (!valid(key, raw)) return { status: 'Rejected', errorCode: OsppErrorCode.INVALID_CONFIGURATION_VALUE };
    return { status: entry.mutability === 'Static' ? 'RebootRequired' : 'Accepted' };
  }

  /**
   * A whole ChangeConfiguration batch: every key judged first, and nothing applied unless none is
   * Rejected or NotSupported (§6 rules 1-2). A Dynamic key is in force at once, a Static one from the
   * next boot. Returns the verdicts in the request's order, and whether the batch was applied.
   */
  applyBatch(entries: ReadonlyArray<{ key: string; value: string }>): { verdicts: ConfigVerdict[]; applied: boolean } {
    const verdicts = entries.map((e) => this.judge(e.key, e.value));
    const applied = verdicts.every((v) => v.status === 'Accepted' || v.status === 'RebootRequired');
    if (applied) {
      entries.forEach((e, i) => {
        if (verdicts[i].status === 'RebootRequired') this.pending.set(e.key, e.value);
        else this.values.set(e.key, e.value);
      });
      this.save();
    }
    return { verdicts, applied };
  }

  /** A value the boot's `configuration` carries, already judged valid: in force at once (08 §8.3). */
  setAtBoot(key: string, value: string): void {
    this.values.set(key, value);
    this.pending.delete(key);
    this.save();
  }

  /** At a boot: the Static values set since the last one take effect (08 §8.2). */
  takePendingIntoForce(): void {
    if (this.pending.size === 0) return;
    for (const [key, value] of this.pending) this.values.set(key, value);
    this.pending.clear();
    this.save();
  }

  /**
   * GetConfiguration's answer (get-configuration.md §5.1): every key held but a WriteOnly one, by its
   * spec name, ReadOnly ones marked so; asked by name, a WriteOnly key appears in neither array and a
   * key the station does not hold is unknown.
   */
  report(keys?: readonly string[]): { configuration: Array<{ key: string; value: string; readonly: boolean }>; unknownKeys: string[] } {
    const entryOf = (key: string) => {
      const registered = (CONFIG_KEY_REGISTRY as Record<string, (typeof CONFIG_KEY_REGISTRY)[ConfigKey] | undefined>)[key];
      const value = this.values.get(key);
      return registered === undefined || value === undefined ? null : { key, value, readonly: registered.access === 'R', writeOnly: registered.access === 'W' };
    };
    const configuration: Array<{ key: string; value: string; readonly: boolean }> = [];
    const unknownKeys: string[] = [];
    for (const key of keys ?? [...this.values.keys()]) {
      const entry = entryOf(key);
      if (entry === null) {
        if (keys !== undefined && (CONFIG_KEY_REGISTRY as Record<string, unknown>)[key] === undefined) unknownKeys.push(key);
        continue;
      }
      if (entry.writeOnly) continue;
      configuration.push({ key: entry.key, value: entry.value, readonly: entry.readonly });
    }
    return { configuration, unknownKeys };
  }

  private load(): void {
    if (this.file === null) return;
    let stored: StoredConfiguration;
    try {
      stored = JSON.parse(readFileSync(this.file, 'utf-8')) as StoredConfiguration;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Stored configuration at ${this.file} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const [key, value] of Object.entries(stored.values ?? {})) {
      // A ReadOnly key is the station's own (its firmware, its protocol): never taken from disk.
      if (this.judge(key, value).status === 'Accepted' || this.judge(key, value).status === 'RebootRequired') this.values.set(key, value);
    }
    // A new process is a boot: a Static value set before it is in force from now (08 §8.2).
    let tookPending = false;
    for (const [key, value] of Object.entries(stored.pending ?? {})) {
      if (this.judge(key, value).status === 'RebootRequired') {
        this.values.set(key, value);
        tookPending = true;
      }
    }
    if (tookPending) this.save();
  }

  private save(): void {
    if (this.file === null) return;
    const stored: StoredConfiguration = {
      values: Object.fromEntries([...this.values].filter(([key]) => CONFIG_KEY_REGISTRY[key as ConfigKey]?.access !== 'R')),
      pending: Object.fromEntries(this.pending),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

/** The value a station holds for `key` - the spec default when its context holds none (a handler test's). */
export function configValue(station: { configuration?: StationConfiguration }, key: HeldConfigKey): number {
  return station.configuration?.get(key) ?? defaultConfigValue(key);
}

/**
 * The `configuration` of an Accepted BootNotification RESPONSE: "the station MUST apply [it]
 * immediately upon boot acceptance" (08 §8.3), with the same type and range rules as
 * ChangeConfiguration - but entry by entry, not atomically, and an invalid entry is warned about and
 * ignored, never failing the boot. Every key of the registry is held now, so csms-server's
 * HeartbeatIntervalSeconds, MaxSessionDurationSeconds, ConnectionLostGracePeriod and SessionTimeout,
 * sent at every boot, are taken too; a Static key applies at once, the boot being the boot it waits
 * for; a key this station does not know, or a ReadOnly one, is left as it was.
 */
export function applyBootConfiguration(
  station: { configuration?: StationConfiguration },
  configuration: Record<string, string> | undefined,
): void {
  const applied: string[] = [];
  for (const [key, raw] of Object.entries(configuration ?? {})) {
    const value = String(raw);
    const verdict = (station.configuration ?? new StationConfiguration()).judge(key, value);
    if (verdict.status === 'NotSupported') continue;
    if (verdict.status === 'Rejected') {
      console.warn(
        '[BootNotification] configuration %s=%s ignored - %s (08-configuration.md §8.3)',
        key, JSON.stringify(raw),
        isHeldConfigKey(key) ? `not an integer in ${describeConfigRange(key)}` : `refused ${verdict.errorCode}`,
      );
      continue;
    }
    station.configuration?.setAtBoot(key, value);
    applied.push(`${key}=${value}`);
  }
  if (applied.length > 0) {
    console.log('[BootNotification] configuration applied: %s', applied.join(', '));
  }
}
