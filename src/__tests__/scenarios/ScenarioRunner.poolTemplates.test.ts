import { describe, it, expect } from 'vitest';
import { _substituteTemplatesForTesting } from '../../scenarios/ScenarioRunner.js';
import { StationPool } from '../../scenarios/stations/StationPool.js';

const NO_VARS = new Map<string, string>();
const NO_CAPTURED = new Map<string, unknown>();

describe('Template substitution — pool.* namespace', () => {
  function poolWith(entries: Array<{ stationId: string; bayIds: string[]; certPath?: string }>): StationPool {
    const p = new StationPool();
    for (const e of entries) {
      p.register(e);
    }
    return p;
  }

  it('renders {{ pool.first.id }}', () => {
    const pool = poolWith([{ stationId: 'stn_alpha', bayIds: ['bay_a1', 'bay_a2'] }]);
    expect(
      _substituteTemplatesForTesting('{{ pool.first.id }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toBe('stn_alpha');
  });

  it('renders {{ pool.first.stationId }} as alias for .id', () => {
    const pool = poolWith([{ stationId: 'stn_alpha', bayIds: ['bay_a1'] }]);
    expect(
      _substituteTemplatesForTesting('{{ pool.first.stationId }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toBe('stn_alpha');
  });

  it('renders {{ pool.first.bayIds[0] }} and bayIds[1]', () => {
    const pool = poolWith([{ stationId: 'stn_alpha', bayIds: ['bay_x', 'bay_y'] }]);
    expect(
      _substituteTemplatesForTesting('{{ pool.first.bayIds[0] }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toBe('bay_x');
    expect(
      _substituteTemplatesForTesting('{{ pool.first.bayIds[1] }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toBe('bay_y');
  });

  it('renders {{ pool.station[1].id }} and pool.stations[1].bayIds[0]', () => {
    const pool = poolWith([
      { stationId: 'stn_first', bayIds: ['bay_f'] },
      { stationId: 'stn_second', bayIds: ['bay_s0', 'bay_s1'] },
    ]);
    expect(
      _substituteTemplatesForTesting('{{ pool.station[1].id }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toBe('stn_second');
    expect(
      _substituteTemplatesForTesting('{{ pool.stations[1].bayIds[1] }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toBe('bay_s1');
  });

  it('renders {{ pool.size }}', () => {
    const pool = poolWith([
      { stationId: 'a', bayIds: [] },
      { stationId: 'b', bayIds: [] },
      { stationId: 'c', bayIds: [] },
    ]);
    expect(
      _substituteTemplatesForTesting('{{ pool.size }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toBe('3');
  });

  it('renders {{ pool.first.certPath }} when available', () => {
    const pool = poolWith([
      { stationId: 'stn_c', bayIds: ['bay_1'], certPath: '/tmp/certs/stn_c.pem' },
    ]);
    expect(
      _substituteTemplatesForTesting('{{ pool.first.certPath }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toBe('/tmp/certs/stn_c.pem');
  });

  it('throws when no pool is provided', () => {
    expect(() =>
      _substituteTemplatesForTesting('{{ pool.first.id }}', NO_VARS, NO_CAPTURED),
    ).toThrow(/no station pool has been initialised/);
  });

  it('throws when pool is empty and pool.first is referenced', () => {
    const pool = new StationPool();
    expect(() =>
      _substituteTemplatesForTesting('{{ pool.first.id }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toThrow(/pool.first.* but the pool is empty/);
  });

  it('throws when pool.station[N] index out of range', () => {
    const pool = poolWith([{ stationId: 'stn_only', bayIds: [] }]);
    expect(() =>
      _substituteTemplatesForTesting('{{ pool.station[5].id }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toThrow(/pool.station\[5\] but only 1 entries are registered/);
  });

  it('throws when bayIds[N] index out of range', () => {
    const pool = poolWith([{ stationId: 'stn_x', bayIds: ['bay_a'] }]);
    expect(() =>
      _substituteTemplatesForTesting('{{ pool.first.bayIds[3] }}', NO_VARS, NO_CAPTURED, { pool }),
    ).toThrow(/bayIds index 3 out of range/);
  });

  it('substitutes pool templates inside nested objects', () => {
    const pool = poolWith([{ stationId: 'stn_alpha', bayIds: ['bay_x', 'bay_y'] }]);
    const result = _substituteTemplatesForTesting(
      { bay_id: '{{ pool.first.bayIds[0] }}', label: 'station-{{ pool.first.id }}' },
      NO_VARS,
      NO_CAPTURED,
      { pool },
    );
    expect(result).toEqual({ bay_id: 'bay_x', label: 'station-stn_alpha' });
  });
});

describe('Template substitution — provisioning.* namespace', () => {
  it('renders {{ provisioning.bayIds[0] }} and stationId', () => {
    const provisioning = { stationId: 'stn_real', bayIds: ['bay_real_a', 'bay_real_b'] };
    expect(
      _substituteTemplatesForTesting('{{ provisioning.bayIds[0] }}', NO_VARS, NO_CAPTURED, { provisioning }),
    ).toBe('bay_real_a');
    expect(
      _substituteTemplatesForTesting('{{ provisioning.bayIds[1] }}', NO_VARS, NO_CAPTURED, { provisioning }),
    ).toBe('bay_real_b');
    expect(
      _substituteTemplatesForTesting('{{ provisioning.stationId }}', NO_VARS, NO_CAPTURED, { provisioning }),
    ).toBe('stn_real');
  });

  it('renders certPath and keyPath when set', () => {
    const provisioning = {
      stationId: 'stn_p',
      bayIds: ['bay_a'],
      certPath: '/tmp/cert.pem',
      keyPath: '/tmp/key.pem',
    };
    expect(
      _substituteTemplatesForTesting('{{ provisioning.certPath }}', NO_VARS, NO_CAPTURED, { provisioning }),
    ).toBe('/tmp/cert.pem');
    expect(
      _substituteTemplatesForTesting('{{ provisioning.keyPath }}', NO_VARS, NO_CAPTURED, { provisioning }),
    ).toBe('/tmp/key.pem');
  });

  it('throws clearly when provisioning is not set', () => {
    expect(() =>
      _substituteTemplatesForTesting('{{ provisioning.bayIds[0] }}', NO_VARS, NO_CAPTURED),
    ).toThrow(/no provisioning artifact is available/);
  });

  it('throws when provisioning.bayIds index out of range', () => {
    const provisioning = { stationId: 'stn_p', bayIds: ['bay_a'] };
    expect(() =>
      _substituteTemplatesForTesting('{{ provisioning.bayIds[7] }}', NO_VARS, NO_CAPTURED, { provisioning }),
    ).toThrow(/bayIds index 7 out of range/);
  });
});
