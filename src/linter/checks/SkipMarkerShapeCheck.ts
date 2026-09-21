import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { LintCheck, LintIssue, ParsedScenario } from '../types.js';

/**
 * A SKIP MARKER THAT DOES NOT MATCH THE TYPE IT IS DECLARED AS.
 *
 * `skip` is `boolean` and the prose belongs in its sibling `skip_reason`
 * (`ScenarioRunner.ts:162-163`). `sessions/start-refused-binding-uncovered.yaml` wrote five
 * lines of measured prose INTO `skip:` and declared no `skip_reason` at all, and added
 * `skip_kind: environment`, which is not a member of `SkipKind`
 * (`ScenarioRunner.ts:542` — `'not-applicable' | 'inconclusive'`).
 *
 * Nothing was red, and three separate things went wrong quietly:
 *
 *   1. YAML hands the runner a non-empty string, which is truthy, so the scenario IS
 *      skipped — the file behaves as intended and the malformation is invisible from the
 *      outcome.
 *   2. The reason is LOST. `ScenarioRunner.ts:1909` reports `scenario.skip_reason ?? 'marked
 *      as skip'`, and `skip_reason` is absent, so a run prints "marked as skip" and the
 *      measurement that justified the skip never reaches the reader.
 *   3. The skip-age report cannot see the file. `skipAge.ts:171` recognises an
 *      unconditional skip by `/^skip:\s*true\s*$/m` and takes prose from the four
 *      `SKIP_KEYS` (`skipAge.ts:130`), of which `skip` is not one. A `skip: >-` block
 *      matches neither, so the longest-standing gate in the corpus was also the one gate
 *      the instrument that ages gates could not count.
 *
 * The third is why this check is worth more than tidiness. A skip is a claim that something
 * cannot run; the age report exists to keep those claims from outliving their reason. A skip
 * written this way opts out of that entirely, and opts out silently.
 *
 * ── DERIVED, NOT TRANSCRIBED ────────────────────────────────────────────────────────────
 *
 * Both the declared type of `skip` and the members of `SkipKind` are read out of
 * `ScenarioRunner`'s own declarations at construction — `.d.ts` beside the compiled runner,
 * or the `.ts` source under vitest, whichever is present. The union is not copied here, so
 * adding a third `SkipKind` member makes it legal in scenarios on the same commit that adds
 * it, with nothing to remember. A derivation that comes back empty is reported as a broken
 * instrument rather than as a clean corpus.
 */

interface Derivation {
  /** The declared TypeScript type of the `skip` key, e.g. `boolean`. */
  skipType: string | null;
  /** The members of the `SkipKind` union. */
  skipKinds: ReadonlySet<string>;
  broken: string | null;
}

/** `skip?: boolean;` inside ScenarioDefinition. */
const SKIP_TYPE_RE = /^\s*skip\?\s*:\s*([A-Za-z]+)\s*;/m;

/** `export type SkipKind = 'not-applicable' | 'inconclusive';` */
const SKIP_KIND_RE = /export\s+(?:declare\s+)?type\s+SkipKind\s*=\s*([^;]+);/;

function derive(): Derivation {
  const scenariosDir = fileURLToPath(new URL('../../scenarios/', import.meta.url));

  let text: string | null = null;
  let from = '';
  for (const name of ['ScenarioRunner.d.ts', 'ScenarioRunner.ts']) {
    try {
      text = readFileSync(join(scenariosDir, name), 'utf8');
      from = name;
      break;
    } catch {
      // Next candidate.
    }
  }
  if (text === null) {
    return {
      skipType: null,
      skipKinds: new Set(),
      broken: `could not read ScenarioRunner declarations in ${scenariosDir}`,
    };
  }

  const typeHit = text.match(SKIP_TYPE_RE);
  const kindHit = text.match(SKIP_KIND_RE);

  if (!typeHit) {
    return { skipType: null, skipKinds: new Set(), broken: `no \`skip?:\` declaration in ${from}` };
  }
  if (!kindHit) {
    return { skipType: typeHit[1], skipKinds: new Set(), broken: `no \`SkipKind\` union in ${from}` };
  }

  const members = new Set(
    [...kindHit[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
  );
  if (members.size === 0) {
    return {
      skipType: typeHit[1],
      skipKinds: members,
      broken: `the SkipKind union in ${from} parsed to no members`,
    };
  }

  return { skipType: typeHit[1], skipKinds: members, broken: null };
}

/** The YAML scalar kinds this check can name, mapped onto TypeScript's spelling. */
function typeOfValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export class SkipMarkerShapeCheck implements LintCheck {
  name = 'skip-marker-shape';

  private readonly derivation: Derivation = derive();

  check(scenario: ParsedScenario): LintIssue[] {
    const { skipType, skipKinds, broken } = this.derivation;

    if (broken !== null) {
      return [{
        file: scenario.filePath,
        step: -1,
        stepAction: '',
        message:
          `INSTRUMENT BROKEN — skip-marker-shape derived nothing believable: ${broken}. ` +
          `Reporting red rather than passing: a check that cannot read the declaration ` +
          `would accept every shape.`,
      }];
    }

    const issues: LintIssue[] = [];
    const { skip, skip_kind: skipKind } = scenario.declarations ?? {};

    if (skip !== undefined && typeOfValue(skip) !== skipType) {
      const actual = typeOfValue(skip);
      const preview =
        typeof skip === 'string'
          ? ` — it holds ${skip.trim().length} characters of prose, beginning "${skip.trim().slice(0, 48)}…"`
          : '';
      issues.push({
        file: scenario.filePath,
        step: -1,
        stepAction: '',
        message:
          `\`skip:\` is declared \`${skipType}\` (ScenarioRunner's ScenarioDefinition) but this ` +
          `file gives a ${actual}${preview}. A non-empty string is truthy, so the scenario IS ` +
          `skipped and nothing looks wrong — but the reason is dropped (the runner reports ` +
          `\`skip_reason\`, which is where prose belongs), and skipAge.ts matches ` +
          `\`/^skip:\\s*true\\s*$/m\`, so this gate is invisible to the skip-age report. Write ` +
          `\`skip: true\` with the prose in \`skip_reason:\`.`,
      });
    }

    if (skipKind !== undefined && (typeof skipKind !== 'string' || !skipKinds.has(skipKind))) {
      issues.push({
        file: scenario.filePath,
        step: -1,
        stepAction: '',
        message:
          `\`skip_kind: ${JSON.stringify(skipKind)}\` is not a member of SkipKind. The ` +
          `declared union is ${[...skipKinds].map((k) => `\`${k}\``).join(' | ')}, read from ` +
          `ScenarioRunner. An unknown kind is not rejected at runtime — it is carried into ` +
          `the result and reported as though it meant something.`,
      });
    }

    return issues;
  }
}
