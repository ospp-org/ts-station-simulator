import { describe, it, expect } from 'vitest';
import { buildTeardownSql } from '../../../scenarios/bootstrap/PoolBootstrap.js';
import { buildTeardownTestUsersSql } from '../../../scenarios/bootstrap/uatPrivileged.js';
import type { PoolBootstrapHandle } from '../../../scenarios/bootstrap/PoolBootstrap.js';

const handle = (): PoolBootstrapHandle =>
  ({
    orgId: 'org-1',
    createdOrgId: 'org-1',
    locationId: 'loc-1',
    stationIds: ['stn_aaaaaaaa'],
    certFiles: [],
    seededServiceIds: [],
    identityCredentials: [],
  }) as unknown as PoolBootstrapHandle;

/**
 * The money path in teardown, added the day a scenario first reached SETTLEMENT.
 *
 * None of these tables needed sweeping before, and that is exactly why the gap existed: no
 * run had ever completed a card payment, so none produced an intent, a refund or a ledger
 * row. `multiunit-jam-drive` now buys a two-unit batch, jams unit 2 and takes the tail
 * refund — and the first pooled run of it failed teardown on `payment_ledger_refund_id_fkey`,
 * leaving an org, a station, a batch, intents, refunds and ledger rows behind.
 *
 * ORDER IS THE ASSERTION, not presence. The FK graph (read from pg_constraint, not guessed)
 * is: payment_ledger + platform_settlement_ledger -> {payment_intents, refunds};
 * refunds -> payment_intents; sessions -> unit_batches; unit_batches -> payment_intents.
 * A sweep with every table present but in the wrong order fails just as hard as one missing
 * a table — and fails LOUDLY, which is the design (FK checks stay on).
 */
describe('teardown — the money path', () => {
  const sql = buildTeardownSql(handle());
  const at = (t: string) => sql.indexOf(`DELETE FROM ${t}`);

  it('sweeps every table the settlement path writes', () => {
    for (const t of [
      'payment_ledger',
      'platform_settlement_ledger',
      'refunds',
      'unit_batches',
      'payment_intents',
      'tenant_payment_credentials',
      // G12, the monthly settlement (csms-server 06c05499).
      'settlement_adjustments',
      'tenant_settlement_terms',
      'tenant_statements',
      // R8, an organization's VAT from a date (csms-server 1d4b1c0d).
      'organization_vat_terms',
    ]) {
      expect(at(t), `${t} is not swept`).toBeGreaterThanOrEqual(0);
    }
  });

  it('deletes children before parents, over the real FK graph', () => {
    expect(at('payment_ledger')).toBeLessThan(at('refunds'));
    expect(at('platform_settlement_ledger')).toBeLessThan(at('refunds'));
    expect(at('refunds')).toBeLessThan(at('payment_intents'));
    expect(at('sessions')).toBeLessThan(at('unit_batches'));
    expect(at('unit_batches')).toBeLessThan(at('payment_intents'));
    // The credential row blocks the ORG delete, which is the last thing to go.
    expect(at('tenant_payment_credentials')).toBeLessThan(at('organizations'));
    // G12: the ledger points at sessions too; an adjustment at payment_intents; a statement is
    // pointed at by both, and the three new tables point at the organization.
    expect(at('platform_settlement_ledger')).toBeLessThan(at('sessions'));
    expect(at('settlement_adjustments')).toBeLessThan(at('payment_intents'));
    expect(at('platform_settlement_ledger')).toBeLessThan(at('tenant_statements'));
    expect(at('settlement_adjustments')).toBeLessThan(at('tenant_statements'));
    for (const t of ['settlement_adjustments', 'tenant_settlement_terms', 'tenant_statements', 'organization_vat_terms']) {
      expect(at(t), `${t} must go before the organization`).toBeLessThan(at('organizations'));
    }
  });

  /**
   * A batch tail refund is raised against the INTENT for units that never started, so it has
   * no session to be found by. Scoping refunds on session_id alone — which is what the sweep
   * did — silently leaves exactly the refund this corpus now produces.
   */
  it('finds a refund that has no session', () => {
    const stmt = sql.slice(at('refunds'), sql.indexOf(';', at('refunds')));
    expect(stmt).toContain('payment_intent_id IN');
    expect(stmt).toContain('session_id IN');
  });

  /**
   * Scoped by the run's own BAY BUSINESS IDS, never by a REUSED organisation: the bootstrap
   * sometimes reuses a standing org rather than minting one, and an org-scoped delete would
   * then reach intents another run created. Bays are always run-created.
   *
   * The distinction is `createdOrgId`, not `orgId`. This used to assert the string
   * `organization_id` was absent outright, on a fixture where the two fields held the SAME
   * value — so it could not tell a reused org from a minted one, and it read as a ban on
   * both. A run-minted org is a different thing: nothing inside it predates the run, so
   * reaching stations through it is how the teardown stops FK-aborting on a location a
   * scenario made (see TeardownOrderMatchesDeletionContract.test.ts). The ban that matters
   * is the one below: a REUSED org must never scope anything.
   */
  it('never scopes the money sweep by a REUSED organisation', () => {
    const reused = buildTeardownSql({ ...handle(), createdOrgId: undefined });
    const from = reused.indexOf('DELETE FROM payment_intents');
    const stmt = reused.slice(from, reused.indexOf(';', from));
    expect(stmt).toContain('SELECT bay_id FROM bays');
    expect(stmt).not.toContain('organization_id');
    // And nothing else in the whole transaction leans on the reused org either.
    expect(reused).not.toContain("organization_id = 'org-1'");
  });

  it('reaches through a MINTED org only, and still only through this run\'s bays', () => {
    const stmt = sql.slice(at('payment_intents'), sql.indexOf(';', at('payment_intents')));
    expect(stmt).toContain('SELECT bay_id FROM bays');
    // The only organisation named anywhere in the transaction is the one this run
    // created: at least one `organization_id = '...'` scope, and every one names that id.
    const scoped = [...sql.matchAll(/organization_id = '([^']+)'/g)].map((m) => m[1]);
    expect(scoped.length).toBeGreaterThan(0);
    expect([...new Set(scoped)]).toEqual(['org-1']);
  });
});

