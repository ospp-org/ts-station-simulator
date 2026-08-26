import { OsppAction, MessageType, type OsppEnvelope } from '@ospp/protocol';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

const ACTION_MAP: ReadonlyMap<string, OsppAction> = new Map(
  Object.entries(OsppAction).map(([, value]) => [value, value]),
);

function mapToOsppAction(name: string): OsppAction {
  const action = ACTION_MAP.get(name);
  if (!action) {
    throw new Error(`Unknown OSPP action: ${name}`);
  }
  return action;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Pick the OSPP messageId this WaitForStep should match against, per
 * Drift 7-E. OSPP correlates a Response to its Request via messageId
 * equality (envelope has no separate correlationId field).
 *
 * Order of precedence:
 *  1. Explicit `correlationId` on the YAML step → use as-is.
 *  2. `messageType === Response` → FIFO scan of `context.sentMessages`
 *     for the first Request of the same action whose messageId hasn't
 *     yet been claimed by an earlier WaitForStep.
 *  3. Otherwise undefined — fall back to first-match-wins on action+type
 *     (Request waits are server-initiated; no outbound to correlate to).
 */
function pickExpectedMessageId(
  context: ScenarioContext,
  action: OsppAction,
  messageType: string | undefined,
  explicit: string | undefined,
): string | undefined {
  if (explicit) return explicit;
  if (messageType !== MessageType.RESPONSE) return undefined;
  for (const sent of context.sentMessages) {
    if (
      sent.action === action &&
      sent.messageType === MessageType.REQUEST &&
      !context.consumedSentMessageIds.has(sent.messageId)
    ) {
      return sent.messageId;
    }
  }
  return undefined;
}

/**
 * `expect_silence: true` — the inverse wait. Passes iff NOTHING matching arrives
 * before `timeout_ms`, and FAILS if something does.
 *
 * Built for the branches csms-server answers by saying nothing. Its inbound-MAC
 * gate is the case that forced it: every failure path in
 * `VerifyIncomingMiddleware.php` ends in `VerificationResult::rejected(...)`, and
 * `MessageDispatcher.php:169` then `return null`s — no error is published, the
 * station is not disconnected, and the worker even records `outcome="ok"`. The
 * ONLY thing a station can observe is that its REQUEST is never answered. With
 * no way to assert an absence, three server branches could be provoked and none
 * could be checked.
 *
 * An absence is a weak proof on its own — a dead link, a wedged worker or a
 * mistyped topic all produce the same silence, which is the hollow-safety-net
 * shape. So every scenario using this MUST follow it with an ordinary `wait_for`
 * on a CLEAN message of the same action, and that control is what makes the
 * silence attributable: the link answered a second later, so the first message
 * was refused rather than lost. The step cannot enforce that pairing, so it is
 * stated here and at each call site.
 */
/**
 * Schema refusals recorded since `mark`, for this action, rendered for a human.
 *
 * A refused message is not emitted, so from the step's point of view it never
 * arrived — the wait times out and blames the clock. This turns that into the
 * real reason. Only violations recorded AFTER the step began are considered:
 * the router's log spans the station's whole life, and an earlier step's
 * refusal attributed to a later timeout would be a confident wrong answer.
 */
function refusalNote(
  station: Station,
  action: OsppAction,
  messageType: MessageType | undefined,
  mark: number,
): string {
  const since = station.router.schemaViolations
    .slice(mark)
    .filter((v) => v.action === action && (!messageType || v.messageType === messageType));
  if (since.length === 0) return '';
  const rendered = since
    .map((v) => `${v.schemaKey}: ${v.errors.join('; ')} | payload=${JSON.stringify(v.payload)}`)
    .join(' || ');
  // Say which of the two actually happened. Under `warn` the message was
  // delivered and this note is a bystander observation; only under `strict` is
  // the non-conformance the REASON nothing arrived.
  const verb = since.every((v) => v.refused)
    ? 'were REFUSED as non-conformant, which is why nothing arrived'
    : 'were recorded as non-conformant (warn mode — they were still delivered, so this is ' +
      'context, not necessarily the cause)';
  return ` — but ${since.length} matching message(s) ${verb} (server defect): ${rendered}`;
}

async function waitForSilence(
  station: Station,
  action: OsppAction,
  messageType: MessageType | undefined,
  expectedMessageId: string | undefined,
  matches: (env: OsppEnvelope) => boolean,
  timeoutMs: number,
  messageName: string,
  violationMark: number,
): Promise<void> {
  // Anything already buffered from before this step counts as arrival — draining
  // it silently would let a message the server DID send satisfy "silence".
  const buffered = station.router
    .drainBuffered(action, messageType, expectedMessageId)
    .filter(matches);
  if (buffered.length > 0) {
    throw new Error(
      `expect_silence: expected no ${messageName}${messageType ? ` ${messageType}` : ''} ` +
        `but one was already buffered (messageId=${buffered[0].messageId})`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    const handler = (env: OsppEnvelope): void => {
      if (!matches(env)) return;
      clearTimeout(timer);
      station.router.offAction(action, handler);
      reject(
        new Error(
          `expect_silence: expected no ${messageName}${messageType ? ` ${messageType}` : ''} ` +
            `within ${timeoutMs}ms, but one arrived (messageId=${env.messageId})`,
        ),
      );
    };

    const timer = setTimeout(() => {
      station.router.offAction(action, handler);
      // A schema-refused message is NOT silence. In strict mode the router
      // neither emits nor buffers it, so this step would otherwise pass — and
      // pass for the one reason it must never pass for: the server DID answer,
      // and the answer was malformed. Left unhandled, arming the inbound gate
      // would have converted three real refusal proofs into vacuous ones.
      const refused = refusalNote(station, action, messageType, violationMark);
      if (refused !== '') {
        reject(
          new Error(
            `expect_silence: expected no ${messageName}${messageType ? ` ${messageType}` : ''}` +
              ` within ${timeoutMs}ms, and none was DELIVERED${refused}`,
          ),
        );
        return;
      }
      resolve();
    }, timeoutMs);

    station.router.onAction(action, handler);
  });
}

export class WaitForStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const messageName = definition.message as string;
    if (!messageName) {
      throw new Error('WaitForStep requires a "message" field');
    }

    const action = mapToOsppAction(messageName);
    const messageType = definition.messageType as string | undefined;
    const expectSilence = definition.expect_silence === true;
    if (expectSilence && definition.capture !== undefined) {
      throw new Error(
        'WaitForStep: "capture" is meaningless with "expect_silence: true" — there is ' +
          'no message to capture from. Remove one of the two.',
      );
    }
    // 15s default gives ~30-50x headroom over typical ~300ms round-trip post-bridge-fix
    // (commit 44f81d1 in csms-mqtt-bridge). Scenarios needing tighter assertion
    // should set timeout_ms explicitly in YAML.
    const timeoutMs = (definition.timeout_ms as number) ?? 15000;
    const explicitCorrelation = definition.correlationId as string | undefined;

    const expectedMessageId = pickExpectedMessageId(
      context,
      action,
      messageType,
      explicitCorrelation,
    );

    // Taken BEFORE anything can arrive for this step, so the attribution below
    // can tell this step's refusals from every earlier one.
    const violationMark = station.router.schemaViolations.length;

    const matches = (env: OsppEnvelope): boolean => {
      if (messageType && env.messageType !== (messageType as MessageType)) {
        return false;
      }
      if (expectedMessageId && env.messageId !== expectedMessageId) {
        return false;
      }
      return true;
    };

    if (expectSilence) {
      await waitForSilence(
        station,
        action,
        messageType as MessageType | undefined,
        expectedMessageId,
        matches,
        timeoutMs,
        messageName,
        violationMark,
      );
      // Claim the correlation anyway. The outbound REQUEST this step was waiting
      // on is spent — the server refused it and will never answer — so a LATER
      // `wait_for ... Response` must correlate to the NEXT unconsumed Request
      // (the clean control message), not re-target this one and time out on a
      // response that can no longer exist.
      if (expectedMessageId && !explicitCorrelation) {
        context.consumedSentMessageIds.add(expectedMessageId);
      }

      return;
    }

    const envelope = await new Promise<OsppEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        station.router.offAction(action, handler);
        const corrSuffix = expectedMessageId
          ? ` (correlationId=${expectedMessageId})`
          : '';
        reject(
          new Error(
            `Timeout waiting for ${messageName}${messageType ? ` ${messageType}` : ''}${corrSuffix} after ${timeoutMs}ms` +
              refusalNote(station, action, messageType as MessageType | undefined, violationMark),
          ),
        );
      }, timeoutMs);

      const handler = (env: OsppEnvelope): void => {
        if (!matches(env)) return;
        clearTimeout(timer);
        station.router.offAction(action, handler);
        // Drain any other correlated duplicates so they don't linger.
        // Non-correlated buffered envelopes remain available for future
        // WaitForSteps awaiting their own correlationId.
        station.router.drainBuffered(
          action,
          messageType as MessageType | undefined,
          expectedMessageId,
        );
        resolve(env);
      };

      const buffered = station.router.drainBuffered(
        action,
        messageType as MessageType | undefined,
        expectedMessageId,
      );
      const match = buffered[0];
      if (match) {
        clearTimeout(timer);
        resolve(match);
        return;
      }

      station.router.onAction(action, handler);
    });

    context.receivedMessages.push(envelope);
    if (expectedMessageId && !explicitCorrelation) {
      context.consumedSentMessageIds.add(expectedMessageId);
    }

    if (definition.capture && typeof definition.capture === 'object') {
      for (const [varName, path] of Object.entries(
        definition.capture as Record<string, string>,
      )) {
        const value = getNestedValue(envelope, path);
        context.captured.set(varName, value);
      }
    }
  }
}
