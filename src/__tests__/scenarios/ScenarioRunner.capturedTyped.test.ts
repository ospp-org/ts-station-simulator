import { describe, it, expect } from 'vitest';
import { _substituteTemplatesForTesting } from '../../scenarios/ScenarioRunner.js';

const NO_VARS = new Map<string, string>();

function captured(entries: Record<string, unknown>): Map<string, unknown> {
  return new Map<string, unknown>(Object.entries(entries));
}

/**
 * C-015: typed whole-value capture injection.
 *
 * When a field's entire value is a single `{{ captured.X }}` token, the captured
 * value is returned with its original type intact so a server-signed payload can
 * be forwarded verbatim (byte/type fidelity is required for the server's ECDSA
 * canonical-form re-verification). Embedded templates and non-capture tokens keep
 * the legacy string-interpolation behaviour.
 */
describe('Template substitution — typed whole-value captures (C-015)', () => {
  it('returns a captured object verbatim (type + structure preserved)', () => {
    const pass = {
      passId: 'opass_a1b2',
      policyVersion: 1,
      revocationEpoch: 0,
      offlineAllowance: { maxUses: 10, allowedServiceTypes: ['svc_wash_basic'] },
      signature: 'MEUCIQ...base64...==',
    };
    const result = _substituteTemplatesForTesting(
      '{{captured.offlinePass}}',
      NO_VARS,
      captured({ offlinePass: pass }),
    );
    expect(result).toEqual(pass);
  });

  it('preserves number type (not the string "1")', () => {
    expect(_substituteTemplatesForTesting('{{captured.n}}', NO_VARS, captured({ n: 1 }))).toBe(1);
  });

  it('preserves array type', () => {
    const arr = ['svc_wash_basic', 'svc_dry'];
    expect(_substituteTemplatesForTesting('{{captured.svc}}', NO_VARS, captured({ svc: arr }))).toEqual(arr);
  });

  it('preserves boolean and null', () => {
    expect(_substituteTemplatesForTesting('{{captured.b}}', NO_VARS, captured({ b: false }))).toBe(false);
    expect(_substituteTemplatesForTesting('{{captured.z}}', NO_VARS, captured({ z: null }))).toBeNull();
  });

  it('tolerates whitespace inside the token', () => {
    const obj = { a: 1 };
    expect(_substituteTemplatesForTesting('{{ captured.o }}', NO_VARS, captured({ o: obj }))).toEqual(obj);
  });

  it('string captures still return a string (no behaviour change)', () => {
    expect(
      _substituteTemplatesForTesting('{{captured.s}}', NO_VARS, captured({ s: 'opass_abc' })),
    ).toBe('opass_abc');
  });

  it('EMBEDDED capture is still string-coerced (legacy partial-template path)', () => {
    // object embedded in a larger string → String() → "[object Object]"
    expect(
      _substituteTemplatesForTesting('id-{{captured.o}}', NO_VARS, captured({ o: { a: 1 } })),
    ).toBe('id-[object Object]');
    // number embedded → string concatenation
    expect(_substituteTemplatesForTesting('n={{captured.n}}', NO_VARS, captured({ n: 1 }))).toBe('n=1');
  });

  it('two adjacent tokens are NOT treated as one typed value (string concat)', () => {
    expect(
      _substituteTemplatesForTesting('{{captured.a}}{{captured.b}}', NO_VARS, captured({ a: 'x', b: 'y' })),
    ).toBe('xy');
  });

  it('injects a typed object into a nested payload field while siblings stay literal', () => {
    const pass = { passId: 'opass_1', policyVersion: 2 };
    const result = _substituteTemplatesForTesting(
      { offlinePassId: '{{captured.pid}}', offlinePass: '{{captured.pass}}', counter: 1 },
      NO_VARS,
      captured({ pid: 'opass_1', pass }),
    );
    expect(result).toEqual({ offlinePassId: 'opass_1', offlinePass: pass, counter: 1 });
  });

  it('throws on a missing whole-value capture (same error as before)', () => {
    expect(() =>
      _substituteTemplatesForTesting('{{captured.missing}}', NO_VARS, new Map<string, unknown>()),
    ).toThrow(/Captured variable not found: missing/);
  });
});