/**
 * G12 — THE MONTHLY SETTLEMENT (csms-server 06c05499, branch feat/g11-monthly-settlement-20261012).
 *
 * A wallet wash now settles in platform_settlement_ledger: one row per session paid from a wallet,
 * written when the session settles, keyed on its session_id with payment_intent_id NULL
 * (WalletWashSettlementRecorder::record). The pool half found ledger rows by intent and refund
 * alone, so the first charged pooled wallet session would have left a row that
 * platform_settlement_ledger_session_id_fkey holds the sessions delete on - and with it, the
 * transaction being one, the whole per-run world.
 *
 * Three new tables point at the organization, all NO ACTION: settlement_adjustments (a chargeback
 * the platform super admin enters, also NO ACTION to payment_intents), tenant_settlement_terms
 * (commission and payment mode from a date) and tenant_statements (a closed month, which holds its
 * ledger rows and adjustments through their statement_id). The teardown removes the minted
 * organization's rows of all three, and nothing of a reused organization.
 */
describe('teardown — the monthly settlement (G12)', () => {
  const lines = (sql: string): string[] => sql.split('\n');
  const deletesOf = (sql: string, table: string): string[] =>
    lines(sql).filter((l) => new RegExp(`^DELETE FROM ${table}\\b`).test(l));
  const firstAt = (sql: string, table: string): number =>
    lines(sql).findIndex((l) => new RegExp(`^DELETE FROM ${table}\\b`).test(l));
  const lastAt = (sql: string, table: string): number =>
    lines(sql).reduce((last, l, i) => (new RegExp(`^DELETE FROM ${table}\\b`).test(l) ? i : last), -1);

  it("finds a wallet wash's ledger row by the session it names - exactly the sessions the sessions delete removes", () => {
    const sql = buildTeardownSql(handle());
    const sessionsWhere = /^DELETE FROM sessions WHERE (.*);$/m.exec(sql)?.[1];
    expect(sessionsWhere).toBeDefined();
    const ledger = deletesOf(sql, 'platform_settlement_ledger');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toContain(` OR session_id IN (SELECT id FROM sessions WHERE ${sessionsWhere}) OR `);
    expect(firstAt(sql, 'platform_settlement_ledger')).toBeLessThan(firstAt(sql, 'sessions'));
  });

  it("deletes the minted organization's adjustments, terms and statements, the held rows by the statement arm", () => {
    const sql = buildTeardownSql(handle());
    const statementsOfOrg = "statement_id IN (SELECT id FROM tenant_statements WHERE organization_id = 'org-1')";
    expect(deletesOf(sql, 'settlement_adjustments')).toEqual([
      `DELETE FROM settlement_adjustments WHERE organization_id = 'org-1' OR ${statementsOfOrg};`,
    ]);
    expect(deletesOf(sql, 'platform_settlement_ledger')[0].endsWith(` OR ${statementsOfOrg};`)).toBe(true);
    expect(deletesOf(sql, 'tenant_settlement_terms')).toEqual([
      "DELETE FROM tenant_settlement_terms WHERE organization_id = 'org-1';",
    ]);
    expect(deletesOf(sql, 'tenant_statements')).toEqual([
      "DELETE FROM tenant_statements WHERE organization_id = 'org-1';",
    ]);
  });

  it('deletes the statements after every ledger row and adjustment delete in the transaction, the identity sweeps included', () => {
    const sql = buildTeardownSql({
      ...handle(),
      ephemeralOwnerEmail: 'sim-pool-owner-g12@onestoppay.dev',
      identityCredentials: [{ email: 'sim-worker-g12-0@test.local', password: 'p' }],
      createdUserEmails: ['created-g12@onestoppay.dev'],
    } as PoolBootstrapHandle);
    const statementsAt = firstAt(sql, 'tenant_statements');
    expect(statementsAt).toBeGreaterThan(-1);
    expect(lastAt(sql, 'platform_settlement_ledger')).toBeLessThan(statementsAt);
    expect(lastAt(sql, 'settlement_adjustments')).toBeLessThan(statementsAt);
    expect(statementsAt).toBeLessThan(firstAt(sql, 'organizations'));
  });

  it("R8: deletes the minted organization's VAT rates by the organization, before the organizations delete", () => {
    const sql = buildTeardownSql(handle());
    expect(deletesOf(sql, 'organization_vat_terms')).toEqual([
      "DELETE FROM organization_vat_terms WHERE organization_id = 'org-1';",
    ]);
    expect(firstAt(sql, 'organization_vat_terms')).toBeLessThan(firstAt(sql, 'organizations'));
  });

  it("R8: deletes no VAT rate of a reused organization - the platform organization's own rates are never a run's", () => {
    // A run reuses an organization it did not mint (no createdOrgId): that organization keeps its
    // rates. The platform organization is never one a run mints (the bootstrap creates its org
    // through POST /api/v1/organizations), so no organization arm can name it.
    const reused = buildTeardownSql({ ...handle(), createdOrgId: undefined });
    expect(deletesOf(reused, 'organization_vat_terms')).toEqual([]);
    expect(reused).not.toContain('organization_vat_terms');
  });

  it('touches none of the three for a reused organization, and names no statement', () => {
    const reused = buildTeardownSql({ ...handle(), createdOrgId: undefined });
    for (const t of ['settlement_adjustments', 'tenant_settlement_terms', 'tenant_statements']) {
      expect(deletesOf(reused, t), `${t} deleted for a reused organization`).toEqual([]);
    }
    expect(reused).not.toContain('tenant_statements');
    // The session arm is the run's bays', so it stays.
    expect(deletesOf(reused, 'platform_settlement_ledger')[0]).toContain(' OR session_id IN (SELECT id FROM sessions WHERE bay_id IN (');
  });
});

