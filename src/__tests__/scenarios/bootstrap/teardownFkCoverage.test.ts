import { describe, it, expect } from 'vitest';
import { buildTeardownSql, type PoolBootstrapHandle } from '../../../scenarios/bootstrap/PoolBootstrap.js';
import { buildTeardownTestUsersSql } from '../../../scenarios/bootstrap/uatPrivileged.js';
import { StationPool } from '../../../scenarios/stations/StationPool.js';

/**
 * P1 static check — pg_constraint reverse-graph assertion.
 *
 * This test asserts a structural property: for EVERY `NO ACTION` foreign key whose
 * parent table the teardown SQL deletes from, the teardown ALSO deletes from the
 * child table, AND the child delete appears BEFORE the parent delete. Without
 * this property, the parent delete is FK-blocked at runtime — exactly the bug
 * that has now shipped twice (F-PROC-1: sessions-before-reservations missing;
 * commit #3: offline_passes-before-users missing). Both slipped because the unit
 * tests asserted SQL TEXT, not the FK GRAPH.
 *
 * THE SNAPSHOT. SCHEMA_FK_GRAPH below was regenerated on 2026-09-29 from csms-server master
 * 87164f7d: its 190 migrations applied to an empty database, and every foreign key read from
 * pg_constraint with
 *
 *   psql -AtF '|' -c "
 *     SELECT par.relname AS parent, chi.relname AS child,
 *            (SELECT string_agg(a.attname, ',' ORDER BY k.n)
 *               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, n)
 *               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
 *            (SELECT string_agg(a.attname, ',' ORDER BY k.n)
 *               FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, n)
 *               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS parent_columns,
 *            CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
 *                 WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END,
 *            con.conname, con.condeferrable, con.condeferred
 *     FROM pg_constraint con
 *     JOIN pg_class chi ON chi.oid = con.conrelid
 *     JOIN pg_class par ON par.oid = con.confrelid
 *     WHERE con.contype = 'f' AND con.conparentid = 0
 *     ORDER BY 1, 2, 6;"
 *
 * 75 foreign keys: 44 NO ACTION, 22 CASCADE, 6 SET NULL, 3 RESTRICT; every one single-column
 * and NOT DEFERRABLE. The snapshot has an entry for every table the teardown deletes from -
 * both halves, buildTeardownSql and buildTeardownTestUsersSql, 36 tables - holding every FK that
 * points at that table; an empty entry is a table no FK points at. 65 of the 75 are listed here.
 * The other 10:
 *
 *   - 9 point at tables the teardown never deletes from: permissions (2), roles (2),
 *     station_models (2) and station_services (3). The checks read DELETE statements, so an
 *     entry for a table the teardown reaches only through a cascade could not be checked.
 *   - 1 is platform_settlement_ledger's reference to itself; see the note at its entry.
 *
 * `con.conparentid = 0` leaves out partition clones. security_events is partitioned by month,
 * and every partition carries a copy of security_events_station_id_fkey whose conparentid names
 * the parent table's FK - 4 of them in that database, security_events_2026_09 to _12. The
 * partitions are created by the migration that creates security_events (the month it runs and
 * the three after) and daily by ospp:security:manage-partitions, so their names follow the
 * calendar; the FK on security_events is the edge, and it is listed under stations.
 *
 * Regenerate when csms-server's migrations add or change a foreign key into a table the
 * teardown deletes from, and whenever the teardown starts deleting from a table it did not
 * (the last describe below fails until that table has an entry). After a regeneration the
 * checks below fail for every NO ACTION child the teardown does not delete first, until
 * `buildTeardownTestUsersSql` / `buildTeardownSql` do. That's the CI-time safety net commit #3
 * lacked.
 *
 * Why a snapshot and not live introspection: the test must run in CI without a live
 * Postgres (the F-PROC-1 doc commits to "pure static analysis on generated SQL +
 * schema graph, no live Postgres at test runtime"). The snapshot is the contract.
 */

type OnDelete = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'RESTRICT';
interface FkEdge {
  child: string;
  column: string;
  onDelete: OnDelete;
}

