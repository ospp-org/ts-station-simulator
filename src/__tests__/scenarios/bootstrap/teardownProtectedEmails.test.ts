import { describe, it, expect } from 'vitest';
import {
  buildTeardownTestUsersSql,
  _readProtectedEmailsForTesting,
} from '../../../scenarios/bootstrap/uatPrivileged.js';
import { buildTeardownSql, type PoolBootstrapHandle } from '../../../scenarios/bootstrap/PoolBootstrap.js';
import { StationPool } from '../../../scenarios/stations/StationPool.js';

/**
 * C-018 invariant guard: the ambient permanent platform admin user
 * (seeded once on UAT via E2EBootstrapSeeder) must NEVER appear in any
 * teardown DELETE. Defense in depth — the email is also absent by
 * construction from PoolBootstrap.identityCredentials, but a regression
 * that accidentally adds it would silently delete the user, break the
 * platform admin role binding (CASCADE on model_has_roles via model_id),
 * and 403 every future e2e run at POST /organizations.
 */
describe('PROTECTED_EMAILS teardown guard (C-018 invariant)', () => {
  describe('_readProtectedEmailsForTesting', () => {
    it('reads both UAT_E2E_PLATFORM_ADMIN_EMAIL and E2E_PLATFORM_ADMIN_EMAIL', () => {
      const env = {
        UAT_E2E_PLATFORM_ADMIN_EMAIL: 'platform@x.com',
        E2E_PLATFORM_ADMIN_EMAIL: 'seeder-side@x.com',
      };
      expect(_readProtectedEmailsForTesting(env)).toEqual([
        'platform@x.com',
        'seeder-side@x.com',
      ]);
    });

    it('returns only the set ones (drops undefined)', () => {
      const env = { UAT_E2E_PLATFORM_ADMIN_EMAIL: 'a@x.com' };
      expect(_readProtectedEmailsForTesting(env)).toEqual(['a@x.com']);
    });

    it('returns empty array when neither is set', () => {
      expect(_readProtectedEmailsForTesting({})).toEqual([]);
    });

    it('drops empty-string values (treat empty as unset)', () => {
      const env = {
        UAT_E2E_PLATFORM_ADMIN_EMAIL: '',
        E2E_PLATFORM_ADMIN_EMAIL: 'real@x.com',
      };
      expect(_readProtectedEmailsForTesting(env)).toEqual(['real@x.com']);
    });
  });

  describe('buildTeardownTestUsersSql', () => {
    it('throws when emails contains a protected platform admin email (explicit list)', () => {
      expect(() => buildTeardownTestUsersSql(
        ['sim-worker-1@test.local', 'e2e-platform-admin@onestoppay.ro'],
        { protectedEmails: ['e2e-platform-admin@onestoppay.ro'] },
      )).toThrow(/protected.*platform.admin|e2e-platform-admin@onestoppay\.ro/i);
    });

    it('error message names the offending email so the regression is obvious', () => {
      let caught: Error | undefined;
      try {
        buildTeardownTestUsersSql(
          ['e2e-platform-admin@onestoppay.ro'],
          { protectedEmails: ['e2e-platform-admin@onestoppay.ro'] },
        );
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('e2e-platform-admin@onestoppay.ro');
    });

    it('does NOT throw when emails are all safe sim-worker pattern', () => {
      expect(() => buildTeardownTestUsersSql(
        ['sim-worker-r1-0@test.local', 'sim-worker-r1-1@test.local'],
        { protectedEmails: ['e2e-platform-admin@onestoppay.ro'] },
      )).not.toThrow();
    });

    it('returns empty array (no-op) when input emails list is empty (guard skipped)', () => {
      expect(buildTeardownTestUsersSql([], { protectedEmails: ['x@y.com'] })).toEqual([]);
    });

    it('explicit protectedEmails: [] disables the guard (for tests only)', () => {
      // Should produce SQL, not throw — even though the email looks like a real one.
      const sql = buildTeardownTestUsersSql(
        ['e2e-platform-admin@onestoppay.ro'],
        { protectedEmails: [] },
      );
      expect(sql.length).toBeGreaterThan(0);
    });

    it('falls back to process.env when no options passed (production path)', () => {
      // Simulate env var set during the test run.
      const original = process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
      process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = 'env-protected@x.com';
      try {
        expect(() => buildTeardownTestUsersSql(['env-protected@x.com'])).toThrow(
          /env-protected@x\.com/,
        );
      } finally {
        if (original === undefined) {
          delete process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
        } else {
          process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = original;
        }
      }
    });
  });

  describe('buildTeardownSql — invariant via PoolBootstrap.teardownPool', () => {
    function safeHandle(): PoolBootstrapHandle {
      return {
        orgId: '019e674f-aa63-7309-ab7a-c71fcd6178de',
        locationId: '019e81fb-58db-7173-89b6-d1ae08cf9a0e',
        stationIds: ['stn_aaaa1111'],
        certFiles: [],
        seededServiceIds: ['svc_basic'],
        identityCredentials: [
          { email: 'sim-worker-r1-0@test.local', password: 'p' },
        ],
        pool: new StationPool(),
      };
    }

    it('does NOT mention the protected platform admin email anywhere in the SQL', () => {
      const original = process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
      process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = 'e2e-platform-admin@onestoppay.ro';
      try {
        const sql = buildTeardownSql(safeHandle());
        expect(sql).not.toContain('e2e-platform-admin@onestoppay.ro');
      } finally {
        if (original === undefined) {
          delete process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
        } else {
          process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = original;
        }
      }
    });

    it('does NOT emit any DELETE that filters by `organization_id IS NULL` (would hit platform admin role binding)', () => {
      const sql = buildTeardownSql(safeHandle());
      // The platform admin's model_has_roles row has organization_id = NULL.
      // The teardown's mhr DELETE filters by `model_id IN (sim worker ids)` —
      // platform admin's model_id is never in that set, so the row is safe.
      // We assert that no DELETE statement targets organization_id IS NULL
      // directly (which would be a categorical match on all NULL-scoped rows).
      expect(sql).not.toMatch(/DELETE FROM[^;]*organization_id IS NULL/i);
    });

    it('throws if handle.identityCredentials contains the protected email (defense in depth)', () => {
      const original = process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
      process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = 'e2e-platform-admin@onestoppay.ro';
      const poisoned: PoolBootstrapHandle = {
        ...safeHandle(),
        identityCredentials: [
          { email: 'sim-worker-r1-0@test.local', password: 'p' },
          { email: 'e2e-platform-admin@onestoppay.ro', password: 'leaked' },
        ],
      };
      try {
        expect(() => buildTeardownSql(poisoned)).toThrow(/e2e-platform-admin@onestoppay\.ro/);
      } finally {
        if (original === undefined) {
          delete process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL;
        } else {
          process.env.UAT_E2E_PLATFORM_ADMIN_EMAIL = original;
        }
      }
    });
  });

  describe('CASCADE on organizations does not affect NULL-scoped Spatie rows (structural argument)', () => {
    // Postgres CASCADE on a FK matches `child.<col> = <deleted parent id>`. NULL
    // is never equal to any uuid (NULL != x is NULL, treated as false). The
    // platform admin's roles + model_has_roles rows have organization_id = NULL,
    // so deleting any tenant org (which CASCADEs via the team_foreign_key) never
    // matches them. This test locks in that the teardown does NOT add any DELETE
    // FROM organizations that could change this assumption.
    it('teardown does not DELETE FROM organizations (e2e scenarios reuse the org transiently; no explicit FK cascade trigger from this teardown)', () => {
      const sql = buildTeardownSql({
        orgId: '019e674f-aa63-7309-ab7a-c71fcd6178de',
        locationId: '019e81fb-58db-7173-89b6-d1ae08cf9a0e',
        stationIds: ['stn_x'],
        certFiles: [],
        seededServiceIds: [],
        identityCredentials: [],
        pool: new StationPool(),
      });
      // If a future commit adds `DELETE FROM organizations` to the teardown,
      // this test fails — surfacing the need to confirm the platform admin's
      // NULL-scoped invariant explicitly.
      expect(sql).not.toMatch(/DELETE FROM organizations\b/);
    });
  });
});
