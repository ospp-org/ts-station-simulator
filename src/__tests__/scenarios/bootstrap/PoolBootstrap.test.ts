import { describe, it, expect } from 'vitest';
import {
  buildTeardownSql,
  certPathsFor,
  type PoolBootstrapHandle,
} from '../../../scenarios/bootstrap/PoolBootstrap.js';
import {
  sqlLiteral,
  buildSeedCatalogSql,
  buildServicesPayloadJson,
  buildSeedTestUsersSql,
  buildTeardownTestUsersSql,
  DEFAULT_SEED_SERVICES,
} from '../../../scenarios/bootstrap/uatPrivileged.js';
import { StationPool } from '../../../scenarios/stations/StationPool.js';
import type { TargetConfig } from '../../../scenarios/ScenarioRunner.js';

function handle(overrides: Partial<PoolBootstrapHandle> = {}): PoolBootstrapHandle {
  return {
    orgId: 'org-1',
    stationIds: [],
    certFiles: [],
    seededServiceIds: [],
    identityCredentials: [],
    pool: new StationPool(),
    ...overrides,
  };
}

describe('sqlLiteral', () => {
  it('single-quotes and doubles embedded quotes (injection-safe)', () => {
    expect(sqlLiteral('plain')).toBe("'plain'");
    expect(sqlLiteral("o'brien@x.dev")).toBe("'o''brien@x.dev'");
    expect(sqlLiteral("a'; DROP TABLE users;--")).toBe("'a''; DROP TABLE users;--'");
  });
});

