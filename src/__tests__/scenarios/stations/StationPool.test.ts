import { describe, it, expect } from 'vitest';
import { StationPool } from '../../../scenarios/stations/StationPool.js';

describe('StationPool registry CRUD', () => {
  it('register() inserts a new entry and returns it with a generated clientIdSuffix', () => {
    const pool = new StationPool();
    const entry = pool.register({
      stationId: 'stn_pool_aabbccdd',
      bayIds: ['bay_1', 'bay_2'],
      certPath: '/tmp/cert.pem',
    });

    expect(entry.stationId).toBe('stn_pool_aabbccdd');
    expect(entry.bayIds).toEqual(['bay_1', 'bay_2']);
    expect(entry.certPath).toBe('/tmp/cert.pem');
    expect(entry.clientIdSuffix).toMatch(/^[0-9a-f-]{36}$/);
    expect(pool.size()).toBe(1);
  });

  it('register() honours an explicit clientIdSuffix', () => {
    const pool = new StationPool();
    const entry = pool.register({
      stationId: 'stn_x',
      bayIds: ['bay_a'],
      clientIdSuffix: 'fixed-suffix',
    });
    expect(entry.clientIdSuffix).toBe('fixed-suffix');
  });

  it('register() with a duplicate stationId replaces the entry (no duplication)', () => {
    const pool = new StationPool();
    pool.register({ stationId: 'stn_dup', bayIds: ['bay_old'] });
    pool.register({ stationId: 'stn_dup', bayIds: ['bay_new1', 'bay_new2'] });

    expect(pool.size()).toBe(1);
    expect(pool.get('stn_dup')?.bayIds).toEqual(['bay_new1', 'bay_new2']);
  });

  it('get() returns undefined for unknown stationIds', () => {
    const pool = new StationPool();
    pool.register({ stationId: 'stn_a', bayIds: [] });
    expect(pool.get('stn_missing')).toBeUndefined();
  });

  it('first() returns the first registered entry; undefined for empty pool', () => {
    const pool = new StationPool();
    expect(pool.first()).toBeUndefined();

    pool.register({ stationId: 'stn_first', bayIds: ['bay_1'] });
    pool.register({ stationId: 'stn_second', bayIds: ['bay_2'] });
    expect(pool.first()?.stationId).toBe('stn_first');
  });

  it('at() supports valid indices and returns undefined for out-of-range', () => {
    const pool = new StationPool();
    pool.register({ stationId: 'stn_0', bayIds: [] });
    pool.register({ stationId: 'stn_1', bayIds: [] });
    pool.register({ stationId: 'stn_2', bayIds: [] });

    expect(pool.at(0)?.stationId).toBe('stn_0');
    expect(pool.at(2)?.stationId).toBe('stn_2');
    expect(pool.at(3)).toBeUndefined();
    expect(pool.at(-1)).toBeUndefined();
  });

  it('list() returns all entries; size() matches', () => {
    const pool = new StationPool();
    pool.register({ stationId: 'a', bayIds: [] });
    pool.register({ stationId: 'b', bayIds: [] });
    pool.register({ stationId: 'c', bayIds: [] });

    expect(pool.size()).toBe(3);
    expect(pool.list().map((e) => e.stationId)).toEqual(['a', 'b', 'c']);
  });

  it('clear() empties the pool', () => {
    const pool = new StationPool();
    pool.register({ stationId: 'a', bayIds: [] });
    pool.register({ stationId: 'b', bayIds: [] });
    pool.clear();
    expect(pool.size()).toBe(0);
    expect(pool.first()).toBeUndefined();
  });

  it('register() defensively copies bayIds array', () => {
    const pool = new StationPool();
    const bays = ['bay_1'];
    pool.register({ stationId: 'stn_iso', bayIds: bays });
    bays.push('bay_2');
    expect(pool.get('stn_iso')?.bayIds).toEqual(['bay_1']);
  });
});
