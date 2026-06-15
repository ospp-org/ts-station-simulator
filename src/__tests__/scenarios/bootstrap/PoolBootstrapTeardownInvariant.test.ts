import { describe, it, expect } from 'vitest';
import { buildTeardownSql, type PoolBootstrapHandle } from '../../../scenarios/bootstrap/PoolBootstrap.js';
import { StationPool } from '../../../scenarios/stations/StationPool.js';

/**
 * LOAD-BEARING teardown invariant (Direction B, symmetric with the P0 platform-admin probe).
 *
 * The pool builder now CREATES an ephemeral tenant_owner + org per run. Teardown is the
 * highest-risk surface: too lazy → orphans accumulate every wipe; too greedy → it eats a
 * pre-existing universe or the persistent platform admin. This pins, on the generated SQL:
 *
 *   (a) the ephemeral owner + org (and, via FK CASCADE, the per-org cloned roles +
 *       model_has_roles + service_definitions) are deleted, scoped strictly to THIS run's ids;
 *   (b) the persistent platform admin is NEVER referenced (protected-emails guard active);
 *   (c) no PRE-EXISTING org (from another universe/session) is touched — the org delete is
 *       scoped to the exact createdOrgId, never unscoped, never `organization_id IS NULL`.
 *
 * (The real proof that nothing orphans on the live DB is the post-run check after the 94-run.)
 */

const PLATFORM_ADMIN = 'e2e-platform-admin@onestoppay.ro';
const EPH_ORG = '019ef000-0000-7000-8000-000000000001';
const EPH_OWNER = 'sim-pool-owner-r1stamp@onestoppay.dev';
const PRE_EXISTING_ORG = '019ec9a9-468b-7006-9d7a-8c3edb299c4d';

function ephemeralHandle(overrides: Partial<PoolBootstrapHandle> = {}): PoolBootstrapHandle {
  return {
    orgId: EPH_ORG,
    createdOrgId: EPH_ORG,
    ephemeralOwnerEmail: EPH_OWNER,
    locationId: '019e81fb-58db-7173-89b6-d1ae08cf9a0e',
    stationIds: ['stn_aaaa1111'],
    certFiles: [],
    seededServiceIds: ['svc_wash_basic'],
    identityCredentials: [{ email: 'sim-worker-r1stamp-0@test.local', password: 'p' }],
    pool: new StationPool(),
    ...overrides,
  };
}

describe('teardown invariant — ephemeral owner+org swept, platform admin + pre-existing orgs untouched', () => {
  // (a) ephemeral owner + org deleted, scoped to the run's ids
  it('(a) deletes the ephemeral org scoped to createdOrgId (org-delete CASCADEs roles/model_has_roles/service_definitions)', () => {
    const sql = buildTeardownSql(ephemeralHandle());
    expect(sql).toContain(`DELETE FROM organizations WHERE id = '${EPH_ORG}'`);
  });

  it('(a) sweeps the ephemeral owner user (full FK web) BEFORE deleting the org', () => {
    const sql = buildTeardownSql(ephemeralHandle());
    const ownerAt = sql.indexOf(`DELETE FROM users WHERE email = ANY(ARRAY['${EPH_OWNER}']::text[])`);
    const orgAt = sql.indexOf('DELETE FROM organizations WHERE id');
    expect(ownerAt, 'ephemeral owner user-sweep present').toBeGreaterThanOrEqual(0);
    expect(orgAt).toBeGreaterThan(ownerAt);
  });

  it('(a) deletes the org NO-ACTION children (organization_members, corporate_policies, invitations) BEFORE the org', () => {
    const sql = buildTeardownSql(ephemeralHandle());
    const orgAt = sql.indexOf('DELETE FROM organizations WHERE id');
    for (const child of ['organization_members', 'corporate_policies', 'invitations']) {
      const at = sql.indexOf(`DELETE FROM ${child}`);
      expect(at, `${child} delete present`).toBeGreaterThanOrEqual(0);
      expect(at, `${child} must precede organizations`).toBeLessThan(orgAt);
    }
  });

  // (b) platform admin intact — protected guard active
  it('(b) never references the platform admin email anywhere in the teardown SQL', () => {
    const original = process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
    process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = PLATFORM_ADMIN;
    try {
      const sql = buildTeardownSql(ephemeralHandle());
      expect(sql).not.toContain(PLATFORM_ADMIN);
    } finally {
      if (original === undefined) delete process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
      else process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = original;
    }
  });

  it('(b) THROWS if the ephemeral owner is ever the platform admin (guard catches identity confusion)', () => {
    const original = process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
    process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = PLATFORM_ADMIN;
    try {
      expect(() => buildTeardownSql(ephemeralHandle({ ephemeralOwnerEmail: PLATFORM_ADMIN })))
        .toThrow(/e2e-platform-admin@onestoppay\.ro/);
    } finally {
      if (original === undefined) delete process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
      else process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = original;
    }
  });

  // (c) no pre-existing org touched
  it('(c) deletes ONLY createdOrgId — exactly one org delete, scoped to the exact id, never IS NULL', () => {
    const sql = buildTeardownSql(ephemeralHandle());
    const orgDeletes = sql.split('\n').filter((l) => /DELETE FROM organizations\b/.test(l));
    expect(orgDeletes).toHaveLength(1);
    expect(orgDeletes[0]).toContain(`WHERE id = '${EPH_ORG}'`);
    expect(orgDeletes[0]).not.toContain(PRE_EXISTING_ORG);
    expect(sql).not.toMatch(/organization_id IS NULL/i);
  });

  it('(c) when createdOrgId is UNSET (legacy / pre-existing org), NEVER deletes any org or org-scoped row', () => {
    const sql = buildTeardownSql(ephemeralHandle({ createdOrgId: undefined, ephemeralOwnerEmail: undefined }));
    expect(sql).not.toMatch(/DELETE FROM organizations\b/);
    expect(sql).not.toMatch(/DELETE FROM corporate_policies\b/);
  });

  it('(c) org-scoped child deletes target createdOrgId (the org we made), not a bare/wildcard scope', () => {
    const sql = buildTeardownSql(ephemeralHandle());
    for (const child of ['organization_members', 'corporate_policies', 'invitations']) {
      const line = sql.split('\n').find((l) => l.includes(`DELETE FROM ${child} WHERE organization_id`));
      expect(line, `${child} org-scoped delete present`).toBeDefined();
      expect(line).toContain(`organization_id = '${EPH_ORG}'`);
    }
  });

  it('emits a single transaction (one BEGIN / one COMMIT) with the org-delete inside it', () => {
    const sql = buildTeardownSql(ephemeralHandle());
    expect((sql.match(/\bBEGIN;/g) ?? []).length).toBe(1);
    expect((sql.match(/\bCOMMIT;/g) ?? []).length).toBe(1);
    expect(sql.indexOf('DELETE FROM organizations')).toBeLessThan(sql.indexOf('COMMIT;'));
    expect(sql.indexOf('DELETE FROM organizations')).toBeGreaterThan(sql.indexOf('BEGIN;'));
  });
});
