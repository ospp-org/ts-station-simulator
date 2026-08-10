import { describe, it, expect } from 'vitest';
import { _getNestedValueForTesting as get } from '../../../scenarios/steps/ApiCallStep.js';

/**
 * `data.bays` comes back UNORDERED. Measured 2026-08-10 across three consecutive runs of
 * GET /admin/stations/{stn_*}: [2,3,4,1], [2,3,4,1], [3,4,1,2]. Index-based assertions on it
 * pin whichever row the database happened to return first.
 */

// Shape and ordering taken verbatim from a real maintenance-mode-all-bays response.
const BODY = {
  data: {
    stationId: 'stn_c6214428',
    bays: [
      { bayId: 'bay_a0ee', bayNumber: 3, status: 'unknown' },
      { bayId: 'bay_9d5f', bayNumber: 4, status: 'unknown' },
      { bayId: 'bay_fca2', bayNumber: 1, status: 'unavailable' },
      { bayId: 'bay_d410', bayNumber: 2, status: 'unavailable' },
    ],
  },
};

describe('getNestedValue — array selection by field', () => {
  it('selects by a numeric field, matching across the string/number boundary', () => {
    expect(get(BODY, 'data.bays[bayNumber=1].status')).toBe('unavailable');
    expect(get(BODY, 'data.bays[bayNumber=3].status')).toBe('unknown');
  });

  it('selects by a string field', () => {
    expect(get(BODY, 'data.bays[bayId=bay_d410].status')).toBe('unavailable');
  });

  it('is immune to the ordering that broke the index form', () => {
    const shuffled = { data: { bays: [...BODY.data.bays].reverse() } };
    expect(get(shuffled, 'data.bays[bayNumber=1].status')).toBe('unavailable');
    // The index form disagrees with itself across the two orderings — the bug this replaces.
    expect(get(BODY, 'data.bays.0.status')).not.toBe(get(shuffled, 'data.bays.0.status'));
  });

  it('returns undefined for no match, so the assertion FAILS loudly rather than passing', () => {
    expect(get(BODY, 'data.bays[bayNumber=9].status')).toBeUndefined();
    expect(get(BODY, 'data.bays[nosuchfield=1].status')).toBeUndefined();
  });

  it('returns undefined when the named field is not an array', () => {
    expect(get(BODY, 'data.stationId[x=1].status')).toBeUndefined();
  });

  it('leaves ordinary paths, index access and .length untouched', () => {
    expect(get(BODY, 'data.stationId')).toBe('stn_c6214428');
    expect(get(BODY, 'data.bays.length')).toBe(4);
    expect(get(BODY, 'data.bays.0.bayNumber')).toBe(3);
    expect(get(BODY, 'data.missing.deeper')).toBeUndefined();
  });
});

describe('selector values containing dots — the bug the bay case could not expose', () => {
  const FW = {
    data: [
      { firmware_version: '2.0.0', status: 'failed', error_text: 'Download failed: network error' },
      { firmware_version: '1.0.0', status: 'activated', error_text: null },
    ],
  };

  it('resolves a dotted value instead of splitting the path through it', () => {
    expect(get(FW, 'data[firmware_version=2.0.0].status')).toBe('failed');
    expect(get(FW, 'data[firmware_version=1.0.0].status')).toBe('activated');
  });

  it('picks the right row when only the dotted value differs', () => {
    expect(get(FW, 'data[firmware_version=2.0.0].error_text'))
      .toBe('Download failed: network error');
    expect(get(FW, 'data[firmware_version=1.0.0].error_text')).toBeNull();
  });

  it('still returns undefined for a dotted value that matches nothing', () => {
    expect(get(FW, 'data[firmware_version=9.9.9].status')).toBeUndefined();
  });

  it('handles a selector at the end of a path and one nested deeper', () => {
    const nested = { a: { b: [{ k: 'x.y', v: { deep: 1 } }] } };
    expect(get(nested, 'a.b[k=x.y].v.deep')).toBe(1);
  });
});
