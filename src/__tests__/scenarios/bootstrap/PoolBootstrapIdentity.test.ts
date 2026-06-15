import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  platformAdminCredsFromEnv,
  acquireEphemeralProvisioningIdentity,
} from '../../../scenarios/bootstrap/PoolBootstrap.js';

/**
 * Class-of-problem fix (Direction B): the pool builder must be SELF-SUFFICIENT on
 * identity — it provisions starting from the PERSISTENT platform admin and mints
 * its own EPHEMERAL tenant_owner (reusing the e2e onboarding sequence:
 * register customer → platform_admin creates org via owner_email → login as the
 * promoted tenant_owner). It must NEVER depend on the external, drift-prone
 * UAT_EMAIL identity.
 *
 * These tests pin that contract at the unit boundary. The functional proof (the
 * minted identity can actually provision the pool on UAT under verify Critical)
 * is the full 94-scenario run — mock-green ≠ functional-green.
 */

// ---- mock fetch -----------------------------------------------------------

interface MockResponse { status: number; body: unknown; }
interface CapturedCall { url: string; method: string; body: unknown; auth?: string; }

function stubFetchSequence(responses: MockResponse[]): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: String(init.method),
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: headers['Authorization'],
    });
    const r = responses[i++] ?? { status: 500, body: {} };
    return {
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  }));
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const API = 'https://api-uat.test';

// ---- platformAdminCredsFromEnv -------------------------------------------

describe('platformAdminCredsFromEnv', () => {
  it('returns the platform-admin creds when both env vars are set', () => {
    expect(platformAdminCredsFromEnv({
      UAT_E2E_PLATFORM_ADMIN_EMAIL: 'admin@x.dev',
      UAT_E2E_PLATFORM_ADMIN_PASSWORD: 'secret',
    })).toEqual({ email: 'admin@x.dev', password: 'secret' });
  });

  it('throws when the email is missing/empty (no silent UAT_EMAIL fallback)', () => {
    expect(() => platformAdminCredsFromEnv({ UAT_E2E_PLATFORM_ADMIN_PASSWORD: 'p' }))
      .toThrow(/UAT_E2E_PLATFORM_ADMIN_EMAIL/);
    expect(() => platformAdminCredsFromEnv({
      UAT_E2E_PLATFORM_ADMIN_EMAIL: '',
      UAT_E2E_PLATFORM_ADMIN_PASSWORD: 'p',
    })).toThrow(/UAT_E2E_PLATFORM_ADMIN/);
  });

  it('throws when the password is missing', () => {
    expect(() => platformAdminCredsFromEnv({ UAT_E2E_PLATFORM_ADMIN_EMAIL: 'a@x' }))
      .toThrow(/UAT_E2E_PLATFORM_ADMIN_PASSWORD/);
  });

  it('error message states the pool builder no longer uses UAT_EMAIL', () => {
    expect(() => platformAdminCredsFromEnv({})).toThrow(/UAT_EMAIL/);
  });
});

// ---- acquireEphemeralProvisioningIdentity --------------------------------

describe('acquireEphemeralProvisioningIdentity', () => {
  const admin = { email: 'platform-admin@onestoppay.ro', password: 'adminpw' };

  function happyResponses(): MockResponse[] {
    return [
      { status: 200, body: { data: { access_token: 'ADMIN_TOK' } } },          // 1. platform admin login
      { status: 201, body: { user: { id: 'u-owner', email: 'ignored' } } },     // 2. register ephemeral owner
      { status: 201, body: { data: { organization: { id: 'ORG-EPH-1' } } } },   // 3. org create (owner_email)
      { status: 200, body: { data: { access_token: 'OWNER_TOK' } } },           // 4. ephemeral owner login
    ];
  }

  it('drives the platform-admin-rooted sequence: admin-login → register → org-create → owner-login', async () => {
    const { calls } = stubFetchSequence(happyResponses());
    const id = await acquireEphemeralProvisioningIdentity(API, admin, 'r1test');

    expect(calls).toHaveLength(4);
    // 1. platform admin login (NOT UAT_EMAIL)
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${API}/api/v1/auth/login`);
    expect((calls[0].body as { email: string }).email).toBe('platform-admin@onestoppay.ro');
    // 2. register a fresh ephemeral owner, runStamp-scoped, clear test domain
    expect(calls[1].url).toBe(`${API}/api/v1/auth/register`);
    expect((calls[1].body as { email: string }).email).toBe('sim-pool-owner-r1test@onestoppay.dev');
    // 3. platform admin creates org on behalf of the owner (owner_email promotion), admin-authed
    expect(calls[2].url).toBe(`${API}/api/v1/organizations`);
    expect((calls[2].body as { owner_email: string }).owner_email).toBe('sim-pool-owner-r1test@onestoppay.dev');
    expect(calls[2].auth).toBe('Bearer ADMIN_TOK');
    // 4. login as the freshly-promoted tenant_owner
    expect(calls[3].url).toBe(`${API}/api/v1/auth/login`);
    expect((calls[3].body as { email: string }).email).toBe('sim-pool-owner-r1test@onestoppay.dev');

    // returns the OWNER token + the created org id + owner identity
    expect(id.token).toBe('OWNER_TOK');
    expect(id.orgId).toBe('ORG-EPH-1');
    expect(id.ownerEmail).toBe('sim-pool-owner-r1test@onestoppay.dev');
    expect(id.ownerPassword.length).toBeGreaterThan(0);
  });

  it('registers and logs in with the SAME generated password (owner is loginable — register-first)', async () => {
    const { calls } = stubFetchSequence(happyResponses());
    await acquireEphemeralProvisioningIdentity(API, admin, 'r2');
    const registerPw = (calls[1].body as { password: string }).password;
    const loginPw = (calls[3].body as { password: string }).password;
    expect(registerPw).toBe(loginPw);
    expect(registerPw.length).toBeGreaterThanOrEqual(12);
  });

  it('generates a random password (different per call)', async () => {
    const a = stubFetchSequence(happyResponses());
    const id1 = await acquireEphemeralProvisioningIdentity(API, admin, 'rA');
    vi.unstubAllGlobals();
    stubFetchSequence(happyResponses());
    const id2 = await acquireEphemeralProvisioningIdentity(API, admin, 'rB');
    expect(id1.ownerPassword).not.toBe(id2.ownerPassword);
    expect(a.calls[1].url).toContain('/auth/register');
  });

  it('NEVER references UAT_EMAIL anywhere in the request flow', async () => {
    const { calls } = stubFetchSequence(happyResponses());
    await acquireEphemeralProvisioningIdentity(API, admin, 'r3');
    const allBodies = JSON.stringify(calls);
    expect(allBodies).not.toMatch(/UAT_EMAIL|e2e-stn_/i);
  });

  it('throws a clear error if platform admin login fails (401)', async () => {
    stubFetchSequence([{ status: 401, body: { message: 'bad creds' } }]);
    await expect(acquireEphemeralProvisioningIdentity(API, admin, 'r4'))
      .rejects.toThrow(/login|401/i);
  });
});
