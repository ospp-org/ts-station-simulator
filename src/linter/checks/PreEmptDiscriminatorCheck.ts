import type { LintCheck, LintIssue, ParsedScenario } from '../types.js';

/**
 * 6008 COMMAND_PRE_EMPTED is not, on its own, an assertion.
 *
 * It is the code for ANY command the SERVER stopped before dispatch, and the server emits
 * it from eight sites. Two of them are in the SAME method: `ResetStationAction` answers
 * 6008 with `details.wouldBe` 2007 when the station never declared the Device Management
 * profile, and 6008 with `details.wouldBe` 3016 when a session is still active — same
 * code, same 409, same endpoint, adjacent in one method. A scenario asserting only
 * `error.ospp_code: 6008` passes on either, so it cannot tell the refusal it is testing
 * from the refusal that means its own precondition never landed. `details.wouldBe` is the
 * only field that separates them.
 *
 * The rule is therefore mechanical: assert 6008, assert `error.details.wouldBe` beside it.
 * Both files that assert 6008 today already do; this check is what keeps the next one from
 * being written the weaker way, since a passing scenario gives no signal that it was.
 *
 * `details.reason` is a stronger pin still (it names the gate rather than the code the
 * station would have answered), but it is not required here: seven of the eight sites share
 * `wouldBe` 2007 and differ only by reason, so requiring reason everywhere would flag files
 * whose `wouldBe` already discriminates the pair they care about.
 */
const PRE_EMPT_CODE = 6008;

export class PreEmptDiscriminatorCheck implements LintCheck {
  name = 'pre-empt-discriminator';

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];

    scenario.steps.forEach((step, index) => {
      if (step.action !== 'api_call') return;

      const expectBody = step.expect_body;
      if (!expectBody || typeof expectBody !== 'object') return;

      const asserted = expectBody as Record<string, unknown>;
      const assertsPreEmpt = Object.entries(asserted).some(
        ([path, want]) => /(^|\.)ospp_code$/.test(path) && want === PRE_EMPT_CODE,
      );
      if (!assertsPreEmpt) return;

      const assertsDiscriminator = Object.keys(asserted).some((path) =>
        /(^|\.)details\.wouldBe$/.test(path),
      );
      if (assertsDiscriminator) return;

      issues.push({
        file: scenario.filePath,
        step: index,
        stepAction: 'api_call',
        message:
          `asserts ospp_code ${PRE_EMPT_CODE} (COMMAND_PRE_EMPTED) without ` +
          `"error.details.wouldBe". The server emits ${PRE_EMPT_CODE} from eight pre-flight ` +
          `gates — two of them adjacent in ResetStationAction — so the code alone does not ` +
          `identify which one refused, and this step would pass on the wrong refusal. Add ` +
          `the wouldBe the gate under test carries (e.g. 2007 for a not-declared profile, ` +
          `3016 for an active session).`,
      });
    });

    return issues;
  }
}
