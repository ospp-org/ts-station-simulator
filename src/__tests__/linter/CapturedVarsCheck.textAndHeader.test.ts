import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CapturedVarsCheck, CAPTURE_MAP_KEYS } from '../../linter/checks/CapturedVarsCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new CapturedVarsCheck();

const scenario = (steps: ParsedScenario['steps']): ParsedScenario => ({
  filePath: 'test.yaml',
  name: 'test',
  steps,
});

/**
 * `capture_text` and `capture_header` write into the SAME `{{captured.*}}` namespace as
 * `capture`, so this check had to learn them or it would have flagged every reference to
 * a CSRF token as "never captured" — which would have made the webpay chain unlintable
 * and, worse, taught the next reader that the lint error was noise.
 *
 * The direction that matters more is the second one: the check must still FLAG a name
 * nothing captures. A check widened until it accepts everything is not a check, and
 * "capture* is fine" would have been exactly that.
 */
describe('CapturedVarsCheck — the two non-JSON capture forms', () => {
  it('accepts a var captured by capture_text', () => {
    expect(check.check(scenario([
      { action: 'api_call', method: 'GET', url: '/w/{{slug}}', capture_text: { csrf: 'value="([^"]+)"' } },
      { action: 'api_call', method: 'POST', url: '/w/{{slug}}/process', body: { _token: '{{captured.csrf}}' } },
    ]))).toHaveLength(0);
  });

  it('accepts a var captured by capture_header', () => {
    expect(check.check(scenario([
      { action: 'api_call', method: 'POST', url: '/w/x/process', capture_header: { payUrl: 'location' } },
      { action: 'assert', field: 'x', equals: '{{captured.payUrl}}' },
    ]))).toHaveLength(0);
  });

  // The control. Widening the check must not have blanked it.
  it('still FLAGS a name no capture form declares', () => {
    const issues = check.check(scenario([
      { action: 'api_call', method: 'GET', url: '/w/x', capture_text: { csrf: 'value="([^"]+)"' } },
      { action: 'api_call', method: 'POST', url: '/w/x/process', body: { _token: '{{captured.csrfToken}}' } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('captured.csrfToken');
  });

  it('still FLAGS a capture_text var referenced BEFORE the step that captures it', () => {
    expect(check.check(scenario([
      { action: 'api_call', method: 'POST', url: '/w/x/process', body: { _token: '{{captured.csrf}}' } },
      { action: 'api_call', method: 'GET', url: '/w/x', capture_text: { csrf: 'value="([^"]+)"' } },
    ]))).toHaveLength(1);
  });

  /**
   * THE GATE. A future capture form added to ApiCallStep and NOT added here would make
   * every scenario using it fail lint for a reason that is not the scenario's fault —
   * and the natural response to that is to weaken the check. Reading the step's source
   * for `context.captured.set(` sites and comparing the key set means the omission is
   * reported HERE, at the check that would have to change, instead of at a red file.
   */
  it('knows every capture map ApiCallStep writes into context.captured', () => {
    const src = readFileSync(
      new URL('../../scenarios/steps/ApiCallStep.ts', import.meta.url),
      'utf8',
    );
    // Each capture form iterates `Object.entries(spec as …)` / `definition.capture` and
    // ends in `context.captured.set(varName, …)`. The declaration sites are the guards
    // that name the key in their own error message, which is what this reads.
    const declared = new Set(
      [...src.matchAll(/definition\.(capture(?:_[a-z]+)?) !== undefined/g)].map((m) => m[1]),
    );
    declared.add('capture'); // read via `definition.capture &&`, not a `!== undefined` guard
    expect([...declared].sort()).toEqual([...CAPTURE_MAP_KEYS].sort());
  });
});
