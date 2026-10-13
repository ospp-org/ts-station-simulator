import { ConfigKey, CONFIG_KEY_REGISTRY } from '@ospp/protocol';

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
 * Kept in memory: it survives restart() - the in-process power cycle of a Reset or an update, as NVS
 * would - and NOT a new process, which starts from the factory values again. 08 §8.4 asks the
 * station to persist it; that is listed in docs/CONFORMANCE-GAPS.md, not built.
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

export class StationConfiguration {
  private readonly values = new Map<HeldConfigKey, number>();

  constructor(factory: FactoryConfiguration = {}) {
    for (const key of HELD_CONFIG_KEYS) {
      const given = factory[key];
      if (given === undefined) {
        this.values.set(key, defaultConfigValue(key));
        continue;
      }
      if (parseConfigValue(key, String(given)) === null) {
        throw new Error(`${key} ${given} is not an integer in ${describeConfigRange(key)} (08-configuration.md §3)`);
      }
      this.values.set(key, given);
    }
  }

  get(key: HeldConfigKey): number {
    return this.values.get(key) ?? defaultConfigValue(key);
  }

  /** A value already validated (parseConfigValue). */
  set(key: HeldConfigKey, value: number): void {
    this.values.set(key, value);
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
 * ignored, never failing the boot. Keys this station does not hold are left as they were: the whole
 * block was ignored before, and csms-server sends HeartbeatIntervalSeconds, MaxSessionDurationSeconds,
 * ConnectionLostGracePeriod and SessionTimeout in it at every boot.
 */
export function applyBootConfiguration(
  station: { configuration?: StationConfiguration },
  configuration: Record<string, string> | undefined,
): void {
  const applied: string[] = [];
  for (const [key, raw] of Object.entries(configuration ?? {})) {
    if (!isHeldConfigKey(key)) continue;
    const value = parseConfigValue(key, String(raw));
    if (value === null) {
      console.warn(
        '[BootNotification] configuration %s=%s ignored - not an integer in %s (08-configuration.md §8.3)',
        key, JSON.stringify(raw), describeConfigRange(key),
      );
      continue;
    }
    station.configuration?.set(key, value);
    applied.push(`${key}=${value}`);
  }
  if (applied.length > 0) {
    console.log('[BootNotification] configuration applied: %s', applied.join(', '));
  }
}
