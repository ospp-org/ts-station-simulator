import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { RequiredStepArgsCheck } from '../../linter/checks/RequiredStepArgsCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const scenario = (steps: Record<string, unknown>[]): ParsedScenario => ({
  filePath: 'scenarios/test.yaml',
  name: 'test',
  steps,
  declarations: {},
});

/**
 * Required arguments are declared NOWHERE a linter can read as a contract — `StepDefinition`
 * is `{ action: string; [key: string]: unknown }`, so every argument is optional to the type
 * system. They exist only as unconditional throws at the top of each `execute()`. This check
 * scrapes those throws, so the table is the writer rather than a copy of it.
 */
describe('RequiredStepArgsCheck', () => {
  const check = new RequiredStepArgsCheck();

  it('flags fund_wallet declared without user_id — the measured instance', () => {
    const issues = check.check(scenario([
      { action: 'fund_wallet', credits: 500 },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(0);
    expect(issues[0].stepAction).toBe('fund_wallet');
    expect(issues[0].message).toMatch(/missing its required "user_id" field/);
  });

  it('accepts fund_wallet once user_id is named', () => {
    const issues = check.check(scenario([
      { action: 'fund_wallet', user_id: '{{captured.user_id}}', credits: 500 },
    ]));
    expect(issues).toEqual([]);
  });

  it('treats an empty string as missing — the step guards on trim() too', () => {
    const issues = check.check(scenario([
      { action: 'fund_wallet', user_id: '   ' },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/present but empty/);
  });

  it('covers the other five steps that declare a requirement', () => {
    const issues = check.check(scenario([
      { action: 'api_call', method: 'GET' },
      { action: 'send' },
      { action: 'wait_for' },
      { action: 'assert', equals: 1 },
      { action: 'fault' },
    ]));
    expect(issues.map((i) => [i.stepAction, i.message.match(/"([a-z_]+)"/)?.[1]])).toEqual([
      ['api_call', 'url'],
      ['send', 'message'],
      ['wait_for', 'message'],
      ['assert', 'field'],
      ['fault', 'type'],
    ]);
  });

  it('leaves steps that declare no requirement alone', () => {
    const issues = check.check(scenario([
      { action: 'delay', ms: 100 },
      { action: 'provision', station_id: 'stn_1' },
      { action: 'connect_mqtt' },
      { action: 'start_heartbeat' },
    ]));
    expect(issues).toEqual([]);
  });

  /**
   * THE ASSUMPTION UNDER THE SCRAPE: every `requires a "x" field` throw is UNCONDITIONAL and
   * sits at the top of `execute()`. If one becomes conditional, "declared" and "always fatal"
   * stop being the same statement and the check would flag files that are in fact fine.
   *
   * Sweeps the step sources rather than trusting the count, and asserts it found enough to be
   * a real sweep — a regex that silently matched nothing would make this test vacuous.
   */
  it('pins that every required-argument throw is unconditional', () => {
    const stepsDir = fileURLToPath(new URL('../../scenarios/steps/', import.meta.url));
    const files = readdirSync(stepsDir).filter((f) => f.endsWith('.ts'));

    const found: string[] = [];
    for (const file of files) {
      const src = readFileSync(join(stepsDir, file), 'utf8');
      for (const m of src.matchAll(/requires an?\s+"([A-Za-z_][A-Za-z0-9_]*)"\s+field/g)) {
        found.push(`${file}:${m[1]}`);

        // The throw's guard is the statement immediately before it. Both shapes in the tree
        // are a bare falsiness/emptiness test on `definition.<arg>` — no `&&` against some
        // other field, no enclosing `if` on a sibling key.
        const before = src.slice(0, m.index);
        const guard = before.slice(before.lastIndexOf('if ('));
        expect(guard, `${file} guard for ${m[1]}`).toMatch(
          /if \((?:!\w+|typeof \w+ !== 'string' \|\| \w+\.trim\(\) === '')\) \{/,
        );
      }
    }

    // A sweep that found nothing proves nothing.
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(found).toContain('FundWalletStep.ts:user_id');
  });
});