/**
 * CW110 — THE SETTLEMENT OUTBOX.
 *
 * csms-server writes a `settlement_outbox` row in the same transaction as a settlement that
 * owes something: `CompleteSessionAction` and `FailSessionAction` record aggregate_type
 * 'session', aggregate_id = sessions.session_id (the varchar `sess_` id), event SessionCompleted
 * or SessionFailed, whenever the settlement leaves a refund; `SettlementFiscalEmitter` records
 * aggregate_type 'payment_intent', aggregate_id = payment_intents.id as text, event
 * 'FiscalDocumentRequested', for a settled web payment (an intent with reference_type
 * 'session_payment' whose platform_settlement_ledger row exists). The table carries no foreign key
 * (2026_07_14_000002_create_settlement_outbox_table), so its rows never block a teardown and
 * were never deleted by one: every settled run left them naming sessions and intents that no
 * longer exist.
 *
 * Each teardown half now deletes the outbox rows of exactly the sessions and intents it
 * deletes — selected by the same predicate as those deletes — BEFORE them, because the rows
 * are found through the sessions and intents themselves.
 */
const OUTBOX_EMAILS = ['sim-worker-cw110-0@test.local', 'sim-worker-cw110-1@test.local'];

/** The WHERE clause of the first `DELETE FROM <table> WHERE ...;` statement in `stmts`. */
function firstDeletePredicate(stmts: string[], table: string): string | undefined {
  const re = new RegExp(`^DELETE FROM ${table} WHERE (.*);$`);
  for (const stmt of stmts) {
    const m = re.exec(stmt);
    if (m) return m[1];
  }
  return undefined;
}

