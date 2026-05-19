import { describe, it, expect } from 'vitest';
import { deriveBays } from '../../cli/connectBays.js';

describe('deriveBays', () => {
  const stationId = 'stn_1a2b3c4d';
  const stationHex = '1a2b3c4d';

  it('falls back to deterministic IDs when userVars empty', () => {
    const { bays, warnings } = deriveBays(stationId, 2, new Map());
    expect(bays).toHaveLength(2);
    expect(bays[0].bayId).toBe(`bay_${stationHex}01`);
    expect(bays[1].bayId).toBe(`bay_${stationHex}02`);
    expect(bays[0].bayNumber).toBe(1);
    expect(bays[1].bayNumber).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('overrides a single bay slot from --var bayId_1', () => {
    const { bays, warnings } = deriveBays(
      stationId,
      2,
      new Map([['bayId_1', 'bay_realbay001']]),
    );
    expect(bays[0].bayId).toBe('bay_realbay001');
    expect(bays[1].bayId).toBe(`bay_${stationHex}02`);
    expect(warnings).toEqual([]);
  });

  it('overrides multiple bay slots', () => {
    const { bays, warnings } = deriveBays(
      stationId,
      2,
      new Map([
        ['bayId_1', 'bay_first'],
        ['bayId_2', 'bay_second'],
      ]),
    );
    expect(bays[0].bayId).toBe('bay_first');
    expect(bays[1].bayId).toBe('bay_second');
    expect(warnings).toEqual([]);
  });

  it('preserves the default service shape on every bay', () => {
    const { bays } = deriveBays(stationId, 2, new Map());
    for (const bay of bays) {
      expect(bay.services).toHaveLength(1);
      expect(bay.services[0]).toEqual({
        serviceId: 'svc_wash_basic',
        serviceName: 'Basic Wash',
        available: true,
      });
    }
  });

  it('warns on bayId_<N> beyond bayCount but still returns deterministic bays', () => {
    const { bays, warnings } = deriveBays(
      stationId,
      2,
      new Map([['bayId_3', 'bay_extra']]),
    );
    expect(bays).toHaveLength(2);
    expect(bays[0].bayId).toBe(`bay_${stationHex}01`);
    expect(bays[1].bayId).toBe(`bay_${stationHex}02`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('out of range');
    expect(warnings[0]).toContain('bayCount=2');
    expect(warnings[0]).toContain('bay #3');
  });

  it('warns on bayId_0 (below valid range)', () => {
    const { warnings } = deriveBays(
      stationId,
      2,
      new Map([['bayId_0', 'bay_zero']]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('out of range');
    expect(warnings[0]).toContain('bay #0');
  });

  it('warns on unrelated keys (not bayId_<N>)', () => {
    const { bays, warnings } = deriveBays(
      stationId,
      2,
      new Map([['serviceId_1', 'svc_premium']]),
    );
    expect(bays[0].bayId).toBe(`bay_${stationHex}01`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not recognized by connect mode');
    expect(warnings[0]).toContain('serviceId_1');
  });

  it('honors bayCount=1 (single-bay station)', () => {
    const { bays, warnings } = deriveBays(
      stationId,
      1,
      new Map([['bayId_1', 'bay_only']]),
    );
    expect(bays).toHaveLength(1);
    expect(bays[0].bayId).toBe('bay_only');
    expect(bays[0].bayNumber).toBe(1);
    expect(warnings).toEqual([]);
  });

  it('honors bayCount=4 (multi-bay station)', () => {
    const { bays, warnings } = deriveBays(
      stationId,
      4,
      new Map([
        ['bayId_2', 'bay_b'],
        ['bayId_4', 'bay_d'],
      ]),
    );
    expect(bays).toHaveLength(4);
    expect(bays[0].bayId).toBe(`bay_${stationHex}01`);
    expect(bays[1].bayId).toBe('bay_b');
    expect(bays[2].bayId).toBe(`bay_${stationHex}03`);
    expect(bays[3].bayId).toBe('bay_d');
    expect(warnings).toEqual([]);
  });

  it('combines override-warn + unrelated-warn in a single call', () => {
    const { warnings } = deriveBays(
      stationId,
      2,
      new Map([
        ['bayId_1', 'bay_first'],
        ['bayId_5', 'bay_oor'],
        ['foo', 'bar'],
      ]),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.some(w => w.includes('bay #5'))).toBe(true);
    expect(warnings.some(w => w.includes('foo'))).toBe(true);
  });

  it('strips stn_ prefix from stationId when deriving default bayIds', () => {
    const { bays } = deriveBays('stn_abcdef01', 2, new Map());
    expect(bays[0].bayId).toBe('bay_abcdef0101');
    expect(bays[1].bayId).toBe('bay_abcdef0102');
  });

  it('uses the raw stationId when no stn_ prefix is present', () => {
    const { bays } = deriveBays('rawstation', 1, new Map());
    expect(bays[0].bayId).toBe('bay_rawstation01');
  });
});
