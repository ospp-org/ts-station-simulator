import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConnectLifecycleCheck } from '../../linter/checks/ConnectLifecycleCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const scenario = (
  steps: Record<string, unknown>[],
  declarations: Record<string, unknown> = { defer_mqtt_connect: true },
): ParsedScenario => ({
  filePath: 'scenarios/test.yaml',
  name: 'test',
  steps,
  declarations,
});

/**
 * The check exists because `MqttConnection.setTls` throws while a client exists, and
 * `ConnectMqttStep` calls it on every connect. A file that connects twice therefore dies at
 * the second one — and one file in the corpus did exactly that, lint-clean, for as long as
 * it existed.
 */
describe('ConnectLifecycleCheck', () => {
  const check = new ConnectLifecycleCheck();

  it('flags a second connect_mqtt with nothing between it and the first', () => {
    const issues = check.check(scenario([
      { action: 'connect_mqtt' },
      { action: 'send', message: 'BootNotification' },
      { action: 'connect_mqtt' },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(2);
    expect(issues[0].stepAction).toBe('connect_mqtt');
    expect(issues[0].message).toMatch(/the connect_mqtt at step 0/);
  });

  it('accepts a second connect_mqtt after fault: sever', () => {
    const issues = check.check(scenario([
      { action: 'connect_mqtt' },
      { action: 'fault', type: 'sever' },
      { action: 'connect_mqtt' },
    ]));
    expect(issues).toEqual([]);
  });

  it('accepts a second connect_mqtt after fault: planned_shutdown', () => {
    const issues = check.check(scenario([
      { action: 'connect_mqtt' },
      { action: 'fault', type: 'planned_shutdown' },
      { action: 'connect_mqtt' },
    ]));
    expect(issues).toEqual([]);
  });

  it('does NOT accept fault: disconnect as clearing the way — it leaves the client in place', () => {
    const issues = check.check(scenario([
      { action: 'connect_mqtt' },
      { action: 'fault', type: 'disconnect' },
      { action: 'connect_mqtt' },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(2);
  });

  it('counts the runner\'s own pre-step connect when the file does not defer', () => {
    const issues = check.check(scenario([{ action: 'connect_mqtt' }], {}));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(0);
    expect(issues[0].message).toMatch(/runner's own pre-step connect/);
  });

  it('leaves a single deferred connect alone — the shape four corpus files use', () => {
    const issues = check.check(scenario([
      { action: 'provision' },
      { action: 'connect_mqtt' },
      { action: 'send', message: 'BootNotification' },
    ]));
    expect(issues).toEqual([]);
  });

  /**
   * THE ASSUMPTION UNDER THE TWO LITERALS.
   *
   * `CONNECTION_CLEARING_FAULTS` is the one thing the check does not derive — a `case` label
   * inside a `switch` is not readable from the compiled step the way a registry is. This
   * sweep reads `FaultStep.ts` itself and asserts the mapping the check assumes, so a third
   * kind that starts nulling the client turns this red instead of leaving the check quietly
   * incomplete. Same arrangement as `sshIdentitiesOnly.test.ts`'s source sweep.
   */
  it('pins the fault→teardown mapping against FaultStep.ts', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../scenarios/steps/FaultStep.ts', import.meta.url)),
      'utf8',
    );

    // The sweep must find the switch at all, or it proves nothing.
    const cases = [...src.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases).toContain('sever');
    expect(cases).toContain('planned_shutdown');
    expect(cases).toContain('disconnect');

    // `sever` -> severConnection(), which nulls the client (MqttConnection.ts:751).
    expect(src).toMatch(/case 'sever':\s*\n\s*station\.severConnection\(\);/);

    // `planned_shutdown` -> disconnect(), whose finalize() nulls the client (:798).
    expect(src).toMatch(/case 'planned_shutdown':\s*\n\s*await station\.disconnect\(/);

    // `disconnect` -> destroyConnection(), which deliberately does NOT null it.
    expect(src).toMatch(/case 'disconnect':\s*\n\s*station\.destroyConnection\(\);/);

    // And no OTHER case reaches a nulling teardown. If one does, the check's set is short.
    const nulling = cases.filter((kind) => {
      const arm = src.match(new RegExp(`case '${kind}':([\\s\\S]*?)break;`));
      if (!arm) return false;
      return /severConnection\(\)|\.disconnect\(/.test(arm[1]);
    });
    expect(new Set(nulling)).toEqual(new Set(['sever', 'planned_shutdown']));
  });
});
