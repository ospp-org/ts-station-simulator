import { describe, it, expect } from 'vitest';
import { buildTeardownSql, type PoolBootstrapHandle } from '../../../scenarios/bootstrap/PoolBootstrap.js';
import { StationPool } from '../../../scenarios/stations/StationPool.js';
import REFUSALS from '../../fixtures/deletion-refusals.json' with { type: 'json' };

/**
 * THE TEARDOWN ORDER, AGAINST THE ORDER THE SERVER'S REFUSALS TEACH.
 *
 * csms-server @ 8f167043 carries a deletion contract (ADR-0013): soft delete for
 * station, service and location, retirement for a station model, and a 409 per door
 * that NAMES the blocking objects and spells out the order to take them in. Those
 * refusals are recorded verbatim in `deletion-refusals.json` beside this file.
 *
 * This repo's teardown does not travel through those routes — it is one FK-ordered
 * SQL transaction shipped over SSH (`runUatSql`), so it never sees a 409. That does
 * not make the contract irrelevant: the ORDER the refusals teach is the same order
 * the SQL has to take, because both are the same foreign-key graph read from the two
 * ends. A refusal saying "delete the stations first, then the location" and a
 * `DELETE FROM locations` placed before `DELETE FROM stations` are the same defect
 * stated twice. So the recorded refusals are used here as the reference the generated
 * SQL is checked against.
 *
 * THE REGRESSION THE LAST GROUP PINS. `locations.organization_id` is
 * `REFERENCES organizations(id)` with no ON DELETE clause — NO ACTION — while
 * `stations.organization_id` is ON DELETE CASCADE
 * (`2026_05_01_060003_add_organization_id_to_stations.php:24`). So a leftover station
 * cannot block the org delete and a leftover LOCATION can, and does. The teardown
 * deleted exactly one location, `handle.locationId`, the one the bootstrap made. Every
 * pool-compatible scenario that declares `creates: location` makes another one inside
 * the SAME run org — three of them do today — and `--keep-created` keeps those. The
 * whole teardown is one transaction, so that single FK violation aborted all of it and
 * the run reported a warning while leaving the entire per-run world on the server.
 */

const RUN_ORG = '019ef000-0000-7000-8000-000000000001';
const RUN_LOCATION = '019e81fb-58db-7173-89b6-d1ae08cf9a0e';

function handle(overrides: Partial<PoolBootstrapHandle> = {}): PoolBootstrapHandle {
  return {
    orgId: RUN_ORG,
    createdOrgId: RUN_ORG,
    ephemeralOwnerEmail: 'sim-pool-owner-r1stamp@onestoppay.dev',
    locationId: RUN_LOCATION,
    stationIds: ['stn_aaaa1111'],
    certFiles: [],
    seededServiceIds: [],
    identityCredentials: [],
    pool: new StationPool(),
    ...overrides,
  };
}

/** Index of the first statement deleting from `table`, or -1. */
function deleteIndex(sql: string, table: string): number {
  return sql
    .split('\n')
    .findIndex((line) => new RegExp(`DELETE FROM ${table}\\b`).test(line));
}

function expectBefore(sql: string, earlier: string, later: string): void {
  const a = deleteIndex(sql, earlier);
  const b = deleteIndex(sql, later);
  expect(a, `no DELETE FROM ${earlier} in the teardown`).toBeGreaterThan(-1);
  expect(b, `no DELETE FROM ${later} in the teardown`).toBeGreaterThan(-1);
  expect(a, `DELETE FROM ${earlier} must precede DELETE FROM ${later}`).toBeLessThan(b);
}

describe('teardown order agrees with the order the server refusals teach', () => {
  it('the recorded contract is the four doors it claims to be (fixture integrity)', () => {
    expect(Object.keys(REFUSALS).filter((k) => !k.startsWith('_'))).toEqual([
      'station', 'service', 'location', 'station_model', 'organization',
    ]);
    // Every ADR-0013 door answers 409 and, on the four DeletionRefusedException ones,
    // names its cause in `details.reason`. The organization door is the odd one out.
    for (const [door, spec] of Object.entries(REFUSALS)) {
      if (door.startsWith('_')) continue;
      for (const r of (spec as { refusals: Array<Record<string, unknown>> }).refusals) {
        expect(r.status, `${door} refuses with 409`).toBe(409);
      }
    }
  });

  it('"Delete them first, then delete the location" — stations go before locations', () => {
    expect(REFUSALS.location.refusals[0].details.reason).toBe('location_has_stations');
    expectBefore(buildTeardownSql(handle()), 'stations', 'locations');
  });

  it('"Let it settle, then delete the station" — sessions go before bays and stations', () => {
    expect(REFUSALS.station.refusals[0].details.reason).toBe('live_session');
    const sql = buildTeardownSql(handle());
    expectBefore(sql, 'sessions', 'bays');
    expectBefore(sql, 'sessions', 'stations');
  });

  it('"Let the batch finish" / "Let the reservation lapse" — both go before their bay', () => {
    expect(REFUSALS.station.refusals[1].details.reason).toBe('unit_batch_in_progress');
    expect(REFUSALS.station.refusals[2].details.reason).toBe('bay_reserved');
    const sql = buildTeardownSql(handle());
    expectBefore(sql, 'unit_batches', 'bays');
    expectBefore(sql, 'reservations', 'bays');
  });

  it('locations go before organizations — the NO-ACTION FK that aborts the transaction', () => {
    expectBefore(buildTeardownSql(handle()), 'locations', 'organizations');
  });

  describe('a location this run created but the handle does not name', () => {
    it('is still swept, because it is inside an org this run minted', () => {
      const sql = buildTeardownSql(handle());
      const line = sql.split('\n').find((l) => /DELETE FROM locations\b/.test(l));
      expect(line).toBeDefined();
      // Scoped by the RUN-CREATED org, never by a bare or reused one: `createdOrgId` is
      // only ever set when this run minted the organization, so everything inside it is
      // this run's by construction. `orgId` alone would not do — the bootstrap sometimes
      // REUSES an organization, and that one holds other runs' locations.
      expect(line).toContain(`organization_id = '${RUN_ORG}'`);
    });

    it('is NOT swept when no org was created this run — nothing else proves ownership', () => {
      const sql = buildTeardownSql(handle({ createdOrgId: undefined }));
      const line = sql.split('\n').find((l) => /DELETE FROM locations\b/.test(l));
      expect(line).toBeDefined();
      expect(line).not.toContain('organization_id');
      expect(line).toContain(RUN_LOCATION);
    });

    it('sweeps that org\'s leftover STATIONS too, so the location delete cannot block either', () => {
      const sql = buildTeardownSql(handle());
      const line = sql.split('\n').find((l) => /DELETE FROM stations\b/.test(l));
      expect(line).toContain(`organization_id = '${RUN_ORG}'`);
    });
  });
});
