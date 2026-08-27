import { describe, it, expect } from 'vitest';
import {
  buildSeedCatalogSql,
  multiUnitSeedService,
  DEFAULT_SEED_SERVICES,
  DEFAULT_IDENTITY_WALLET_CREDITS,
  deriveRequiredWalletCredits,
  MULTIUNIT_SERVICE_ID,
  MULTIUNIT_UNIT_PRICE_CREDITS,
  MULTIUNIT_PULSE_SECONDS,
} from '../../../scenarios/bootstrap/uatPrivileged.js';

/**
 * The three DB preconditions a multi-unit purchase needs, none of which the corpus had.
 *
 * `PaymentLandingController::process` computes
 *   effectiveMax = (service_kind === MultiUnit && max_unit_quantity >= 1) ? max : 1
 * and refuses `invalid_quantity` outside 1..effectiveMax. Against the four services the
 * pool seeds by default — all PerMinute, service_kind NULL, max_unit_quantity NULL — every
 * purchase is capped at ONE unit, so no batch can be bought and `unit_batches` stays empty.
 * That is not a server defect. It is a fixture nobody built.
 */
describe('the multi-unit catalog seed', () => {
  const withMultiUnit = (units: number) => [...DEFAULT_SEED_SERVICES, multiUnitSeedService(units)];

  it('writes BOTH halves of the capacity gate — the kind and the capacity', () => {
    const sql = buildSeedCatalogSql('org-1', ['stn_x'], withMultiUnit(3));
    // The kind lives on the DEFINITION (service_definitions.service_kind)...
    expect(sql).toContain("'MultiUnit'::service_kind");
    // ...and the capacity on the per-STATION row (station_services.max_unit_quantity).
    expect(sql).toContain(`('${MULTIUNIT_SERVICE_ID}', NULL::int, 200::int, 5::int, 3::int)`);
  });

  // Either half alone caps the purchase at one unit, which is why both are asserted
  // separately rather than by one "it seeds a multi-unit service" claim.
  it('leaves both columns NULL for every service that does not declare them', () => {
    const sql = buildSeedCatalogSql('org-1', ['stn_x'], DEFAULT_SEED_SERVICES);
    expect(sql).toContain('NULL::service_kind');
    expect(sql).not.toContain('MultiUnit');
    // The four defaults: per-minute rate present, every server-resolved column NULL.
    expect(sql).toContain("('svc_wash_basic', 100::int, NULL::int, NULL::int, NULL::int)");
  });

  it('prices it Fixed, because a per-minute quote over a 5-second pulse is a number nobody chose', () => {
    // getServicePricing: Fixed quotes price_credits_fixed; anything else quotes
    // ceil(seconds/60 * rate) — over a 5s pulse that is ceil(0.083 * rate), and if it
    // rounds to 0 the quote chokepoint refuses to charge and the page says
    // payment_unavailable.
    const svc = multiUnitSeedService(3);
    expect(svc.pricingType).toBe('Fixed');
    expect(svc.priceCreditsFixed).toBe(MULTIUNIT_UNIT_PRICE_CREDITS);
    expect(svc.priceCreditsPerMinute).toBeUndefined();
  });

  it('carries the pulse, without which the page cannot quote it at all', () => {
    // A MultiUnit entry with no fixed_duration_seconds makes getServicePricing THROW
    // ServicePricingUnavailableException — the service exists and is unsellable.
    expect(multiUnitSeedService(3).fixedDurationSeconds).toBe(MULTIUNIT_PULSE_SECONDS);
    const sql = buildSeedCatalogSql('org-1', ['stn_x'], withMultiUnit(3));
    expect(sql).toContain('fixed_duration_seconds = EXCLUDED.fixed_duration_seconds');
  });

  it('refuses a capacity Postgres would refuse, at the call rather than at the CHECK', () => {
    // chk_station_services_max_unit_quantity: NULL OR >= 1.
    expect(() => multiUnitSeedService(0)).toThrow(/must be an integer >= 1/);
    expect(() => multiUnitSeedService(-1)).toThrow(/must be an integer >= 1/);
    expect(() => multiUnitSeedService(2.5)).toThrow(/must be an integer >= 1/);
  });

  /**
   * THE CONTROL THAT KEEPS THIS FROM CHANGING THE OTHER 145 FILES' WORLD.
   *
   * `DEFAULT_IDENTITY_WALLET_CREDITS` is `max()` over the seeded catalog, so a per-unit
   * price above it would silently re-fund every bootstrapped identity — a change to the
   * money fixture of the whole corpus, made by adding a service none of them use.
   */
  it('does not move the wallet default every identity is funded at', () => {
    expect(DEFAULT_IDENTITY_WALLET_CREDITS).toBe(1000);
    expect(deriveRequiredWalletCredits(withMultiUnit(3)))
      .toBe(deriveRequiredWalletCredits(DEFAULT_SEED_SERVICES));
    // Stated as the property, not the number: the guard must survive a price change.
    expect(MULTIUNIT_UNIT_PRICE_CREDITS).toBeLessThanOrEqual(DEFAULT_IDENTITY_WALLET_CREDITS);
  });

  /**
   * AND THE CONTROL FOR THE OTHER DIRECTION. `device-management/service-catalog-update.yaml`
   * asserts `serviceCount: 4` against the publish endpoint, which counts station_services
   * rows. A fifth service seeded unconditionally reddens it for a fixture reason — the exact
   * failure class the pool bootstrap exists to keep out of the summary.
   */
  it('is absent unless asked for — the default seed is still exactly four services', () => {
    expect(DEFAULT_SEED_SERVICES).toHaveLength(4);
    expect(DEFAULT_SEED_SERVICES.map((s) => s.serviceId)).not.toContain(MULTIUNIT_SERVICE_ID);
    const sql = buildSeedCatalogSql('org-1', ['stn_x'], DEFAULT_SEED_SERVICES);
    expect(sql).not.toContain(MULTIUNIT_SERVICE_ID);
  });

  it('still escapes every value, with the new columns in the row', () => {
    const sql = buildSeedCatalogSql("org'1", ["stn'x"], [
      { ...multiUnitSeedService(2), serviceId: "svc'mu", serviceName: "Ev'il" },
    ]);
    expect(sql).toContain("'org''1'");
    expect(sql).toContain("'stn''x'");
    expect(sql).toContain("'svc''mu'");
    expect(sql).toContain("'Ev''il'");
  });
});
