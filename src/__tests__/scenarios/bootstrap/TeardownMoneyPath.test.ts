import { describe, it, expect } from 'vitest';
import { buildTeardownSql } from '../../../scenarios/bootstrap/PoolBootstrap.js';
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
    // created — 28 scopes at the time of writing, every one of them that id.
    const scoped = [...sql.matchAll(/organization_id = '([^']+)'/g)].map((m) => m[1]);
    expect(scoped.length).toBeGreaterThan(0);
    expect([...new Set(scoped)]).toEqual(['org-1']);
  });
});
