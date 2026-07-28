import { describe, it, expect } from 'vitest';
import { assertBayIds } from '../../provisioning/assertBayIds.js';

const OK = 'bay_0123456789abcdef0123456789abcdef';
const OK2 = 'bay_fedcba9876543210fedcba9876543210';

const ctx = { context: 'T', expectedCount: 2 } as const;

describe('assertBayIds', () => {
  it('accepts a dense, well-formed array whose length equals bayCount', () => {
    expect(assertBayIds([OK, OK2], ctx)).toEqual([OK, OK2]);
  });

  it('rejects a missing bayIds field', () => {
    expect(() => assertBayIds(undefined, ctx)).toThrow(/missing bayIds/);
  });

  it('rejects a non-array bayIds', () => {
    expect(() => assertBayIds({ 1: OK }, ctx)).toThrow(/not an array/);
  });

  it('rejects an empty array', () => {
    expect(() => assertBayIds([], ctx)).toThrow(/empty bayIds/);
  });

  it('rejects a malformed bay id and names its index', () => {
    expect(() => assertBayIds([OK, 'nope'], ctx)).toThrow(/bayIds\[1\] is not a well-formed bay id/);
  });

  it('rejects duplicates, because the index-to-bayNumber mapping would be ambiguous', () => {
    expect(() => assertBayIds([OK, OK], ctx)).toThrow(/duplicates/);
  });

  it('rejects a SURPLUS — the shape a replay answered from live rows returns', () => {
    // The server bound 2 bays; a boot minted 2 more inside the token TTL and a
    // replay reconstructed from live rows. This is the csms-server defect the
    // gate exists to catch, and a lenient reader accepts it silently.
    expect(() => assertBayIds([OK, OK2, 'bay_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bay_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'], ctx))
      .toThrow(/has 4 entries but the request declared bayCount=2/);
  });

  it('rejects a GAP — fewer entries than the declared bayCount', () => {
    expect(() => assertBayIds([OK], ctx)).toThrow(/has 1 entries but the request declared bayCount=2/);
  });

  it('names the caller in the message so a scenario log identifies the step', () => {
    expect(() => assertBayIds([], { context: 'ProvisionStep', expectedCount: 1 }))
      .toThrow(/^ProvisionStep:/);
  });
});