/** The outbox delete that reaches exactly the sessions and intents the two predicates select. */
function expectedOutboxDelete(sessionsWhere: string, intentsWhere: string): string {
  return (
    `DELETE FROM settlement_outbox WHERE ` +
    `(aggregate_type = 'session' AND aggregate_id IN (SELECT session_id FROM sessions WHERE ${sessionsWhere})) ` +
    `OR (aggregate_type = 'payment_intent' AND aggregate_id IN (SELECT id::text FROM payment_intents WHERE ${intentsWhere}));`
  );
}

function expectOutboxSwept(stmts: string[], label: string): void {
  const sessionsWhere = firstDeletePredicate(stmts, 'sessions');
  const intentsWhere = firstDeletePredicate(stmts, 'payment_intents');
  expect(sessionsWhere, `${label} deletes no sessions`).toBeDefined();
  expect(intentsWhere, `${label} deletes no payment_intents`).toBeDefined();

  const outbox = stmts.filter((s) => /^DELETE FROM settlement_outbox\b/.test(s));
  expect(
    outbox,
    `${label} never deletes from settlement_outbox, so the SessionCompleted / SessionFailed rows ` +
    `of the sessions it deletes and the FiscalDocumentRequested rows of the intents it deletes ` +
    `outlive their subjects`,
  ).toHaveLength(1);
  expect(
    outbox[0],
    `${label}: the outbox delete must select the rows of exactly the sessions and intents this ` +
    `teardown deletes, by the same predicates, and nothing else`,
  ).toBe(expectedOutboxDelete(sessionsWhere!, intentsWhere!));

  const at = (re: RegExp) => stmts.findIndex((s) => re.test(s));
  const outboxAt = at(/^DELETE FROM settlement_outbox\b/);
  expect(outboxAt, `${label}: the outbox delete must run BEFORE DELETE FROM sessions, which it reads`)
    .toBeLessThan(at(/^DELETE FROM sessions\b/));
  expect(outboxAt, `${label}: the outbox delete must run BEFORE DELETE FROM payment_intents, which it reads`)
    .toBeLessThan(at(/^DELETE FROM payment_intents\b/));
}

describe('teardown — the settlement outbox (CW110)', () => {
  it("the pool half deletes the outbox rows of the run's sessions and intents, before them", () => {
    // The pool half alone: no identity sweep, so the first sessions and payment_intents
    // deletes are the pool's own (by the run's bays).
    expectOutboxSwept(buildTeardownSql(handle()).split('\n'), 'the pool teardown');
  });

  it("the user sweep deletes the outbox rows of the swept users' sessions and intents, before them", () => {
    expectOutboxSwept(
      buildTeardownTestUsersSql(OUTBOX_EMAILS, { protectedEmails: [] }),
      'the user sweep',
    );
  });
});

/**
 * csms-server offline group 2 (spec v0.45.0, OM13) - THE OFFLINE WASHES IN THE MONTHLY STATEMENT.
 *
 * A settled offline wash now enters its station's tenant's statement: a platform_settlement_ledger row
 * keyed on its offline_transaction_id, with no session and no intent, NO ACTION to the organization. Its
 * FK to the offline transaction is SET NULL, so the offline_transactions delete is not refused - it nulls
 * the column and leaves the row naming the organization, and the organizations delete at the end refused
 * the whole transaction. Measured on UAT 2026-10-23, the first pooled runs of the group 2 scenarios:
 * platform_settlement_ledger_organization_id_fkey, every run whose wash settled leaving its pool behind.
 */
