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
    // The warning names the bays this station actually HAS, not a count: a
    // non-contiguous topology has no "range" to be outside of.
    expect(warnings[0]).toContain('names no bay');
    expect(warnings[0]).toContain('declared bays: 1, 2');
    expect(warnings[0]).toContain('bayId_3');
  });

  it('warns on bayId_0 (names no bay)', () => {
    const { warnings } = deriveBays(
      stationId,
      2,
      new Map([['bayId_0', 'bay_zero']]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('names no bay');
    expect(warnings[0]).toContain('bayId_0');
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
    expect(warnings.some(w => w.includes('bayId_5'))).toBe(true);
    expect(warnings.some(w => w.includes('foo'))).toBe(true);
  });

  /*
   * The pairs the SERVER issued win over anything derived.
   *
   * `connect` used to invent `bay_<stationHex><NN>` and ignore the `bays.json` that
   * `provision` had just written beside the key. The server then addresses a REAL bay
   * — a `TriggerMessage` carrying a `bayId`, which the guide documents as the server
   * asking a bay's state back — and the station denied owning it. Measured against
   * UAT: the process died on `Unknown bay`, 3 runs out of 3, ~40-60s after boot, and
   * both bays stayed `unknown` for the whole run.
   */
  it('prefers the provisioned pairs over derived ids', () => {
    const { bays, warnings } = deriveBays(stationId, 2, new Map(), [
      { bayId: 'bay_19917fa0', bayNumber: 1 },
      { bayId: 'bay_0c078392', bayNumber: 2 },
    ]);
    expect(bays.map(b => b.bayId)).toEqual(['bay_19917fa0', 'bay_0c078392']);
    expect(warnings).toEqual([]);
  });

  it('keeps a non-contiguous topology instead of flattening it to 1..n', () => {
    // A model whose programs sit on bays {1,3} yields bayNumber 3 at index 1.
    // Deriving would have produced bays 1 and 2 — inventing a bay 2 that does not
    // exist and losing bay 3, which does.
    const { bays } = deriveBays(stationId, 2, new Map(), [
      { bayId: 'bay_one', bayNumber: 1 },
      { bayId: 'bay_three', bayNumber: 3 },
    ]);
    expect(bays.map(b => b.bayNumber)).toEqual([1, 3]);
    expect(bays.map(b => b.bayId)).toEqual(['bay_one', 'bay_three']);
  });

  it('lets an explicit --var override a provisioned pair', () => {
    const { bays, warnings } = deriveBays(stationId, 2, new Map([['bayId_2', 'bay_manual']]), [
      { bayId: 'bay_one', bayNumber: 1 },
      { bayId: 'bay_two', bayNumber: 2 },
    ]);
    expect(bays.map(b => b.bayId)).toEqual(['bay_one', 'bay_manual']);
    expect(warnings).toEqual([]);
  });

  it('accepts --var for a provisioned bay number outside 1..bayCount', () => {
    const { bays, warnings } = deriveBays(stationId, 2, new Map([['bayId_3', 'bay_manual']]), [
      { bayId: 'bay_one', bayNumber: 1 },
      { bayId: 'bay_three', bayNumber: 3 },
    ]);
    expect(bays.map(b => b.bayId)).toEqual(['bay_one', 'bay_manual']);
    expect(warnings).toEqual([]);
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
