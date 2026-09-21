import type { LintCheck, LintIssue, ParsedScenario } from '../types.js';

/**
 * A SECOND `connect_mqtt` ON A LIVE CONNECTION THROWS, AND NOTHING SAW IT.
 *
 * `ConnectMqttStep` ends by calling `station.setTls(...)` (`ConnectMqttStep.ts:140`), and
 * `MqttConnection.setTls` refuses outright while a client exists:
 *
 *     if (this.client !== null) {
 *       throw new Error('MqttConnection.setTls: cannot change TLS after connect(); disconnect first');
 *     }
 *
 * — `MqttConnection.ts:396-400`. So a scenario that connects twice does not reconnect; it
 * dies on the second step, at the step BEFORE the one it was setting up. There is no
 * `disconnect` action in the step registry, so a file cannot simply ask for the teardown.
 *
 * Measured on this corpus before the check existed: FIVE of the 158 scenarios call
 * `connect_mqtt`, all five declare `defer_mqtt_connect: true`, and exactly ONE —
 * `sessions/start-refused-binding-uncovered.yaml` — calls it twice. That file lints clean,
 * has never run, and could not have run. A single unexercised shape is exactly the case a
 * linter is for: nothing else in the corpus would have discovered it.
 *
 * ── WHAT COUNTS AS THE FIRST CONNECT ────────────────────────────────────────────────────
 *
 * Not always a step. `ScenarioRunner.ts:2117` reads `if (!scenario.defer_mqtt_connect)` and
 * connects the station itself before the first step runs. So in a file that does NOT defer,
 * the connection is ALREADY up when step 0 begins and the first `connect_mqtt` step in it is
 * the second connect. Counting only the steps would have made that file invisible — the
 * whole class here is "a connect while one is live", and the runner owns one of the connects.
 *
 * ── WHAT PUTS THE CONNECTION BACK DOWN ──────────────────────────────────────────────────
 *
 * `MqttConnection` nulls `this.client` in exactly two places, `severConnection()` at :751 and
 * the `finalize()` inside `disconnect()` at :798. Reached from a scenario, those are two
 * `fault` kinds and no others — `FaultStep.ts:29-30` maps `sever` to `severConnection()` and
 * `:50-51` maps `planned_shutdown` to `disconnect({ announceDeparture: true })`. The third
 * teardown, `fault: disconnect`, calls `destroyConnection()` and deliberately leaves the
 * client in place to auto-reconnect, so it does NOT clear the way for a `connect_mqtt`.
 *
 * Those two kinds are the one thing here that is a literal rather than a derivation: a
 * `case` label inside a `switch` is not machine-readable from the compiled step the way a
 * registry or a `.d.ts` is. `ConnectLifecycleCheck.test.ts` pins the assumption underneath
 * them by sweeping `FaultStep.ts` itself, so the day a third kind starts nulling the client
 * the test goes red instead of this check going quietly incomplete — the same arrangement
 * `ErrorCodeRegistryCheck` uses for the vendor band and `sshIdentitiesOnly.test.ts` for the
 * ssh call sites.
 */

/**
 * The `fault` kinds that null `MqttConnection.client`, and therefore the only steps after
 * which a further `connect_mqtt` is legal. Pinned by ConnectLifecycleCheck.test.ts against
 * FaultStep.ts — see the note above.
 */
const CONNECTION_CLEARING_FAULTS: ReadonlySet<string> = new Set([
  'sever',
  'planned_shutdown',
]);

export class ConnectLifecycleCheck implements LintCheck {
  name = 'connect-lifecycle';

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];

    // The runner connects for us unless the file defers — see ScenarioRunner.ts:2117.
    let connected = (scenario.declarations ?? {}).defer_mqtt_connect !== true;
    let openedAt: number | null = null;

    scenario.steps.forEach((step, index) => {
      if (step.action === 'fault') {
        if (typeof step.type === 'string' && CONNECTION_CLEARING_FAULTS.has(step.type)) {
          connected = false;
          openedAt = null;
        }
        return;
      }

      if (step.action !== 'connect_mqtt') return;

      if (!connected) {
        connected = true;
        openedAt = index;
        return;
      }

      const opener =
        openedAt === null
          ? "the runner's own pre-step connect (this file does not set `defer_mqtt_connect: true`)"
          : `the connect_mqtt at step ${openedAt}`;

      issues.push({
        file: scenario.filePath,
        step: index,
        stepAction: 'connect_mqtt',
        message:
          `connect_mqtt while a connection is already live — opened by ${opener}, and no ` +
          `step between the two nulls the client. ConnectMqttStep calls station.setTls(), ` +
          `and MqttConnection.setTls throws "cannot change TLS after connect(); disconnect ` +
          `first" whenever a client exists, so this step cannot run. There is no ` +
          `\`disconnect\` action: put a \`fault\` of kind ` +
          `${[...CONNECTION_CLEARING_FAULTS].map((k) => `\`${k}\``).join(' or ')} before it ` +
          `(those are the only two that null the client), or drop this connect.`,
      });

      openedAt = index;
    });

    return issues;
  }
}
