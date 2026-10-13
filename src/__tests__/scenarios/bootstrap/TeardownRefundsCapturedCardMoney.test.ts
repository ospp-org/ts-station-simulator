import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No ssh, no psql, no BT: the SQL channel is a spy, and child_process is mocked as well so a slip
// cannot reach the real host (the same belt sshIdentitiesOnly.test.ts wears). The server is
// fakePaymentsServer, a stateful stand-in for csms-server's payments admin API.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock('../../../scenarios/bootstrap/uatPrivileged.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../scenarios/bootstrap/uatPrivileged.js')>();
  return { ...actual, runUatSql: vi.fn(async () => '') };
});

import { runUatSql, type UatDbConfig } from '../../../scenarios/bootstrap/uatPrivileged.js';
import { teardownPool, buildTeardownSql, type PoolBootstrapHandle } from '../../../scenarios/bootstrap/PoolBootstrap.js';
import { StationPool } from '../../../scenarios/stations/StationPool.js';
import { fakePaymentsServer, settleUnderFakeTime, type FakePayment } from '../../helpers/fakePaymentsServer.js';

/**
 * A POOL TEARDOWN NEVER DELETES A CAPTURED CARD PAYMENT (Part C2, 2026-10-13).
 *
 * The teardown is one SQL transaction over SSH that deletes the run's payment_intents with their
 * refunds and ledgers. It called no API, so a card order the corpus paid at BT - a Batch Drive's 6
 * lei, the 2 lei a Jam Drive keeps - was deleted from UAT while its money stayed at BT with nothing
 * on UAT naming it: 10 such orders held 37,57 lei on 2026-10-13 (HS53).
 *
 * The rule: before it deletes anything, the teardown gives every captured card payment of the
 * run's organization back through the server's own refund path, signed in as the pool owner, and
 * it never deletes money still captured:
 *  - it lists the organization's payments as the owner (GET /api/v1/admin/payments), with the
 *    handle's ephemeralOwnerEmail and the password the bootstrap copied onto its identities;
 *  - it first waits, at most 10 minutes and reading every 15 s, for a pending payment to settle;
 *  - it refunds each payment still captured - succeeded or partially refunded - for what is left,
 *    the amount less every refund that did not fail, with POST /api/v1/admin/payments/{id}/refund;
 *  - BT's refund.do answers "system error" for minutes at a time, and the server then answers 502
 *    and keeps the payment unrefunded; the teardown tries again every 90 s, 10 tries at most;
 *  - a refund has gone through when the server answers 200 with the refund succeeded and a read
 *    of the payment shows nothing left;
 *  - if any payment still holds money, or is still pending, when the budget runs out, it deletes
 *    nothing - no SQL, no local file - and fails naming each order.
 * And the delete transaction refuses by itself while a payment of the minted organization still
 * holds captured money. Separately, a teardown whose delete fails no longer removes the
 * certificate files: the pool they belong to is still on the server.
 */

const API = 'https://api-uat.example.test';
const ORG = '019ef000-0000-7000-8000-000000000001';
const OWNER = 'sim-pool-owner-r1@onestoppay.dev';
const OWNER_PASSWORD = 'Pp1!0123456789abcdef0123456789abcd';
const REASON = "Pool teardown: the corpus's card payment is given back";
const BATCH = '01a13289-fdad-703c-9639-421aace7f759';
const BATCH_BT = '88c0b457-6f6b-4b54-9ad9-aeade6625071';
const JAM = '01a132a0-2686-718e-8261-06d78bd0852d';
const JAM_BT = 'cb4617c9-b743-4883-9220-097d160fffb9';
const DB: UatDbConfig = {
  sshHost: 'gabi@203.0.113.1', sshKey: '/dev/null', container: 'csms-postgres-uat',
  dbUser: 'csms_uat', dbName: 'csms_uat', appContainer: 'csms-app-uat',
};

let dir: string;
let certFiles: string[];

