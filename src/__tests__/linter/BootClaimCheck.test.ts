import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  BootClaimCheck,
  FAULT_TIMEOUT_DEFAULT_MS,
  FIRST_BOOT_MAX_UPTIME_S,
  NO_DEADLINE_STEP_S,
  WAIT_DEFAULT_MS,
} from '../../linter/checks/BootClaimCheck.js';
import { ScenarioLinter } from '../../linter/ScenarioLinter.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new BootClaimCheck();

function makeScenario(steps: Record<string, unknown>[]): ParsedScenario {
  return { filePath: 'test.yaml', name: 'test', declarations: {}, steps };
}

const boot = (bootReason: unknown, uptimeSeconds: unknown): Record<string, unknown> => ({
  action: 'send',
  message: 'BootNotification',
  payload: { bootReason, uptimeSeconds },
});

/** The boot's Response, waited for 10 s, and the status the file asserts on it. */
const answered = (status: string): Record<string, unknown>[] => [
  { action: 'wait_for', message: 'BootNotification', messageType: 'Response', timeout_ms: 10_000 },
  { action: 'assert', field: 'payload.status', equals: status },
];

const delay = (ms: unknown): Record<string, unknown> => ({ action: 'delay', ms });

/** trigger-message-boot.yaml's shape: ask over REST, receive it, check what it asks, answer it. */
const trigger = (requestedMessage: string, status: string): Record<string, unknown>[] => [
  {
    action: 'api_call',
    method: 'POST',
    url: '{{target_url}}/api/v1/admin/stations/{{stationId}}/trigger-message',
    body: { requestedMessage },
    expect_status: 202,
  },
  { action: 'wait_for', message: 'TriggerMessage', messageType: 'Request', timeout_ms: 15_000 },
  { action: 'assert', field: 'payload.requestedMessage', equals: requestedMessage },
  { action: 'send', message: 'TriggerMessage', messageType: 'Response', payload: { status } },
];

/**
 * boot-notification.md §5.2 rule 2: a restart reason carries "an uptime measured from the
 * restart" it names, a `Reconnect` "the uptime the station already had". Five corpus files
 * contradicted that inside themselves, lint-clean, and the server's cross-check could see only
 * three of them (rule 3); each case below is named after the file whose shape it reduces.
 */
describe('BootClaimCheck — a restart reason carries the uptime from the restart it names', () => {
  it('flags a first boot carrying the uptime from before its restart — boot-scheduled-reset.yaml\'s 86400', () => {
    const issues = check.check(makeScenario([boot('ScheduledReset', 86_400), ...answered('Accepted')]));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(0);
    expect(issues[0].stepAction).toBe('send');
    expect(issues[0].message).toMatch(/^ScheduledReset with uptimeSeconds 86400 opens the file/);
    expect(issues[0].message).toMatch(/at most 300 s/);
  });

  it('accepts a first boot up to the allowance and flags one second past it', () => {
    expect(check.check(makeScenario([boot('Watchdog', 0)]))).toEqual([]);
    expect(check.check(makeScenario([boot('Watchdog', FIRST_BOOT_MAX_UPTIME_S)]))).toEqual([]);
    expect(check.check(makeScenario([boot('Watchdog', FIRST_BOOT_MAX_UPTIME_S + 1)]))).toHaveLength(1);
  });

  it('flags a later restart whose uptime is older than the previous boot — trigger-message-boot.yaml\'s PowerOn 3600', () => {
    // 10 s for the Response, NO_DEADLINE_STEP_S for the api_call: the most this file can wait.
    const between = [...answered('Accepted'), { action: 'api_call', method: 'GET', url: 'x' }];
    const most = 10 + NO_DEADLINE_STEP_S;
    const run = (uptime: number) => check.check(makeScenario([boot('PowerOn', 0), ...between, boot('PowerOn', uptime)]));

    const issues = run(3600);
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(4);
    expect(issues[0].message).toMatch(new RegExp(`at most ${most} s after the boot at step 0 \\(PowerOn, uptimeSeconds 0\\)`));
    expect(issues[0].message).toMatch(new RegExp(`the uptime is at most ${most + 1}: this one did not reset`));

    // The boundary: the most the file waits, plus a second of rounding.
    expect(run(most + 1)).toEqual([]);
    expect(run(most + 2)).toHaveLength(1);
  });

  it('lets a boot repeating the reason of one not answered Accepted run on as its retry — its uptime grows by the wait', () => {
    // First boot 100 (inside the allowance), then 10 s for its Response and a 10 s delay.
    const steps = (status: string, reason: string, uptime: number) =>
      makeScenario([boot('PowerOn', 100), ...answered(status), delay(10_000), boot(reason, uptime)]);

    expect(check.check(steps('Pending', 'PowerOn', 110))).toEqual([]);
    expect(check.check(steps('Rejected', 'PowerOn', 121))).toEqual([]);
    expect(check.check(steps('Pending', 'PowerOn', 122))).toHaveLength(1);

    // After an Accepted boot the same reason names a NEW restart, which came after it.
    const afterAccepted = check.check(steps('Accepted', 'PowerOn', 110));
    expect(afterAccepted).toHaveLength(1);
    expect(afterAccepted[0].message).toMatch(/the uptime is at most 21: this one did not reset/);

    // A different reason after a Pending is not a retry either.
    expect(check.check(steps('Pending', 'Watchdog', 110))).toHaveLength(1);
  });

  it('stays silent when the window has a deadline it cannot read, or the claim is not a literal', () => {
    expect(check.check(makeScenario([boot('PowerOn', 0), delay('{{pause}}'), boot('Watchdog', 3600)]))).toEqual([]);
    expect(check.check(makeScenario([
      boot('PowerOn', 0),
      { action: 'api_call', method: 'GET', url: 'x', poll: { timeout_ms: '{{settleMs}}', interval_ms: 1000 } },
      boot('Watchdog', 3600),
    ]))).toEqual([]);
    expect(check.check(makeScenario([boot('ScheduledReset', '{{uptime}}')]))).toEqual([]);
    expect(check.check(makeScenario([boot('{{reason}}', 86_400)]))).toEqual([]);
  });
});

