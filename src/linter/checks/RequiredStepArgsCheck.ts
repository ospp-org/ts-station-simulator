import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { LintCheck, LintIssue, ParsedScenario } from '../types.js';

/**
 * A STEP THAT OMITS AN ARGUMENT ITS OWN CODE REQUIRES.
 *
 * `fund_wallet` is the measured instance. `FundWalletStep.execute` opens with
 *
 *     const rawUserId = definition.user_id;
 *     if (typeof rawUserId !== 'string' || rawUserId.trim() === '') {
 *       throw new Error('FundWalletStep requires a "user_id" field — …');
 *     }
 *
 * (`FundWalletStep.ts:46-53`), and `sessions/start-refused-binding-uncovered.yaml` declared
 * `fund_wallet` with `credits:` alone. The file lints clean and dies at that step — after
 * two provisionings and two boots, which is the most expensive place in the file to discover
 * a missing key.
 *
 * ── ARE REQUIRED ARGUMENTS DECLARED ANYWHERE A LINTER CAN READ THEM? NO. ─────────────────
 *
 * They are not in a schema, a decorator, a manifest or a type. `StepDefinition` is
 * `{ action: string; [key: string]: unknown }` (`Step.ts:5-8`) — every argument of every step
 * is `unknown` and optional as far as the type system is concerned. The requirement exists
 * ONLY as an imperative throw in the first lines of each `execute()`, and there are six of
 * them across six step classes, in one shape:
 *
 *     AssertStep.ts:87      requires a "field" field
 *     WaitForStep.ts:186    requires a "message" field
 *     FaultStep.ts:13       requires a "type" field
 *     FundWalletStep.ts:49  requires a "user_id" field
 *     ApiCallStep.ts:793    requires a "url" field
 *     SendStep.ts:336       requires a "message" field
 *
 * All six are unconditional and sit at the top of `execute()` before any other work, so
 * "declared and required" and "absent and fatal" are the same statement. That is what makes
 * them safe to read as a contract.
 *
 * So the table IS derived — from the throws themselves, which are the writers of the rule,
 * rather than transcribed into a list here that would drift the first time a step gained an
 * argument. Transcribing it was the alternative and it is the defect this repository keeps
 * finding: a second statement of a rule, correct on the day it is written.
 *
 * ── WHY IT READS ITS OWN SIBLING DIRECTORY ──────────────────────────────────────────────
 *
 * `src/` and `dist/` have the same internal layout, and the throw string survives compilation
 * byte-for-byte (verified: `dist/scenarios/steps/FundWalletStep.js:35` carries it). Resolving
 * `../../scenarios/` off `import.meta.url` therefore lands on the TypeScript sources under
 * vitest and on the compiled ones under `npm run lint:scenarios`, and both scrape the same.
 * It also means the table travels with the published package, which ships `dist` and not
 * `src` — a check that read `src/` would be correct here and silently empty for a consumer.
 *
 * The action→class map is read the same way, from `STEP_REGISTRY` in `ScenarioRunner`, so an
 * action renamed in the registry renames here too.
 *
 * ── WHEN THE DERIVATION FINDS NOTHING ───────────────────────────────────────────────────
 *
 * It reports, as a file-level issue, that the instrument is broken. A scrape that matched
 * zero throws is indistinguishable from a corpus with no missing arguments if it stays quiet,
 * and quiet is the failure mode this check exists to end.
 */

interface Derivation {
  /** action name -> the argument names its step class requires. */
  required: ReadonlyMap<string, ReadonlySet<string>>;
  /** Non-empty when the derivation produced nothing believable. */
  broken: string | null;
}

/** `['fund_wallet', new FundWalletStep()]` in STEP_REGISTRY, source or compiled. */
const REGISTRY_ENTRY_RE = /\[\s*'([a-z_]+)'\s*,\s*new\s+(\w+)\s*\(\s*\)\s*\]/g;

/** `requires a "user_id" field` / `requires an "x" field`, in a throw at the top of execute(). */
const REQUIRED_ARG_RE = /requires an?\s+"([A-Za-z_][A-Za-z0-9_]*)"\s+field/g;

function readFirstThatExists(dir: string, basenames: readonly string[]): string | null {
  for (const name of basenames) {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      // Next candidate. A genuinely absent pair is reported by the caller as a
      // broken instrument rather than as an empty table.
    }
  }
  return null;
}

function derive(): Derivation {
  const scenariosDir = fileURLToPath(new URL('../../scenarios/', import.meta.url));
  const stepsDir = join(scenariosDir, 'steps');

  const runner = readFirstThatExists(scenariosDir, ['ScenarioRunner.js', 'ScenarioRunner.ts']);
  if (runner === null) {
    return { required: new Map(), broken: `could not read ScenarioRunner in ${scenariosDir}` };
  }

  const classToActions = new Map<string, string[]>();
  for (const m of runner.matchAll(REGISTRY_ENTRY_RE)) {
    const [, action, className] = m;
    const list = classToActions.get(className) ?? [];
    list.push(action);
    classToActions.set(className, list);
  }
  if (classToActions.size === 0) {
    return { required: new Map(), broken: 'STEP_REGISTRY produced no action→class pairs' };
  }

  let stepFiles: string[];
  try {
    stepFiles = readdirSync(stepsDir).filter(
      (f) => (f.endsWith('.js') || f.endsWith('.ts')) && !f.endsWith('.d.ts'),
    );
  } catch {
    return { required: new Map(), broken: `could not read the steps directory ${stepsDir}` };
  }

  const required = new Map<string, Set<string>>();
  let throwsSeen = 0;
  for (const file of stepFiles) {
    const className = file.replace(/\.(js|ts)$/, '');
    const actions = classToActions.get(className);
    if (!actions) continue;

    const body = readFileSync(join(stepsDir, file), 'utf8');
    const args = new Set<string>();
    for (const m of body.matchAll(REQUIRED_ARG_RE)) {
      args.add(m[1]);
      throwsSeen++;
    }
    if (args.size === 0) continue;
    for (const action of actions) required.set(action, args);
  }

  if (throwsSeen === 0) {
    return {
      required,
      broken: `scraped ${stepFiles.length} step file(s) in ${stepsDir} and found no required-argument throws`,
    };
  }

  return { required, broken: null };
}

export class RequiredStepArgsCheck implements LintCheck {
  name = 'required-step-args';

  private readonly derivation: Derivation = derive();

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];

    if (this.derivation.broken !== null) {
      return [{
        file: scenario.filePath,
        step: -1,
        stepAction: '',
        message:
          `INSTRUMENT BROKEN — required-step-args derived nothing believable: ` +
          `${this.derivation.broken}. Reporting red rather than passing: an empty table ` +
          `would make every scenario look complete.`,
      }];
    }

    scenario.steps.forEach((step, index) => {
      const action = typeof step.action === 'string' ? step.action : '';
      const required = this.derivation.required.get(action);
      if (!required) return;

      for (const arg of required) {
        const value = step[arg];
        const missing = value === undefined || value === null;
        const blank = typeof value === 'string' && value.trim() === '';
        if (!missing && !blank) continue;

        issues.push({
          file: scenario.filePath,
          step: index,
          stepAction: action,
          message:
            `\`${action}\` is missing its required "${arg}" field` +
            `${blank ? ' (present but empty)' : ''}. The step's own code throws on it before ` +
            `doing anything else, so this scenario cannot reach the step after this one.`,
        });
      }
    });

    return issues;
  }
}