describe('teardown — the offline washes in the monthly statement (csms-server offline group 2)', () => {
  const ledgerOfOfflineWashes = (offlineWhere: string): string =>
    ` OR offline_transaction_id IN (SELECT id FROM offline_transactions WHERE ${offlineWhere})`;

  it("the pool half finds an offline wash's ledger row by the transaction it names - exactly the offline transactions it deletes, before them", () => {
    const sql = buildTeardownSql(handle());
    const lines = sql.split('\n');
    const offlineWhere = /^DELETE FROM offline_transactions WHERE (.*);$/m.exec(sql)?.[1];
    expect(offlineWhere).toBeDefined();
    const ledger = lines.filter((l) => /^DELETE FROM platform_settlement_ledger\b/.test(l));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toContain(ledgerOfOfflineWashes(offlineWhere as string));
    expect(lines.findIndex((l) => /^DELETE FROM platform_settlement_ledger\b/.test(l)))
      .toBeLessThan(lines.findIndex((l) => /^DELETE FROM offline_transactions\b/.test(l)));
  });

  it("the user sweep finds the ledger rows of the swept users' offline washes the same way, before their offline transactions", () => {
    const lines = buildTeardownTestUsersSql(OUTBOX_EMAILS, { protectedEmails: [] });
    const offlineWhere = lines.map((l) => /^DELETE FROM offline_transactions WHERE (.*);$/.exec(l)?.[1]).find(Boolean);
    expect(offlineWhere).toBeDefined();
    const ledgerAt = lines.findIndex((l) => /^DELETE FROM platform_settlement_ledger\b/.test(l));
    expect(lines[ledgerAt]).toContain(ledgerOfOfflineWashes(offlineWhere as string));
    expect(ledgerAt).toBeLessThan(lines.findIndex((l) => /^DELETE FROM offline_transactions\b/.test(l)));
  });
});

/**
 * csms-server offline group 3 (2026-10-23) - THE PARTIAL-A WASH IN THE STATEMENT.
 *
 * A Partial-A receipt is stored as the offline transaction it is, naming its authorization: offline_transactions.auth_id
 * -> offline_auth_grants.auth_id, ON DELETE CASCADE. So deleting a grant deletes its transaction, and that delete nulls the
 * ledger row's offline_transaction_id (SET NULL) - the row stays, naming its organization NO ACTION. Measured on UAT
 * 2026-10-23: the Partial-A expiry scenario's customer swept its grant first, and the pool's organizations delete was
 * refused on platform_settlement_ledger_organization_id_fkey. Every sweep that deletes grants deletes the ledger rows of
 * the swept offline transactions BEFORE it.
 */
describe('teardown — the Partial-A wash in the monthly statement (csms-server offline group 3)', () => {
  it("the user sweep deletes the swept users' offline-wash ledger rows before their grants, whose cascade nulls the key", () => {
    const lines = buildTeardownTestUsersSql(OUTBOX_EMAILS, { protectedEmails: [] });
    const ledgerAt = lines.findIndex((l) => /^DELETE FROM platform_settlement_ledger\b/.test(l));
    const grantsAt = lines.findIndex((l) => /^DELETE FROM offline_auth_grants\b/.test(l));
    expect(ledgerAt).toBeGreaterThanOrEqual(0);
    expect(grantsAt).toBeGreaterThanOrEqual(0);
    expect(ledgerAt).toBeLessThan(grantsAt);
  });

  it('the pool half does too', () => {
    const lines = buildTeardownSql(handle()).split('\n');
    const ledgerAt = lines.findIndex((l) => /^DELETE FROM platform_settlement_ledger\b/.test(l));
    const grantsAt = lines.findIndex((l) => /^DELETE FROM offline_auth_grants\b/.test(l));
    expect(ledgerAt).toBeGreaterThanOrEqual(0);
    expect(grantsAt).toBeGreaterThanOrEqual(0);
    expect(ledgerAt).toBeLessThan(grantsAt);
  });
});