function handle(overrides: Partial<PoolBootstrapHandle> = {}): PoolBootstrapHandle {
  return {
    orgId: ORG,
    createdOrgId: ORG,
    ephemeralOwnerEmail: OWNER,
    locationId: '019e81fb-58db-7173-89b6-d1ae08cf9a0e',
    stationIds: ['stn_aaaa1111'],
    certFiles,
    seededServiceIds: [],
    // Every identity carries the owner's password: PoolBootstrap copies it onto each one.
    identityCredentials: [
      { email: 'sim-worker-r1-0@test.local', password: OWNER_PASSWORD },
      { email: 'sim-worker-r1-1@test.local', password: OWNER_PASSWORD },
    ],
    pool: new StationPool(),
    // The run's API base. Cast, so this file compiles against a handle type that has no such field.
    ...({ apiBaseUrl: API } as object),
    ...overrides,
  } as PoolBootstrapHandle;
}

/** A Batch Drive's 6 lei: 3 units of 200, captured at BT, nothing refunded. */
const batch = (over: Partial<FakePayment> = {}): FakePayment => ({
  id: BATCH, status: 'succeeded', amountCents: 600, processorTransactionId: BATCH_BT,
  referenceId: 'bay_aaaa0001', ...over,
});

function serve(payments: FakePayment[], password = OWNER_PASSWORD) {
  const server = fakePaymentsServer({ api: API, orgId: ORG, ownerEmail: OWNER, ownerPassword: password, payments });
  vi.stubGlobal('fetch', server.fetch);
  return server;
}