describe('BootClaimCheck — a Reconnect carries the uptime the station already had', () => {
  it('flags a Reconnect that does not span the waits since the previous boot — boot-reconnect-preserves-live-session.yaml\'s 0', () => {
    const run = (uptime: number) => check.check(makeScenario([boot('PowerOn', 0), delay(1500), boot('Reconnect', uptime)]));

    const issues = run(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(2);
    expect(issues[0].message).toMatch(/^Reconnect with uptimeSeconds 0, at least 1\.5 s after the boot at step 0/);
    expect(issues[0].message).toMatch(/so it is at least 1:/);
    expect(run(1)).toEqual([]);
  });

  it('flags a Reconnect with more uptime than the station this file booted can have — boot-resets-bays-to-unknown.yaml\'s 90000', () => {
    // 10 s for the Response and a 1 s delay: at most 11 s pass.
    const run = (uptime: number) => check.check(makeScenario([
      boot('PowerOn', 0), ...answered('Accepted'), delay(1000), boot('Reconnect', uptime),
    ]));

    const issues = run(90_000);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/^Reconnect with uptimeSeconds 90000, at most 11 s after the boot at step 0/);
    expect(issues[0].message).toMatch(/so it is at most 12: 90000 is not the uptime/);
    expect(run(12)).toEqual([]);
    expect(run(13)).toHaveLength(1);
  });

  it('counts the waits that must run out — expect_silence and a fault: timeout — as time on the station\'s clock', () => {
    const silence = { action: 'wait_for', message: 'Heartbeat', messageType: 'Response', expect_silence: true, timeout_ms: 5000 };
    expect(check.check(makeScenario([boot('PowerOn', 0), silence, boot('Reconnect', 3)]))).toHaveLength(1);
    expect(check.check(makeScenario([boot('PowerOn', 0), silence, boot('Reconnect', 4)]))).toEqual([]);

    const stall = { action: 'fault', type: 'timeout' };
    const least = FAULT_TIMEOUT_DEFAULT_MS / 1000;
    expect(check.check(makeScenario([boot('PowerOn', 0), stall, boot('Reconnect', least - 2)]))).toHaveLength(1);
    expect(check.check(makeScenario([boot('PowerOn', 0), stall, boot('Reconnect', least - 1)]))).toEqual([]);
  });

  it('does not judge a Reconnect that opens the file — the station was up before it began (arc8-reconnect-preserve.yaml\'s 90000)', () => {
    expect(check.check(makeScenario([boot('Reconnect', 90_000), ...answered('Accepted')]))).toEqual([]);
  });

  it('reads an unanswered wait at its default deadline', () => {
    // A wait_for with no timeout_ms waits WAIT_DEFAULT_MS: one second of rounding past it is the edge.
    const wait = { action: 'wait_for', message: 'Heartbeat', messageType: 'Response' };
    const edge = WAIT_DEFAULT_MS / 1000 + 1;
    expect(check.check(makeScenario([boot('PowerOn', 0), wait, boot('Reconnect', edge)]))).toEqual([]);
    expect(check.check(makeScenario([boot('PowerOn', 0), wait, boot('Reconnect', edge + 1)]))).toHaveLength(1);
  });
});