const SCHEMA_FK_GRAPH: Record<string, FkEdge[]> = {
  // 15 FKs point at users: 12 NO ACTION, each of which blocks the users delete until its rows
  // are gone; 2 CASCADE (api_keys, refresh_tokens), removed with the user; 1 SET NULL
  // (session_settlement_retries.settled_by_user_id), nulled with the user.
  users: [
    { child: 'api_keys',                   column: 'user_id',            onDelete: 'CASCADE'   },
    { child: 'invitations',                column: 'invited_by',         onDelete: 'NO ACTION' },
    { child: 'invitations',                column: 'revoked_by',         onDelete: 'NO ACTION' },
    { child: 'offline_auth_grants',        column: 'user_id',            onDelete: 'NO ACTION' },
    { child: 'offline_passes',             column: 'user_id',            onDelete: 'NO ACTION' },
    { child: 'offline_transactions',       column: 'user_id',            onDelete: 'NO ACTION' },
    { child: 'organization_members',       column: 'user_id',            onDelete: 'NO ACTION' },
    { child: 'payment_intents',            column: 'user_id',            onDelete: 'NO ACTION' },
    { child: 'refresh_tokens',             column: 'user_id',            onDelete: 'CASCADE'   },
    { child: 'reservations',               column: 'user_id',            onDelete: 'NO ACTION' },
    { child: 'session_settlement_retries', column: 'settled_by_user_id', onDelete: 'SET NULL'  },
    { child: 'sessions',                   column: 'user_id',            onDelete: 'NO ACTION' },
    { child: 'unit_batches',               column: 'user_id',            onDelete: 'NO ACTION' },
    { child: 'vehicles',                   column: 'user_id',            onDelete: 'NO ACTION' },
    { child: 'wallets',                    column: 'user_id',            onDelete: 'NO ACTION' },
  ],
  // 1 FK points at wallets, NO ACTION — easy to miss, blew up commit #3's teardown at the
  // wallets-delete step if wallet_entries was non-empty.
  wallets: [
    { child: 'wallet_entries', column: 'wallet_id', onDelete: 'NO ACTION' },
  ],
  // 4 FKs point at sessions: 3 NO ACTION, which must go before the sessions delete, and
  // session_settlement_retries.session_id, which references sessions.session_id (not id) ON
  // DELETE CASCADE. offline_auth_grants.reconciled_session_id was a NO ACTION child until
  // 2026_08_19_000005_retype_offline_auth_grant_reconciled_session_id dropped its FK and
  // retyped the column to the varchar business id.
  sessions: [
    { child: 'offline_transactions',       column: 'reconciled_session_id', onDelete: 'NO ACTION' },
    { child: 'platform_settlement_ledger', column: 'session_id',            onDelete: 'NO ACTION' },
    { child: 'refunds',                    column: 'session_id',            onDelete: 'NO ACTION' },
    { child: 'session_settlement_retries', column: 'session_id',            onDelete: 'CASCADE'   },
  ],
  // 1 FK points at reservations, NO ACTION.
  reservations: [
    { child: 'sessions', column: 'reservation_id', onDelete: 'NO ACTION' },
  ],
  // 4 FKs point at payment_intents, all NO ACTION. sessions carries a payment_intent_id column
  // with no FK, so it is not among them.
  payment_intents: [
    { child: 'payment_ledger',             column: 'payment_intent_id', onDelete: 'NO ACTION' },
    { child: 'platform_settlement_ledger', column: 'payment_intent_id', onDelete: 'NO ACTION' },
    { child: 'refunds',                    column: 'payment_intent_id', onDelete: 'NO ACTION' },
    { child: 'unit_batches',               column: 'payment_intent_id', onDelete: 'NO ACTION' },
  ],
  // 2 FKs point at refunds, both NO ACTION.
  refunds: [
    { child: 'payment_ledger',             column: 'refund_id', onDelete: 'NO ACTION' },
    { child: 'platform_settlement_ledger', column: 'refund_id', onDelete: 'NO ACTION' },
  ],
  // 1 FK points at unit_batches, NO ACTION. The table was created as token_batches by
  // 2026_07_08_000001 and renamed by 2026_07_09_000003, its FKs with it (they keep their
  // token_batches_ names).
  unit_batches: [
    { child: 'sessions', column: 'batch_id', onDelete: 'NO ACTION' },
  ],
  // 1 FK points at platform_settlement_ledger, and it is NOT LISTED, on purpose:
  // platform_settlement_ledger.reverses_settlement_id references platform_settlement_ledger
  // itself (NO ACTION). A table-order check cannot express a self-reference, since no delete
  // can precede itself. What keeps it from blocking: a reversal row copies its settlement's
  // payment_intent_id and session_id (SettlementReversalRecorder), so a statement that reaches
  // a settlement by either key reaches its reversals in the same statement, and NO ACTION is
  // checked at the end of it.
  platform_settlement_ledger: [],
  // 10 FKs point at stations: 7 NO ACTION; station_services CASCADE; security_events and
  // station_journal SET NULL, which neither block nor cascade - the delete nulls the key and the
  // row stays, so buildTeardownSql deletes both itself. (The 4 partition clones of the
  // security_events FK are left out; see the docblock.)
  stations: [
    { child: 'bays',                   column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'diagnostics_uploads',    column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'firmware_updates',       column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'offline_auth_grants',    column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'offline_transactions',   column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'security_events',        column: 'station_id', onDelete: 'SET NULL'  },
    { child: 'service_catalogs',       column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'station_configurations', column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'station_journal',        column: 'station_id', onDelete: 'SET NULL'  },
    { child: 'station_services',       column: 'station_id', onDelete: 'CASCADE'   },
  ],
  // 6 FKs point at bays: 3 NO ACTION; bay_programs and bay_services CASCADE; station_journal
  // SET NULL.
  bays: [
    { child: 'bay_programs',         column: 'bay_id', onDelete: 'CASCADE'   },
    { child: 'bay_services',         column: 'bay_id', onDelete: 'CASCADE'   },
    { child: 'offline_transactions', column: 'bay_id', onDelete: 'NO ACTION' },
    { child: 'reservations',         column: 'bay_id', onDelete: 'NO ACTION' },
    { child: 'sessions',             column: 'bay_id', onDelete: 'NO ACTION' },
    { child: 'station_journal',      column: 'bay_id', onDelete: 'SET NULL'  },
  ],
  // 1 FK points at locations, NO ACTION.
  locations: [
    { child: 'stations', column: 'location_id', onDelete: 'NO ACTION' },
  ],
  // 1 FK points at service_definitions.
  service_definitions: [
    // RESTRICT acts identical to NO ACTION for the blocking question — but the
    // teardown deliberately orphan-sweeps service_definitions LAST (after stations
    // cascade-removes station_services), so the RESTRICT FK is satisfied by then.
    { child: 'station_services', column: 'service_definition_id', onDelete: 'RESTRICT' },
  ],
  // 14 FKs point at organizations: 7 NO ACTION, each of which must be deleted first or the org
  // delete FK-blocks; 7 CASCADE, removed by the org delete. The ephemeral-org teardown
  // (Direction B) deletes the org last. corporate_policies.organization_id went with its table
  // (2026_09_04_000003_drop_corporate_policies_table, ADR-0012).
  organizations: [
    { child: 'invitations',                column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'locations',                  column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'model_has_roles',            column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'offline_auth_grants',        column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'offline_passes',             column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'organization_members',       column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'platform_settlement_ledger', column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'revocation_epochs',          column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'roles',                      column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'service_definitions',        column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'sessions',                   column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'station_models',             column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'stations',                   column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'tenant_payment_credentials', column: 'organization_id', onDelete: 'NO ACTION' },
  ],
  // 2 FKs point at offline_passes: offline_transactions NO ACTION, offline_pass_consumptions
  // CASCADE.
  offline_passes: [
    { child: 'offline_pass_consumptions', column: 'offline_pass_id', onDelete: 'CASCADE'   },
    { child: 'offline_transactions',      column: 'offline_pass_id', onDelete: 'NO ACTION' },
  ],
  // 2 FKs point at provisioning_tokens, both CASCADE.
  provisioning_tokens: [
    { child: 'provisioning_bound_bays', column: 'provisioning_token_id', onDelete: 'CASCADE' },
    { child: 'provisioning_bound_keys', column: 'provisioning_token_id', onDelete: 'CASCADE' },
  ],
  // 1 FK points at certificates, SET NULL.
  certificates: [
    { child: 'provisioning_tokens', column: 'issued_certificate_id', onDelete: 'SET NULL' },
  ],
  // No FK points at any of these 20, so nothing can block their deletes (the FKs they carry
  // as children are in the entries above).
  diagnostics_uploads: [],
  firmware_updates: [],
  invitations: [],
  meter_values: [],
  model_has_permissions: [],
  model_has_roles: [],
  offline_auth_grants: [],
  offline_transactions: [],
  organization_members: [],
  payment_ledger: [],
  pending_commands: [],
  security_event_dedup: [],
  security_events: [],
  service_catalogs: [],
  settlement_outbox: [],
  station_configurations: [],
  station_journal: [],
  tenant_payment_credentials: [],
  vehicles: [],
  wallet_entries: [],
};

