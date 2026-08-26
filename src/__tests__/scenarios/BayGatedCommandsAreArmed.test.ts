import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/**
 * THE GATE THAT REFUSES A COMMAND SENT TO A BAY NOBODY HAS REPORTED.
 *
 * `bays.status` is reset to `unknown` on EVERY accepted BootNotification —
 * `BootNotificationHandler` calls `resetBaysToUnknown()` unconditionally, and nothing but an
 * accepted StatusNotification clears it. Three server surfaces refuse a bay in that state
 * with 3002 BAY_NOT_READY:
 *
 *   POST /api/v1/sessions/start                    SessionStateMachine::validateBayForStart
 *   POST /api/v1/reservations                      ReservationTransitions::validateBayForReservation
 *   POST /api/v1/admin/stations/{id}/maintenance   SetMaintenanceModeAction::validateBayForMaintenance
 *
 * The first two are old. The third is not: `set-maintenance-mode.md` §6 has listed
 * `Unknown -> Rejected, 3002` in BOTH directions since spec `7eb6acb` (2026-08-05), but
 * csms-server only started applying it at `e9fa3fc4` (2026-08-18) — until then it answered
 * 202 for a command a conformant station must refuse. Two files had been booting and
 * commanding without ever reporting a bay, and the day enforcement landed they failed on
 * UAT: `maintenance-mode-on` (bay 1) and `maintenance-mode-all-bays` (bays 1 and 2, because
 * an absent `bayId` means ALL bays and one Unknown bay refuses the whole command).
 *
 * WHY A GATE AND NOT JUST THE REPAIR. `maintenance-mode-off` passed the same run, on the
 * same route, with the same identity, differing in exactly one step: it reported the bay
 * first. A repair that only moves two files leaves the next author with nothing to hit —
 * the rule lives in a server file and a spec table, neither of which this corpus reads.
 *
 * WHAT COUNTS AS ARMED. An earlier `send` of a StatusNotification naming the SAME bayId
 * token the command names. Matching on the token, not on `bayNumber`, keeps the two halves
 * addressing one bay: the header of the maintenance files records a run where a captured
 * `data.bays.0.bayId` requested maintenance on an arbitrary bay while the report named bay 1.
 *
 * WHAT DISARMS. A `send BootNotification` clears everything armed so far, because the server
 * does. Scenarios that boot twice — `boot-disabled-station-boots-and-stays-gated` — must and
 * do report again after the second boot; without the reset this gate would pass them on the
 * strength of a report the server had already thrown away.
 */

const SCENARIOS_DIR = fileURLToPath(new URL('../../../scenarios', import.meta.url));

/**
 * The bay-state-gated routes, and how each one names its bay.
 *
 * `allWhenAbsent` is the maintenance route's own rule and not a convenience: omitting
 * `bayId` targets every bay on the station (`SetMaintenanceModeAction` loops
 * `getBaysForStation()`), so the requirement is every bay the scenario declares, not none.
 */
const GATED_ROUTES: ReadonlyArray<{ pattern: RegExp; bayKey: string; allWhenAbsent: boolean }> = [
  { pattern: /\/api\/v1\/admin\/stations\/[^/]+\/maintenance$/, bayKey: 'bayId', allWhenAbsent: true },
  { pattern: /\/api\/v1\/sessions\/start$/, bayKey: 'bay_id', allWhenAbsent: false },
  { pattern: /\/api\/v1\/reservations$/, bayKey: 'bay_id', allWhenAbsent: false },
];

/** 3005 — see the exclusion in `unarmedCommandsIn`. */
const BAY_NOT_FOUND = 3005;

/**
 * Does this scenario connect its station DURING its steps? A `defer_mqtt_connect` file that
 * does is on the wire and can report a bay; one that does not, cannot.
 */
