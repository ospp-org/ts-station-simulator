import { describe, it, expect } from 'vitest';
import { PayloadSchemaCheck } from '../../linter/checks/PayloadSchemaCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new PayloadSchemaCheck();

// AuthorizeOfflinePass Request → schema "authorize-offline-pass-request", whose
// `offlinePass` field MUST be an object. We vary only that field to exercise the
// C-015 whole-value-capture handling.
function authStep(offlinePassValue: unknown): Record<string, unknown> {
  return {
    action: 'send',
    message: 'AuthorizeOfflinePass',
    messageType: 'Request',
    payload: {
      offlinePassId: 'opass_a000000001',
      offlinePass: offlinePassValue,
      deviceId: 'dev_test001',
      counter: 1,
      bayId: 'bay_a1b2c3d4e5f6',
      serviceId: 'svc_wash_basic',
    },
  };
}

function offlinePassTypeErrors(offlinePassValue: unknown): string[] {
  const scenario: ParsedScenario = {
    filePath: 'test.yaml',
    name: 'test',
    steps: [authStep(offlinePassValue)],
  };
  return check
    .check(scenario)
    .map((i) => i.message)
    .filter((m) => m.includes('/offlinePass') && m.includes('must be object'));
}

describe('PayloadSchemaCheck — typed whole-value captures (C-015)', () => {
  it('does NOT flag a whole-value {{captured.X}} on an object-typed field', () => {
    // The signed pass is captured from the issuance API and injected verbatim;
    // its static type is unknown, so the linter must not demand "must be object".
    expect(offlinePassTypeErrors('{{captured.offlinePass}}')).toHaveLength(0);
  });

  it('tolerates whitespace in the whole-value capture token', () => {
    expect(offlinePassTypeErrors('{{ captured.offlinePass }}')).toHaveLength(0);
  });

  it('STILL flags an embedded (non-whole-value) template on an object field', () => {
    // "pass-{{captured.x}}" resolves to a string at runtime → genuinely wrong type.
    expect(offlinePassTypeErrors('pass-{{captured.offlinePass}}').length).toBeGreaterThan(0);
  });

  it('STILL flags a literal non-object on an object field', () => {
    expect(offlinePassTypeErrors('not-an-object').length).toBeGreaterThan(0);
  });
});