/** Full-coverage handle — every optional path populated so buildTeardownSql emits everything. */
function fullHandle(): PoolBootstrapHandle {
  return {
    orgId: '019e674f-aa63-7309-ab7a-c71fcd6178de',
    createdOrgId: '019e674f-aa63-7309-ab7a-c71fcd6178de',
    ephemeralOwnerEmail: 'sim-pool-owner-test@onestoppay.dev',
    locationId: '019e81fb-58db-7173-89b6-d1ae08cf9a0e',
    stationIds: ['stn_aaaa1111', 'stn_bbbb2222'],
    certFiles: [],
    seededServiceIds: ['svc_wash_basic', 'svc_wash_premium', 'svc_dry', 'svc_vacuum'],
    identityCredentials: [
      { email: 'sim-worker-test-0@test.local', password: 'p' },
      { email: 'sim-worker-test-1@test.local', password: 'p' },
    ],
    pool: new StationPool(),
  };
}

/**
 * Find the first line index where a `DELETE FROM <table>` appears (word-boundary
 * matched so `DELETE FROM users` doesn't match `DELETE FROM users_...`). Returns
 * -1 if not found. The earliest match is what matters for ordering checks — multiple
 * DELETEs against the same table all need to land before any parent delete, and the
 * first one is the floor.
 */