export function connectsLater(doc: unknown): boolean {
  const steps = (doc as { steps?: unknown[] } | null)?.steps;

  return Array.isArray(steps)
    && steps.some((raw) => (raw as { action?: string } | null)?.action === 'connect_mqtt');
}

interface Offender {
  file: string;
  step: number;
  url: string;
  unarmed: string[];
}

interface Scan {
  files: number;
  gatedCommands: number;
  offenders: Offender[];
  deferred: string[];
}

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...yamlFiles(full));
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      out.push(full);
    }
  }

  return out;
}

/** The whole predicate, over one parsed scenario. Exported shape so the controls can drive it. */
export function unarmedCommandsIn(doc: unknown, label: string): Offender[] {
  const scenario = doc as {
    steps?: unknown[];
    station?: { bayCount?: number };
  } | null;
  if (!scenario || !Array.isArray(scenario.steps)) return [];

  const bayCount = Number(scenario.station?.bayCount ?? 0);
  const offenders: Offender[] = [];
  let armed = new Set<string>();

  scenario.steps.forEach((raw, index) => {
    const step = raw as Record<string, unknown> | null;
    if (!step) return;

    if (step.action === 'send' && step.message === 'BootNotification') {
      armed = new Set<string>();

      return;
    }

    const payload = step.payload as Record<string, unknown> | undefined;
    if (step.action === 'send' && step.message === 'StatusNotification' && payload?.bayId !== undefined) {
      armed.add(String(payload.bayId));

      return;
    }

    if (step.action !== 'api_call') return;
    if (String(step.method ?? '').toUpperCase() !== 'POST') return;

    const url = String(step.url ?? '').replace('{{target_url}}', '');
    const route = GATED_ROUTES.find((candidate) => candidate.pattern.test(url));
    if (!route) return;

    // THE SECOND PRINCIPLED EXCLUSION, and it is the same shape as the first: not a
    // name on a list, but a case where the requirement is an IMPOSSIBILITY.
    //
    // The rule this gate enforces is "do not command a bay the server still holds at
    // `unknown`", and its remedy is "report that bay first". A step whose expected
    // answer is 3005 BAY_NOT_FOUND is not asking for a bay to be READY — it is naming
    // a bay that does not exist, on purpose, and a station cannot report a bay it does
    // not have. The server agrees on the ordering: SessionController:53-55 resolves the
    // bay and answers 3005 BEFORE SessionStateMachine::validateBayForStart can answer
    // 3002, so the state this gate is about is never reached.
    //
    // Deliberately keyed on the ASSERTED code and not on the bay id looking synthetic.
    // A heuristic on the id ("does it look made up?") would be a guess about intent; the
    // assertion is the intent, written down, and a step that stops expecting 3005 stops
    // being excused in the same edit.
    const expectBody = step.expect_body as Record<string, unknown> | undefined;
    const expectsBayNotFound = expectBody !== undefined
      && Object.entries(expectBody).some(
        ([path, want]) => /(^|\.)ospp_code$/.test(path) && want === BAY_NOT_FOUND,
      );
    if (expectsBayNotFound) return;

    const body = step.body as Record<string, unknown> | undefined;
    const named = body?.[route.bayKey];
    const required = named !== undefined
      ? [String(named)]
      : route.allWhenAbsent
        ? Array.from({ length: bayCount }, (_unused, i) => `{{bayId_${i + 1}}}`)
        : [];

    const unarmed = required.filter((bay) => !armed.has(bay));
    if (unarmed.length > 0) {
      offenders.push({ file: label, step: index, url, unarmed });
    }
  });

  return offenders;
}