describe('buildTeardownSql', () => {
  it('empty handle → valid no-op transaction (idempotent)', () => {
    const sql = buildTeardownSql(handle());
    expect(sql.startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    // Empty arrays so every WHERE matches nothing — re-runnable with no error.
    expect(sql).toContain('ARRAY[]::text[]');
    expect(sql).toContain('ARRAY[]::uuid[]');
    // No offline reset when no email was flipped.
    expect(sql).not.toContain('offline_enabled');
  });

  it('includes the offline reset only when an email was enabled', () => {
    expect(buildTeardownSql(handle())).not.toContain('UPDATE users');
    const sql = buildTeardownSql(handle({ offlineEnabledEmail: 'e2e@x.dev' }));
    expect(sql).toContain("UPDATE users SET offline_enabled = false WHERE email = 'e2e@x.dev';");
  });

  it('embeds station ids / location id as escaped literals', () => {
    const sql = buildTeardownSql(handle({
      stationIds: ['stn_aaaa1111', 'stn_bbbb2222'],
      locationId: '019e674f-aa63-7309-ab7a-c71fcd6178de',
    }));
    expect(sql).toContain("ARRAY['stn_aaaa1111', 'stn_bbbb2222']::text[]");
    expect(sql).toContain("ARRAY['019e674f-aa63-7309-ab7a-c71fcd6178de']::uuid[]");
  });

  it('orders deletes FK-safe: bay-children → station-children → bays → stations → location', () => {
    const sql = buildTeardownSql(handle({ stationIds: ['stn_x'], locationId: 'loc-1', offlineEnabledEmail: 'e@x' }));
    const at = (needle: string): number => {
      const i = sql.indexOf(needle);
      expect(i, `expected SQL to contain: ${needle}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    // session-children before sessions (refunds.session_id,
    // offline_transactions.reconciled_session_id both reference sessions)
    expect(at('DELETE FROM refunds')).toBeLessThan(at('DELETE FROM sessions'));
    expect(at('DELETE FROM offline_transactions')).toBeLessThan(at('DELETE FROM sessions'));
    // sessions before reservations (sessions.reservation_id → reservations) —
    // the FK that the first hand-ordered version got backwards
    expect(at('DELETE FROM sessions')).toBeLessThan(at('DELETE FROM reservations'));
    // bay-level children before bays
    expect(at('DELETE FROM reservations')).toBeLessThan(at('DELETE FROM bays'));
    expect(at('DELETE FROM sessions')).toBeLessThan(at('DELETE FROM bays'));
    expect(at('DELETE FROM offline_transactions')).toBeLessThan(at('DELETE FROM bays'));
    // station-level children before stations
    expect(at('DELETE FROM service_catalogs')).toBeLessThan(at('DELETE FROM stations'));
    expect(at('DELETE FROM station_configurations')).toBeLessThan(at('DELETE FROM stations'));
    expect(at('DELETE FROM firmware_updates')).toBeLessThan(at('DELETE FROM stations'));
    expect(at('DELETE FROM diagnostics_uploads')).toBeLessThan(at('DELETE FROM stations'));
    expect(at('DELETE FROM provisioning_tokens')).toBeLessThan(at('DELETE FROM stations'));
    expect(at('DELETE FROM certificates')).toBeLessThan(at('DELETE FROM stations'));
    // bays before stations; stations before location; everything before the offline reset
    expect(at('DELETE FROM bays')).toBeLessThan(at('DELETE FROM stations'));
    expect(at('DELETE FROM stations')).toBeLessThan(at('DELETE FROM locations'));
    expect(at('DELETE FROM locations')).toBeLessThan(at('UPDATE users'));
  });

  it('reaches sessions via bay_id only (sessions has no station_id column)', () => {
    const sql = buildTeardownSql(handle({ stationIds: ['stn_x'] }));
    const sessionsLine = sql.split('\n').find((l) => l.includes('DELETE FROM sessions'));
    expect(sessionsLine).toBeDefined();
    // The DELETE predicate must filter sessions by bay_id (not a non-existent
    // sessions.station_id). The nested bays subquery legitimately contains
    // "station_id IN (SELECT id FROM stations …)" — so assert on the WHERE
    // predicate column, i.e. the text right after "WHERE".
    // The OUTER predicate must filter by bay_id (sessions has no station_id
    // column). The nested bays subquery legitimately contains "WHERE station_id
    // IN (SELECT id FROM stations …)", so assert only on the outer predicate:
    // the text right after the first WHERE must begin with bay_id.
    const where = sessionsLine!.slice(sessionsLine!.indexOf('WHERE '));
    expect(where.startsWith('WHERE bay_id IN')).toBe(true);
  });

  it('deletes cert material by the varchar business station_id (no FK / no uuid subquery)', () => {
    const sql = buildTeardownSql(handle({ stationIds: ['stn_x'] }));
    for (const tbl of ['provisioning_tokens', 'certificates']) {
      const line = sql.split('\n').find((l) => l.includes(`DELETE FROM ${tbl}`));
      expect(line, `${tbl} delete present`).toBeDefined();
      // keyed directly on the text[] business id, not the uuid stations.id subquery
      expect(line).toContain('station_id = ANY(ARRAY[');
      expect(line).not.toContain('SELECT id FROM stations');
    }
  });
});

describe('buildTeardownSql — service_definitions orphan-sweep (seed symmetry)', () => {
  it('is absent when no service_definitions were seeded this run', () => {
    const sql = buildTeardownSql(handle({ stationIds: ['stn_x'], locationId: 'loc-1' }));
    expect(sql).not.toContain('DELETE FROM service_definitions');
  });

  it('appears when seededServiceIds is non-empty and is scoped to org + seeded svc_* set', () => {
    const sql = buildTeardownSql(handle({
      orgId: '019e674f-aa63-7309-ab7a-c71fcd6178de',
      stationIds: ['stn_x'],
      locationId: 'loc-1',
      seededServiceIds: ['svc_wash_basic', 'svc_wash_premium', 'svc_dry', 'svc_vacuum'],
    }));
    const line = sql.split('\n').find((l) => l.includes('DELETE FROM service_definitions sd'));
    expect(line, 'orphan-sweep present').toBeDefined();
    // Filtered to OUR org
    expect(line).toContain("sd.organization_id = '019e674f-aa63-7309-ab7a-c71fcd6178de'");
    // Filtered to OUR seeded svc_* set (every code present + escaped as text[])
    expect(line).toContain("sd.service_id = ANY(ARRAY['svc_wash_basic', 'svc_wash_premium', 'svc_dry', 'svc_vacuum']::text[])");
    // NOT EXISTS clause keeps it safe even if FK RESTRICT is one day relaxed
    expect(line).toContain('NOT EXISTS (SELECT 1 FROM station_services ss WHERE ss.service_definition_id = sd.id)');
  });

  it('runs AFTER the DELETE FROM stations cascade so station_services is already gone', () => {
    const sql = buildTeardownSql(handle({
      orgId: 'org-1', stationIds: ['stn_x'],
      seededServiceIds: ['svc_wash_basic'],
    }));
    const stationsAt = sql.indexOf('DELETE FROM stations');
    const sweepAt = sql.indexOf('DELETE FROM service_definitions sd');
    expect(stationsAt).toBeGreaterThanOrEqual(0);
    expect(sweepAt).toBeGreaterThan(stationsAt);
  });
});

describe('buildServicesPayloadJson — byte-identical to ServiceItemDto::toPayload()', () => {
  it('produces the canonical PerMinute payload in the PHP DTO key order', () => {
    const json = buildServicesPayloadJson([
      { serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', pricingType: 'PerMinute', priceCreditsPerMinute: 100 },
    ]);
    // Key order: serviceId, serviceName, pricingType, available, priceCreditsPerMinute.
    // Matches ServiceItemDto::toPayload() at csms-server. Re-ordering breaks fidelity.
    expect(json).toBe('[{"serviceId":"svc_wash_basic","serviceName":"Basic Wash","pricingType":"PerMinute","available":true,"priceCreditsPerMinute":100}]');
  });

  it('switches to priceCreditsFixed for the Fixed pricing branch', () => {
    const json = buildServicesPayloadJson([
      { serviceId: 'svc_x', serviceName: 'X', pricingType: 'Fixed', priceCreditsFixed: 500 },
    ]);
    expect(json).toBe('[{"serviceId":"svc_x","serviceName":"X","pricingType":"Fixed","available":true,"priceCreditsFixed":500}]');
  });

  it('default 4-service set produces the expected canonical JSON', () => {
    const json = buildServicesPayloadJson(DEFAULT_SEED_SERVICES);
    expect(json).toBe('[' + [
      '{"serviceId":"svc_wash_basic","serviceName":"Basic Wash","pricingType":"PerMinute","available":true,"priceCreditsPerMinute":100}',
      '{"serviceId":"svc_wash_premium","serviceName":"Premium Wash","pricingType":"PerMinute","available":true,"priceCreditsPerMinute":100}',
      '{"serviceId":"svc_dry","serviceName":"Dry","pricingType":"PerMinute","available":true,"priceCreditsPerMinute":100}',
      '{"serviceId":"svc_vacuum","serviceName":"Vacuum","pricingType":"PerMinute","available":true,"priceCreditsPerMinute":100}',
    ].join(',') + ']');
  });
});

describe('buildSeedCatalogSql', () => {
  it('empty stationIds OR empty services → no-op transaction (safe to call)', () => {
    expect(buildSeedCatalogSql('org-1', [], DEFAULT_SEED_SERVICES)).toBe('BEGIN;\nCOMMIT;');
    expect(buildSeedCatalogSql('org-1', ['stn_x'], [])).toBe('BEGIN;\nCOMMIT;');
  });

  it('mirrors handler conflict semantics — DO NOTHING on definitions, DO UPDATE on station_services', () => {
    const sql = buildSeedCatalogSql('org-1', ['stn_x'], DEFAULT_SEED_SERVICES);
    // service_definitions: DO NOTHING (handler resolveOrCreateDefinition preserves)
    expect(sql).toContain('INSERT INTO service_definitions');
    expect(sql).toContain('ON CONFLICT (organization_id, service_id) DO NOTHING;');
    // station_services: DO UPDATE (Laravel updateOrInsert)
    expect(sql).toContain('INSERT INTO station_services (station_id, service_definition_id, price_credits_per_minute, available)');
    expect(sql).toContain('ON CONFLICT (station_id, service_definition_id) DO UPDATE SET');
    expect(sql).toContain('price_credits_per_minute = EXCLUDED.price_credits_per_minute');
    expect(sql).toContain('updated_at = NOW();');
  });

  it('audit row INSERT + current_catalog_version bump are scoped to current_catalog_version IS NULL (re-seed-safe)', () => {
    const sql = buildSeedCatalogSql('org-1', ['stn_x'], DEFAULT_SEED_SERVICES);
    const catalogLine = sql.indexOf('INSERT INTO service_catalogs');
    const updateLine = sql.indexOf('UPDATE stations SET current_catalog_version');
    expect(catalogLine).toBeGreaterThanOrEqual(0);
    expect(updateLine).toBeGreaterThanOrEqual(0);
    // Both gated on IS NULL so re-running the seed against a previously-seeded station
    // neither double-writes an audit row nor restarts the monotonic version sequence.
    const catalogStmt = sql.slice(catalogLine, updateLine);
    expect(catalogStmt).toContain('s.current_catalog_version IS NULL');
    const updateStmt = sql.slice(updateLine);
    expect(updateStmt).toContain('current_catalog_version IS NULL');
    // First push: catalog_version = '1', previous = NULL
    expect(catalogStmt).toContain("'1', NULL,");
    expect(updateStmt).toContain("current_catalog_version = '1'");
  });

  it('values are sqlLiteral-escaped (injection-safe for orgId, station ids, service ids/names)', () => {
    const sql = buildSeedCatalogSql(
      "org'1",
      ["stn_x'; DROP TABLE stations;--"],
      [{ serviceId: "svc_x'", serviceName: "Evil'Name", pricingType: 'PerMinute', priceCreditsPerMinute: 100 }],
    );
    // Safety property: every user-supplied value appears EXCLUSIVELY in its doubled-quote
    // escaped form (the SQL-literal-safe representation). The presence of the doubled-quote
    // form on every channel proves the injection payload never escapes its string literal —
    // it's just inert characters inside a quoted string.
    expect(sql).toContain("'org''1'");
    expect(sql).toContain("'stn_x''; DROP TABLE stations;--'");
    expect(sql).toContain("'svc_x'''");
    expect(sql).toContain("'Evil''Name'");
  });

  it('embeds the canonical 4-service services_data JSON in the audit INSERT (fidelity)', () => {
    const sql = buildSeedCatalogSql('org-1', ['stn_x'], DEFAULT_SEED_SERVICES);
    // The JSON literal is single-quoted by sqlLiteral and cast to ::jsonb.
    const expectedJson = buildServicesPayloadJson(DEFAULT_SEED_SERVICES);
    // Defensive: the default set has no embedded quotes, so the literal equals JSON
    // wrapped in single quotes.
    expect(sql).toContain(`'${expectedJson}'::jsonb`);
  });
});

describe('buildSeedTestUsersSql — per-worker identity seed', () => {
  it('empty emails → no-op transaction', () => {
    expect(buildSeedTestUsersSql('org-1', 'admin@x', [])).toBe('BEGIN;\nCOMMIT;');
  });

  it('emits exactly 4 INSERT statements (users + wallets + organization_members + model_has_roles)', () => {
    const sql = buildSeedTestUsersSql('org-1', 'admin@x', ['sim-worker-abc-0@test.local']);
    // INSERT INTO users appears once (one row per email = one INSERT)
    expect((sql.match(/INSERT INTO users /g) ?? []).length).toBe(1);
    expect((sql.match(/INSERT INTO wallets /g) ?? []).length).toBe(1);
    expect((sql.match(/INSERT INTO organization_members /g) ?? []).length).toBe(1);
    expect((sql.match(/INSERT INTO model_has_roles /g) ?? []).length).toBe(1);
  });

  it('users INSERT count scales linearly with emails (one INSERT per email)', () => {
    const emails = ['e1@t', 'e2@t', 'e3@t', 'e4@t', 'e5@t'];
    const sql = buildSeedTestUsersSql('org-1', 'admin@x', emails);
    expect((sql.match(/INSERT INTO users /g) ?? []).length).toBe(emails.length);
    // wallets/members/model_has_roles use ARRAY(...)::text[], so one statement each
    expect((sql.match(/INSERT INTO wallets /g) ?? []).length).toBe(1);
    expect((sql.match(/INSERT INTO organization_members /g) ?? []).length).toBe(1);
    expect((sql.match(/INSERT INTO model_has_roles /g) ?? []).length).toBe(1);
  });

  it('copies password_hash from the source identity (so the seeded user shares its password)', () => {
    const sql = buildSeedTestUsersSql('org-1', 'admin@onestoppay.dev', ['sim-worker-abc-0@test.local']);
    // Each user INSERT SELECTs password_hash FROM users WHERE email = sourceEmail.
    expect(sql).toContain("SELECT 'sim-worker-abc-0@test.local', password_hash, 'sim-worker-abc-0@test.local', true, true");
    expect(sql).toContain("FROM users WHERE email = 'admin@onestoppay.dev';");
  });

  it('offline_enabled flag flows through (default false, opt-in true)', () => {
    const off = buildSeedTestUsersSql('org-1', 'admin@x', ['e@t']);
    expect(off).toContain('true, true, false ');
    const on = buildSeedTestUsersSql('org-1', 'admin@x', ['e@t'], true);
    expect(on).toContain('true, true, true ');
  });

  it('Spatie model_type is App\\Modules\\Auth\\Models\\User (single backslashes, MemberObserver fidelity)', () => {
    const sql = buildSeedTestUsersSql('org-1', 'admin@x', ['e@t']);
    // Spatie compares model_has_roles.model_type === User::class; PHP renders that as
    // "App\Modules\Auth\Models\User" — any double-escape silently fails the lookup.
    expect(sql).toContain("'App\\Modules\\Auth\\Models\\User'");
  });

  it('all user-supplied values are sqlLiteral-escaped (injection-safe)', () => {
    const sql = buildSeedTestUsersSql(
      "org'1",
      "admin'@x",
      ["sim-worker'; DROP TABLE users;--@test.local"],
      true,
    );
    expect(sql).toContain("'org''1'");
    expect(sql).toContain("'admin''@x'");
    expect(sql).toContain("'sim-worker''; DROP TABLE users;--@test.local'");
  });
});

describe('buildTeardownTestUsersSql — per-scenario identity sweep (full FK coverage)', () => {
  it('empty emails → no statements', () => {
    expect(buildTeardownTestUsersSql([])).toEqual([]);
  });

  it('emits 14 DELETEs covering offline_auth_grants + wallet_entries + all 10 NO-ACTION user FKs + Spatie + users', () => {
    const stmts = buildTeardownTestUsersSql(['e1@t', 'e2@t']);
    // Children before parents: offline_auth_grants → wallet_entries → (NO-ACTION FKs) →
    // Spatie (2) → users. The reverse-graph static check (teardownFkCoverage.test.ts) is the
    // authoritative contract — this test just pins the count + the per-statement table targets.
    expect(stmts).toHaveLength(14);
    const tables = [
      'offline_auth_grants',
      'wallet_entries',
      'offline_passes',
      'offline_transactions',
      'payment_intents',
      'sessions',
      'reservations',
      'vehicles',
      'organization_members',
      'wallets',
      'invitations',
      'model_has_roles',
      'model_has_permissions',
      'users',
    ];
    for (let i = 0; i < tables.length; i++) {
      expect(stmts[i], `stmt[${i}] should delete from ${tables[i]}`).toContain(`DELETE FROM ${tables[i]}`);
    }
    // Every DELETE is scoped to the seeded email set (either via the userIds subquery
    // or directly on email columns).
    for (const stmt of stmts) {
      expect(stmt).toContain("ARRAY['e1@t', 'e2@t']::text[]");
    }
  });

  it('wallet_entries delete precedes wallets delete (NO-ACTION FK: wallet_entries.wallet_id → wallets)', () => {
    const stmts = buildTeardownTestUsersSql(['e@t']);
    const walletEntriesAt = stmts.findIndex((s) => s.includes('DELETE FROM wallet_entries'));
    const walletsAt = stmts.findIndex((s) => s.includes('DELETE FROM wallets WHERE user_id'));
    expect(walletEntriesAt).toBeGreaterThanOrEqual(0);
    expect(walletsAt).toBeGreaterThanOrEqual(0);
    expect(walletEntriesAt).toBeLessThan(walletsAt);
  });

  it('invitations DELETE catches both invited_by AND email (defense-in-depth for never-accepted invites)', () => {
    const stmts = buildTeardownTestUsersSql(['sim-worker-abc-0@test.local']);
    const inv = stmts.find((s) => s.includes('DELETE FROM invitations'));
    expect(inv).toBeDefined();
    expect(inv).toContain('invited_by IN');
    expect(inv).toContain('OR email = ANY');
  });
});

describe('buildTeardownSql — identity-pool sweep integrated', () => {
  it('absent when identityCredentials is empty (legacy single-identity runs)', () => {
    const sql = buildTeardownSql(handle({ stationIds: ['stn_x'], locationId: 'loc-1' }));
    // None of the user-sweep tables should appear when the pool is empty.
    expect(sql).not.toContain('DELETE FROM model_has_roles');
    expect(sql).not.toContain('DELETE FROM model_has_permissions');
    expect(sql).not.toContain('DELETE FROM organization_members');
    expect(sql).not.toContain('DELETE FROM wallet_entries');
    expect(sql).not.toContain('DELETE FROM offline_passes');
    expect(sql).not.toContain('DELETE FROM vehicles');
    expect(sql).not.toContain('DELETE FROM invitations');
  });

  it('appears when identityCredentials is non-empty and is scoped to THIS run\'s stamped emails', () => {
    const sql = buildTeardownSql(handle({
      stationIds: ['stn_x'], locationId: 'loc-1',
      identityCredentials: [
        { email: 'sim-worker-abc-0@test.local', password: 'p' },
        { email: 'sim-worker-abc-1@test.local', password: 'p' },
      ],
    }));
    // Full FK coverage: all 13 user-side DELETEs land in the integrated transaction.
    for (const tbl of [
      'wallet_entries', 'offline_passes', 'offline_transactions', 'payment_intents',
      'reservations', 'vehicles', 'organization_members', 'wallets', 'invitations',
      'model_has_roles', 'model_has_permissions',
    ]) {
      expect(sql, `expected DELETE FROM ${tbl}`).toContain(`DELETE FROM ${tbl}`);
    }
    expect(sql).toContain('DELETE FROM users WHERE email = ANY(ARRAY[\'sim-worker-abc-0@test.local\', \'sim-worker-abc-1@test.local\']::text[])');
  });

  it('user-sweep runs AFTER station/location deletes (children before parents)', () => {
    const sql = buildTeardownSql(handle({
      orgId: 'org-1', stationIds: ['stn_x'], locationId: 'loc-1',
      seededServiceIds: ['svc_wash_basic'],
      identityCredentials: [{ email: 'e@t', password: 'p' }],
    }));
    const stationsAt = sql.indexOf('DELETE FROM stations');
    const usersAt = sql.indexOf('DELETE FROM users WHERE email');
    expect(stationsAt).toBeGreaterThanOrEqual(0);
    expect(usersAt).toBeGreaterThan(stationsAt);
  });

  it('wallet_entries precedes wallets in the integrated SQL (NO-ACTION FK preservation)', () => {
    const sql = buildTeardownSql(handle({
      stationIds: ['stn_x'],
      identityCredentials: [{ email: 'e@t', password: 'p' }],
    }));
    const weAt = sql.indexOf('DELETE FROM wallet_entries');
    const wAt = sql.indexOf('DELETE FROM wallets WHERE user_id');
    expect(weAt).toBeGreaterThanOrEqual(0);
    expect(wAt).toBeGreaterThan(weAt);
  });
});

describe('certPathsFor', () => {
  const target: TargetConfig = {
    mqttUrl: 'mqtts://broker:8883',
    tls: {
      keyPattern: 'certs/uat/{{stationId}}-key.pem',
      certPattern: 'certs/uat/{{stationId}}.pem',
      serverCa: 'certs/uat/{{stationId}}-chain.pem',
    },
  };

  it('derives flat certs/<env>/ paths so Station.connect + disk hydration find them', () => {
    const p = certPathsFor(target, 'stn_dead');
    expect(p.keyPath).toBe('certs/uat/stn_dead-key.pem');
    expect(p.certPath).toBe('certs/uat/stn_dead.pem');
    expect(p.chainPath).toBe('certs/uat/stn_dead-chain.pem');
    // bays.json must sit next to the key so hydrateProvisioningFromDisk finds it.
    expect(p.baysJsonPath).toBe('certs/uat/stn_dead-bays.json');
  });

  it('falls back to deriving cert/chain from the key pattern when not set', () => {
    const p = certPathsFor({ mqttUrl: 'x', tls: { keyPattern: 'certs/uat/{{stationId}}-key.pem' } }, 'stn_x');
    expect(p.certPath).toBe('certs/uat/stn_x.pem');
    expect(p.chainPath).toBe('certs/uat/stn_x-chain.pem');
  });

  it('throws a clear error when the target has no cert pattern', () => {
    expect(() => certPathsFor({ mqttUrl: 'x' }, 'stn_x')).toThrow(/no certs\.key/);
  });
});
