import { describe, it, expect } from 'vitest';
import { buildTeardownSql, type PoolBootstrapHandle } from '../../../scenarios/bootstrap/PoolBootstrap.js';
import { StationPool } from '../../../scenarios/stations/StationPool.js';

/**
 * ADR-0005 invariant 7 vs. a one-transaction teardown.
 *
 * csms-server carries a BEFORE DELETE trigger on `certificates`
 * (`database/migrations/2026_07_23_000001_guard_revoked_certificate_deletion.php`):
 *
 *   IF OLD.status = 'revoked' AND OLD.expires_at > now() THEN RAISE EXCEPTION ... restrict_violation
 *
 * A revoked certificate IS the CRL — `CertificateRevocationRepository::revokedSerials()` reads
 * `certificates WHERE status='revoked'` and NOTHING else — so removing the row un-revokes the
 * holder. The database therefore refuses, and because `buildTeardownSql` emits ONE transaction
 * the refusal aborts EVERY other statement: the run leaves its whole world standing.
 *
 * MEASURED ON UAT 2026-09-21, against the live kept pool (org 01a0c58b…, stn_daf82a0f),
 * inside a transaction that was rolled back:
 *   ERROR: ADR-0005 invariant 7: a revoked certificate (serial 1394) is the CRL source of
 *          truth and cannot be deleted before it expires (2027-09-21 19:57:39+00)
 *   CONTEXT: PL/pgSQL function ospp_refuse_delete_unexpired_revoked_cert() line 4 at RAISE
 * 14 statements had run, 39 were skipped, and after ROLLBACK the pool stood untouched.
 *
 * WHAT A KEPT CERTIFICATE NEEDS, read off the schema rather than assumed (UAT pg_constraint,
 * 2026-09-21): `certificates` has ZERO outbound foreign keys — not to stations, not to
 * organizations; `certificates.station_id` is a varchar business key with no FK at all. Its
 * only inbound FK is `provisioning_tokens.issued_certificate_id … ON DELETE SET NULL`, a
 * child. So a kept certificate requires NOTHING else to stay. The live proof, same date:
 * 3 of the 10 revoked-unexpired certificates on UAT (serials 1361, 1362, 1363) have no
 * station row at all, and the CRL still carries them.
 */

const ORG = '019ef000-0000-7000-8000-000000000001';

function handle(overrides: Partial<PoolBootstrapHandle> = {}): PoolBootstrapHandle {
  return {
    orgId: ORG,
    createdOrgId: ORG,
    ephemeralOwnerEmail: 'sim-pool-owner-r1stamp@onestoppay.dev',
    locationId: '019e81fb-58db-7173-89b6-d1ae08cf9a0e',
    stationIds: ['stn_aaaa1111'],
    certFiles: [],
    seededServiceIds: ['svc_wash_basic'],
    identityCredentials: [{ email: 'sim-worker-r1stamp-0@test.local', password: 'p' }],
    pool: new StationPool(),
    ...overrides,
  };
}

/** The one line that deletes from `certificates` (exactly one is asserted below). */
function certificatesDelete(sql: string): string {
  const lines = sql.split('\n').filter((l) => /^DELETE FROM certificates\b/.test(l));
  expect(lines, 'exactly one DELETE FROM certificates').toHaveLength(1);
  return lines[0]!;
}

