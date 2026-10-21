import { describe, it, expect, vi } from 'vitest';
import { ConfigKey } from '@ospp/protocol';
import {
  StationConfiguration,
  applyBootConfiguration,
  configValue,
  defaultConfigValue,
  parseConfigValue,
} from '../../station/StationConfiguration.js';
import { readingAt, highestSeqNo } from '../../station/sessionMeter.js';
import { SequenceCounter } from '../../station/SequenceCounter.js';

/*
 * The configuration keys the station holds (08-configuration.md §3) and the one parser that
 * validates them - for ChangeConfiguration (§8.2), the boot's `configuration` (§8.3) and
 * `simulator connect --meter-values-interval` alike.
 */

const INTERVAL = ConfigKey.METER_VALUES_INTERVAL;
const SAMPLE = ConfigKey.METER_VALUES_SAMPLE_INTERVAL;

describe('the values a held key takes (08-configuration.md §3, §8.2 rule 1)', () => {
  it('defaults to the registry\'s values: MeterValuesInterval 60, MeterValuesSampleInterval 10', () => {
    expect(defaultConfigValue(INTERVAL)).toBe(60);
    expect(defaultConfigValue(SAMPLE)).toBe(10);
    const held = new StationConfiguration();
    expect(held.get(INTERVAL)).toBe(60);
    expect(held.get(SAMPLE)).toBe(10);
  });

  it.each([['10', 10], ['60', 60], ['3600', 3600], ['0060', 60]])('MeterValuesInterval %s is %d', (raw, value) => {
    expect(parseConfigValue(INTERVAL, raw)).toBe(value);
  });

  it.each(['9', '3601', '0', '-10', '+10', '10.0', '10.5', '1e2', ' 10', '10 ', '', 'abc', '0x10', '12345678901'])(
    'MeterValuesInterval %j is refused - not an integer in 10-3600',
    (raw) => {
      expect(parseConfigValue(INTERVAL, raw)).toBeNull();
    },
  );

  it('MeterValuesSampleInterval takes 1-60', () => {
    expect(parseConfigValue(SAMPLE, '1')).toBe(1);
    expect(parseConfigValue(SAMPLE, '60')).toBe(60);
    expect(parseConfigValue(SAMPLE, '0')).toBeNull();
    expect(parseConfigValue(SAMPLE, '61')).toBeNull();
  });

  it('a factory value is the station\'s until the server sets another, and one outside the range builds no station', () => {
    const held = new StationConfiguration({ [INTERVAL]: 15 });
    expect(held.get(INTERVAL)).toBe(15);
    expect(held.get(SAMPLE)).toBe(10);
    held.set(INTERVAL, 20);
    expect(held.get(INTERVAL)).toBe(20);
    expect(() => new StationConfiguration({ [INTERVAL]: 5 })).toThrow(/MeterValuesInterval 5 is not an integer in 10-3600/);
  });

  it('a context that holds none reads the spec default', () => {
    expect(configValue({}, INTERVAL)).toBe(60);
    expect(configValue({ configuration: new StationConfiguration({ [INTERVAL]: 30 }) }, INTERVAL)).toBe(30);
  });
});

describe('the boot\'s configuration (08-configuration.md §8.3) - entry by entry, never failing the boot', () => {
  it('applies every valid key it holds beside an invalid one, warns about the invalid one, and leaves a key it does not know alone', () => {
    const station = { configuration: new StationConfiguration() };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      applyBootConfiguration(station, {
        MeterValuesInterval: '15',
        MeterValuesSampleInterval: '61',
        HeartbeatIntervalSeconds: '30',
        SessionTimeout: '0',
        VendorTurboMode: 'on',
      });
      expect(station.configuration.get(INTERVAL)).toBe(15);
      expect(station.configuration.get(SAMPLE)).toBe(10);
      // Every key of the registry is held since 2026-10-21: the ones csms-server sends at every boot are taken.
      expect(station.configuration.value('HeartbeatIntervalSeconds')).toBe('30');
      expect(station.configuration.value('VendorTurboMode')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0].map(String).join(' ')).toContain('MeterValuesSampleInterval');
      expect(log.mock.calls.map((c) => c.map(String).join(' '))).toContain('[BootNotification] configuration applied: %s MeterValuesInterval=15, HeartbeatIntervalSeconds=30, SessionTimeout=0');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('an absent block changes nothing and says nothing', () => {
    const station = { configuration: new StationConfiguration({ [INTERVAL]: 45 }) };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      applyBootConfiguration(station, undefined);
      expect(station.configuration.get(INTERVAL)).toBe(45);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe('the readings and the final seqNo (meter-values.md §4, 05-state-machines.md §3.5 rule 5)', () => {
  it('readings are cumulative from the delivered time - 125 ml and 0.25 Wh a second, rounded to whole units, consumableMl omitted', () => {
    expect(readingAt(0)).toEqual({ liquidMl: 0, energyWh: 0 });
    expect(readingAt(60)).toEqual({ liquidMl: 7500, energyWh: 15 });
    expect(readingAt(150)).toEqual({ liquidMl: 18750, energyWh: 38 });
    expect(readingAt(-3)).toEqual({ liquidMl: 0, energyWh: 0 });
    expect(readingAt(61).liquidMl).toBeGreaterThan(readingAt(60).liquidMl!);
  });

  it('finalSeqNo is the highest number issued, and there is none before the first', () => {
    const seq = new SequenceCounter();
    expect(highestSeqNo({ seq })).toBeUndefined();
    seq.next();
    expect(highestSeqNo({ seq })).toBe(0);
    seq.forceTo(7);
    expect(highestSeqNo({ seq })).toBe(6);
  });
});