function scanCorpus(): Scan {
  const files = yamlFiles(SCENARIOS_DIR);
  const offenders: Offender[] = [];
  const deferred: string[] = [];
  let gatedCommands = 0;

  for (const file of files) {
    const label = file.slice(SCENARIOS_DIR.length + 1);
    const doc = YAML.parse(readFileSync(file, 'utf-8')) as {
      steps?: unknown[];
      defer_mqtt_connect?: boolean;
      skip_when_pooled?: string;
    } | null;
    if (!doc || !Array.isArray(doc.steps)) continue;

    for (const raw of doc.steps) {
      const step = raw as Record<string, unknown> | null;
      if (step?.action !== 'api_call') continue;
      if (String(step.method ?? '').toUpperCase() !== 'POST') continue;
      const url = String(step.url ?? '').replace('{{target_url}}', '');
      if (GATED_ROUTES.some((candidate) => candidate.pattern.test(url))) gatedCommands++;
    }

    // THE FIRST OF TWO PRINCIPLED EXCLUSIONS, and both are structural rather than a name
    // on a list. The second lives in `unarmedCommandsIn` and excuses a step whose expected
    // answer is 3005 BAY_NOT_FOUND; the shared justification is that the remedy this gate
    // prescribes — report the bay first — is IMPOSSIBLE for the file in question.
    //
    // `defer_mqtt_connect: true` means the runner does not connect the station before the
    // steps run. On its own that is NOT enough to excuse anything, and the predicate was
    // narrowed on 2026-08-26 to say so: what excuses a file is never connecting AT ALL, and
    // that is visible in the file — a `connect_mqtt` step.
    //
    //   defers and NEVER connects   -> cannot send any station message -> excused
    //   defers and THEN connects    -> can send StatusNotifications    -> held to the rule
    //
    // The second row is the one that changed. A file that provisions a station of its own
    // and then connects it (`owns_station`) is on the wire for the rest of its run; excusing
    // it because of how it STARTED would hand the whole class a permanent exemption on the
    // strength of a key that no longer describes it.
    //
    // Derived from the file rather than declared, deliberately — the same argument the
    // variable preflight makes: a hand-maintained list drifts the first time someone adds a
    // file, and drift here means the gate either blocks a correct file or waves through the
    // one it exists to catch.
    //
    // The exclusion is fenced by the assertion below: a file that is excused must also
    // declare `skip_when_pooled`, so it can never quietly cover a file the unattended suite
    // runs.
    if (doc.defer_mqtt_connect === true && !connectsLater(doc)) {
      deferred.push(label);
      continue;
    }

    offenders.push(...unarmedCommandsIn(doc, label));
  }

  return { files: files.length, gatedCommands, offenders, deferred };
}

