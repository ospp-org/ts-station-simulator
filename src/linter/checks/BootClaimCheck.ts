import {
  BootReason,
  MessageType,
  OsppAction,
  bootReasonNamesAnActualBoot,
  type BootNotificationResponse,
  type TriggerableMessage,
  type TriggerMessageStatus,
} from '@ospp/protocol';
import type { LintCheck, LintIssue, ParsedScenario } from '../types.js';

/**
 * A BOOT CLAIM THE SAME FILE CONTRADICTS — boot-notification.md §5.2, read inside one scenario.
 *
 * §5.2 rule 2: "`uptimeSeconds` MUST be consistent with `bootReason`. A `Reconnect` carries the
 * uptime the station already had — it spans the outage. `PowerOn`, `Watchdog`, `FirmwareUpdate`,
 * `RemoteReset`, `ManualReset`, `ScheduledReset` and `ErrorRecovery` all carry an uptime measured
 * from the restart they name." And of a Boot the server asked for by TriggerMessage: "`Reconnect`
 * therefore covers both cases of no boot occurred: a re-dialled session, and a Boot the server
 * asked for."
 *
 * A scenario's BootNotification is a pair of literals its author typed, so it can contradict the
 * rest of the same file, and nothing ran it against the rule. Measured over the 159 files at
 * a6eb905 (2026-10-13), five did: a `ScheduledReset` and a `Watchdog` opening their files with the
 * uptime from BEFORE the restart they name (86400, 3600); a triggered boot saying `PowerOn` with
 * 3600, about a second after the same file's `PowerOn` 0; a `Reconnect` with 25 h of uptime a
 * second or two after the `PowerOn` 0 the file itself sent; and a `Reconnect` with uptime 0 after
 * a `PowerOn` 0 and seconds of running. The server's cross-check (rule 3) refuses the first three
 * whenever the station's previous boot implies a later power-on (the triggered one on every run),
 * and then does not act on the reason the file is about. The last two are what rule 3 calls a
 * coherent falsehood: the server cannot see them, so only a reading of the file can.
 *
 * ── THE THREE RULES ──────────────────────────────────────────────────────────────────────
 *
 * Each boot is read against the boot before it in the same file, with the time the file lets
 * pass between the two taken as a window [least, most] (below):
 *
 *   1. A RESTART REASON — every value `bootReasonNamesAnActualBoot` is true for — carries an
 *      uptime measured from a restart that came after the previous boot, so it is at most
 *      `most` + 1 s. A boot repeating the reason of a previous boot that was not answered
 *      `Accepted` may be that boot's retry ("the same bootReason, its uptime grown by the wait",
 *      rule 3), so it is at most the previous uptime + `most` + 1 s. The file's FIRST boot may
 *      carry at most 300 s: a station boots right after it restarts.
 *   2. A `Reconnect` carries the uptime the station already had, so it lies within
 *      [previous + `least` − 1 s, previous + `most` + 1 s]. A `Reconnect` that opens the file is
 *      not judged: the station was up before the file began.
 *   3. The BootNotification a file sends after accepting a TriggerMessage for a BootNotification
 *      is `Reconnect`: a Boot the server asked for names no restart.
 *
 * ── THE WINDOW ───────────────────────────────────────────────────────────────────────────
 *
 * `least` counts only what MUST pass for the file to pass: a `delay`'s `ms`, a `fault: timeout`'s
 * `ms`, and a `wait_for` with `expect_silence: true`, which passes only once its whole
 * `timeout_ms` has run out. `most` adds every step's own deadline — a `wait_for`'s or a
 * `wait_for_connect`'s `timeout_ms`, an `api_call`'s `poll.timeout_ms` — and
 * {@link NO_DEADLINE_STEP_S} for each step that does I/O with no deadline of its own. A deadline
 * this check cannot read (a `{{template}}`) makes `most` unbounded, so rule 1 and the upper half
 * of rule 2 stay silent rather than guess. The 1 s either way is the rounding of whole seconds.
 *
 * A boot whose `bootReason` or `uptimeSeconds` is templated, missing or not a value at all is not
 * judged here (EnumValuesCheck and PayloadSchemaCheck judge the values); it still starts the next
 * window, with whatever of the pair it did state.
 */

/**
 * `WaitForStep` and `WaitForConnectStep` both read `(definition.timeout_ms as number) ?? 15000`.
 * Pinned against their sources by BootClaimCheck.test.ts.
 */
export const WAIT_DEFAULT_MS = 15_000;

/** `FaultStep`'s `timeout` kind reads `(definition.ms as number) ?? 30_000`. Pinned the same way. */
export const FAULT_TIMEOUT_DEFAULT_MS = 30_000;

/**
 * The most a step that does I/O with no deadline of its own is taken to need: an `api_call`
 * (on top of its `poll` budget), `provision`, `provision_station_pool`, `fund_wallet`,
 * `connect_mqtt`, a `fault` other than `timeout` (its reconnect included), and any action this
 * check does not know. Corpus policy, not a measurement: generous, because it only widens `most`.
 */
