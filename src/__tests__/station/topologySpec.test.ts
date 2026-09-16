import { describe, it, expect } from 'vitest';
import {
  parseTopologySpec,
  formatTopologySpec,
  denseTopology,
} from '../../station/topologySpec.js';

describe('parseTopologySpec — the shape a station declares', () => {
  it('one bay, one program', () => {
    expect(parseTopologySpec('1:1')).toEqual([
      { bayNumber: 1, programs: [{ programNumber: 1, label: 'Program 1' }] },
    ]);
  });

  it('several programs in one bay, comma separated', () => {
    expect(parseTopologySpec('1:1,2,5')).toEqual([
      {
        bayNumber: 1,
        programs: [
          { programNumber: 1, label: 'Program 1' },
          { programNumber: 2, label: 'Program 2' },
          { programNumber: 5, label: 'Program 5' },
        ],
      },
    ]);
  });

  it('several bays, semicolon separated', () => {
    const bays = parseTopologySpec('1:1;2:1,2');
    expect(bays.map(b => b.bayNumber)).toEqual([1, 2]);
    expect(bays[1].programs.map(p => p.programNumber)).toEqual([1, 2]);
  });

  it('a NON-DENSE bay set survives — {1,3} is a conforming declaration', () => {
    // provisioning-request.schema.json on bayNumber: "The set of bayNumber values
    // across bays need NOT be dense — {1,3} is a conforming declaration for a
    // station whose bay 2 was never fitted."
    expect(parseTopologySpec('1:1;3:1').map(b => b.bayNumber)).toEqual([1, 3]);
  });

  it('a non-dense PROGRAM set survives too', () => {
    expect(parseTopologySpec('1:7,9').map(b => b.programs.map(p => p.programNumber))).toEqual([[7, 9]]);
  });

  it('bays and programs come back SORTED, so two spellings of one topology are one value', () => {
    expect(parseTopologySpec('3:2,1;1:1')).toEqual(parseTopologySpec('1:1;3:1,2'));
  });

  it('whitespace around the separators is ignored', () => {
    expect(parseTopologySpec(' 1 : 1 , 2 ; 2 : 3 ')).toEqual(parseTopologySpec('1:1,2;2:3'));
  });

  it('a trailing separator is not a bay', () => {
    expect(parseTopologySpec('1:1;')).toHaveLength(1);
  });
});

describe('parseTopologySpec — every bound comes from the schema, and each names itself', () => {
  it('refuses an empty spec', () => {
    expect(() => parseTopologySpec('')).toThrow(/at least one bay/i);
    expect(() => parseTopologySpec('   ')).toThrow(/at least one bay/i);
  });

  it('refuses a bay with no programs (minItems 1)', () => {
    expect(() => parseTopologySpec('1:')).toThrow(/at least one program/i);
    expect(() => parseTopologySpec('1')).toThrow(/bayNumber:programNumber/);
  });

  it('refuses bayNumber outside 1..64', () => {
    expect(() => parseTopologySpec('0:1')).toThrow(/bayNumber.*1\.\.64/);
    expect(() => parseTopologySpec('65:1')).toThrow(/bayNumber.*1\.\.64/);
  });

  it('refuses programNumber outside 1..32', () => {
    expect(() => parseTopologySpec('1:0')).toThrow(/programNumber.*1\.\.32/);
    expect(() => parseTopologySpec('1:33')).toThrow(/programNumber.*1\.\.32/);
  });

  it('refuses a non-integer', () => {
    expect(() => parseTopologySpec('1.5:1')).toThrow(/integer/i);
    expect(() => parseTopologySpec('1:x')).toThrow(/integer/i);
  });

  it('refuses a duplicate bayNumber — the mapping would be ambiguous', () => {
    expect(() => parseTopologySpec('1:1;1:2')).toThrow(/duplicate bayNumber/i);
  });

  it('refuses a duplicate programNumber within a bay', () => {
    expect(() => parseTopologySpec('1:1,1')).toThrow(/duplicate programNumber/i);
  });

  it('accepts the same programNumber in DIFFERENT bays — it is scoped to its bay', () => {
    expect(() => parseTopologySpec('1:1;2:1')).not.toThrow();
  });

  it('refuses more than 64 bays (maxItems 64)', () => {
    const tooMany = Array.from({ length: 65 }, (_, i) => `${i + 1}:1`).join(';');
    expect(() => parseTopologySpec(tooMany)).toThrow(/bayNumber.*1\.\.64/);
  });

  it('refuses more than 32 programs in a bay (maxItems 32)', () => {
    const tooMany = `1:${Array.from({ length: 33 }, (_, i) => i + 1).join(',')}`;
    expect(() => parseTopologySpec(tooMany)).toThrow(/programNumber.*1\.\.32/);
  });

  it('the derived label satisfies the schema at every legal programNumber', () => {
    // label: minLength 1, maxLength 32, pattern ^[\x20-\x7E]+$
    for (let n = 1; n <= 32; n++) {
      const [bay] = parseTopologySpec(`1:${n}`);
      const { label } = bay.programs[0];
      expect(label.length).toBeGreaterThanOrEqual(1);
      expect(label.length).toBeLessThanOrEqual(32);
      expect(label).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it('labels are unique within a bay, which the schema requires', () => {
    const [bay] = parseTopologySpec('1:1,2,3');
    const labels = bay.programs.map(p => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('denseTopology — what a bare bay count has always meant', () => {
  it('is 1..N with one program each, byte-identical to the historical default', () => {
    expect(denseTopology(2)).toEqual([
      { bayNumber: 1, programs: [{ programNumber: 1, label: 'Basic Wash' }] },
      { bayNumber: 2, programs: [{ programNumber: 1, label: 'Basic Wash' }] },
    ]);
  });

  it('refuses a count outside 1..64', () => {
    expect(() => denseTopology(0)).toThrow(/1\.\.64/);
    expect(() => denseTopology(65)).toThrow(/1\.\.64/);
  });
});

describe('formatTopologySpec — round trips, so a run can print what it declared', () => {
  it('parse(format(x)) === x for a non-dense topology', () => {
    const spec = '1:1,2;3:5;7:1';
    expect(formatTopologySpec(parseTopologySpec(spec))).toBe(spec);
    expect(parseTopologySpec(formatTopologySpec(parseTopologySpec(spec)))).toEqual(parseTopologySpec(spec));
  });

  it('formats the dense default too', () => {
    expect(formatTopologySpec(denseTopology(3))).toBe('1:1;2:1;3:1');
  });
});
