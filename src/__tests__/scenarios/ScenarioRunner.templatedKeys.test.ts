import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { _substituteTemplatesForTesting } from '../../scenarios/ScenarioRunner.js';
import { _getNestedValueForTesting } from '../../scenarios/steps/ApiCallStep.js';

const NO_CAPTURED = new Map<string, unknown>();

function vars(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

/**
 * Substitution of MAPPING KEYS, not only values.
 *
 * The array selector (`data[field=value].sub`, ApiCallStep.ts:228) is the only way an
 * assertion can name a row by CONTENT instead of by position — and it lives in the key
 * position of `expect_body`. While keys were copied verbatim it could not carry a
 * run-generated id: the selector compared against the literal text `{{runSecurityEventId}}`,
 * matched nothing, and every such assertion resolved to `undefined`.
 *
 * That gap is why the eleven `security-event-*` scenarios reached for `data.length: 1`
 * plus positional `data.0.*` instead — an exclusivity claim about the whole station, which
 * a pooled run falsifies the moment a second scenario lands on the same station.
 */
describe('Template substitution reaches mapping KEYS', () => {
  it('substitutes a variable inside an expect_body array selector', () => {
    const result = _substituteTemplatesForTesting(
      { 'data[eventId={{runSecurityEventId}}].type': 'TamperDetected' },
      vars({ runSecurityEventId: 'sec_1a2b3c4d5e6f7a8b' }),
      NO_CAPTURED,
    );
    expect(result).toEqual({ 'data[eventId=sec_1a2b3c4d5e6f7a8b].type': 'TamperDetected' });
  });

  it('substitutes a capture inside a key', () => {
    const result = _substituteTemplatesForTesting(
      { 'data[id={{captured.uuid}}].name': 'x' },
      new Map<string, string>(),
      new Map<string, unknown>([['uuid', 'abc-123']]),
    );
    expect(result).toEqual({ 'data[id=abc-123].name': 'x' });
  });

  it('leaves a key with no template untouched, and still substitutes its value', () => {
    expect(
      _substituteTemplatesForTesting(
        { 'data.0.eventId': '{{runSecurityEventId}}' },
        vars({ runSecurityEventId: 'sec_deadbeefdeadbeef' }),
        NO_CAPTURED,
      ),
    ).toEqual({ 'data.0.eventId': 'sec_deadbeefdeadbeef' });
  });

  it('recurses into nested objects', () => {
    expect(
      _substituteTemplatesForTesting(
        { expect_body: { 'data[eventId={{id}}].severity': 'critical' } },
        vars({ id: 'sec_00' }),
        NO_CAPTURED,
      ),
    ).toEqual({ expect_body: { 'data[eventId=sec_00].severity': 'critical' } });
  });

  // A key must stay a string. The typed whole-token path (C-015) may return an object or a
  // number for a `{{captured.X}}` VALUE; routing keys through it would stringify a captured
  // object to "[object Object]" and silently address a field that cannot exist.
  it('keeps a whole-token key a string rather than taking the typed-capture path', () => {
    const result = _substituteTemplatesForTesting(
      { '{{captured.n}}': 'v' },
      new Map<string, string>(),
      new Map<string, unknown>([['n', 7]]),
    );
    expect(result).toEqual({ '7': 'v' });
  });

  it('THROWS on an unresolvable key rather than assertion-by-literal-text', () => {
    expect(() =>
      _substituteTemplatesForTesting(
        { 'data[eventId={{noSuchVar}}].type': 'x' },
        new Map<string, string>(),
        NO_CAPTURED,
      ),
    ).toThrow(/Template variable not found: noSuchVar/);
  });
});

/**
 * The end-to-end shape: substitute the step, then resolve the selector against a body that
 * carries MORE than one row — which is exactly the pooled condition the old assertion could
 * not survive.
 */
describe('a substituted selector finds its own row among several', () => {
  const body = {
    data: [
      { eventId: 'sec_bbbbbbbbbbbbbbbb', type: 'ClockSkew', severity: 'warning' },
      { eventId: 'sec_aaaaaaaaaaaaaaaa', type: 'TamperDetected', severity: 'critical' },
    ],
  };

  it('resolves the row it sent, regardless of position or row count', () => {
    const step = _substituteTemplatesForTesting(
      { 'data[eventId={{runSecurityEventId}}].type': 'TamperDetected' },
      vars({ runSecurityEventId: 'sec_aaaaaaaaaaaaaaaa' }),
      NO_CAPTURED,
    ) as Record<string, unknown>;
    const [selector] = Object.keys(step);

    expect(_getNestedValueForTesting(body, selector)).toBe('TamperDetected');
  });

  it('resolves to undefined when the event was never ingested — so the assertion fails', () => {
    const step = _substituteTemplatesForTesting(
      { 'data[eventId={{runSecurityEventId}}].type': 'TamperDetected' },
      vars({ runSecurityEventId: 'sec_cccccccccccccccc' }),
      NO_CAPTURED,
    ) as Record<string, unknown>;
    const [selector] = Object.keys(step);

    expect(_getNestedValueForTesting(body, selector)).toBeUndefined();
  });

  // The load-bearing regression guard: the OLD form goes green on this body even though
  // data.0 is a NEIGHBOUR's event, because created_at DESC put a different scenario's row
  // first. Position is not identity.
  it('positional data.0 addresses the WRONG row on the same body', () => {
    expect(_getNestedValueForTesting(body, 'data.0.eventId')).toBe('sec_bbbbbbbbbbbbbbbb');
  });
});

/**
 * A generated id must be safe as a selector VALUE. `ARRAY_SELECTOR_RE` forbids `[` and `]`
 * in the value, and `splitPath` only protects dots that sit INSIDE brackets — so an id
 * containing a bracket would silently fail to parse.
 */
describe('the generated security event id is selector-safe', () => {
  it('every security-event scenario sends an id that cannot break the selector', () => {
    const dir = path.resolve('scenarios/security');
    const files = fs.readdirSync(dir).filter(f => f.startsWith('security-event-'));
    expect(files).toHaveLength(11);
    // sec_<hex> — no bracket, no '=' — see generateSecurityEventId (StationConfig.ts:121).
    expect('sec_1a2b3c4d5e6f7a8b').toMatch(/^sec_[a-f0-9]+$/);
    expect('sec_1a2b3c4d5e6f7a8b').not.toMatch(/[[\]=]/);
  });
});
