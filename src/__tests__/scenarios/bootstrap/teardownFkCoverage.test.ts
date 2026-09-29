import { describe, it, expect } from 'vitest';
import { buildTeardownSql, type PoolBootstrapHandle } from '../../../scenarios/bootstrap/PoolBootstrap.js';
import { buildTeardownTestUsersSql } from '../../../scenarios/bootstrap/uatPrivileged.js';
import { StationPool } from '../../../scenarios/stations/StationPool.js';

/**
 * P1 static check — pg_constraint reverse-graph assertion.
 *
 * This test asserts a structural property: for EVERY `NO ACTION` or `RESTRICT` foreign key
 * whose parent table the teardown SQL removes rows from - by deleting from it, or by deleting
 * from a table whose ON DELETE CASCADE edges reach it - the teardown ALSO removes the child
 * table's rows, AND does so BEFORE that delete. Without this property, the delete is
 * FK-blocked at runtime — exactly the bug that has now shipped twice (F-PROC-1:
 * sessions-before-reservations missing; commit #3: offline_passes-before-users missing). Both
 * slipped because the unit tests asserted SQL TEXT, not the FK GRAPH.
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
 * and NOT DEFERRABLE. The same query was run again on 2026-09-29 against a database migrated
 * from master d9d860fd, whose database/migrations is the same tree as 87164f7d's
 * (b0c5887b64ff052a37c97ec5a5395a918e04d1f7): the same 75 rows. The snapshot has an entry for
 * every table the teardown removes rows from - the 36 tables both halves, buildTeardownSql and
 * buildTeardownTestUsersSql, delete from, and the 14 their deletes reach only through ON DELETE
 * CASCADE, 50 tables - holding every FK that points at that table; an empty entry is a table no
 * FK points at. 72 of the 75 are listed here. The other 3:
 *
 *   - 2 point at permissions, which the teardown neither deletes from nor reaches through a
 *     CASCADE.
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
 * teardown removes, and whenever the teardown starts removing a table it did not (the last
 * describe below fails until that table has an entry). After a regeneration the checks below
 * fail for every NO ACTION or RESTRICT child the teardown does not remove first, until
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
  /** The parent column the FK references, when it is not `id` (pg_constraint confkey). */
  references?: string;
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
    { child: 'session_settlement_retries', column: 'session_id',            onDelete: 'CASCADE', references: 'session_id' },
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
    // RESTRICT blocks as NO ACTION does (see BLOCKING) — and the teardown deliberately
    // orphan-sweeps service_definitions LAST (after stations cascade-removes
    // station_services), so the RESTRICT FK is satisfied by then.
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
  // The next three the teardown never names in a DELETE: it removes their rows only through a
  // CASCADE, and the checks follow the CASCADE to the edges that point at them.
  //
  // 3 FKs point at station_services, removed with their station (stations CASCADE): bay_services
  // CASCADE, and offline_transactions.service_id and sessions.service_id RESTRICT, so both must be
  // gone before a stations delete that cascades here.
  station_services: [
    { child: 'bay_services',         column: 'station_service_id', onDelete: 'CASCADE'  },
    { child: 'offline_transactions', column: 'service_id',         onDelete: 'RESTRICT' },
    { child: 'sessions',             column: 'service_id',         onDelete: 'RESTRICT' },
  ],
  // 2 FKs point at roles, removed with their organization (organizations CASCADE), both CASCADE.
  roles: [
    { child: 'model_has_roles',      column: 'role_id', onDelete: 'CASCADE' },
    { child: 'role_has_permissions', column: 'role_id', onDelete: 'CASCADE' },
  ],
  // 2 FKs point at station_models, removed with their organization (organizations CASCADE):
  // station_model_programs CASCADE, stations.station_model_id SET NULL.
  station_models: [
    { child: 'station_model_programs', column: 'station_model_id', onDelete: 'CASCADE'  },
    { child: 'stations',               column: 'station_model_id', onDelete: 'SET NULL' },
  ],
  // No FK points at any of these 11, each removed only through a CASCADE: api_keys and
  // refresh_tokens (users), session_settlement_retries (sessions), bay_programs (bays),
  // bay_services (bays, station_services), offline_pass_consumptions (offline_passes),
  // provisioning_bound_bays and provisioning_bound_keys (provisioning_tokens), revocation_epochs
  // (organizations), role_has_permissions (roles), station_model_programs (station_models).
  api_keys: [],
  bay_programs: [],
  bay_services: [],
  offline_pass_consumptions: [],
  provisioning_bound_bays: [],
  provisioning_bound_keys: [],
  refresh_tokens: [],
  revocation_epochs: [],
  role_has_permissions: [],
  session_settlement_retries: [],
  station_model_programs: [],
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

/**
 * The two ON DELETE actions that make a delete of the parent row fail while a child row still
 * points at it. RESTRICT blocks as NO ACTION does; it differs only in that it cannot be deferred,
 * and every FK in the snapshot is NOT DEFERRABLE, so for the question these checks ask the two are
 * the same. SET NULL and CASCADE never block: SET NULL nulls the child's key and keeps the row,
 * CASCADE removes the row - and the rows it removes are blocked by their own children, which is why
 * the checks follow it (see {@link cascadeReach}).
 */
