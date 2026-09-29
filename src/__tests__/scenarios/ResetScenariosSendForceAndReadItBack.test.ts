import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/**
 * CW120 — A RESET SCENARIO SENDS THE ONE CHOICE OSPP OFFERS, AND READS BACK WHAT IT DID.
 *
 * reset-request.schema.json has exactly one member, `force`, and `additionalProperties: false`:
 * there is one reset operation, a reboot, and Hard/Soft are not in the protocol. csms-server's
 * reset doors validate `force` alone - StationManagementController::resetStation and
 * DashboardStationController::reset through ResetStationRequest, TriggerCommandController::
 * dispatchReset through its own validator - and build the command from what they validated, so
 * any other key is dropped. hard-reset.yaml sent `type: "Hard"` and soft-reset.yaml
 * `type: "Soft"`, so both drove the same unforced reset.
 *
 * What an accepted Reset leaves is readable. ResetResponseHandler::handle writes a
 * `station_reset` row to the station journal whose details carry the Reset's messageId and the
 * `forced` its pending command was registered with (GET /api/v1/admin/stations/{stationId}/
 * journal, newest first), then dispatches StationReset. The event's listener,
 * SettleSessionsOnForcedReset, returns on an unforced reset; on a forced one it runs
 * StopAllStationSessionsAction, whose StopSessionAction moves each active session to `stopping`
 * and then publishes a StopService naming it.
 *
 * So, over the parsed YAML:
 *   - every reset the corpus commands sends no key but `force`;
 *   - hard-reset commands the forced reset and soft-reset the unforced one, each saying so;
 *   - the three files that answer their Reset to prove the round trip read back the
 *     station_reset row of THAT Reset (by its messageId) with the force they sent;
 *   - the forced reset, with a session running, waits for the listener's StopService, checks it
 *     names that session and reads `stopping`, all before the station's own SessionEnded.
 */

const SCENARIOS_DIR = fileURLToPath(new URL('../../../scenarios', import.meta.url));
const DEVICE_MANAGEMENT = join(SCENARIOS_DIR, 'device-management');

type Step = Record<string, unknown>;

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...yamlFiles(full));
    else if (entry.endsWith('.yaml')) out.push(full);
  }
  return out.sort();
}

function stepsOf(file: string): Step[] {
  const doc = YAML.parse(readFileSync(file, 'utf8')) as { steps?: unknown } | null;
  return Array.isArray(doc?.steps) ? (doc.steps as Step[]) : [];
}

const ADMIN_RESET_URL = /\/api\/v1\/admin\/stations\/[^/]+\/reset$/;
const TRIGGER_COMMAND_URL = /\/api\/v1\/testing\/trigger-command\/[^/]+$/;

interface ResetCall {
  file: string;
  index: number;
  /** The object the Reset validator receives: the admin route's body, the trigger route's payload. */
  sent: Record<string, unknown>;
}

function resetCalls(file: string, steps: Step[]): ResetCall[] {
  const calls: ResetCall[] = [];
  steps.forEach((step, index) => {
    if (step.action !== 'api_call' || step.method !== 'POST' || typeof step.url !== 'string') return;
    const body = (step.body ?? {}) as Record<string, unknown>;
    if (ADMIN_RESET_URL.test(step.url)) {
      calls.push({ file, index, sent: body });
    } else if (TRIGGER_COMMAND_URL.test(step.url) && body.command === 'Reset') {
      calls.push({ file, index, sent: (body.payload ?? {}) as Record<string, unknown> });
    }
  });
  return calls;
}

function indexFrom(steps: Step[], from: number, match: (step: Step) => boolean): number {
  for (let i = Math.max(from, 0); i < steps.length; i++) {
    if (match(steps[i])) return i;
  }
  return -1;
}

describe('CW120 — every reset the corpus commands sends no key but force', () => {
  it('no reset body or trigger payload carries a key other than a boolean force', () => {
    const calls = yamlFiles(SCENARIOS_DIR).flatMap((file) =>
      resetCalls(relative(SCENARIOS_DIR, file), stepsOf(file)));
    const files = new Set(calls.map((c) => c.file)).size;
    const offenders = calls
      .filter((c) => Object.entries(c.sent).some(([key, value]) => key !== 'force' || typeof value !== 'boolean'))
      .map((c) => `${c.file} step ${c.index}: ${JSON.stringify(c.sent)}`);

    expect(calls.length, 'reset commands found in the corpus').toBeGreaterThan(0);
    expect(
      offenders,
      `${offenders.length} of ${calls.length} reset commands, in ${files} files, send a key the Reset does not have`,
    ).toEqual([]);
  });

  it('hard-reset commands the forced reset and soft-reset the unforced one, each saying so', () => {
    const hard = resetCalls('hard-reset.yaml', stepsOf(join(DEVICE_MANAGEMENT, 'hard-reset.yaml')));
    const soft = resetCalls('soft-reset.yaml', stepsOf(join(DEVICE_MANAGEMENT, 'soft-reset.yaml')));

    expect(hard.map((c) => c.sent), 'hard-reset.yaml').toEqual([{ force: true }]);
    expect(soft.map((c) => c.sent), 'soft-reset.yaml').toEqual([{ force: false }]);
  });
});

