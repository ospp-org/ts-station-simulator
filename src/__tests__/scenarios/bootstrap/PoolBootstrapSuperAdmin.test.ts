import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  acquireEphemeralSuperAdmin,
  buildTeardownSql,
  clearEphemeralSuperAdminFromEnv,
  exportEphemeralSuperAdminToEnv,
  handleFromSerialized,
  serializePoolHandle,
  POOL_SUPER_ADMIN_EMAIL_ENV,
  POOL_SUPER_ADMIN_PASSWORD_ENV,
  type PoolBootstrapHandle,
} from '../../../scenarios/bootstrap/PoolBootstrap.js';
import { buildAppArtisanCommand } from '../../../scenarios/bootstrap/uatPrivileged.js';
import { StationPool } from '../../../scenarios/stations/StationPool.js';

/**
 * THE RUN'S OWN PLATFORM SUPER ADMIN.
 *
 * Raising the platform revocation epoch is platform_super_admin's alone since csms-server's
 * offline group 1 (06-security.md 6.6, the platform's one epoch), and the pool's identities are a
 * persistent platform_admin, a tenant_owner it mints and its tenant_operators - none of which may.
 * So a bootstrapped run mints one more account, grants it platform_super_admin through the
 * server's own command (`ospp:assign-platform-role` - no API hands out the role, as none should),
 * publishes it to its scenarios as the owner is published, and deletes it at teardown with the
 * owner.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  clearEphemeralSuperAdminFromEnv();
});

function handle(overrides: Partial<PoolBootstrapHandle> = {}): PoolBootstrapHandle {
  return {
    orgId: 'org-9',
    apiBaseUrl: 'https://api-uat.test',
    stationIds: [],
    certFiles: [],
    seededServiceIds: [],
    identityCredentials: [],
    pool: new StationPool(),
    ...overrides,
  };
}

describe('acquireEphemeralSuperAdmin', () => {
  it('registers a fresh account under the run stamp and grants it the role through the server command', async () => {
    const registered: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      registered.push(JSON.parse(String(init.body)));
      return { status: 201, json: async () => ({}), text: async () => '{}' } as unknown as Response;
    }));
    const granted: string[] = [];

    const psa = await acquireEphemeralSuperAdmin('https://api-uat.test', 'ab12cd34', async (email) => {
      granted.push(email);
    });

    expect(psa.email).toBe('sim-pool-psa-ab12cd34@onestoppay.dev');
    expect(registered[0]!.email).toBe(psa.email);
    expect(registered[0]!.password).toBe(psa.password);
    expect(granted).toEqual([psa.email]);
  });
});

describe('the run super admin in the environment and at teardown', () => {
  it('is published to the scenarios and cleared again', () => {
    exportEphemeralSuperAdminToEnv({ email: 'sim-pool-psa-x@onestoppay.dev', password: 'Pp1!x' });
    expect(process.env[POOL_SUPER_ADMIN_EMAIL_ENV]).toBe('sim-pool-psa-x@onestoppay.dev');
    expect(process.env[POOL_SUPER_ADMIN_PASSWORD_ENV]).toBe('Pp1!x');

    clearEphemeralSuperAdminFromEnv();
    expect(process.env[POOL_SUPER_ADMIN_EMAIL_ENV]).toBeUndefined();
  });

  it('is deleted by the teardown, with the owner', () => {
    const sql = buildTeardownSql(handle({
      ephemeralOwnerEmail: 'sim-pool-owner-x@onestoppay.dev',
      ephemeralSuperAdminEmail: 'sim-pool-psa-x@onestoppay.dev',
    }));

    expect(sql).toContain("'sim-pool-psa-x@onestoppay.dev'");
    expect(sql).toContain("'sim-pool-owner-x@onestoppay.dev'");
  });

  it('survives the handle a later teardown-pool reads back', () => {
    const back = handleFromSerialized(serializePoolHandle(handle({ ephemeralSuperAdminEmail: 'sim-pool-psa-x@onestoppay.dev' })));
    expect(back.ephemeralSuperAdminEmail).toBe('sim-pool-psa-x@onestoppay.dev');
  });
});

describe('buildAppArtisanCommand', () => {
  it('runs the command in the application container, every argument single-quoted', () => {
    expect(buildAppArtisanCommand(['ospp:assign-platform-role', "o'x@y.dev", 'platform_super_admin'], 'csms-app-uat')).toBe(
      "docker exec -i -w /var/www/html csms-app-uat php artisan 'ospp:assign-platform-role' 'o'\\''x@y.dev' 'platform_super_admin'",
    );
  });
});
