import { describe, it, expect } from 'vitest';
import { MessageType, OsppAction, type OsppEnvelope } from '@ospp/protocol';
import { BootNotificationHandler } from '../../handlers/BootNotificationHandler.js';
import type { Handler, StationContext } from '../../handlers/Handler.js';
import { validateInbound } from '../../mqtt/inboundSchema.js';

/*
 * A `Pending` BOOT CARRIES A SESSION KEY, AND THE STATION MUST STORE IT.
 *
 * `profiles/core/boot-notification.md:71` rule 5 — "On `Pending`: the station
 * MUST store the `sessionKey` — a `Pending` station answers signed commands and
 * needs it (§5.3)". §5.3 at :115 — "Every `Accepted` and every `Pending`
 * response MUST carry `sessionKey`. The requirement is unconditional and is
 * enforced by the schema." And :117 says what withholding it costs: "the server
 * may not send the command, the station may not accept it, and the station may
 * not answer it — which closes the exact channel the `Pending` window exists to
 * keep open."
 *
 * `05-state-machines.md:57` says the same from the state's side: Pending "does
 * hold a session key — the response that put it here carries one — because
 * every command it answers is signed". `Rejected` at :58 holds none, and that
 * asymmetry is the whole point — the simulator collapsed the two.
 *
 * MEASURED CONSEQUENCE on the live run of 2026-09-11: the station refused
 * `UpdateServiceCatalog` and `ChangeConfiguration` with `1013 MAC_MISSING`.
 *
 * THE FIXTURE IS SCHEMA-CHECKED, and that is not decoration. The one existing
 * test that looks like Pending coverage — `heartbeatIsDefault.test.ts:177` —
 * builds its Pending payload as `...(status === 'Accepted' ? { sessionKey } :
 * {})`, so the payload is schema-INVALID, the strict inbound gate refuses it,
 * the handler never runs and the assertion passes against an empty array that
 * was always going to be empty. A Pending test that does not prove its own
 * fixture would reach the wire is the same trap.
 */

const PENDING_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const ACCEPTED_KEY = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');

function makeContext(): StationContext {
  return {
    config: {
      stationId: 'stn_pendingkey01',
      bays: [],
      // Deterministic: no timer re-entry from the retry branch.
      behavior: { autoRetryBoot: false },
    },
    sender: { async send(): Promise<void> {} },
    sessionKey: null as string | null,
    getBayState: () => 'Available',
    setBayState: (): void => {},
    startHeartbeat(): void {},
    stopHeartbeat(): void {},
    async retryBoot(): Promise<void> {},
    destroyConnection(): void {},
  } as unknown as StationContext;
}

function bootResponse(payload: Record<string, unknown>): OsppEnvelope {
  return {
    messageId: 'msg_boot_pendingkey',
    messageType: MessageType.RESPONSE,
    action: OsppAction.BOOT_NOTIFICATION,
    timestamp: '2026-09-11T00:00:00.000Z',
    source: 'Server',
    protocolVersion: '0.2.1',
    payload,
  } as unknown as OsppEnvelope;
}

const pendingBoot = (): OsppEnvelope =>
  bootResponse({
    status: 'Pending',
    heartbeatIntervalSec: 30,
    serverTime: '2026-09-11T00:00:00.000Z',
    retryInterval: 30,
    sessionKey: PENDING_KEY,
  });

const acceptedBoot = (): OsppEnvelope =>
  bootResponse({
    status: 'Accepted',
    heartbeatIntervalSec: 30,
    serverTime: '2026-09-11T00:00:00.000Z',
    sessionKey: ACCEPTED_KEY,
  });

const rejectedBoot = (): OsppEnvelope =>
  bootResponse({
    status: 'Rejected',
    heartbeatIntervalSec: 30,
    serverTime: '2026-09-11T00:00:00.000Z',
    retryInterval: 30,
    errorCode: 3018,
    errorText: 'TOPOLOGY_MISMATCH',
  });

describe('a Pending boot stores its session key', () => {
  it('CONTROL: the Pending fixture is what the strict inbound gate would actually deliver', () => {
    // Without this the test below could assert against a payload the router
    // refuses, and would pass for the same reason the vacuous one does.
    const verdict = validateInbound(pendingBoot());

    expect(
      verdict.kind,
      `Pending fixture rejected by the schema: ${JSON.stringify(verdict)}`,
    ).toBe('conformant');
  });

  it('CONTROL: the schema is the thing refusing — a Pending WITHOUT a key is a violation', () => {
    // Proves the gate above is live rather than permissive, so "conformant"
    // means something. boot-notification-response.schema.json requires
    // sessionKey when status is Accepted or Pending.
    const { sessionKey: _dropped, ...withoutKey } = pendingBoot().payload as Record<string, unknown>;

    expect(validateInbound(bootResponse(withoutKey)).kind).toBe('violation');
  });

  it('RED: stores the sessionKey a Pending response carries', async () => {
    const handler = new BootNotificationHandler() as unknown as Handler;
    const station = makeContext();

    await handler.handle(pendingBoot(), station);

    expect(station.sessionKey).toBe(PENDING_KEY);
  });

  it('CONTROL: an Accepted boot still stores its key', async () => {
    const handler = new BootNotificationHandler() as unknown as Handler;
    const station = makeContext();

    await handler.handle(acceptedBoot(), station);

    expect(station.sessionKey).toBe(ACCEPTED_KEY);
  });

  it('CONTROL: a Rejected boot stores nothing — it holds no key, and may not', async () => {
    // `05-state-machines.md:58` — Rejected "holds no session key, so it could
    // not verify one". Guards against a fix that stores unconditionally.
    const handler = new BootNotificationHandler() as unknown as Handler;
    const station = makeContext();

    await handler.handle(rejectedBoot(), station);

    expect(station.sessionKey).toBeNull();
  });

  it('CONTROL: a Rejected boot does not erase a key an earlier Accepted boot stored', async () => {
    const handler = new BootNotificationHandler() as unknown as Handler;
    const station = makeContext();
    station.sessionKey = ACCEPTED_KEY;

    await handler.handle(rejectedBoot(), station);

    // Discarding is tied to the MQTT session ending (06-security.md:1070),
    // not to a boot verdict — see Station.disconnect.
    expect(station.sessionKey).toBe(ACCEPTED_KEY);
  });
});
