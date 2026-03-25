import { describe, it, expect } from 'vitest';
import {
  generateStationId,
  generateBayId,
  generateServiceId,
  generateSerialNumber,
} from '../../station/StationConfig.js';

describe('generateStationId', () => {
  it('returns string matching stn_ + 8 hex chars', () => {
    const id = generateStationId();
    expect(id).toMatch(/^stn_[0-9a-f]{8}$/);
  });

  it('generates unique values on each call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateStationId()));
    expect(ids.size).toBe(50);
  });
});

describe('generateBayId', () => {
  it('returns string matching bay_ + 8 hex chars', () => {
    const id = generateBayId();
    expect(id).toMatch(/^bay_[0-9a-f]{8}$/);
  });

  it('generates unique values on each call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateBayId()));
    expect(ids.size).toBe(50);
  });
});

describe('generateServiceId', () => {
  it('returns svc_wash_basic for "Wash Basic"', () => {
    expect(generateServiceId('Wash Basic')).toBe('svc_wash_basic');
  });

  it('lowercases and replaces non-alphanumeric chars with underscores', () => {
    expect(generateServiceId('Premium Wash!')).toBe('svc_premium_wash_');
  });
});

describe('generateSerialNumber', () => {
  it('returns string matching SN- + 8 uppercase hex chars', () => {
    const sn = generateSerialNumber();
    expect(sn).toMatch(/^SN-[0-9A-F]{8}$/);
  });

  it('generates unique values on each call', () => {
    const sns = new Set(Array.from({ length: 50 }, () => generateSerialNumber()));
    expect(sns.size).toBe(50);
  });
});
