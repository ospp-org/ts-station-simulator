import { describe, it, expect } from 'vitest';
import { parseUserVars } from '../../cli/userVars.js';

describe('parseUserVars', () => {
  it('returns an empty map for empty input', () => {
    expect(parseUserVars([]).size).toBe(0);
  });

  it('parses a single KEY=VALUE pair', () => {
    const out = parseUserVars(['bayId_1=bay_realbay1']);
    expect(out.get('bayId_1')).toBe('bay_realbay1');
    expect(out.size).toBe(1);
  });

  it('accumulates multiple pairs', () => {
    const out = parseUserVars([
      'bayId_1=bay_aa',
      'bayId_2=bay_bb',
      'stationId=stn_cc',
    ]);
    expect(out.size).toBe(3);
    expect(out.get('bayId_1')).toBe('bay_aa');
    expect(out.get('bayId_2')).toBe('bay_bb');
    expect(out.get('stationId')).toBe('stn_cc');
  });

  it('later occurrences overwrite earlier ones (last-write semantics)', () => {
    const out = parseUserVars(['bayId_1=bay_first', 'bayId_1=bay_second']);
    expect(out.get('bayId_1')).toBe('bay_second');
    expect(out.size).toBe(1);
  });

  it('accepts hyphenated values (UUIDs)', () => {
    const out = parseUserVars(['orgId=550e8400-e29b-41d4-a716-446655440000']);
    expect(out.get('orgId')).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('accepts underscored values', () => {
    const out = parseUserVars(['serviceId_1=svc_wash_basic']);
    expect(out.get('serviceId_1')).toBe('svc_wash_basic');
  });

  it('rejects missing equals sign', () => {
    expect(() => parseUserVars(['bayId_1bay_xx'])).toThrow(/KEY=VALUE form/);
  });

  it('rejects empty key', () => {
    expect(() => parseUserVars(['=value'])).toThrow(/KEY=VALUE form/);
  });

  it('rejects empty value', () => {
    expect(() => parseUserVars(['bayId_1='])).toThrow(/must not be empty/);
  });

  it('rejects keys starting with a digit', () => {
    expect(() => parseUserVars(['1bay=bay_xx'])).toThrow(/identifier pattern/);
  });

  it('rejects keys with hyphens', () => {
    expect(() => parseUserVars(['bay-id=bay_xx'])).toThrow(/identifier pattern/);
  });

  it('rejects keys with spaces', () => {
    expect(() => parseUserVars(['bay id=bay_xx'])).toThrow(/identifier pattern/);
  });

  it('rejects values with template injection chars', () => {
    expect(() => parseUserVars(['bayId_1=bay_{{evil}}'])).toThrow(/must match/);
  });

  it('rejects values with spaces', () => {
    expect(() => parseUserVars(['bayId_1=bay one'])).toThrow(/must match/);
  });

  it('rejects values with shell metacharacters', () => {
    expect(() => parseUserVars(['bayId_1=bay;rm'])).toThrow(/must match/);
    expect(() => parseUserVars(['bayId_1=bay$VAR'])).toThrow(/must match/);
    expect(() => parseUserVars(['bayId_1=bay|x'])).toThrow(/must match/);
  });

  it('rejects values with extra equals signs (= belongs only to KEY/VALUE split)', () => {
    expect(() => parseUserVars(['bayId_1=a=b'])).toThrow(/must match/);
  });
});