const BLOCKING: ReadonlySet<OnDelete> = new Set<OnDelete>(['NO ACTION', 'RESTRICT']);

/** The snapshot's entry for `table`; a table the checks reach without an entry fails loudly. */
function edgesInto(table: string): FkEdge[] {
  const edges = SCHEMA_FK_GRAPH[table];
  if (edges === undefined) {
    throw new Error(
      `${table} is removed by the teardown (its own DELETE or a CASCADE) but has no SCHEMA_FK_GRAPH ` +
      `entry - read pg_constraint for it (see the docblock) and add one`,
    );
  }
  return edges;
}

/**
 * Every table a delete of `table` reaches through ON DELETE CASCADE edges, transitively, each
 * with its path: `DELETE FROM organizations` removes the organization's offline_passes
 * (path [offline_passes]) and its stations, and with the stations their station_services
 * (path [stations, station_services]), and so on down. A table reached along two paths is listed
 * once per path.
 */
function cascadeReach(table: string): Array<{ table: string; path: string[] }> {
  const reached: Array<{ table: string; path: string[] }> = [];
  const walk = (from: string, path: string[]): void => {
    for (const edge of edgesInto(from)) {
      if (edge.onDelete !== 'CASCADE' || edge.child === table || path.includes(edge.child)) continue;
      const to = [...path, edge.child];
      reached.push({ table: edge.child, path: to });
      walk(edge.child, to);
    }
  };
  walk(table, []);
  return reached;
}

/**
 * The first line at which `sql` removes rows of `table`: its own first `DELETE FROM <table>`, or
 * an earlier `DELETE FROM` of a table whose CASCADE reaches it. -1 if it never does.
 */
function removedAt(sql: string, table: string): number {
  let first = deleteAt(sql, table);
  for (const parent of Object.keys(SCHEMA_FK_GRAPH)) {
    const at = deleteAt(sql, parent);
    if (at < 0 || (first >= 0 && at >= first)) continue;
    if (cascadeReach(parent).some((r) => r.table === table)) first = at;
  }
  return first;
}

/**
 * One ordering the P1 check asks of a piece of SQL: before the first `DELETE FROM <parent>`, the
 * rows of `edge.child` are gone, because `edge` blocks the removal of `target` - which is the
 * parent itself (`path` empty) or a table the parent's delete reaches through the CASCADE edges
 * of `path`.
 */
interface Ordering {
  parent: string;
  /** The line of the first `DELETE FROM <parent>`. */
  parentAt: number;
  path: string[];
  target: string;
  edge: FkEdge;
}

/**
 * The orderings the P1 check asks of one piece of SQL: for every parent it deletes from, and for
 * every table that delete reaches through a CASCADE, every NO ACTION or RESTRICT child must be
 * removed first - by its own DELETE, or by an EARLIER delete whose CASCADE reaches it (a CASCADE
 * of the same statement does not count: which of its triggers fires first is not the teardown's to
 * choose). SET NULL doesn't block. RESTRICT is present on three edges: service_definitions <-
 * station_services, whose rows the teardown removes through the stations CASCADE before its
 * orphan-sweep of service_definitions, and station_services <- sessions and offline_transactions,
 * both deleted before the stations delete that cascades to station_services.
 */
function blockingOrderings(sql: string): Ordering[] {
  const orderings: Ordering[] = [];
  for (const parent of Object.keys(SCHEMA_FK_GRAPH)) {
    const parentAt = deleteAt(sql, parent);
    if (parentAt < 0) continue; // this SQL doesn't touch this parent — nothing to assert
    for (const { table: target, path } of [{ table: parent, path: [] as string[] }, ...cascadeReach(parent)]) {
      for (const edge of edgesInto(target)) {
        if (!BLOCKING.has(edge.onDelete)) continue;
        orderings.push({ parent, parentAt, path, target, edge });
      }
    }
  }
  return orderings;
}

/**
 * How the checks name an ordering: `<parent> <- <child>.<column>` for an edge into the table the
 * statement deletes from, `<parent> -> <t1> -> ... -> <tn> <- <child>.<column>` for an edge into a
 * table the statement reaches through the CASCADE edges parent -> t1 -> ... -> tn.
 */
function orderingKey(o: { parent: string; path: string[]; edge: FkEdge }): string {
  const via = o.path.length > 0 ? ` -> ${o.path.join(' -> ')}` : '';
  return `${o.parent}${via} <- ${o.edge.child}.${o.edge.column}`;
}

/** The keys of the orderings `sql` does not meet. */
function unmetOrderings(sql: string): string[] {
  return blockingOrderings(sql)
    .filter((o) => {
      const childAt = removedAt(sql, o.edge.child);
      return childAt < 0 || childAt >= o.parentAt;
    })
    .map(orderingKey);
}

/**
 * The P1 check over one piece of SQL, one case per ordering {@link blockingOrderings} asks. A NO
 * ACTION edge into the deleted table itself keeps the case name it has always had; an edge into a
 * table reached through a CASCADE, and every RESTRICT edge, is named by its path.
 */
