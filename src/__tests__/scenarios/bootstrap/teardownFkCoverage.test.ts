import { describe, it, expect } from 'vitest';
import { buildTeardownSql, type PoolBootstrapHandle } from '../../../scenarios/bootstrap/PoolBootstrap.js';
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
 */

type OnDelete = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'RESTRICT';
interface FkEdge {
  child: string;
  column: string;
  onDelete: OnDelete;
}

const SCHEMA_FK_GRAPH: Record<string, FkEdge[]> = {
  // 11 FKs pointing at users. 2 CASCADE (auto-handled by users delete), 9 NO ACTION.
  users: [
    { child: 'api_keys',             column: 'user_id',    onDelete: 'CASCADE'   },
    { child: 'invitations',          column: 'invited_by', onDelete: 'NO ACTION' },
    { child: 'offline_passes',       column: 'user_id',    onDelete: 'NO ACTION' },
    { child: 'offline_transactions', column: 'user_id',    onDelete: 'NO ACTION' },
    { child: 'organization_members', column: 'user_id',    onDelete: 'NO ACTION' },
    { child: 'payment_intents',      column: 'user_id',    onDelete: 'NO ACTION' },
    { child: 'refresh_tokens',       column: 'user_id',    onDelete: 'CASCADE'   },
    { child: 'reservations',         column: 'user_id',    onDelete: 'NO ACTION' },
    { child: 'sessions',             column: 'user_id',    onDelete: 'NO ACTION' },
    { child: 'vehicles',             column: 'user_id',    onDelete: 'NO ACTION' },
    { child: 'wallets',              column: 'user_id',    onDelete: 'NO ACTION' },
  ],
  // wallets has ONE NO ACTION child — easy to miss, blew up commit #3's teardown
  // at the wallets-delete step if wallet_entries was non-empty.
  wallets: [
    { child: 'wallet_entries', column: 'wallet_id', onDelete: 'NO ACTION' },
  ],
  // sessions has two NO ACTION children that the teardown must handle BEFORE
  // deleting sessions — both legitimately surface in real runs (refunds for a
  // refunded session, offline_transactions reconciled against a session).
  sessions: [
    { child: 'refunds',              column: 'session_id',            onDelete: 'NO ACTION' },
    { child: 'offline_transactions', column: 'reconciled_session_id', onDelete: 'NO ACTION' },
  ],
  reservations: [
    { child: 'sessions', column: 'reservation_id', onDelete: 'NO ACTION' },
  ],
  stations: [
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
  // organizations: 10 FKs (captured 2026-06-15 via pg_constraint, confrelid='organizations').
  // The 5 CASCADE children are auto-removed by the org delete (stations, offline_passes, roles,
  // model_has_roles, service_definitions); the 5 NO ACTION children must be deleted first or the
  // org delete FK-blocks. The ephemeral-org teardown (Direction B) deletes the org last.
  organizations: [
    { child: 'stations',             column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'offline_passes',       column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'roles',                column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'model_has_roles',      column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'service_definitions',  column: 'organization_id', onDelete: 'CASCADE'   },
    { child: 'organization_members', column: 'organization_id', onDelete: 'NO ACTION' },
    { child: 'corporate_policies',   column: 'organization_id', onDelete: 'NO ACTION' },
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

describe('teardown FK coverage — P1 reverse-graph static check', () => {
  const sql = buildTeardownSql(fullHandle());

  // For every parent the teardown deletes from, every NO-ACTION FK child must
  // also be deleted, and the child delete must come BEFORE the parent's delete.
  // (CASCADE auto-handles itself; SET NULL doesn't block; RESTRICT is treated
  // like NO ACTION but is currently only present on service_definitions, where
  // the teardown deliberately defers the orphan-sweep until AFTER stations
  // cascade-removes station_services — that ordering is covered by a separate
  // test in PoolBootstrap.test.ts.)
  for (const [parent, edges] of Object.entries(SCHEMA_FK_GRAPH)) {
    const parentAt = deleteAt(sql, parent);
    if (parentAt < 0) continue; // teardown doesn't touch this parent — nothing to assert
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
            `teardown SQL is missing 'DELETE FROM ${edge.child}' — without it, ` +
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