describe('BootClaimCheck — a Boot the server asked for is Reconnect', () => {
  it('flags the BootNotification answering an accepted TriggerMessage for one when it names a restart — trigger-message-boot.yaml\'s PowerOn', () => {
    const issues = check.check(makeScenario([
      boot('PowerOn', 0), ...answered('Accepted'), ...trigger('BootNotification', 'Accepted'), boot('PowerOn', 1),
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(7);
    expect(issues[0].message).toMatch(/TriggerMessage for a BootNotification accepted at step 6 says PowerOn/);
    expect(issues[0].message).toMatch(/Send `Reconnect`/);
  });

  it('accepts the triggered boot as Reconnect with the uptime running on', () => {
    expect(check.check(makeScenario([
      boot('PowerOn', 0), ...answered('Accepted'), ...trigger('BootNotification', 'Accepted'), boot('Reconnect', 1),
    ]))).toEqual([]);
  });

  it('owes no Reconnect for a trigger asking another message, or one the station did not accept', () => {
    expect(check.check(makeScenario([
      boot('PowerOn', 0), ...trigger('Heartbeat', 'Accepted'), boot('PowerOn', 0),
    ]))).toEqual([]);
    expect(check.check(makeScenario([
      boot('PowerOn', 0), ...trigger('BootNotification', 'Rejected'), boot('PowerOn', 0),
    ]))).toEqual([]);
  });

  it('owes it once: the next boot after the triggered one is judged by the other rules only', () => {
    expect(check.check(makeScenario([
      boot('PowerOn', 0), ...trigger('BootNotification', 'Accepted'), boot('Reconnect', 1),
      ...answered('Accepted'), boot('PowerOn', 0),
    ]))).toEqual([]);
  });
});

describe('BootClaimCheck — wiring', () => {
  let dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
    dirs = [];
  });

  it('runs inside ScenarioLinter, so lint:scenarios reports it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boot-claim-'));
    dirs.push(dir);
    const file = path.join(dir, 'scenario.yaml');
    await fs.writeFile(file, [
      'name: "Boot Watchdog"',
      'steps:',
      '  - action: send',
      '    message: BootNotification',
      '    payload:',
      '      bootReason: "Watchdog"',
      '      uptimeSeconds: 3600',
    ].join('\n'), 'utf-8');

    const issues = await new ScenarioLinter().lintFile(file);
    expect(issues.map((i) => i.message).filter((m) => m.startsWith('Watchdog with uptimeSeconds 3600 opens the file'))).toHaveLength(1);
  });

  /**
   * THE DEFAULTS THE WINDOW ASSUMES. A `wait_for` without `timeout_ms` and a `fault: timeout`
   * without `ms` are read at the defaults their steps apply — literals inside `execute()`, not
   * an exported value. Read off the sources here, so a step that changes its default turns this
   * red instead of leaving the check's window quietly wrong.
   */
  it('pins the step defaults it assumes against the step sources', () => {
    const source = (file: string) =>
      readFileSync(fileURLToPath(new URL(`../../scenarios/steps/${file}`, import.meta.url)), 'utf8');
    const numeric = (text: string) => Number(text.replace(/_/g, ''));

    for (const file of ['WaitForStep.ts', 'WaitForConnectStep.ts']) {
      const m = source(file).match(/\(definition\.timeout_ms as number\) \?\? ([0-9_]+)/);
      expect(m, `${file} no longer reads timeout_ms with a default`).not.toBeNull();
      expect(numeric(m![1])).toBe(WAIT_DEFAULT_MS);
    }

    const fault = source('FaultStep.ts').match(/case 'timeout': \{\s*const ms = \(definition\.ms as number\) \?\? ([0-9_]+);/);
    expect(fault, 'FaultStep.ts no longer reads a timeout fault\'s ms with a default').not.toBeNull();
    expect(numeric(fault![1])).toBe(FAULT_TIMEOUT_DEFAULT_MS);
  });
});

/**
 * THE CORPUS. Every scenario file, read as ScenarioLinter reads it, with no claim this check
 * refuses. The denominator comes first: a walk that found no files, or files with no boots,
 * would pass the empty-list assertion while guarding nothing.
 */
describe('BootClaimCheck — the scenario corpus', () => {
  const SCENARIOS_DIR = fileURLToPath(new URL('../../../scenarios', import.meta.url));

  function yamlFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...yamlFiles(full));
      else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(full);
    }
    return out.sort();
  }

  it('carries no boot claim the file itself contradicts', () => {
    const files = yamlFiles(SCENARIOS_DIR);
    let boots = 0;
    const offenders: string[] = [];

    for (const file of files) {
      const parsed = parseYaml(readFileSync(file, 'utf-8')) as { name?: string; steps?: unknown } | null;
      if (!parsed || !Array.isArray(parsed.steps)) continue;
      const steps = parsed.steps as Record<string, unknown>[];
      boots += steps.filter((s) => s?.action === 'send' && s?.message === 'BootNotification').length;
      const { steps: _steps, ...declarations } = parsed;
      const rel = path.relative(SCENARIOS_DIR, file);
      for (const issue of check.check({ filePath: rel, name: parsed.name ?? rel, steps, declarations })) {
        offenders.push(`${rel} step ${issue.step}: ${issue.message}`);
      }
    }

    expect(files.length).toBeGreaterThan(150);
    expect(boots).toBeGreaterThan(150);
    expect(offenders, `boot claims the same file contradicts:\n${offenders.join('\n')}`).toEqual([]);
  });
});
