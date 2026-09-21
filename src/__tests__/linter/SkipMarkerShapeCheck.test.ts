import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SkipMarkerShapeCheck } from '../../linter/checks/SkipMarkerShapeCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const scenario = (declarations: Record<string, unknown>): ParsedScenario => ({
  filePath: 'scenarios/test.yaml',
  name: 'test',
  steps: [],
  declarations,
});

/**
 * A `skip:` carrying prose is truthy, so the scenario IS skipped and nothing looks wrong —
 * while the reason is dropped on the floor and the skip-age report, which matches
 * `/^skip:\s*true\s*$/m`, cannot see the gate at all.
 */
describe('SkipMarkerShapeCheck', () => {
  const check = new SkipMarkerShapeCheck();

  it('flags prose written into skip:', () => {
    const issues = check.check(scenario({
      skip: 'The local stack cannot provision: 6 pending migrations, the first of which refuses.',
    }));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(-1);
    expect(issues[0].message).toMatch(/declared `boolean`.*but this file gives a string/s);
    expect(issues[0].message).toMatch(/invisible to the skip-age report/);
  });

  it('flags a skip_kind outside the declared union', () => {
    const issues = check.check(scenario({ skip: true, skip_kind: 'environment' }));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/not a member of SkipKind/);
    expect(issues[0].message).toMatch(/not-applicable/);
    expect(issues[0].message).toMatch(/inconclusive/);
  });

  it('reports both when both are wrong — the shape the corpus actually had', () => {
    const issues = check.check(scenario({ skip: 'prose', skip_kind: 'environment' }));
    expect(issues).toHaveLength(2);
  });

  it('accepts the correct shape', () => {
    const issues = check.check(scenario({
      skip: true,
      skip_reason: 'why, measured',
      skip_kind: 'inconclusive',
    }));
    expect(issues).toEqual([]);
  });

  it('accepts a file with no skip at all', () => {
    expect(check.check(scenario({ name: 'x' }))).toEqual([]);
  });

  it('accepts skip: false', () => {
    expect(check.check(scenario({ skip: false }))).toEqual([]);
  });

  /**
   * THE ASSUMPTION UNDER THE DERIVATION. The check reads `skip?:`'s declared type and the
   * `SkipKind` union out of ScenarioRunner. If either declaration is reworded past the
   * regexes, the check reports a broken instrument — but only at lint time, on every file.
   * This asserts the derivation works against the tree as it stands, so a rewording is
   * caught here first.
   */
  it('derives boolean and the two kinds from ScenarioRunner itself', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../scenarios/ScenarioRunner.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/^\s*skip\?\s*:\s*boolean\s*;/m);
    expect(src).toMatch(/export\s+type\s+SkipKind\s*=\s*'not-applicable'\s*\|\s*'inconclusive';/);

    // And the check is reading that, not a copy: a wrong kind must be named against the
    // union the source declares.
    const issues = check.check(scenario({ skip_kind: 'environment' }));
    expect(issues[0].message).toContain('`not-applicable` | `inconclusive`');
  });

  /**
   * The third failure this check covers is that `skipAge.ts` could not see the gate. Pin the
   * matcher it uses, so the claim in the check's message stays true.
   */
  it('pins the skipAge matcher the message cites', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../scenarios/skipAge.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain("/^skip:\\s*true\\s*$/m");

    // A `skip: >-` block does not match it — which is the whole point.
    const matcher = /^skip:\s*true\s*$/m;
    expect(matcher.test('skip: true\n')).toBe(true);
    expect(matcher.test('skip: >-\n  prose here\n')).toBe(false);
  });
});