describe('CW120 — a scenario that answers its Reset reads back the station_reset row of that Reset', () => {
  const ROUND_TRIPS = [
    'hard-reset.yaml',
    'soft-reset.yaml',
    'reset-forced-settles-session-as-operator-stop.yaml',
  ];

  for (const name of ROUND_TRIPS) {
    it(`${name} reads the row by the Reset's messageId, with the force it sent`, () => {
      const steps = stepsOf(join(DEVICE_MANAGEMENT, name));
      const calls = resetCalls(name, steps);
      expect(calls.length, `${name}: reset commands`).toBe(1);
      // An absent `force` is false: every door builds the command with `force ?? false`.
      const forced = calls[0].sent.force === true;

      const request = indexFrom(steps, calls[0].index, (s) =>
        s.action === 'wait_for' && s.message === 'Reset' && s.messageType === 'Request');
      const capture = (steps[request]?.capture ?? {}) as Record<string, unknown>;
      const idVar = Object.keys(capture).find((key) => capture[key] === 'messageId');
      expect(idVar, `${name}: the wait_for on the Reset Request captures its messageId`).toBeDefined();

      const answer = indexFrom(steps, request, (s) =>
        s.action === 'send' && s.message === 'Reset' && s.messageType === 'Response' &&
        (s.payload as Record<string, unknown> | undefined)?.status === 'Accepted');
      expect(answer, `${name}: the Reset is answered Accepted after it arrives`).toBeGreaterThan(request);

      const read = indexFrom(steps, answer, (s) =>
        s.action === 'api_call' && s.method === 'GET' &&
        s.url === '{{target_url}}/api/v1/admin/stations/{{stationId}}/journal?kind=station_reset');
      expect(read, `${name}: the journal's station_reset rows are read after the Response`).toBeGreaterThan(answer);

      const body = (steps[read].expect_body ?? {}) as Record<string, unknown>;
      expect(body['data[kind=station_reset].details.messageId'], `${name}: the row is this Reset's`)
        .toBe(`{{captured.${idVar}}}`);
      expect(body['data[kind=station_reset].details.forced'], `${name}: the row records the force sent`)
        .toBe(forced);
    });
  }
});

describe('CW120 — the forced reset asserts its operator stop before the station settles', () => {
  it("waits for the listener's StopService, checks it names the session, and reads stopping before the SessionEnded", () => {
    const steps = stepsOf(join(DEVICE_MANAGEMENT, 'reset-forced-settles-session-as-operator-stop.yaml'));

    const answer = indexFrom(steps, 0, (s) =>
      s.action === 'send' && s.message === 'Reset' && s.messageType === 'Response');
    const stopService = indexFrom(steps, answer, (s) =>
      s.action === 'wait_for' && s.message === 'StopService' && s.messageType === 'Request');
    const namesSession = indexFrom(steps, stopService, (s) =>
      s.action === 'assert' && s.field === 'payload.sessionId' && s.equals === '{{captured.sessionId}}');
    const stopping = indexFrom(steps, namesSession, (s) =>
      s.action === 'api_call' && s.method === 'GET' &&
      s.url === '{{target_url}}/api/v1/sessions/{{captured.sessionId}}' &&
      (s.expect_body as Record<string, unknown> | undefined)?.['data.status'] === 'stopping');
    const sessionEnded = indexFrom(steps, 0, (s) => s.action === 'send' && s.message === 'SessionEnded');

    const order = { answer, stopService, namesSession, stopping, sessionEnded };
    expect(answer, JSON.stringify(order)).toBeGreaterThanOrEqual(0);
    expect(stopService, JSON.stringify(order)).toBeGreaterThan(answer);
    // AssertStep reads the LAST message received, so the check has to follow its wait_for directly.
    expect(namesSession, JSON.stringify(order)).toBe(stopService + 1);
    expect(stopping, JSON.stringify(order)).toBeGreaterThan(namesSession);
    expect(sessionEnded, JSON.stringify(order)).toBeGreaterThan(stopping);
  });
});
