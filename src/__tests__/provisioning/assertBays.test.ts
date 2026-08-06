import { describe, it, expect } from 'vitest';
import { assertBays } from '../../provisioning/assertBays.js';

// ---------------------------------------------------------------------------
// v0.11.0 replaced `bayIds[]` with `bays[]` — pairs, not positions.
//
// provisioning-response.schema.json:21 — "Server-assigned bay identifiers, each
// paired EXPLICITLY with the bayNumber the station declared for it. This is the
// mapping the station needs and the only one it is given."
//
// The old reader's premise is now FALSE in every part. It said "the bayNumber is
// not a member; it is the array INDEX", and enforced that the array be "ordered
// and dense … covering 1..bayCount with no gaps". A station whose bay 2 was
// never fitted declares {1,3}; under the old rule the response came back as a
// two-element array and the station re-indexed bay 3 to slot 2 — silently
// binding the wrong hardware. The density check that was the file's centrepiece
// is exactly the bug.
//
// What survives is the STRICTNESS, which is the module's real value: refuse a
// response a conforming station could not act on.
// ---------------------------------------------------------------------------

const OPTS = { context: 'T', declaredBayNumbers: [1, 3] };

describe('assertBays — pairs, not positions', () => {
  it('accepts an explicit pairing of the declared set', () => {
    expect(
      assertBays(
        [
          { bayId: 'bay_aaaaaaaa', bayNumber: 1 },
          { bayId: 'bay_bbbbbbbb', bayNumber: 3 },
        ],
        OPTS,
      ),
    ).toEqual([
      { bayId: 'bay_aaaaaaaa', bayNumber: 1 },
      { bayId: 'bay_bbbbbbbb', bayNumber: 3 },
    ]);
  });

  it('accepts the pairs in any order — order carries no meaning now', () => {
    // Under the old contract order WAS the meaning. Asserting that it no longer
    // is, is the point: a server free to answer in any order must not be able to
    // break a station by doing so.
    const out = assertBays(
      [
        { bayId: 'bay_bbbbbbbb', bayNumber: 3 },
        { bayId: 'bay_aaaaaaaa', bayNumber: 1 },
      ],
      OPTS,
    );

    expect(out.find(p => p.bayNumber === 1)?.bayId).toBe('bay_aaaaaaaa');
    expect(out.find(p => p.bayNumber === 3)?.bayId).toBe('bay_bbbbbbbb');
  });

  it('accepts a NON-DENSE declared set, which the old reader refused', () => {
    // {1,3} for a station whose bay 2 was never fitted. This is the case the
    // density check made impossible to express.
    expect(() =>
      assertBays(
        [
          { bayId: 'bay_aaaaaaaa', bayNumber: 1 },
          { bayId: 'bay_bbbbbbbb', bayNumber: 3 },
        ],
        { context: 'T', declaredBayNumbers: [1, 3] },
      ),
    ).not.toThrow();
  });

  it('refuses a set that is not the one declared', () => {
    // The replay case the old length check caught, now stated as what it always
    // meant: a token that bound {1,3}, replayed after a boot minted more bays,
    // comes back with a set that is not the declared one.
    expect(() =>
      assertBays(
        [
          { bayId: 'bay_aaaaaaaa', bayNumber: 1 },
          { bayId: 'bay_bbbbbbbb', bayNumber: 3 },
          { bayId: 'bay_cccccccc', bayNumber: 4 },
        ],
        OPTS,
      ),
    ).toThrow(/declared/i);
  });

  it('refuses a missing bayNumber from the declared set', () => {
    expect(() =>
      assertBays([{ bayId: 'bay_aaaaaaaa', bayNumber: 1 }], OPTS),
    ).toThrow(/declared/i);
  });

  it('refuses a malformed bayId', () => {
    expect(() =>
      assertBays(
        [
          { bayId: 'bay_ZZZZ', bayNumber: 1 },
          { bayId: 'bay_bbbbbbbb', bayNumber: 3 },
        ],
        OPTS,
      ),
    ).toThrow(/well-formed/i);
  });

  it('refuses a duplicate bayNumber — the mapping would be ambiguous', () => {
    expect(() =>
      assertBays(
        [
          { bayId: 'bay_aaaaaaaa', bayNumber: 1 },
          { bayId: 'bay_bbbbbbbb', bayNumber: 1 },
        ],
        { context: 'T', declaredBayNumbers: [1] },
      ),
    ).toThrow(/duplicate/i);
  });

  it('refuses a duplicate bayId — two bay numbers sharing one identifier', () => {
    expect(() =>
      assertBays(
        [
          { bayId: 'bay_aaaaaaaa', bayNumber: 1 },
          { bayId: 'bay_aaaaaaaa', bayNumber: 3 },
        ],
        OPTS,
      ),
    ).toThrow(/duplicate/i);
  });

  it('refuses an entry that is a bare string — the old wire shape', () => {
    // A server still emitting the 0.10.0 array must be refused loudly, not
    // coerced. Silently accepting it would put the positional bug back.
    expect(() => assertBays(['bay_aaaaaaaa', 'bay_bbbbbbbb'], OPTS)).toThrow();
  });

  it('refuses a non-array and an empty array', () => {
    expect(() => assertBays(undefined, OPTS)).toThrow(/missing/i);
    expect(() => assertBays([], OPTS)).toThrow(/empty/i);
  });
});
