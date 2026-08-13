import { describe, it, expect } from 'vitest';
import { ScenarioResourceLedger } from '../../../scenarios/bootstrap/ScenarioResources.js';
import { buildTeardownSql } from '../../../scenarios/bootstrap/PoolBootstrap.js';

/**
 * The ledger is what closes the standalone-run leak: cleanup used to be reachable ONLY
 * through `--bootstrap-pool`'s handle, so the three `scenarios/e2e/*` files — which carry
 * `skip_when_pooled` and therefore run outside it — created an org, a location, a station
 * and a user per run and removed none of them. Eight `E2E Org …` organizations were still
 * on UAT when this was written.
 *
 * These tests pin the two properties that make the fix safe rather than merely present:
 *
 *   1. Ownership is RECORDED, never inferred. Deleting an organization CASCADEs its roles,
 *      members, service definitions and remaining stations, so a teardown that guessed
 *      from a naming convention would eventually take a real tenant with it.
 *   2. The ledger REFUSES to under-report. A second organization or location cannot be
 *      silently dropped, because the run would then claim a clean teardown over a row it
 *      never touched.
 */
describe('ScenarioResourceLedger', () => {
  it('is empty until something is recorded, so a scenario that declares nothing tears down nothing', () => {
    expect(new ScenarioResourceLedger().isEmpty()).toBe(true);
  });

  it('records each kind and projects it onto the field buildTeardownSql deletes by', () => {
    const ledger = new ScenarioResourceLedger();
    ledger.record('organization', 'org-uuid-1', 'POST /api/v1/organizations → data.organization.id');
    ledger.record('location', 'loc-uuid-1', 'POST /api/v1/locations → data.id');
    ledger.record('station', 'stn_abcd1234', 'POST /api/v1/admin/stations → data.station_id');
    ledger.record('user', 'e2e-stn_abcd1234@onestoppay.dev', 'POST /api/v1/auth/register → user.email');

    const handle = ledger.toHandle();
    expect(handle.createdOrgId).toBe('org-uuid-1');
    expect(handle.locationId).toBe('loc-uuid-1');
    expect(handle.stationIds).toEqual(['stn_abcd1234']);
    expect(handle.createdUserEmails).toEqual(['e2e-stn_abcd1234@onestoppay.dev']);
    // Nothing was seeded by this path — the scenario's service definitions are written by
    // the server's own catalog handler inside the org and go with the org CASCADE.
    expect(handle.seededServiceIds).toEqual([]);
    expect(handle.identityCredentials).toEqual([]);
  });

  it('de-duplicates a repeated declaration of the same id', () => {
    const ledger = new ScenarioResourceLedger();
    ledger.record('station', 'stn_abcd1234', 'first');
    ledger.record('station', 'stn_abcd1234', 'second');
    expect(ledger.toHandle().stationIds).toEqual(['stn_abcd1234']);
  });

  it('records MULTIPLE stations and users — both are plural in the teardown handle', () => {
    const ledger = new ScenarioResourceLedger();
    ledger.record('station', 'stn_1', 'a');
    ledger.record('station', 'stn_2', 'b');
    ledger.record('user', 'a@test.local', 'c');
    ledger.record('user', 'b@test.local', 'd');
    const handle = ledger.toHandle();
    expect(handle.stationIds).toEqual(['stn_1', 'stn_2']);
    expect(handle.createdUserEmails).toEqual(['a@test.local', 'b@test.local']);
  });

  // The refusals. Both fields are singular in PoolBootstrapHandle, so a second value could
  // only be dropped — and a dropped org is a cascade-capable row left on the server under a
  // "teardown complete" line. Failing in-run is what keeps that from being discovered later.
  it('REFUSES a second organization, naming both ids', () => {
    const ledger = new ScenarioResourceLedger();
    ledger.record('organization', 'org-1', 'step 2');
    expect(() => ledger.record('organization', 'org-2', 'step 9'))
      .toThrow(/second organization \(org-2, from step 9\).*already holding org-1/s);
  });

  it('REFUSES a second location, naming both ids', () => {
    const ledger = new ScenarioResourceLedger();
    ledger.record('location', 'loc-1', 'step 4');
    expect(() => ledger.record('location', 'loc-2', 'step 5'))
      .toThrow(/second location \(loc-2, from step 5\).*already holding loc-1/s);
  });

  it('REFUSES an empty value — teardown would have nothing to delete by', () => {
    const ledger = new ScenarioResourceLedger();
    expect(() => ledger.record('organization', '', 'POST /organizations → data.id'))
      .toThrow(/must be a non-empty string/);
  });

  it('describe() names every resource and its origin, for the LEFTOVERS report', () => {
    const ledger = new ScenarioResourceLedger();
    ledger.record('organization', 'org-uuid-1', 'POST /api/v1/organizations → data.organization.id');
    ledger.recordArtifactDir('tests/artifacts/uat/stn_abcd1234');
    const text = ledger.describe();
    expect(text).toContain('org-uuid-1');
    expect(text).toContain('POST /api/v1/organizations → data.organization.id');
    expect(text).toContain('tests/artifacts/uat/stn_abcd1234');
  });

  it('an artifact dir alone makes the ledger non-empty (keys on disk are leftovers too)', () => {
    const ledger = new ScenarioResourceLedger();
    ledger.recordArtifactDir('tests/artifacts/uat/stn_abcd1234');
    expect(ledger.isEmpty()).toBe(false);
  });
});

