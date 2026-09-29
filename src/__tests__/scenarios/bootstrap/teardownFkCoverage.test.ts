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
 * The SCHEMA_FK_GRAPH constant below is a hand-curated snapshot of the live UAT
 * `pg_constraint` table for the entity types this teardown touches, captured
 * 2026-06-02 via:
 *
 *   docker exec -i csms-postgres-uat psql -U csms_uat -d csms_uat -t -c "
 *     SELECT con.conname, cls.relname AS child, att.attname AS column,
 *            par.relname AS parent, con.confdeltype
 *     FROM pg_constraint con
 *     JOIN pg_class cls ON cls.oid = con.conrelid
 *     JOIN pg_class par ON par.oid = con.confrelid
 *     JOIN pg_attribute att ON att.attnum = con.conkey[1] AND att.attrelid = con.conrelid
 *     WHERE con.contype = 'f' AND par.relname IN
 *       ('users','wallets','sessions','reservations','stations','bays','locations',
 *        'service_definitions')
 *     ORDER BY par.relname, cls.relname;"
 *
 * Regenerate when csms-server's migrations add a new NO-ACTION FK pointing at any
 * of these parents — the test below will then red-fail (asserting the teardown
 * doesn't cover the new child) until both this snapshot and `buildTeardownTestUsersSql`
 * / `buildTeardownSql` are updated. That's the CI-time safety net commit #3 lacked.
 *
 * Why hand-curated vs. live introspection: the test must run in CI without a live
 * Postgres (the F-PROC-1 doc commits to "pure static analysis on generated SQL +
 * schema graph, no live Postgres at test runtime"). The snapshot is the contract;
 * a future `scripts/regenerate-fk-graph.ts` could automate the refresh from a dev
 * machine with SSH access.
 *
 * RE-DERIVED 2026-09-29 FROM csms-server's MIGRATIONS for five parents - users, sessions,
 * payment_intents, refunds and unit_batches - by reading every REFERENCES, constrained() and
 * foreign() in an up() body, with the renames and drops that followed applied (token_batches
 * became unit_batches; the FK on offline_auth_grants.reconciled_session_id was dropped). Read
 * at csms-server master aadea673, plus 2026_09_29_000002_create_session_settlement_retries_table,
 * which was not yet on master that day. The other parents below were not re-derived then.
 */

type OnDelete = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'RESTRICT';
interface FkEdge {
  child: string;
  column: string;
  onDelete: OnDelete;
}

const SCHEMA_FK_GRAPH: Record<string, FkEdge[]> = {
  // 15 FKs point at users (re-derived 2026-09-29, see the docblock): 2 CASCADE, removed with
  // the user; 1 SET NULL, nulled with the user; 12 NO ACTION, each of which blocks the users
  // delete until its rows are gone. invitations.revoked_by, unit_batches.user_id and
  // session_settlement_retries.settled_by_user_id are the three the earlier 12 lacked.
  users: [
    { child: 'offline_auth_grants',        column: 'user_id',            onDelete: 'NO ACTION' },
    { child: 'api_keys',                   column: 'user_id',            onDelete: 'CASCADE'   },
    { child: 'invitations',                column: 'invited_by',         onDelete: 'NO ACTION' },
    { child: 'invitations',                column: 'revoked_by',         onDelete: 'NO ACTION' },
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
  // wallets has ONE NO ACTION child — easy to miss, blew up commit #3's teardown
  // at the wallets-delete step if wallet_entries was non-empty.
  wallets: [
    { child: 'wallet_entries', column: 'wallet_id', onDelete: 'NO ACTION' },
  ],
  // 4 FKs point at sessions (re-derived 2026-09-29): 3 NO ACTION, which must go before the
  // sessions delete, and session_settlement_retries.session_id, which references
  // sessions.session_id ON DELETE CASCADE. offline_auth_grants.reconciled_session_id was a
  // NO ACTION child until 2026_08_19_000005_retype_offline_auth_grant_reconciled_session_id
  // dropped its FK and retyped the column to the varchar business id.
  sessions: [
    { child: 'refunds',                    column: 'session_id',            onDelete: 'NO ACTION' },
    { child: 'offline_transactions',       column: 'reconciled_session_id', onDelete: 'NO ACTION' },
    { child: 'platform_settlement_ledger', column: 'session_id',            onDelete: 'NO ACTION' },
    { child: 'session_settlement_retries', column: 'session_id',            onDelete: 'CASCADE'   },
  ],
  reservations: [
    { child: 'sessions', column: 'reservation_id', onDelete: 'NO ACTION' },
  ],
  // 4 FKs point at payment_intents (re-derived 2026-09-29), all NO ACTION. sessions carries a
  // payment_intent_id column with no FK, so it is not among them.
  payment_intents: [
    { child: 'payment_ledger',             column: 'payment_intent_id', onDelete: 'NO ACTION' },
    { child: 'platform_settlement_ledger', column: 'payment_intent_id', onDelete: 'NO ACTION' },
    { child: 'refunds',                    column: 'payment_intent_id', onDelete: 'NO ACTION' },
    { child: 'unit_batches',               column: 'payment_intent_id', onDelete: 'NO ACTION' },
  ],
  // 2 FKs point at refunds (re-derived 2026-09-29), both NO ACTION.
  refunds: [
    { child: 'payment_ledger',             column: 'refund_id', onDelete: 'NO ACTION' },
    { child: 'platform_settlement_ledger', column: 'refund_id', onDelete: 'NO ACTION' },
  ],
  // 1 FK points at unit_batches (re-derived 2026-09-29; the table was created as token_batches
  // by 2026_07_08_000001 and renamed by 2026_07_09_000003, its FKs with it).
  unit_batches: [
    { child: 'sessions', column: 'batch_id', onDelete: 'NO ACTION' },
  ],
  // NOT LISTED, on purpose: platform_settlement_ledger.reverses_settlement_id references
  // platform_settlement_ledger itself (NO ACTION). A table-order check cannot express a
  // self-reference, since no delete can precede itself. What keeps it from blocking: a
  // reversal row copies its settlement's payment_intent_id and session_id
  // (SettlementReversalRecorder), so a statement that reaches a settlement by either key
  // reaches its reversals in the same statement, and NO ACTION is checked at the end of it.
  stations: [
    { child: 'offline_auth_grants',    column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'bays',                   column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'diagnostics_uploads',    column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'firmware_updates',       column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'offline_transactions',   column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'service_catalogs',       column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'station_configurations', column: 'station_id', onDelete: 'NO ACTION' },
    { child: 'station_services',       column: 'station_id', onDelete: 'CASCADE'   },
    { child: 'security_events',        column: 'station_id', onDelete: 'SET NULL'  },
  ],
  bays: [
    { child: 'bay_services',         column: 'bay_id', onDelete: 'CASCADE'   },
    { child: 'offline_transactions', column: 'bay_id', onDelete: 'NO ACTION' },
    { child: 'reservations',         column: 'bay_id', onDelete: 'NO ACTION' },
    { child: 'sessions',             column: 'bay_id', onDelete: 'NO ACTION' },
  ],
  locations: [
    { child: 'stations', column: 'location_id', onDelete: 'NO ACTION' },
  ],
  service_definitions: [
    // RESTRICT acts identical to NO ACTION for the blocking question — but the
    // teardown deliberately orphan-sweeps service_definitions LAST (after stations
    // cascade-removes station_services), so the RESTRICT FK is satisfied by then.
    { child: 'station_services', column: 'service_definition_id', onDelete: 'RESTRICT' },
  ],
  // organizations: 10 FKs. `corporate_policies` was an 11th until csms-server
  // 2026_09_04_000003_drop_corporate_policies_table DROPPED the table (ADR-0012) — the FK went
  // with it, so it is removed here rather than left as a NO ACTION child that cannot block.
  // (10 captured 2026-06-15 via pg_constraint + offline_auth_grants,
  // table added 0.6.2/B1 after that capture — exactly the "regenerate" case in the top docstring).
  // The 5 CASCADE children are auto-removed by the org delete (stations, offline_passes, roles,
  // model_has_roles, service_definitions); the 5 NO ACTION children must be deleted first or the
  // org delete FK-blocks. The ephemeral-org teardown (Direction B) deletes the org last.
  organizations: [
    { child: 'offline_auth_grants',  column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'stations',             column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'offline_passes',       column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'roles',                column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'model_has_roles',      column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'service_definitions',  column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'organization_members', column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'locations',            column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'sessions',             column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'invitations',          column: 'organization_id', onDelete: 'NO ACTION' },
  ],
  // roles: 2 FKs, both CASCADE via the org→roles cascade (no explicit DELETE FROM roles needed).
  roles: [
    { child: 'model_has_roles',      column: 'role_id', onDelete: 'CASCADE' },
    { child: 'role_has_permissions', column: 'role_id', onDelete: 'CASCADE' },
  ],
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

/**
 * The P1 check over one piece of SQL: for every parent it deletes from, every NO-ACTION FK
 * child must also be deleted, and the child delete must come BEFORE the parent's delete.
 * (CASCADE auto-handles itself; SET NULL doesn't block; RESTRICT is treated like NO ACTION
 * but is currently only present on service_definitions, where the teardown deliberately
 * defers the orphan-sweep until AFTER stations cascade-removes station_services — that
 * ordering is covered by a separate test in PoolBootstrap.test.ts.)
 */
function reverseGraphChecks(sql: string, label: string): void {
  for (const [parent, edges] of Object.entries(SCHEMA_FK_GRAPH)) {
    const parentAt = deleteAt(sql, parent);
    if (parentAt < 0) continue; // this SQL doesn't touch this parent — nothing to assert
    for (const edge of edges) {
      if (edge.onDelete !== 'NO ACTION') continue;
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
            `constraints at statement time, not at COMMIT (default DEFERRABLE INITIALLY ` +
            `IMMEDIATE), so order is load-bearing inside the transaction.`,
          ).toBeLessThan(parentAt);
        },
      );
    }
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

describe('teardown FK coverage — the user sweep reaches every row that points at what it deletes (CW109)', () => {
  const stmts = buildTeardownTestUsersSql(
    ['sim-worker-test-0@test.local', 'sim-worker-test-1@test.local'],
    { protectedEmails: [] },
  );

  for (const [parent, edges] of Object.entries(SCHEMA_FK_GRAPH)) {
    const parentWhere = deletePredicate(stmts, parent);
    if (parentWhere === undefined) continue; // the sweep doesn't delete this parent
    for (const edge of edges) {
      if (edge.onDelete !== 'NO ACTION') continue;
      const key = `${parent} <- ${edge.child}.${edge.column}`;
      if (key in NOT_KEYED_IN_THE_USER_SWEEP) continue;
      it(
        `[${parent}] DELETE FROM ${edge.child} selects through ${edge.child}.${edge.column} ` +
        `and the ${parent} delete's own predicate`,
        () => {
          const childStmts = stmts.filter((s) =>
            new RegExp(`^DELETE FROM ${edge.child}(?![A-Za-z0-9_])`).test(s));
          expect(
            childStmts.length,
            `the user sweep has no DELETE FROM ${edge.child}, so DELETE FROM ${parent} is ` +
            `FK-blocked by any row of ${edge.child} whose ${edge.column} names a swept row of ${parent}`,
          ).toBeGreaterThan(0);
          expect(
            childStmts.some((s) => selectsThrough(s, edge.column, parent, parentWhere)),
            `DELETE FROM ${edge.child} does not select through ${edge.column}: a row of ` +
            `${edge.child} whose ${edge.column} names a row of ${parent} this sweep deletes survives it, and ` +
            `DELETE FROM ${parent} is FK-blocked (${edge.child}.${edge.column} → ${parent}, ` +
            `ON DELETE NO ACTION)`,
          ).toBe(true);
        },
      );
    }
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