describe('every bay-gated command is issued to a bay the scenario has reported', () => {
  // ---- DENOMINATOR ----------------------------------------------------------
  // A gate that reads no files, or finds no gated commands in them, passes every assertion
  // below it while measuring nothing. Both halves are pinned.
  it('actually reads the corpus and finds the commands it is about', () => {
    const scan = scanCorpus();
    expect(scan.files).toBeGreaterThan(100);
    expect(scan.gatedCommands).toBeGreaterThan(40);
  });

  // ---- MATCHER CONTROL ------------------------------------------------------
  // A conformant sample AND a refusal, so a widened-or-broken predicate is caught here
  // rather than by the number it produces. The refusal is the one that matters: it is the
  // scenario the two repaired files WERE, and this gate is worth nothing if it passes it.
  it('flags a command with no report, and passes the same file once the report is added', () => {
    const command = {
      action: 'api_call',
      method: 'POST',
      url: '{{target_url}}/api/v1/admin/stations/{{stationId}}/maintenance',
      body: { bayId: '{{bayId_1}}', enabled: true },
    };
    const boot = { action: 'send', message: 'BootNotification' };
    const report = {
      action: 'send',
      message: 'StatusNotification',
      messageType: 'Event',
      payload: { bayId: '{{bayId_1}}', bayNumber: 1, status: 'Available' },
    };

    // REFUSAL — boot, then command. This is exactly maintenance-mode-on before the repair.
    expect(unarmedCommandsIn({ station: { bayCount: 2 }, steps: [boot, command] }, 'x'))
      .toEqual([{ file: 'x', step: 1, url: '/api/v1/admin/stations/{{stationId}}/maintenance', unarmed: ['{{bayId_1}}'] }]);

    // CONFORMANT — the same file with the report in front of it.
    expect(unarmedCommandsIn({ station: { bayCount: 2 }, steps: [boot, report, command] }, 'x')).toEqual([]);
  });

  it('treats a second BootNotification as disarming every bay reported before it', () => {
    const boot = { action: 'send', message: 'BootNotification' };
    const report = {
      action: 'send',
      message: 'StatusNotification',
      payload: { bayId: '{{bayId_1}}' },
    };
    const start = {
      action: 'api_call',
      method: 'POST',
      url: '{{target_url}}/api/v1/sessions/start',
      body: { bay_id: '{{bayId_1}}' },
    };

    expect(unarmedCommandsIn({ steps: [boot, report, boot, start] }, 'x')).toHaveLength(1);
    expect(unarmedCommandsIn({ steps: [boot, report, boot, report, start] }, 'x')).toEqual([]);
  });

  it('requires every declared bay when the maintenance command names none', () => {
    const boot = { action: 'send', message: 'BootNotification' };
    const one = { action: 'send', message: 'StatusNotification', payload: { bayId: '{{bayId_1}}' } };
    const allBays = {
      action: 'api_call',
      method: 'POST',
      url: '{{target_url}}/api/v1/admin/stations/{{stationId}}/maintenance',
      body: { enabled: true },
    };

    // Bay 1 reported, bay 2 not — and an absent bayId means both.
    expect(unarmedCommandsIn({ station: { bayCount: 2 }, steps: [boot, one, allBays] }, 'x')[0]?.unarmed)
      .toEqual(['{{bayId_2}}']);
  });

  it('does not fire on routes that carry no bay', () => {
    const boot = { action: 'send', message: 'BootNotification' };
    const notGated = [
      { action: 'api_call', method: 'POST', url: '{{target_url}}/api/v1/admin/stations/{{stationId}}/reset', body: { type: 'Hard' } },
      { action: 'api_call', method: 'POST', url: '{{target_url}}/api/v1/sessions/sess_00000099/stop', body: {} },
      { action: 'api_call', method: 'GET', url: '{{target_url}}/api/v1/admin/stations/{{stationId}}' },
    ];

    expect(unarmedCommandsIn({ station: { bayCount: 2 }, steps: [boot, ...notGated] }, 'x')).toEqual([]);
  });

  // ---- CONTROL FOR THE 3005 EXCLUSION ---------------------------------------
  // Both directions, because an exclusion that only ever excuses is indistinguishable
  // from a deleted rule. The two steps below are IDENTICAL but for the expected code.
  it('excuses a command that expects 3005, and still flags the same command expecting 3001', () => {
    const boot = { action: 'send', message: 'BootNotification' };
    const base = {
      action: 'api_call',
      method: 'POST',
      url: '{{target_url}}/api/v1/sessions/start',
      body: { bay_id: 'bay_ffffffff' },
    };

    const expectsNotFound = { ...base, expect_body: { 'error.ospp_code': 3005 } };
    expect(unarmedCommandsIn({ station: { bayCount: 2 }, steps: [boot, expectsNotFound] }, 'x')).toEqual([]);

    const expectsBusy = { ...base, expect_body: { 'error.ospp_code': 3001 } };
    expect(unarmedCommandsIn({ station: { bayCount: 2 }, steps: [boot, expectsBusy] }, 'x'))
      .toEqual([{ file: 'x', step: 1, url: '/api/v1/sessions/start', unarmed: ['bay_ffffffff'] }]);

    // And an unasserted command is still flagged — the excuse requires the assertion,
    // it is not inherited from the route or from the shape of the id.
    expect(unarmedCommandsIn({ station: { bayCount: 2 }, steps: [boot, base] }, 'x')).toHaveLength(1);
  });

  // ---- CONTROL FOR THE NARROWED EXCUSE --------------------------------------
  // Both directions, and then the corpus effect — an exclusion that excuses the same set it
  // did before is a comment, not a change.
  it('excuses a deferred file only while it never connects', () => {
    const defer = { defer_mqtt_connect: true, steps: [{ action: 'api_call' }] };
    expect(connectsLater(defer)).toBe(false);

    const deferThenConnect = {
      defer_mqtt_connect: true,
      steps: [{ action: 'api_call' }, { action: 'provision' }, { action: 'connect_mqtt' }],
    };
    expect(connectsLater(deferThenConnect)).toBe(true);

    // Not fooled by a file with no steps at all, nor by a step of another kind.
    expect(connectsLater({ steps: [] })).toBe(false);
    expect(connectsLater({ steps: [{ action: 'send' }] })).toBe(false);
    expect(connectsLater(null)).toBe(false);
  });

  it('the narrowing actually moved files INTO the checked set', () => {
    // Measured, not asserted as a constant: every file declaring `defer_mqtt_connect` used to
    // be excused. Now only the ones that never connect are, and the difference must be
    // non-empty or this predicate is decoration.
    const defers: string[] = [];
    const stillExcused: string[] = [];
    for (const file of yamlFiles(SCENARIOS_DIR)) {
      const doc = YAML.parse(readFileSync(file, 'utf-8')) as { defer_mqtt_connect?: boolean } | null;
      if (doc?.defer_mqtt_connect !== true) continue;
      defers.push(file);
      if (!connectsLater(doc)) stillExcused.push(file);
    }
    expect(defers.length).toBeGreaterThan(0);
    expect(
      defers.length - stillExcused.length,
      'no file lost the excuse, so narrowing it changed nothing — either the predicate is ' +
        'wrong or the corpus no longer has a file that defers and then connects',
    ).toBeGreaterThan(0);
  });

  // ---- THE ASSERTIONS -------------------------------------------------------
  it('no scenario commands a bay it has not reported since the last boot', () => {
    const scan = scanCorpus();

    expect(
      scan.offenders,
      'these steps command a bay the server still holds at `unknown` — every accepted Boot ' +
        'resets it and only a StatusNotification clears it, so the server answers 3002 ' +
        'BAY_NOT_READY:\n' +
        scan.offenders
          .map((o) => `  ${o.file} [step ${o.step}] ${o.url} -> ${o.unarmed.join(', ')}`)
          .join('\n'),
    ).toEqual([]);
  });

  it('a file excused for never connecting is one the unattended suite never runs', () => {
    const files = yamlFiles(SCENARIOS_DIR);
    const leaking: string[] = [];

    for (const file of files) {
      const doc = YAML.parse(readFileSync(file, 'utf-8')) as {
        defer_mqtt_connect?: boolean;
        skip_when_pooled?: string;
      } | null;
      if (doc?.defer_mqtt_connect !== true) continue;
      // Only an EXCUSED file needs the fence. A deferred file that connects later is held to
      // the arming rule like every other, so it is free to run in the unattended suite.
      if (connectsLater(doc)) continue;
      if (typeof doc.skip_when_pooled !== 'string' || doc.skip_when_pooled === '') {
        leaking.push(file.slice(SCENARIOS_DIR.length + 1));
      }
    }

    expect(
      leaking,
      '`defer_mqtt_connect: true` excuses a file from the arming rule because it cannot send ' +
        'a StatusNotification at all. That excuse is only tolerable while the file stays out ' +
        'of the unattended suite — these declare the first without the second:\n' +
        leaking.map((f) => `  ${f}`).join('\n'),
    ).toEqual([]);

    // The exclusion covers something, or its fence is measuring nothing.
    expect(scanCorpus().deferred.length).toBeGreaterThan(0);
  });
});