export const NO_DEADLINE_STEP_S = 30;

/** The most uptime a restart reason may carry on the file's first boot. */
export const FIRST_BOOT_MAX_UPTIME_S = 300;

/** Whole seconds on the wire. */
const ROUNDING_S = 1;

const BOOT_REASONS: ReadonlySet<string> = new Set(Object.values(BootReason));
const ACCEPTED: BootNotificationResponse['status'] = 'Accepted';
const TRIGGER_ACCEPTED: TriggerMessageStatus = 'Accepted';
const TRIGGERED_BOOT: TriggerableMessage = 'BootNotification';

interface Window {
  least: number;
  most: number;
}

interface Boot {
  step: number;
  reason: string | undefined;
  uptime: number | undefined;
  /** The `payload.status` the file asserted on this boot's Response, if it did. */
  answer: string | undefined;
}

export class BootClaimCheck implements LintCheck {
  name = 'boot-claim';

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];
    const report = (step: number, message: string): void => {
      issues.push({ file: scenario.filePath, step, stepAction: 'send', message });
    };

    let previous: Boot | undefined;
    let window: Window = { least: 0, most: 0 };
    // The boot whose Response is the last message the file received, so an `assert` on
    // `payload.status` reads that boot's answer (AssertStep reads the last received message).
    let answering: Boot | undefined;
    // What the TriggerMessage in hand asks for, as the file states it: the REST body that asked
    // the server to send it, or an assertion on the received request.
    let asked: string | undefined;
    // The step at which the station accepted a TriggerMessage for a BootNotification it has
    // not sent yet.
    let owedSince: number | undefined;

    scenario.steps.forEach((raw, index) => {
      if (raw === null || typeof raw !== 'object') return;
      const step = raw as Record<string, unknown>;

      if (step.action === 'wait_for' && step.expect_silence !== true) {
        answering =
          step.message === OsppAction.BOOT_NOTIFICATION && step.messageType === MessageType.RESPONSE
            ? previous
            : undefined;
      }
      if (step.action === 'assert' && typeof step.equals === 'string') {
        if (step.field === 'payload.status' && answering !== undefined) {
          answering.answer = step.equals;
        }
        if (step.field === 'payload.requestedMessage') {
          asked = step.equals;
        }
      }
      if (step.action === 'api_call') {
        const requested = record(step.body)?.requestedMessage;
        if (typeof requested === 'string') asked = requested;
      }
      if (
        step.action === 'send' &&
        step.message === OsppAction.TRIGGER_MESSAGE &&
        step.messageType === MessageType.RESPONSE
      ) {
        if (record(step.payload)?.status === TRIGGER_ACCEPTED && asked === TRIGGERED_BOOT) {
          owedSince = index;
        }
        asked = undefined;
      }

      if (!isBootRequest(step)) {
        const spent = stepWindow(step);
        window = { least: window.least + spent.least, most: window.most + spent.most };
        return;
      }

      const payload = record(step.payload) ?? {};
      const reason = literalBootReason(payload.bootReason);
      const uptime = wholeSeconds(payload.uptimeSeconds);

      if (owedSince !== undefined && reason !== undefined && reason !== BootReason.RECONNECT) {
        report(
          index,
          `the BootNotification answering the TriggerMessage for a BootNotification accepted at ` +
            `step ${owedSince} says ${reason}. A Boot the server asked for names no restart: ` +
            `boot-notification.md §5.2 makes \`Reconnect\` cover both cases of no boot occurring, ` +
            `a re-dialled session and a Boot the server asked for. Send \`Reconnect\`, with the ` +
            `uptime running on from the station's previous boot.`,
        );
      }
      owedSince = undefined;

      if (reason !== undefined && uptime !== undefined) {
        if (bootReasonNamesAnActualBoot(reason as BootReason)) {
          const message = restartIssue(reason, uptime, previous, window);
          if (message !== undefined) report(index, message);
        } else {
          for (const message of reconnectIssues(uptime, previous, window)) report(index, message);
        }
      }

      previous = { step: index, reason, uptime, answer: undefined };
      window = { least: 0, most: 0 };
      answering = undefined;
    });

    return issues;
  }
}