const sqlCalls = (): string[] => vi.mocked(runUatSql).mock.calls.map(([sql]) => String(sql));
const deleteCalls = (): string[] => sqlCalls().filter((s) => s.includes('DELETE FROM'));
/** The global call order of the first SQL call that deletes anything, or Infinity. */
const firstDeleteOrder = (): number => {
  const i = vi.mocked(runUatSql).mock.calls.findIndex(([sql]) => String(sql).includes('DELETE FROM'));
  return i < 0 ? Infinity : vi.mocked(runUatSql).mock.invocationCallOrder[i];
};
/** The global call order of the n-th fetch that POSTed a refund. */
const refundOrder = (server: ReturnType<typeof serve>, n = 0): number => {
  const fetchCalls = server.fetch.mock.calls;
  const idx = fetchCalls
    .map(([u, init], i) => ({ i, refund: (init?.method ?? 'GET') === 'POST' && /\/refund$/.test(String(u)) }))
    .filter((c) => c.refund)[n]?.i;
  return idx === undefined ? -1 : server.fetch.mock.invocationCallOrder[idx];
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.mocked(runUatSql).mockReset();
  vi.mocked(runUatSql).mockImplementation(async () => '');
  delete process.env.SIM_POOL_OWNER_EMAIL;
  delete process.env.SIM_POOL_OWNER_PASSWORD;
  dir = mkdtempSync(join(tmpdir(), 'teardown-card-money-'));
  certFiles = ['stn_aaaa1111-key.pem', 'stn_aaaa1111.pem', 'stn_aaaa1111-chain.pem'].map((f) => {
    const p = join(dir, f);
    writeFileSync(p, 'material');
    return p;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('a pool teardown gives the card money back through the server before it deletes anything', { timeout: 30_000 }, () => {
  it("signs in as the pool owner, refunds a Batch Drive's captured 6 lei, and deletes only after the refund went through", async () => {
    const server = serve([batch()]);

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error, String(out.error)).toBeUndefined();
    const login = server.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/auth/login');
    expect(login?.body, 'the teardown never signed in as the pool owner').toEqual({ email: OWNER, password: OWNER_PASSWORD });
    const refunds = server.refundCalls(BATCH);
    expect(refunds, `the 6 lei of ${BATCH} were never refunded; calls: ${JSON.stringify(server.calls.map((c) => `${c.method} ${c.path}`))}`)
      .toHaveLength(1);
    expect(refunds[0].body).toEqual({ amount_cents: 600, reason: REASON });
    expect(refunds[0].headers['authorization']).toMatch(/^Bearer owner-token-/);
    expect(refunds[0].headers['x-organization-id']).toBe(ORG);
    expect(server.payment(BATCH)?.status).toBe('refunded');
    expect(refundOrder(server)).toBeGreaterThan(0);
    expect(refundOrder(server), 'the delete ran before the refund').toBeLessThan(firstDeleteOrder());
    expect(deleteCalls().some((s) => s.includes('DELETE FROM payment_intents'))).toBe(true);
  });

  it('refunds only what is left of a Jam Drive the server already refunded in part: the amount less every refund that did not fail', async () => {
    // 2 units of 200 captured; the server gave the jammed unit's 200 back; an earlier attempt failed.
    const server = serve([{
      id: JAM, status: 'partially_refunded', amountCents: 400, processorTransactionId: JAM_BT, referenceId: 'bay_aaaa0001',
      refunds: [
        { id: 'r-tail', amountCents: 200, status: 'succeeded' },
        { id: 'r-tried', amountCents: 200, status: 'failed' },
      ],
    }]);

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error, String(out.error)).toBeUndefined();
    expect(server.refundCalls(JAM).map((c) => c.body)).toEqual([{ amount_cents: 200, reason: REASON }]);
    expect(server.payment(JAM)?.status).toBe('refunded');
    expect(refundOrder(server)).toBeLessThan(firstDeleteOrder());
  });

  it('tries again every 90 s while BT answers its system error (the server answers 502), and deletes once a try went through', async () => {
    const server = serve([batch({ btAnswers: ['system-error', 'system-error', 'refunds'] })]);

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error, String(out.error)).toBeUndefined();
    const tries = server.refundCalls(BATCH);
    expect(tries.map((c) => c.status)).toEqual([502, 502, 200]);
    for (let i = 1; i < tries.length; i++) {
      expect(tries[i].at - tries[i - 1].at, `try ${i + 1} came too soon after try ${i}`).toBeGreaterThanOrEqual(90_000);
    }
    // Every try asked for what was left: a failed refund moved nothing.
    expect(tries.map((c) => (c.body as { amount_cents: number }).amount_cents)).toEqual([600, 600, 600]);
    expect(server.payment(BATCH)?.status).toBe('refunded');
    expect(refundOrder(server, 2)).toBeLessThan(firstDeleteOrder());
  });

  it('after 10 tries BT turned down, deletes nothing, keeps the certificate files, and fails naming the order and what it still holds', async () => {
    const server = serve([batch({ btAnswers: ['system-error'] })]);

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.settled).toBe(true);
    const tries = server.refundCalls(BATCH);
    expect(tries).toHaveLength(10);
    for (let i = 1; i < tries.length; i++) expect(tries[i].at - tries[i - 1].at).toBeGreaterThanOrEqual(90_000);
    expect(out.error, 'the teardown reported success over 6 lei still captured').toBeInstanceOf(Error);
    const message = (out.error as Error).message;
    expect(message).toContain(BATCH);
    expect(message).toContain(BATCH_BT);
    expect(message).toMatch(/\b600\b/);
    expect((out.error as Error).name).toBe('PoolCardMoneyHeldError');
    expect(sqlCalls(), 'a teardown that keeps the pool must not run its SQL').toEqual([]);
    for (const f of certFiles) expect(existsSync(f), `${f} was removed from a pool that is still on the server`).toBe(true);
  });

  it("waits for a pending payment the server's poller settles, then refunds it before deleting", async () => {
    // c-proof4 (2026-10-12): BT had deposited, the browser never came back, the poller settled it ~2 min later.
    const server = serve([batch({ status: 'pending', settles: { afterMs: 130_000, to: 'succeeded' } })]);
    const t0 = Date.now();

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error, String(out.error)).toBeUndefined();
    const lists = server.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/v1/admin/payments?'));
    expect(lists.length, 'the pending payment was never read again').toBeGreaterThan(2);
    for (let i = 1; i < lists.length && lists[i].at - t0 < 130_000; i++) {
      expect(lists[i].at - lists[i - 1].at, 'a pending payment is read every 15 s').toBeLessThanOrEqual(15_000);
    }
    const refunds = server.refundCalls(BATCH);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].at - t0, 'refunded before the poller had settled it').toBeGreaterThanOrEqual(130_000);
    expect(server.payment(BATCH)?.status).toBe('refunded');
    expect(refundOrder(server)).toBeLessThan(firstDeleteOrder());
  });

  it('a payment still pending after 10 minutes holds the whole pool: what is captured is given back, nothing is deleted, and the teardown fails naming it', async () => {
    const server = serve([
      { id: JAM, status: 'pending', amountCents: 400, processorTransactionId: JAM_BT, referenceId: 'bay_aaaa0002' },
      batch(),
    ]);

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error).toBeInstanceOf(Error);
    expect((out.error as Error).message).toContain(JAM);
    expect((out.error as Error).message).toMatch(/pending/);
    expect(out.fakeElapsedMs, 'it gave up on the pending payment before 10 minutes').toBeGreaterThanOrEqual(10 * 60_000 - 15_000);
    expect(server.refundCalls(JAM)).toEqual([]);
    expect(server.refundCalls(BATCH)).toHaveLength(1);
    expect(server.payment(BATCH)?.status).toBe('refunded');
    expect(sqlCalls()).toEqual([]);
    for (const f of certFiles) expect(existsSync(f)).toBe(true);
  });

  it('waits for a refund the server holds in flight instead of sending a second one, and deletes once it landed', async () => {
    // BT's refund.do timed out and BT does not show the refund yet: the server keeps it pending and
    // refunds:recover-stranded settles it later. A second refund of the same money must not be asked.
    const server = serve([batch({ btAnswers: ['not-yet'], notYetSettlesAfterMs: 4 * 60_000 })]);

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error, String(out.error)).toBeUndefined();
    expect(server.refundCalls(BATCH)).toHaveLength(1);
    expect(server.payment(BATCH)?.status).toBe('refunded');
    const settledRead = server.calls.filter((c) => c.method === 'GET' && c.path === `/api/v1/admin/payments/${BATCH}`).at(-1);
    expect(settledRead!.at - server.refundCalls(BATCH)[0].at).toBeGreaterThanOrEqual(4 * 60_000);
    expect(refundOrder(server)).toBeLessThan(firstDeleteOrder());
  });

  it('when the pool owner cannot sign in, the money cannot be read, so nothing is deleted', async () => {
    const server = serve([batch()], 'a-password-the-handle-does-not-carry');

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error).toBeInstanceOf(Error);
    expect((out.error as Error).message).toContain(OWNER);
    expect((out.error as Error).message).toContain(ORG);
    expect((out.error as Error).name).toBe('PoolCardMoneyHeldError');
    expect(server.refundCalls()).toEqual([]);
    expect(sqlCalls()).toEqual([]);
    for (const f of certFiles) expect(existsSync(f)).toBe(true);
  });

  it('when the payments cannot be read for the whole 10 minutes, nothing is deleted and the teardown says so', async () => {
    const server = fakePaymentsServer({
      api: API, orgId: ORG, ownerEmail: OWNER, ownerPassword: OWNER_PASSWORD, payments: [batch()],
      unavailable: ({ method, path }) => method === 'GET' && path.startsWith('/api/v1/admin/payments'),
    });
    vi.stubGlobal('fetch', server.fetch);

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error).toBeInstanceOf(Error);
    expect((out.error as Error).name).toBe('PoolCardMoneyHeldError');
    expect((out.error as Error).message).toMatch(/could not be read/);
    expect((out.error as Error).message).toContain('503');
    // The wait is the budget; no refund rounds are spent on an API that never answered.
    expect(out.fakeElapsedMs).toBeGreaterThanOrEqual(10 * 60_000 - 15_000);
    expect(out.fakeElapsedMs).toBeLessThan(11 * 60_000);
    expect(server.refundCalls()).toEqual([]);
    expect(sqlCalls()).toEqual([]);
    for (const f of certFiles) expect(existsSync(f)).toBe(true);
  });

  it('a pool with no card payment is read as its owner and then torn down', async () => {
    const server = serve([]);

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error, String(out.error)).toBeUndefined();
    const list = server.calls.find((c) => c.method === 'GET' && c.path.startsWith('/api/v1/admin/payments?'));
    expect(list, 'the teardown deleted without reading the payments').toBeDefined();
    expect(list!.headers['x-organization-id']).toBe(ORG);
    expect(server.fetch.mock.invocationCallOrder[0]).toBeLessThan(firstDeleteOrder());
    expect(deleteCalls()).toHaveLength(1);
    for (const f of certFiles) expect(existsSync(f)).toBe(false);
  });

  it('a run that minted no organization has no card payment of its own: it is torn down without signing in', async () => {
    const server = serve([batch()]);

    const out = await settleUnderFakeTime(teardownPool(handle({ createdOrgId: undefined, ephemeralOwnerEmail: undefined }), DB));

    expect(out.error, String(out.error)).toBeUndefined();
    expect(server.calls).toEqual([]);
    expect(deleteCalls()).toHaveLength(1);
  });
});