describe('buildTeardownSql — scenario-created resources', () => {
  const ledger = (): ScenarioResourceLedger => {
    const l = new ScenarioResourceLedger();
    l.record('organization', 'org-uuid-1', 'POST /organizations');
    l.record('location', 'loc-uuid-1', 'POST /locations');
    l.record('station', 'stn_abcd1234', 'POST /admin/stations');
    l.record('user', 'e2e-stn_abcd1234@onestoppay.dev', 'POST /auth/register');
    return l;
  };

  it('deletes the station, its location, the created org, and the created user', () => {
    const sql = buildTeardownSql(ledger().toHandle());
    expect(sql).toContain("ARRAY['stn_abcd1234']::text[]");
    expect(sql).toContain("ARRAY['loc-uuid-1']::uuid[]");
    expect(sql).toContain("DELETE FROM organizations WHERE id = 'org-uuid-1';");
    expect(sql).toContain("DELETE FROM users WHERE email = ANY(ARRAY['e2e-stn_abcd1234@onestoppay.dev']::text[]);");
  });

  it('sweeps the created user BEFORE the organization — organization_members is a NO-ACTION child of both', () => {
    const sql = buildTeardownSql(ledger().toHandle());
    const userDelete = sql.indexOf("DELETE FROM users WHERE email = ANY(ARRAY['e2e-stn_abcd1234@onestoppay.dev']");
    const orgDelete = sql.indexOf("DELETE FROM organizations WHERE id = 'org-uuid-1';");
    expect(userDelete).toBeGreaterThan(-1);
    expect(orgDelete).toBeGreaterThan(-1);
    expect(userDelete).toBeLessThan(orgDelete);
  });

  // The scenario path reaches buildTeardownTestUsersSql through a NEW field
  // (createdUserEmails), so the C-018 protected-admin guard has to be re-proven over it —
  // an e2e file's `creates: user` points at a register response, and a scenario mis-authored
  // to run as the platform admin would otherwise hand its email straight to the sweep.
  it('carries the C-018 guard: a scenario that somehow recorded the platform admin is REFUSED', () => {
    const original = process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
    process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = 'e2e-platform-admin@onestoppay.ro';
    const l = new ScenarioResourceLedger();
    l.record('user', 'e2e-platform-admin@onestoppay.ro', 'POST /auth/register');
    const handle = l.toHandle();
    try {
      expect(() => buildTeardownSql(handle)).toThrow(/e2e-platform-admin@onestoppay\.ro/);
    } finally {
      if (original === undefined) delete process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
      else process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = original;
    }
  });

  it('emits no user sweep when the scenario created no user', () => {
    const l = new ScenarioResourceLedger();
    l.record('station', 'stn_abcd1234', 'POST /admin/stations');
    const sql = buildTeardownSql(l.toHandle());
    expect(sql).not.toContain('DELETE FROM users');
  });
});