/** Rule 1: a restart reason's uptime is measured from a restart after the previous boot. */
function restartIssue(
  reason: string,
  uptime: number,
  previous: Boot | undefined,
  window: Window,
): string | undefined {
  if (previous === undefined) {
    if (uptime <= FIRST_BOOT_MAX_UPTIME_S) return undefined;
    return (
      `${reason} with uptimeSeconds ${uptime} opens the file. A restart reason carries the uptime ` +
      `measured from the restart it names (boot-notification.md §5.2 rule 2), and a station boots ` +
      `right after it restarts, so a first boot may carry at most ${FIRST_BOOT_MAX_UPTIME_S} s: ` +
      `${uptime} is an uptime from before that restart. The server's cross-check (rule 3) refuses ` +
      `the claim whenever the station's previous boot implies a later power-on, and then does not ` +
      `act on this reason.`
    );
  }

  // A boot repeating the reason of one that was not answered Accepted may be its retry, whose
  // uptime runs on from the previous one; any other restart came after the previous boot.
  const mayBeRetry =
    previous.answer !== ACCEPTED && (previous.reason === undefined || previous.reason === reason);
  const base = mayBeRetry ? previous.uptime : 0;
  if (base === undefined) return undefined;
  const limit = Math.floor(base + window.most + ROUNDING_S);
  if (uptime <= limit) return undefined;

  const since = mayBeRetry
    ? `it repeats the reason of a boot that was not answered ${ACCEPTED}, so it may be that ` +
      `boot's retry, whose uptime grows by the wait from ${base} (rule 3)`
    : `that restart came after the previous boot`;
  return (
    `${reason} with uptimeSeconds ${uptime}, at most ${seconds(window.most)} s after the boot at ` +
    `step ${previous.step} (${describeBoot(previous)}). A restart reason carries the uptime measured ` +
    `from the restart it names (boot-notification.md §5.2 rule 2), and ${since}, so the uptime ` +
    `is at most ${limit}: this one did not reset. That is the contradiction rule 3 makes the ` +
    `server refuse, and it then does not act on this reason.`
  );
}

/** Rule 2: a Reconnect carries the uptime the station already had. */
function reconnectIssues(uptime: number, previous: Boot | undefined, window: Window): string[] {
  if (previous?.uptime === undefined) return [];
  const issues: string[] = [];
  const lower = Math.ceil(previous.uptime + window.least - ROUNDING_S);
  const upper = Math.floor(previous.uptime + window.most + ROUNDING_S);
  if (uptime < lower) {
    issues.push(
      `Reconnect with uptimeSeconds ${uptime}, at least ${seconds(window.least)} s after the boot ` +
        `at step ${previous.step} (${describeBoot(previous)}). A Reconnect carries the uptime the ` +
        `station already had — it spans the outage (boot-notification.md §5.2 rule 2) — so it is ` +
        `at least ${lower}: the waits this file makes between the two boots ran on the station's ` +
        `clock too.`,
    );
  }
  if (uptime > upper) {
    issues.push(
      `Reconnect with uptimeSeconds ${uptime}, at most ${seconds(window.most)} s after the boot at ` +
        `step ${previous.step} (${describeBoot(previous)}). A Reconnect carries the uptime the station ` +
        `already had (boot-notification.md §5.2 rule 2), so it is at most ${upper}: ${uptime} is ` +
        `not the uptime of the station this file booted.`,
    );
  }
  return issues;
}

/** The least and the most time a non-boot step lets pass. */
function stepWindow(step: Record<string, unknown>): Window {
  switch (step.action) {
    case 'send':
    case 'assert':
    case 'start_heartbeat':
      return { least: 0, most: 0 };
    case 'delay':
      return exactly(toSeconds(step.ms));
    case 'wait_for': {
      const budget = toSeconds(step.timeout_ms, WAIT_DEFAULT_MS);
      if (budget === undefined) return { least: 0, most: Infinity };
      return { least: step.expect_silence === true ? budget : 0, most: budget };
    }
    case 'wait_for_connect':
      return { least: 0, most: toSeconds(step.timeout_ms, WAIT_DEFAULT_MS) ?? Infinity };
    case 'fault':
      if (step.type === 'timeout') return exactly(toSeconds(step.ms, FAULT_TIMEOUT_DEFAULT_MS));
      return { least: 0, most: NO_DEADLINE_STEP_S };
    case 'api_call': {
      const poll = record(step.poll);
      if (poll === undefined) return { least: 0, most: NO_DEADLINE_STEP_S };
      const budget = toSeconds(poll.timeout_ms);
      return { least: 0, most: budget === undefined ? Infinity : budget + NO_DEADLINE_STEP_S };
    }
    default:
      return { least: 0, most: NO_DEADLINE_STEP_S };
  }
}

function exactly(value: number | undefined): Window {
  return value === undefined ? { least: 0, most: Infinity } : { least: value, most: value };
}

function isBootRequest(step: Record<string, unknown>): boolean {
  return (
    step.action === 'send' &&
    step.message === OsppAction.BOOT_NOTIFICATION &&
    (step.messageType === undefined || step.messageType === MessageType.REQUEST)
  );
}

/** Milliseconds as seconds; `undefined` for a value this check cannot read (a template). */
function toSeconds(value: unknown, absentMs?: number): number | undefined {
  if (value === undefined || value === null) {
    return absentMs === undefined ? undefined : absentMs / 1000;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value / 1000;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value) / 1000;
  return undefined;
}

function literalBootReason(value: unknown): string | undefined {
  return typeof value === 'string' && BOOT_REASONS.has(value) ? value : undefined;
}

function wholeSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeBoot(boot: Boot): string {
  return `${boot.reason ?? 'bootReason not a literal'}, uptimeSeconds ${boot.uptime ?? 'not a literal'}`;
}

function seconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