function deleteAt(sql: string, table: string): number {
  // Word-boundary: the table name must be followed by whitespace or end-of-string,
  // not by an identifier character. Prevents 'users' matching 'users_meta', etc.
  const re = new RegExp(`DELETE FROM ${table}(?![A-Za-z0-9_])`);
  const lines = sql.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

/** One ordering the P1 check asks of a piece of SQL: `edge.child` is deleted before `parent`. */
interface Ordering {
  parent: string;
  /** The line of the first `DELETE FROM <parent>`. */
  parentAt: number;
  edge: FkEdge;
}

/**
 * The orderings the P1 check asks of one piece of SQL: for every parent it deletes from, every
 * NO-ACTION FK child must also be deleted, and the child delete must come BEFORE the parent's
 * delete. (CASCADE auto-handles itself; SET NULL doesn't block; RESTRICT is treated like NO ACTION
 * but is currently only present on service_definitions, where the teardown deliberately
 * defers the orphan-sweep until AFTER stations cascade-removes station_services — that
 * ordering is covered by a separate test in PoolBootstrap.test.ts.)
 */
function blockingOrderings(sql: string): Ordering[] {
  const orderings: Ordering[] = [];
  for (const [parent, edges] of Object.entries(SCHEMA_FK_GRAPH)) {
    const parentAt = deleteAt(sql, parent);
    if (parentAt < 0) continue; // this SQL doesn't touch this parent — nothing to assert
    for (const edge of edges) {
      if (edge.onDelete !== 'NO ACTION') continue;
      orderings.push({ parent, parentAt, edge });
    }
  }
  return orderings;
}

/** The P1 check over one piece of SQL, one case per ordering {@link blockingOrderings} asks. */
function reverseGraphChecks(sql: string, label: string): void {
  for (const { parent, parentAt, edge } of blockingOrderings(sql)) {
    it(
      `[${parent}] DELETE FROM ${edge.child} ` +
      `(FK: ${edge.child}.${edge.column} → ${parent}, ON DELETE NO ACTION) ` +
      `must run before DELETE FROM ${parent}`,
      () => {
        const childAt = deleteAt(sql, edge.child);
        expect(
          childAt,
          `${label} is missing 'DELETE FROM ${edge.child}' — without it, ` +
          `'DELETE FROM ${parent}' will be FK-blocked at runtime by ` +
          `${edge.child}.${edge.column} → ${parent}.id (ON DELETE NO ACTION). ` +
          `This is the exact failure class that shipped twice already; close it now.`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          childAt,
          `'DELETE FROM ${edge.child}' (line ${childAt}) must run BEFORE ` +
          `'DELETE FROM ${parent}' (line ${parentAt}) — Postgres evaluates FK ` +
          `constraints at statement time, not at COMMIT (every FK in the snapshot is NOT ` +
          `DEFERRABLE), so order is load-bearing inside the transaction.`,
        ).toBeLessThan(parentAt);
      },
    );
  }
}

describe('teardown FK coverage — P1 reverse-graph static check', () => {
  const sql = buildTeardownSql(fullHandle());

  reverseGraphChecks(sql, 'teardown SQL');

  it('emits a single transaction (one BEGIN, one COMMIT)', () => {
    expect((sql.match(/\bBEGIN;/g) ?? []).length).toBe(1);
    expect((sql.match(/\bCOMMIT;/g) ?? []).length).toBe(1);
  });

  it('full-coverage handle exercises every conditional branch (sanity for the snapshot)', () => {
    // service_definitions orphan-sweep, identity sweep, offline reset all opt-in based
    // on handle fields. The full handle should trigger all of them so the FK coverage
    // assertion sees the full graph the teardown can emit.
    expect(sql).toContain('DELETE FROM service_definitions');
    expect(sql).toContain('DELETE FROM users WHERE email');
  });
});

/**
 * CW109 — THE USER SWEEP, CHECKED BY ITSELF.
 *
 * The check above reads the FIRST `DELETE FROM` of each table in the WHOLE teardown. The pool
 * half deletes refunds, payment_ledger, platform_settlement_ledger and unit_batches before its
 * own payment_intents, so those first occurrences stood in for the user sweep's, and the user
 * sweep's own order was never checked. It had no refunds, ledger or unit_batches delete at all.
 *
 * The user sweep does run alone: `teardownScenarioResources` feeds a scenario's ledger through
 * `buildTeardownSql`, whose pool half then covers only the scenario's OWN stations. A
 * `creates: user` customer whose wallet session was refunded anywhere else leaves a refund
 * that points at the synthetic intent `ProcessRefundAction::getOrCreatePaymentIntentId` minted
 * for that session - processor 'wallet', user_id the session's user, reference_type
 * 'session_wallet' - and with no refunds delete in the sweep, `refunds_payment_intent_id_fkey`
 * blocked its payment_intents delete and rolled the whole teardown back.
 */
describe('teardown FK coverage — the user sweep alone (CW109)', () => {
  const sql = buildTeardownTestUsersSql(
    ['sim-worker-test-0@test.local', 'sim-worker-test-1@test.local'],
    { protectedEmails: [] },
  ).join('\n');

  reverseGraphChecks(sql, 'the user sweep');
});

/**
 * CW109 — THE SAME GRAPH, ROW BY ROW, FOR THE USER SWEEP.
 *
 * The reverse-graph check is TABLE-level: it proves a `DELETE FROM <child>` exists and runs
 * first, not that it reaches the child rows that point at the parent rows being deleted. The
 * user sweep's invitations delete passed it for invitations.revoked_by while selecting only
 * by invited_by and email, so an invitation a swept user revoked, sent by someone else to
 * someone else, would still have blocked the users delete.
 *
 * So each NO ACTION edge into a parent the user sweep deletes is also checked by predicate: the
 * child's delete must select through that edge's column and the parent delete's own WHERE,
 *
 *     <column> IN (SELECT id FROM <parent> WHERE <the parent delete's predicate>)
 *
 * which, with the child delete running first (checked above), leaves no child row pointing at
 * a parent row the parent delete removes.
 */
const NOT_KEYED_IN_THE_USER_SWEEP: Record<string, string> = {
  // The child is another identity's row: an offline transaction carries its own user_id, and the
  // sweep reaches it by that. At csms-server master aadea673 nothing in app/ writes this column
  // (OfflineTransaction lists it as fillable; no code assigns it), so nothing in the server
  // fills it today.
  'sessions <- offline_transactions.reconciled_session_id':
    'an offline transaction is reached by its own user_id, never through a session',
  // The child is a session, and a session is reached by its own user_id (and its batch). The
  // start gate matches a reservation by its id alone (SessionStateMachine::
  // validateReservedBayForStart), so a session naming a swept user's reservation need not be
  // the swept user's, and selecting sessions by reservation would reach past the swept users.
  'reservations <- sessions.reservation_id':
    "a session is reached by its own user_id, never through a reservation",
  // The child is the pass holder's own row, so its user_id reaches it. csms-server writes
  // offline_transactions in one place, Reconciler::persistTransaction (through
  // OfflineTransactionRepository::createOrUpdate), and writes user_id there as the user_id of
  // the very pass offline_pass_id names: TransactionEventResolver::resolve takes both from the
  // pass (OfflinePassQueryService::resolveUuid and ::resolveUserIdFromPass) and ignores the
  // station's userId. offline_passes.user_id is written when the pass is issued and never
  // updated, so the user_id arm deletes every transaction that names a swept user's pass.
  'offline_passes <- offline_transactions.offline_pass_id':
    "an offline transaction is reached by its own user_id, which is the user_id of its pass",
};

/** The WHERE clause of the one `DELETE FROM <table> WHERE ...;` in `stmts`, or undefined. */
function deletePredicate(stmts: string[], table: string): string | undefined {
  const re = new RegExp(`^DELETE FROM ${table} WHERE (.*);$`);
  for (const stmt of stmts) {
    const m = re.exec(stmt);
    if (m) return m[1];
  }
  return undefined;
}

/** True when `stmt` selects through `column IN (SELECT id FROM parent WHERE parentWhere)`. */
function selectsThrough(stmt: string, column: string, parent: string, parentWhere: string): boolean {
  const needle = `${column} IN (SELECT id FROM ${parent} WHERE ${parentWhere})`;
  for (let i = stmt.indexOf(needle); i >= 0; i = stmt.indexOf(needle, i + 1)) {
    // `session_id` must not be satisfied by `reconciled_session_id`.
    if (i === 0 || !/[A-Za-z0-9_]/.test(stmt[i - 1])) return true;
  }
  return false;
}

/** One row requirement: every `edge.child` row pointing at a `parent` row the delete removes goes first. */
interface RowRequirement {
  /** `<parent> <- <child>.<column>`, the form the exemption lists use. */
  key: string;
  parent: string;
  parentWhere: string;
  edge: FkEdge;
}

/** The row requirements of `stmts`: one per NO ACTION edge into a parent it deletes, less `exempt`. */
function rowRequirements(stmts: string[], exempt: Record<string, string>): RowRequirement[] {
  const requirements: RowRequirement[] = [];
  for (const [parent, edges] of Object.entries(SCHEMA_FK_GRAPH)) {
    const parentWhere = deletePredicate(stmts, parent);
    if (parentWhere === undefined) continue; // the statements don't delete this parent
    for (const edge of edges) {
      if (edge.onDelete !== 'NO ACTION') continue;
      const key = `${parent} <- ${edge.child}.${edge.column}`;
      if (key in exempt) continue;
      requirements.push({ key, parent, parentWhere, edge });
    }
  }
  return requirements;
}

/** Every `DELETE FROM <table>` statement of `stmts`. */
function deletesOf(stmts: string[], table: string): string[] {
  return stmts.filter((s) => new RegExp(`^DELETE FROM ${table}(?![A-Za-z0-9_])`).test(s));
}

/** True when one of the child's deletes in `stmts` meets the requirement. */
function rowMet(stmts: string[], r: RowRequirement): boolean {
  return deletesOf(stmts, r.edge.child).some((s) => selectsThrough(s, r.edge.column, r.parent, r.parentWhere));
}

describe('teardown FK coverage — the user sweep reaches every row that points at what it deletes (CW109)', () => {
  const stmts = buildTeardownTestUsersSql(
    ['sim-worker-test-0@test.local', 'sim-worker-test-1@test.local'],
    { protectedEmails: [] },
  );

  for (const r of rowRequirements(stmts, NOT_KEYED_IN_THE_USER_SWEEP)) {
    const { parent, edge } = r;
    it(
      `[${parent}] DELETE FROM ${edge.child} selects through ${edge.child}.${edge.column} ` +
      `and the ${parent} delete's own predicate`,
      () => {
        const childStmts = deletesOf(stmts, edge.child);
        expect(
          childStmts.length,
          `the user sweep has no DELETE FROM ${edge.child}, so DELETE FROM ${parent} is ` +
          `FK-blocked by any row of ${edge.child} whose ${edge.column} names a swept row of ${parent}`,
        ).toBeGreaterThan(0);
        expect(
          rowMet(stmts, r),
          `DELETE FROM ${edge.child} does not select through ${edge.column}: a row of ` +
          `${edge.child} whose ${edge.column} names a row of ${parent} this sweep deletes survives it, and ` +
          `DELETE FROM ${parent} is FK-blocked (${edge.child}.${edge.column} → ${parent}, ` +
          `ON DELETE NO ACTION)`,
        ).toBe(true);
      },
    );
  }

  it('every edge exempted from the predicate check is still an edge of the snapshot', () => {
    const edges = new Set(
      Object.entries(SCHEMA_FK_GRAPH).flatMap(([parent, list]) =>
        list.map((e) => `${parent} <- ${e.child}.${e.column}`)),
    );
    for (const key of Object.keys(NOT_KEYED_IN_THE_USER_SWEEP)) {
      expect(edges.has(key), `${key} is exempted but no longer in SCHEMA_FK_GRAPH`).toBe(true);
    }
  });
});

/**
 * CW121 — THE SNAPSHOT HAS AN ENTRY FOR EXACTLY THE TABLES THE TEARDOWN DELETES FROM.
 *
 * Every check above asks only about parents that have an entry: a table the teardown deletes
 * from with no entry is skipped without a word, whatever points at it. offline_passes,
 * provisioning_tokens and certificates, all three deleted by the teardown, had no entry until
 * the 2026-09-29 regeneration, so the FK from offline_transactions to offline_passes was never
 * checked. So the DELETE targets of both halves are read from the SQL they build and held equal
 * to the snapshot's parents: a new target fails here until pg_constraint has been read for it,
 * and an entry for a table the teardown no longer deletes fails as stale.
 */
describe('teardown FK coverage — the snapshot has an entry for every table the teardown deletes from (CW121)', () => {
  const targets = (sql: string): string[] => [...sql.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1]);
  const deleted = [...new Set([
    ...targets(buildTeardownSql(fullHandle())),
    ...targets(buildTeardownTestUsersSql(['sim-worker-test-0@test.local'], { protectedEmails: [] }).join('\n')),
  ])].sort();
  const parents = Object.keys(SCHEMA_FK_GRAPH).sort();

  it('every table either half deletes from has an entry, and every entry is a table one of them deletes from', () => {
    const unlisted = deleted.filter((t) => !parents.includes(t));
    const stale = parents.filter((p) => !deleted.includes(p));
    expect(
      { unlisted, stale },
      `${deleted.length} tables deleted by the teardown, ${parents.length} entries in SCHEMA_FK_GRAPH`,
    ).toEqual({ unlisted: [], stale: [] });
  });
});
