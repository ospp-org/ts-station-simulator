import { describe, it, expect } from 'vitest';
import { OsppErrorCode } from '@ospp/protocol';
import { ErrorCodeRegistryCheck } from '../../linter/checks/ErrorCodeRegistryCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

/*
 * WHAT WAS MEASURED BEFORE THIS CHECK EXISTED.
 *
 * Four scenarios, one per shape a code can be written in, each carrying a code that is not
 * in the registry (3911 / 3914 / 3918 / 3907) — all four linted GREEN against the seven
 * checks that were there. The harness itself was proved live in the same run: a fabricated
 * `bootReason` in a fifth file went red through `EnumValuesCheck` and `PayloadSchemaCheck`.
 * So the negative result was the linter's, not the harness's.
 *
 * The four shapes below are that experiment, kept.
 */

const check = new ErrorCodeRegistryCheck();

function makeScenario(steps: Record<string, unknown>[]): ParsedScenario {
  return { filePath: 'test.yaml', name: 'test', steps, declarations: {} };
}

describe('ErrorCodeRegistryCheck — the registry is the SDK, not a transcription', () => {
  it('derives the registry from the SDK, and it is not empty', () => {
    // ANTI-VACUITY. Every "0 issues" assertion below would also pass against an empty
    // registry ONLY if the check reddened on everything — but a check reading an empty
    // registry would redden on everything instead, so this pins the other direction: the
    // set is real, and it is the SDK's.
    const members = Object.values(OsppErrorCode).filter((v) => typeof v === 'number');
    expect(members.length).toBeGreaterThan(100);
    expect(OsppErrorCode.BAY_MAINTENANCE).toBe(3011);
  });

  it('THE ASSUMPTION UNDER THE VENDOR LITERALS — the SDK enumerates nothing in 9000-9999', () => {
    // The check exempts the vendor band with two written numbers, because the SDK documents
    // the band in a doc comment and exports no constant for it. This is what keeps that
    // transcription honest: the day the SDK enumerates a 9xxx code, the exemption stops
    // being a no-op and this goes red rather than silently excusing a real member.
    const inBand = Object.values(OsppErrorCode)
      .filter((v): v is number => typeof v === 'number')
      .filter((v) => v >= 9000 && v <= 9999);
    expect(inBand).toEqual([]);
  });

  // ── THE FOUR SHAPES, RED ───────────────────────────────────────────────────────────────

  it('send payload, flat `errorCode` — an unknown code is 1 issue', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'StopService', messageType: 'Response', payload: { status: 'Rejected', errorCode: 3907 } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3907');
    expect(issues[0].message).toContain('payload.errorCode');
  });

  it('api_call expect_body, flat `errorCode` — an unknown code is 1 issue', () => {
    const issues = check.check(makeScenario([
      { action: 'api_call', method: 'POST', url: '/x', expect_body: { errorCode: 3911 } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3911');
  });

  it('api_call expect_body, wrapped `error.ospp_code` — an unknown code is 1 issue', () => {
    // The wrapped spelling is a DOTTED KEY, not a nested object. A check that only walked
    // nested objects would see nothing here and would be indistinguishable from a corpus
    // that never uses the wrapped envelope — which 17 sites do.
    const issues = check.check(makeScenario([
      { action: 'api_call', method: 'POST', url: '/x', expect_body: { 'error.ospp_code': 3914 } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3914');
  });

  it('assert step, `field` + `equals` — an unknown code is 1 issue', () => {
    const issues = check.check(makeScenario([
      { action: 'assert', field: 'payload.errorCode', equals: 3918 },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3918');
  });

  it('a code nested deep inside a payload is still seen', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'ChangeConfiguration', messageType: 'Response', payload: { results: [{ key: 'k', errorCode: 3999 }] } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('payload.results[0].errorCode');
  });

  // ── THE SAME FOUR SHAPES, GREEN ────────────────────────────────────────────────────────

  it('every shape stays green on a REAL code', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'StopService', messageType: 'Response', payload: { status: 'Rejected', errorCode: OsppErrorCode.SESSION_NOT_FOUND } },
      { action: 'api_call', method: 'POST', url: '/x', expect_body: { errorCode: OsppErrorCode.BAY_MAINTENANCE } },
      { action: 'api_call', method: 'POST', url: '/x', expect_body: { 'error.ospp_code': OsppErrorCode.BAY_RESERVED } },
      { action: 'assert', field: 'payload.errorCode', equals: OsppErrorCode.TOPOLOGY_MISMATCH },
      { action: 'provision', expect_body: { errorCode: OsppErrorCode.BAY_NOT_FOUND } },
    ]));
    expect(issues).toEqual([]);
  });

  it('a vendor-band code is accepted — 9000-9999 is reserved and deliberately not enumerated', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'StopService', messageType: 'Response', payload: { errorCode: 9001 } },
    ]));
    expect(issues).toEqual([]);
  });

  // ── WHAT IS NOT A CLAIM ABOUT A CODE ───────────────────────────────────────────────────

  it('a capture map naming a JSON path is not a code, and is not walked', () => {
    // `capture: {ospp_code: "error.ospp_code"}` — the one non-numeric site in the corpus's
    // 67. Reading it as a code would red a file that asserts nothing.
    const issues = check.check(makeScenario([
      { action: 'api_call', method: 'GET', url: '/x', capture: { ospp_code: 'error.ospp_code' } },
    ]));
    expect(issues).toEqual([]);
  });

  it('a templated code is left to run time, not guessed', () => {
    const issues = check.check(makeScenario([
      { action: 'api_call', method: 'GET', url: '/x', expect_body: { errorCode: '{{expectedCode}}' } },
    ]));
    expect(issues).toEqual([]);
  });

  it('`expect_invalid` opts a send OUT — the same opt-out PayloadSchemaCheck grants', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'StopService', messageType: 'Response', expect_invalid: true, payload: { errorCode: 3907 } },
    ]));
    expect(issues).toEqual([]);
  });

  it('the opt-out is per-step, not per-file', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'StopService', messageType: 'Response', expect_invalid: true, payload: { errorCode: 3907 } },
      { action: 'send', message: 'StopService', messageType: 'Response', payload: { errorCode: 3907 } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(1);
  });

  // ── THE MESSAGE HAS TO BE USABLE ───────────────────────────────────────────────────────

  it('names the nearest defined codes, so a transposed digit reads as one', () => {
    const issues = check.check(makeScenario([
      { action: 'api_call', method: 'POST', url: '/x', expect_body: { errorCode: 3911 } },
    ]));
    expect(issues[0].message).toMatch(/Nearest defined:.*3011 BAY_MAINTENANCE/);
  });

  it('carries the file, so the red line names it', () => {
    const issues = check.check(makeScenario([
      { action: 'assert', field: 'payload.errorCode', equals: 3918 },
    ]));
    expect(issues[0].file).toBe('test.yaml');
    expect(issues[0].stepAction).toBe('assert');
  });
});