function lineIndex(sql: string, table: string): number {
  const lines = sql.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^DELETE FROM ${table}\\b`).test(l));
  expect(at, `DELETE FROM ${table} present`).toBeGreaterThanOrEqual(0);
  return at;
}

describe('teardown respects ADR-0005 invariant 7 — it removes what the guard permits and nothing it forbids', () => {
  it('excludes revoked-unexpired certificates with the EXACT predicate the trigger refuses on', () => {
    // Mirrors `OLD.status = 'revoked' AND OLD.expires_at > now()` from the migration named
    // in the docblock. Narrower would still abort; wider would keep certificates the guard
    // allows to go (an expired revoked one is date-rejected at the handshake anyway).
    expect(certificatesDelete(buildTeardownSql(handle())))
      .toContain("AND NOT (status = 'revoked' AND expires_at > now())");
  });

  it('still deletes every OTHER certificate of the run — the exclusion narrows, it does not disable', () => {
    const line = certificatesDelete(buildTeardownSql(handle()));
    expect(line).toContain("station_id = ANY(ARRAY['stn_aaaa1111']::text[])");
    expect(line).toContain(`OR station_id IN (SELECT station_id FROM stations WHERE organization_id = '${ORG}')`);
  });

  it('keeps deleting the station, its bays, the location and the org — a kept certificate anchors nothing', () => {
    // The schema, not taste: `certificates` has no outbound FK, so nothing above it in the
    // graph has to survive with it. Keeping the station would be keeping more than necessary.
    const sql = buildTeardownSql(handle());
    for (const table of ['bays', 'stations', 'locations', 'organizations']) {
      expect(sql, `${table} still swept`).toMatch(new RegExp(`^DELETE FROM ${table}\\b`, 'm'));
    }
  });

  it('deletes provisioning_tokens BEFORE certificates, so a kept certificate sheds its child first', () => {
    const sql = buildTeardownSql(handle());
    expect(lineIndex(sql, 'provisioning_tokens')).toBeLessThan(lineIndex(sql, 'certificates'));
  });
});

/**
 * The same teardown, measured for what it leaves behind that the guard does NOT forbid.
 *
 * Three tables carry this run's rows, are reachable from the handle, and were never swept
 * (UAT counts 2026-09-21, whole database): `station_journal` 21 703 rows of which 21 437
 * already orphaned to station_id NULL by the SET NULL foreign key, `pending_commands` 9 770
 * of which 9 544 name a station that no longer exists, `meter_values` 2 723 of which 2 721
 * name a bay that no longer exists. A single pooled boot of stn_daf82a0f wrote 3 journal rows.
 *
 * `provisioning_bound_bays` is deliberately NOT here: its FK to `provisioning_tokens` is
 * ON DELETE CASCADE and 26 of 26 rows on UAT hang off a token, so the existing
 * `DELETE FROM provisioning_tokens` already takes them.
 */
describe('teardown sweeps the run rows no foreign key would have made it notice', () => {
  it('sweeps station_journal by BOTH keys, before the bays and stations that SET NULL would orphan', () => {
    const sql = buildTeardownSql(handle());
    const line = sql.split('\n').find((l) => l.startsWith('DELETE FROM station_journal'));
    expect(line, 'station_journal swept').toBeDefined();
    // station_id/bay_id are uuid FKs with ON DELETE SET NULL; station_ospp_id is the varchar
    // business key and is the only one that survives a SET NULL (21 437 of 21 437 orphans
    // still carry it), so it is what makes the sweep idempotent on a re-run.
    expect(line).toContain("station_ospp_id = ANY(ARRAY['stn_aaaa1111']::text[])");
    expect(lineIndex(sql, 'station_journal')).toBeLessThan(lineIndex(sql, 'bays'));
    expect(lineIndex(sql, 'station_journal')).toBeLessThan(lineIndex(sql, 'stations'));
  });

  it('sweeps pending_commands by the varchar station id, before the stations delete', () => {
    const sql = buildTeardownSql(handle());
    const line = sql.split('\n').find((l) => l.startsWith('DELETE FROM pending_commands'));
    expect(line, 'pending_commands swept').toBeDefined();
    expect(line).toContain("station_id = ANY(ARRAY['stn_aaaa1111']::text[])");
    expect(lineIndex(sql, 'pending_commands')).toBeLessThan(lineIndex(sql, 'stations'));
  });

  it('sweeps meter_values before the sessions and bays its scope is resolved through', () => {
    const sql = buildTeardownSql(handle());
    expect(lineIndex(sql, 'meter_values')).toBeLessThan(lineIndex(sql, 'sessions'));
    expect(lineIndex(sql, 'meter_values')).toBeLessThan(lineIndex(sql, 'bays'));
  });

  it('leaves provisioning_bound_bays to its CASCADE — no statement names it', () => {
    expect(buildTeardownSql(handle())).not.toMatch(/provisioning_bound_bays/);
  });
});