function reverseGraphChecks(sql: string, label: string): void {
  for (const o of blockingOrderings(sql)) {
    const { parent, parentAt, path, target, edge } = o;
    const direct = path.length === 0 && edge.onDelete === 'NO ACTION';
    const via = path.length > 0 ? `, which DELETE FROM ${parent} reaches through CASCADE (${[parent, ...path].join(' -> ')})` : '';
    it(
      direct
        ? `[${parent}] DELETE FROM ${edge.child} ` +
          `(FK: ${edge.child}.${edge.column} → ${parent}, ON DELETE NO ACTION) ` +
          `must run before DELETE FROM ${parent}`
        : `[${[parent, ...path].join(' -> ')}] ${edge.child} ` +
          `(FK: ${edge.child}.${edge.column} -> ${target}, ON DELETE ${edge.onDelete}) ` +
          `is removed before DELETE FROM ${parent}`,
      () => {
        const childAt = removedAt(sql, edge.child);
        expect(
          childAt,
          `${label} never removes ${edge.child} - no 'DELETE FROM ${edge.child}' and no earlier ` +
          `delete whose CASCADE reaches it - so 'DELETE FROM ${parent}' will be FK-blocked at ` +
          `runtime by ${edge.child}.${edge.column} -> ${target}.id (ON DELETE ${edge.onDelete})${via}. ` +
          `This is the exact failure class that shipped twice already; close it now.`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          childAt,
          `${edge.child} is first removed at line ${childAt}, and must be gone BEFORE ` +
          `'DELETE FROM ${parent}' (line ${parentAt})${via} — Postgres evaluates FK ` +
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
 * So each NO ACTION or RESTRICT edge into a parent the user sweep deletes is also checked by
 * predicate: the child's delete must select through that edge's column and the parent delete's
 * own WHERE,
 *
 *     <column> IN (SELECT id FROM <parent> WHERE <the parent delete's predicate>)
 *
 * as one of its top-level OR arms, which, with the child delete running first (checked above),
 * leaves no child row pointing at a parent row the parent delete removes. The same is asked of
 * every table the parent's delete reaches through ON DELETE CASCADE, with the arm that selects
 * the cascaded rows in place of the parent's WHERE (see rowRequirements). For the user sweep
 * that adds no case: what its deletes cascade to - api_keys and refresh_tokens (users),
 * offline_pass_consumptions (offline_passes), session_settlement_retries (sessions) - has no FK
 * pointing at it.
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

/**
 * The WHERE clause of the first `DELETE FROM <table> [<alias>] WHERE ...;` in `stmts`, with its
 * index and alias, or undefined.
 */
function deletePredicate(
  stmts: string[],
  table: string,
): { at: number; where: string; alias?: string } | undefined {
  const re = new RegExp(`^DELETE FROM ${table}(?: (?!WHERE\\b)(\\w+))? WHERE (.*);$`);
  for (let at = 0; at < stmts.length; at++) {
    const m = re.exec(stmts[at]);
    if (m) return { at, where: m[2], alias: m[1] };
  }
  return undefined;
}

/**
 * `expr` split at every `sep` that stands outside parentheses and string literals: the top-level
 * disjuncts of a WHERE clause for ' OR '. A predicate reaches every row an arm selects only when
 * the arm is one of these - inside parentheses or next to an AND it may select fewer.
 */
function splitTopLevel(expr: string, sep: ' OR ' | ' AND '): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inString) {
      if (ch === "'" && expr[i + 1] === "'") i++;
      else if (ch === "'") inString = false;
    } else if (ch === "'") {
      inString = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (depth === 0 && expr.startsWith(sep, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

/** The top-level disjuncts of `stmt`'s WHERE clause when it is a `DELETE FROM <table>`, else []. */
function disjunctsOf(stmt: string, table: string): string[] {
  const found = deletePredicate([stmt], table);
  return found === undefined ? [] : splitTopLevel(found.where, ' OR ');
}

/**
 * Rows of `table` a delete removes, as predicates over `table` each of which selects exactly those
 * rows: the parent delete's own WHERE for the parent, and for a table reached through a CASCADE
 * the arms that select the rows pointing at the rows removed above it. `lit` is set when the parent
 * delete selects one id, `id = '<uuid>'`: then `<column> = '<uuid>'` selects the rows pointing at it
 * as well as `<column> IN (SELECT id FROM <parent> WHERE id = '<uuid>')` does.
 */
interface RowSet {
  table: string;
  wheres: string[];
  lit?: string;
  /** The alias the parent delete gives its table (`DELETE FROM service_definitions sd`). */
  alias?: string;
}

/** The arms over `column` that select the rows of a child pointing at the rows of `set` through its `ref` column. */
function pointingAt(set: RowSet, column: string, ref: string): string[] {
  const from = set.alias !== undefined ? `${set.table} ${set.alias}` : set.table;
  const arms = set.wheres.map((w) => `${column} IN (SELECT ${ref} FROM ${from} WHERE ${w})`);
  if (set.lit !== undefined && ref === 'id') arms.push(`${column} = ${set.lit}`);
  return arms;
}

/**
 * True when the parent delete's own WHERE keeps every row the child references out of the
 * delete: a top-level `NOT EXISTS (SELECT 1 FROM <child> <a> WHERE <a>.<column> = <parent>.<ref>)`,
 * as the orphan-sweep of service_definitions has for station_services. No row it deletes is then
 * referenced through that edge, whatever the child's own deletes select.
 */
function guardedAgainst(where: string, parentRef: string, edge: FkEdge): boolean {
  const ref = edge.references ?? 'id';
  const guard = new RegExp(
    `^NOT EXISTS \\(SELECT 1 FROM ${edge.child} (\\w+) WHERE \\1\\.${edge.column} = ${parentRef}\\.${ref}\\)$`,
  );
  return splitTopLevel(where, ' AND ').some((conjunct) => guard.test(conjunct));
}

/**
 * One row requirement: every `edge.child` row pointing at a row of `target` that the `parent`
 * delete removes - its own rows, or rows its CASCADE reaches along `path` - is gone first, because
 * `edge` blocks. It is met when a `DELETE FROM <edge.child>` has one of `arms` as a top-level
 * disjunct.
 */
interface RowRequirement {
  /** Named as {@link orderingKey} names it - the form the exemption lists use. */
  key: string;
  parent: string;
  path: string[];
  target: string;
  edge: FkEdge;
  arms: string[];
  /** Met by the parent delete itself: see {@link guardedAgainst}. */
  guarded: boolean;
}

/**
 * The row requirements of `stmts`, less `exempt`: for every parent it deletes, one per NO ACTION or
 * RESTRICT edge into the parent, and one per such edge into every table the parent's delete reaches
 * through a CASCADE. A CASCADE edge is not followed when an EARLIER delete of its child already
 * removed exactly the rows it would reach (it has one of their arms as a top-level disjunct): the
 * cascade then finds nothing, and that earlier delete's own children are checked as its own.
 */
function rowRequirements(stmts: string[], exempt: Record<string, string>): RowRequirement[] {
  const requirements: RowRequirement[] = [];
  for (const parent of Object.keys(SCHEMA_FK_GRAPH)) {
    const found = deletePredicate(stmts, parent);
    if (found === undefined) continue; // the statements don't delete this parent
    const walk = (set: RowSet, path: string[]): void => {
      for (const edge of edgesInto(set.table)) {
        const arms = pointingAt(set, edge.column, edge.references ?? 'id');
        if (BLOCKING.has(edge.onDelete)) {
          const key = orderingKey({ parent, path, edge });
          const guarded = path.length === 0 && guardedAgainst(found.where, found.alias ?? parent, edge);
          if (!(key in exempt)) requirements.push({ key, parent, path, target: set.table, edge, arms, guarded });
        } else if (edge.onDelete === 'CASCADE' && edge.child !== parent && !path.includes(edge.child)) {
          const preempted = stmts
            .slice(0, found.at)
            .some((s) => disjunctsOf(s, edge.child).some((d) => arms.includes(d)));
          if (!preempted) walk({ table: edge.child, wheres: arms }, [...path, edge.child]);
        }
      }
    };
    walk({
      table: parent,
      wheres: [found.where],
      lit: /^id = ('(?:[^']|'')*')$/.exec(found.where)?.[1],
      alias: found.alias,
    }, []);
  }
  return requirements;
}

/** Every `DELETE FROM <table>` statement of `stmts`. */
function deletesOf(stmts: string[], table: string): string[] {
  return stmts.filter((s) => new RegExp(`^DELETE FROM ${table}(?![A-Za-z0-9_])`).test(s));
}

/** True when the parent delete is guarded, or one of the child's deletes in `stmts` meets the requirement. */
function rowMet(stmts: string[], r: RowRequirement): boolean {
  return r.guarded ||
    deletesOf(stmts, r.edge.child).some((s) => disjunctsOf(s, r.edge.child).some((d) => r.arms.includes(d)));
}

/** The name of a row requirement's case: the one it has always had for an edge into the parent itself. */
function rowCaseName(r: RowRequirement): string {
  return r.path.length === 0
    ? `[${r.parent}] DELETE FROM ${r.edge.child} selects through ${r.edge.child}.${r.edge.column} ` +
      `and the ${r.parent} delete's own predicate`
    : `[${[r.parent, ...r.path].join(' -> ')}] DELETE FROM ${r.edge.child} selects through ` +
      `${r.edge.child}.${r.edge.column} and the ${r.target} rows the ${r.parent} delete cascades to`;
}

/** The keys of the row requirements `stmts` does not meet, named as {@link orderingKey} names them. */
function unmetRows(stmts: string[], exempt: Record<string, string>): string[] {
  return rowRequirements(stmts, exempt).filter((r) => !rowMet(stmts, r)).map((r) => r.key);
}

describe('teardown FK coverage — the user sweep reaches every row that points at what it deletes (CW109)', () => {
  const stmts = buildTeardownTestUsersSql(
    ['sim-worker-test-0@test.local', 'sim-worker-test-1@test.local'],
    { protectedEmails: [] },
  );

  for (const r of rowRequirements(stmts, NOT_KEYED_IN_THE_USER_SWEEP)) {
    const { parent, target, edge } = r;
    it(rowCaseName(r), () => {
      const childStmts = deletesOf(stmts, edge.child);
      expect(
        childStmts.length,
        `the user sweep has no DELETE FROM ${edge.child}, so DELETE FROM ${parent} is ` +
        `FK-blocked by any row of ${edge.child} whose ${edge.column} names a swept row of ${target}`,
      ).toBeGreaterThan(0);
      expect(
        rowMet(stmts, r),
        `DELETE FROM ${edge.child} does not select through ${edge.column}: a row of ` +
        `${edge.child} whose ${edge.column} names a row of ${target} this sweep removes survives it, and ` +
        `DELETE FROM ${parent} is FK-blocked (${edge.child}.${edge.column} -> ${target}, ` +
        `ON DELETE ${edge.onDelete})`,
      ).toBe(true);
    });
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
 * THE POOL HALF, ROW BY ROW.
 *
 * The user sweep has had the row check since CW109; the other half of the teardown, the
 * statements buildTeardownSql emits itself, had only the table-level one. This is the same check
 * over the pool half alone: a handle with the run's organization, location, stations and seeded
 * services and no user to sweep, so that every statement below is one buildTeardownSql writes.
 *
 * Its first reading, 2026-09-29: 34 requirements, 20 met, 14 not. Each of the 14 was read against
 * csms-server master d9d860fd's writers of the child column. 11 cannot happen under those writers
 * and are listed below with the writer that rules them out. 2 can, and are asked below: an
 * offline_auth_grants row of the run organization at a station outside the run
 * (AuthorizeOfflineSessionAction::execute writes the caller's organization and the station the
 * request names, and compares neither), and an offline_transactions row naming a pass of the run
 * organization at a station outside the run (IssueOfflinePassAction::execute writes the request's
 * organization; Reconciler::persistTransaction stores a rejected transaction without the
 * RevalidationGate check of the pass's organization against the station's, and the dashboard
 * issues a pass to a user who need not be a member, so neither the station arms nor the user
 * sweep need reach it). 1 can, and needs a decision before it can be closed
 * (OPEN_IN_THE_POOL_HALF).
 */
const NOT_KEYED_IN_THE_POOL_HALF: Record<string, string> = {
  // No writer sets the column. SettlementLedgerRecorder::record, the one writer of settlement
  // rows, writes session_id null (the session starts after the settlement commits), and
  // SettlementReversalRecorder::record copies the settlement's session_id into its reversal;
  // FiscalOutboxRelay::issue saves only fiscal_status and fiscal_document_id.
  'sessions <- platform_settlement_ledger.session_id':
    'no csms-server writer sets platform_settlement_ledger.session_id: a settlement writes null and a reversal copies it',
  // WebPaymentOrchestrator::initiateUnitBatch, the one writer of unit_batches, creates the batch
  // with bay_id the intent's metadata.bay_id, which PaymentLandingController::process wrote from the
  // same bay business id as the intent's reference_id; neither column is updated afterwards.
  'payment_intents <- unit_batches.payment_intent_id':
    "a batch's bay_id is its intent's reference_id, so the bay arm reaches every batch of a run intent",
  // ProcessRefundAction::execute writes the only payment_ledger rows, for a processor refund alone
  // (willCallProcessor: an intent with a processor_transaction_id), with the refund's own
  // payment_intent_id. A refund of a run-bay session is against that session's own intent - the
  // session_payment intent PaymentLandingController::process wrote with the bay's business id as
  // reference_id, a run intent, since a web-payment session starts on that bay - or, when it has
  // none, against the intent getOrCreatePaymentIntentId mints (processor 'wallet', no
  // processor_transaction_id), which never gets a payment_ledger row.
  'refunds <- payment_ledger.refund_id':
    "a payment_ledger row names its refund's own intent, and a refund the refunds delete reaches by session alone is on a wallet intent, which has none",
  // SettlementReversalRecorder::record writes the only rows with a refund_id, called by
  // ProcessRefundAction::finalizeSettlement with the refund's own payment_intent_id, and writes
  // nothing unless that intent has a settlement row - which SettlementLedgerRecorder::record writes
  // for session_payment intents alone - copying the settlement's payment_intent_id. A refund the
  // refunds delete reaches by session alone is on a minted 'session_wallet' intent (entry above):
  // no settlement, no reversal.
  'refunds <- platform_settlement_ledger.refund_id':
    "a reversal names its refund's own intent, which has a settlement only when it is a session_payment intent, and those of run-bay sessions are run intents",
  // StartSessionAction::execute is the one insert of sessions, and a batch_id reaches it only on the
  // web-payment path, always with the bay the batch was created on: initiateUnitBatch dispatches
  // unit 1 with the bay it wrote into the batch, UnitBatchCoordinator::dispatchUnit with
  // $batch->bay_id, StartServiceRetryJob re-dispatches both unchanged; bays.bay_id is unique, and
  // neither column is updated.
  'unit_batches <- sessions.batch_id':
    "a batch's sessions start on the batch's bay, which the bay arm covers",
  // Reconciler::persistTransaction writes service_id and station_id from one
  // TransactionEventResolver::resolve, which resolves the service with
  // StationQueryService::resolveServiceUuid scoped to that station; a rewrite of a pending_sync row
  // resolves both again, together.
  'stations -> station_services <- offline_transactions.service_id':
    "an offline transaction's service is resolved on its own station, which the station arm covers",
  // Both start paths resolve the service on the bay's own station (SessionController::start and
  // SessionCommandAdapter::startSessionForWebPayment call resolveServiceUuid with the bay's
  // station_id), StartSessionAction::execute refuses a service with no bay_services binding on the
  // bay (ServiceProgramResolver::resolve), and no writer updates sessions.service_id.
  'stations -> station_services <- sessions.service_id':
    "a session's service is one of its bay's station, which the bay arm covers",
  // StationManagementController::registerStation refuses a location outside the caller's
  // organization, which BelongsToTenant writes as the station's organization_id; no writer updates
  // stations.location_id, trg_refuse_station_org_reassignment refuses any change of
  // stations.organization_id, and UpdateLocationAction never writes locations.organization_id. The
  // locations this delete removes - the run location and the run organization's - are all in the
  // run organization, so every station at one of them is a run-organization station.
  'locations <- stations.location_id':
    "a station's location is in the station's own organization, and the stations delete's organization arm removes every run-organization station",
  // SettlementLedgerRecorder::record writes organization_id from the intent's
  // metadata.organization_id, which PaymentLandingController::process takes from the bay's station
  // (StationQueryService::findBayWithStationInfo) as it writes that bay's business id as the
  // reference_id; a reversal copies its settlement's. A station's organization cannot change, a bay
  // never moves station, and no production code deletes a bay row (DeleteStationAction retires
  // them), so the bay is still listed when the run's bays are read.
  'organizations <- platform_settlement_ledger.organization_id':
    "a ledger row's organization is its intent's bay's, so a run-organization row names a run intent, which the payment_intent_id arm covers",
  // Every writer pairs a station with a definition of the station's own organization:
  // UpdateServiceCatalogResponseHandler::handleAccepted (resolveOrCreateDefinition with
  // $station->organization_id) and StationServiceCatalogController::store; neither column is
  // rewritten, and a station's organization cannot change. This bootstrap's seed
  // (buildSeedCatalogSql) pairs the run's stations with the run organization's definitions.
  'organizations -> service_definitions <- station_services.service_definition_id':
    "a station's services name its own organization's definitions, and go with the run-organization stations in the stations delete's CASCADE",
  // No writer sets the column: StartSessionAction::execute, the one insert of sessions, writes no
  // organization_id, 2026_05_28_053346_add_session_org_attribution_and_org_wallet_type added it
  // nullable with no default, and no update, trigger or hook writes it (only test factories do).
  'organizations <- sessions.organization_id':
    'no csms-server writer sets sessions.organization_id',
};

/**
 * Requirements of the pool half that CAN go unmet under csms-server's writers, and whose fix needs
 * a decision this change does not make. The row check leaves them out, and a case below holds each
 * one still asked and still unmet, so that closing it fails that case until the entry goes.
 */
const OPEN_IN_THE_POOL_HALF: Record<string, string> = {
  // StartSessionAction::execute checks a request's reservation against the bay only when the bay
  // is reserved - SessionStateMachine::validateBayForStart allows an available bay outright - and
  // resolves the id through ReservationQueryService::resolveUuid, which filters by the id alone.
  // So a session started on another, available bay can carry the id of a reservation on a run bay,
  // and it blocks DELETE FROM reservations, while the pool half reaches sessions by the run's bays
  // only. No scenario does it today: of the 3 scenario files that pass a reservation_id to a start,
  // 2 pass the one they captured on the bay they start on and 1 an id nothing owns. Closing it means
  // choosing: delete the sessions that name a run-bay reservation wherever they run (and with them
  // what reads through the sessions delete), have csms-server refuse a reservation that is not the
  // bay's, or keep the gap - the user sweep keeps it (NOT_KEYED_IN_THE_USER_SWEEP).
  'reservations <- sessions.reservation_id':
    'a session on another, available bay can name a run-bay reservation; closing it needs a decision on how far the sessions delete reaches',
};

/** The pool half alone: {@link fullHandle} with no identity, created user or ephemeral owner. */
function poolHalfStatements(): string[] {
  const handle: PoolBootstrapHandle = { ...fullHandle(), ephemeralOwnerEmail: undefined, identityCredentials: [] };
  return buildTeardownSql(handle).split('\n').filter((s) => s !== 'BEGIN;' && s !== 'COMMIT;');
}

describe('teardown FK coverage — the pool half reaches every row that points at what it removes', () => {
  const stmts = poolHalfStatements();

  it('the handle builds the pool half alone, and the row check reads the WHERE of every DELETE in it', () => {
    const deletes = stmts.filter((s) => s.startsWith('DELETE FROM '));
    const unread = deletes.filter((s) => {
      const table = /^DELETE FROM (\w+)/.exec(s)?.[1] ?? '';
      return deletePredicate([s], table) === undefined;
    });
    expect(unread, `${deletes.length} DELETE statements in the pool half`).toEqual([]);
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.filter((s) => s.startsWith('DELETE FROM users'))).toEqual([]);
  });

  it('every exempted key is still a requirement the pool half gives rise to', () => {
    const keys = new Set(rowRequirements(stmts, {}).map((r) => r.key));
    for (const key of Object.keys(NOT_KEYED_IN_THE_POOL_HALF)) {
      expect(keys.has(key), `${key} is exempted but the pool half no longer asks it`).toBe(true);
    }
  });

  it('every key left open is still asked by the pool half and still unmet', () => {
    const unmet = new Set(unmetRows(stmts, {}));
    for (const key of Object.keys(OPEN_IN_THE_POOL_HALF)) {
      expect(
        unmet.has(key),
        `${key} is listed as open but the pool half meets it now (or no longer asks it): ` +
        `take it out of OPEN_IN_THE_POOL_HALF`,
      ).toBe(true);
    }
  });

  for (const r of rowRequirements(stmts, { ...NOT_KEYED_IN_THE_POOL_HALF, ...OPEN_IN_THE_POOL_HALF })) {
    const { parent, target, edge } = r;
    it(rowCaseName(r), () => {
      expect(
        rowMet(stmts, r),
        (deletesOf(stmts, edge.child).length === 0
          ? `the pool half has no DELETE FROM ${edge.child}`
          : `no DELETE FROM ${edge.child} of the pool half has an arm over ${edge.column} that selects ` +
            `the ${target} rows DELETE FROM ${parent} removes`) +
        `, so a row of ${edge.child} pointing at one of them blocks DELETE FROM ${parent} ` +
        `(${edge.child}.${edge.column} -> ${target}, ON DELETE ${edge.onDelete})`,
      ).toBe(true);
    });
  }
});

/**
 * CASCADE AND RESTRICT, PUT TO THE CHECKS ABOVE - POSITIVE CONTROLS.
 *
 * A delete removes its own rows and every row an ON DELETE CASCADE edge reaches from them, and a
 * row removed by a cascade is blocked by its own NO ACTION and RESTRICT children exactly as a row
 * the statement names. organizations -> offline_passes is CASCADE and
 * offline_transactions.offline_pass_id -> offline_passes is NO ACTION, so DELETE FROM
 * organizations fails while an offline transaction names one of the organization's passes, and it
 * fails whether or not any statement names offline_passes. RESTRICT blocks as NO ACTION does; the
 * one difference, that RESTRICT cannot be deferred, is moot while every FK in the snapshot is NOT
 * DEFERRABLE.
 *
 * Each planted teardown below holds one such edge, and each check must report it by the key
 * {@link orderingKey} gives it.
 */
describe('teardown FK coverage — the checks follow CASCADE edges and treat RESTRICT as blocking (positive controls)', () => {
  const planted = (...stmts: string[]): string => ['BEGIN;', ...stmts, 'COMMIT;'].join('\n');

  it('the P1 check reports offline_transactions before an organizations delete, through the offline_passes CASCADE', () => {
    expect(unmetOrderings(planted("DELETE FROM organizations WHERE id = 'org-x';")))
      .toContain('organizations -> offline_passes <- offline_transactions.offline_pass_id');
  });

  it('the P1 check reports station_services before a service_definitions delete (RESTRICT)', () => {
    expect(unmetOrderings(planted("DELETE FROM service_definitions WHERE organization_id = 'org-x';")))
      .toContain('service_definitions <- station_services.service_definition_id');
  });

  it('the P1 check reports sessions before a stations delete, through the station_services CASCADE (RESTRICT)', () => {
    expect(unmetOrderings(planted("DELETE FROM stations WHERE station_id = 'stn_x';")))
      .toContain('stations -> station_services <- sessions.service_id');
  });

  it("the row check reports an offline_transactions delete that misses the passes an organizations delete cascades to", () => {
    const stmts = [
      "DELETE FROM offline_transactions WHERE station_id IN (SELECT id FROM stations WHERE organization_id = 'org-x');",
      "DELETE FROM organizations WHERE id = 'org-x';",
    ];
    expect(unmetRows(stmts, {}))
      .toContain('organizations -> offline_passes <- offline_transactions.offline_pass_id');
  });

  // The other direction: what the checks must NOT report.

  it('the P1 check credits a child that an EARLIER delete removed through its CASCADE', () => {
    // stations -> station_services is CASCADE, so the stations delete leaves no station_services row
    // for the service_definitions delete after it to be blocked by.
    const sql = planted(
      "DELETE FROM stations WHERE station_id = 'stn_x';",
      "DELETE FROM service_definitions WHERE organization_id = 'org-x';",
    );
    expect(unmetOrderings(sql)).not.toContain('service_definitions <- station_services.service_definition_id');
  });

  it('the P1 check does not credit a CASCADE of the same statement', () => {
    // The organizations delete reaches station_services (through stations) and service_definitions in
    // one statement; which of its cascades runs first is not the teardown's to choose.
    expect(unmetOrderings(planted("DELETE FROM organizations WHERE id = 'org-x';")))
      .toContain('organizations -> service_definitions <- station_services.service_definition_id');
  });

  it('the row check accepts a child delete that selects through the rows a CASCADE reaches', () => {
    const stmts = [
      "DELETE FROM offline_transactions WHERE offline_pass_id IN (SELECT id FROM offline_passes WHERE organization_id = 'org-x');",
      "DELETE FROM organizations WHERE id = 'org-x';",
    ];
    expect(unmetRows(stmts, {}))
      .not.toContain('organizations -> offline_passes <- offline_transactions.offline_pass_id');
  });

  it('the row check stops at a CASCADE whose rows an earlier delete already removed through the same FK', () => {
    const alone = ["DELETE FROM organizations WHERE id = 'org-x';"];
    const preempted = ["DELETE FROM stations WHERE station_id = 'stn_x' OR organization_id = 'org-x';", ...alone];
    expect(unmetRows(alone, {})).toContain('organizations -> stations <- bays.station_id');
    expect(unmetRows(preempted, {})).not.toContain('organizations -> stations <- bays.station_id');
  });

  it('the row check reads an aliased delete, and its NOT EXISTS guard meets the edge it names and only that', () => {
    const guarded = [
      "DELETE FROM service_definitions sd WHERE sd.organization_id = 'org-x' AND NOT EXISTS " +
      '(SELECT 1 FROM station_services ss WHERE ss.service_definition_id = sd.id);',
    ];
    const unguarded = ["DELETE FROM service_definitions sd WHERE sd.organization_id = 'org-x';"];
    const key = 'service_definitions <- station_services.service_definition_id';
    expect(rowRequirements(unguarded, {}).map((r) => r.key)).toContain(key);
    expect(unmetRows(unguarded, {})).toContain(key);
    expect(unmetRows(guarded, {})).not.toContain(key);
    // The guard names station_services.service_definition_id; it says nothing of another edge.
    const where = deletePredicate(guarded, 'service_definitions')?.where ?? '';
    expect(guardedAgainst(where, 'sd', { child: 'sessions', column: 'service_id', onDelete: 'RESTRICT' })).toBe(false);
  });

  it('a conjoined arm does not stand in for the rows a CASCADE reaches', () => {
    // organization_id = 'org-x' AND ... selects some of the organization's definitions, not all of them.
    const stmts = [
      "DELETE FROM service_definitions WHERE organization_id = 'org-x' AND service_id = ANY(ARRAY['svc_x']::text[]);",
      "DELETE FROM organizations WHERE id = 'org-x';",
    ];
    expect(unmetRows(stmts, {}))
      .toContain('organizations -> service_definitions <- station_services.service_definition_id');
  });
});

/**
 * CW121 — THE SNAPSHOT HAS AN ENTRY FOR EXACTLY THE TABLES THE TEARDOWN REMOVES.
 *
 * Every check above asks only about tables that have an entry: a table the teardown removes with
 * no entry would be skipped without a word, whatever points at it. offline_passes,
 * provisioning_tokens and certificates, all three deleted by the teardown, had no entry until
 * the 2026-09-29 regeneration, so the FK from offline_transactions to offline_passes was never
 * checked. So the DELETE targets of both halves are read from the SQL they build, the tables
 * their CASCADE edges reach are added, and the result is held equal to the snapshot's parents: a
 * new target, or a new CASCADE into a table without an entry, fails here until pg_constraint has
 * been read for it, and an entry for a table the teardown no longer removes fails as stale.
 *
 * REWRITTEN when the checks began to follow CASCADE edges. The case pinned "every entry is a
 * table one of them deletes from", which forbade the entries for station_services, roles,
 * station_models and the 11 tables no FK points at: tables the teardown removes only through a
 * CASCADE, whose blocking children the checks now read from those entries.
 */
describe('teardown FK coverage — the snapshot has an entry for every table the teardown removes (CW121)', () => {
  const targets = (sql: string): string[] => [...sql.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1]);
  const deleted = [...new Set([
    ...targets(buildTeardownSql(fullHandle())),
    ...targets(buildTeardownTestUsersSql(['sim-worker-test-0@test.local'], { protectedEmails: [] }).join('\n')),
  ])].sort();
  const parents = Object.keys(SCHEMA_FK_GRAPH).sort();

  it('every table either half removes, by its own DELETE or through a CASCADE, has an entry, and every entry is one of them', () => {
    // Walked here rather than with cascadeReach, so that a table reached through a CASCADE with no
    // entry is reported as unlisted instead of thrown.
    const removed = new Set(deleted);
    const queue = [...deleted];
    while (queue.length > 0) {
      const table = queue.pop() as string;
      for (const edge of SCHEMA_FK_GRAPH[table] ?? []) {
        if (edge.onDelete === 'CASCADE' && !removed.has(edge.child)) {
          removed.add(edge.child);
          queue.push(edge.child);
        }
      }
    }
    const unlisted = [...removed].filter((t) => !parents.includes(t)).sort();
    const stale = parents.filter((p) => !removed.has(p));
    expect(
      { unlisted, stale },
      `${deleted.length} tables deleted by the teardown, ${removed.size - deleted.length} more ` +
      `reached only through a CASCADE, ${parents.length} entries in SCHEMA_FK_GRAPH`,
    ).toEqual({ unlisted: [], stale: [] });
  });
});