describe('the delete transaction refuses captured card money by itself', () => {
  it('right after BEGIN and SET LOCAL, before any delete, it raises while a payment of the minted organization is succeeded or partially refunded', () => {
    const lines = buildTeardownSql(handle()).split('\n');
    const guard = lines.findIndex((l) => /RAISE EXCEPTION/.test(l) && /payment_intents/.test(l));
    expect(guard, 'no guard in the teardown transaction').toBe(2);
    expect(lines.slice(0, 2)).toEqual(['BEGIN;', "SET LOCAL ospp.purge_test_data = 'on';"]);
    const firstDelete = lines.findIndex((l) => l.startsWith('DELETE FROM'));
    expect(guard).toBeLessThan(firstDelete);
    const g = lines[guard];
    expect(g).toContain(`metadata->>'organization_id' = '${ORG}'`);
    expect(g).toContain("status IN ('succeeded', 'partially_refunded')");
    expect(g).toContain("processor <> 'wallet'");
    expect(g).not.toContain('DELETE FROM');
  });

  it('a delete the guard refuses is reported as card money held, and leaves the certificate files', async () => {
    serve([]);
    vi.mocked(runUatSql).mockImplementation(async () => {
      throw new Error(
        'runUatSql: psql exited 3 — ERROR:  pool teardown refused, card money still captured: ' +
        `${BATCH} (BT order ${BATCH_BT}, succeeded)\nCONTEXT:  PL/pgSQL function inline_code_block line 1 at RAISE`,
      );
    });

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error).toBeInstanceOf(Error);
    expect((out.error as Error).name).toBe('PoolCardMoneyHeldError');
    expect((out.error as Error).message).toContain(BATCH);
    for (const f of certFiles) expect(existsSync(f)).toBe(true);
  });
});

describe('a teardown whose delete fails leaves the local files of the pool it did not delete', () => {
  it('keeps the certificate files when the database refuses the delete', async () => {
    serve([]);
    vi.mocked(runUatSql).mockImplementation(async () => {
      throw new Error('runUatSql: psql exited 3 — ERROR:  update or delete on table "organizations" violates foreign key constraint');
    });

    const out = await settleUnderFakeTime(teardownPool(handle(), DB));

    expect(out.error).toBeInstanceOf(Error);
    for (const f of certFiles) {
      expect(existsSync(f), `${f} was removed although the pool it belongs to is still on the server`).toBe(true);
    }
  });
});
