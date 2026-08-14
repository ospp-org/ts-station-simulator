import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';
import { substituteTemplateValue } from './ApiCallStep.js';
import {
  deriveRequiredWalletCredits,
  fundWalletByUserId,
  readStationCatalogServices,
  uatDbConfigFromEnv,
} from '../bootstrap/uatPrivileged.js';

/**
 * Fund the wallet of a customer THIS SCENARIO created.
 *
 * `POST /v1/auth/register` gives every new customer a wallet at balance 0
 * (`RegisterAction.php:49`), and `StartSessionAction.php:241-250` refuses a card-free start
 * when `balance < creditsAuthorized` — 402 `INSUFFICIENT_BALANCE` / ospp_code 4001. A scenario
 * that registers its own customer and then starts a session therefore has to fund it, and
 * nothing else can: the pool's `wallet_balance:` declaration seeds a POOL identity, and a
 * self-provisioning scenario never takes one.
 *
 * THE AMOUNT IS DERIVED, NOT DECLARED. With no `credits:` field this reads the catalog the
 * scenario actually published on its own station and applies
 * {@link deriveRequiredWalletCredits} — the same rule, and the same function, that sizes the
 * pool's `DEFAULT_IDENTITY_WALLET_CREDITS`. Re-price a service in the YAML and the funding
 * follows on the next run with nothing to remember. A literal here would be a second statement
 * of the same rule, and the two would drift the first time a price moved.
 *
 * A scenario that WANTS an unfunded customer — one whose subject is the 4001 refusal — asks
 * for it: `credits: 0`. That is the only way to get a starved fixture, so a starved fixture is
 * never an accident.
 *
 *   - action: fund_wallet
 *     user_id: "{{captured.user_id}}"
 *
 * Runs against the UAT database directly, like the pool bootstrap, because no REST route
 * credits a wallet: `/v1/payments/start` initiates a real card payment, and `/v1/wallet/balance`
 * is read-only.
 */
export class FundWalletStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    _station: Station,
  ): Promise<void> {
    const rawUserId = definition.user_id;
    if (typeof rawUserId !== 'string' || rawUserId.trim() === '') {
      throw new Error(
        'FundWalletStep requires a "user_id" field — normally "{{captured.user_id}}", the id ' +
        'the server returned when this scenario registered its customer. The wallet is keyed ' +
        'on that uuid rather than on an email pattern, so funding cannot reach a row this run ' +
        'did not create.',
      );
    }
    const userId = substituteTemplateValue(rawUserId, context);

    const rawStationId = typeof definition.station_id === 'string'
      ? substituteTemplateValue(definition.station_id, context)
      : context.variables.get('stationId');
    if (typeof rawStationId !== 'string' || rawStationId === '') {
      throw new Error(
        'FundWalletStep could not resolve a stationId — pass "station_id" explicitly, or run ' +
        'this step in a scenario that has one. It names the station whose published catalog ' +
        'the funding amount is derived from.',
      );
    }

    const cfg = uatDbConfigFromEnv();

    // An explicit `credits:` is an override and is honoured verbatim, including 0.
    if (definition.credits !== undefined) {
      const credits = definition.credits;
      if (typeof credits !== 'number' || !Number.isInteger(credits) || credits < 0) {
        throw new Error(
          `FundWalletStep "credits" must be a non-negative integer when given, got ${String(credits)}`,
        );
      }
      if (credits === 0) {
        console.log(
          `[FundWalletStep] credits: 0 declared — customer ${userId} left unfunded deliberately. ` +
          'A card-free /sessions/start will answer 402 / ospp_code 4001.',
        );
        return;
      }
      await fundWalletByUserId(userId, credits, cfg);
      console.log(`[FundWalletStep] funded customer ${userId} with ${credits} credits (declared)`);
      return;
    }

    const services = await readStationCatalogServices(rawStationId, cfg);
    if (services.length === 0) {
      throw new Error(
        `FundWalletStep: station ${rawStationId} has no published catalog, so there is nothing ` +
        'to derive a funding amount from. Place this step AFTER the catalog is published — ' +
        'before that, the only honest amount is one this step cannot compute. To fund a fixed ' +
        'amount regardless, declare "credits:".',
      );
    }

    const credits = deriveRequiredWalletCredits(services);
    await fundWalletByUserId(userId, credits, cfg);
    console.log(
      `[FundWalletStep] funded customer ${userId} with ${credits} credits — derived from the ` +
      `${services.length} service(s) published on ${rawStationId} (the largest single ` +
      'authorization the server can accept against that catalog)',
    );
  }
}
