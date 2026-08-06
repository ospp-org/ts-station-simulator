import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/*
 * A TriggerMessage is not a power-cycle — the BootNotification it emits must say so.
 *
 * The server asks the station to re-announce itself; nothing reboots. Reporting
 * `uptimeSeconds: 0` there tells the CSMS the station just power-cycled, and its
 * gate (csms BootNotificationHandler.php — bootTime = now() - uptimeSeconds; rows
 * with started_at < bootTime, and pending rows with created_at < bootTime, are
 * force-failed and refunded) then kills every live wash on the station. A server
 * cannot disbelieve a station asserting it just power-cycled, so this is closable
 * only on the station side — and this simulator is the only second implementation
 * of the protocol, so it is the station that produces that input.
 *
 * Station.retryBoot() already derives every one of these fields from live state.
 * The defect was a second, hand-rolled payload literal on the trigger path that
 * disagreed with it in three places (uptimeSeconds, bootReason,
 * deviceManagementSupported). The last test here pins the CLASS rather than the
 * three instances: the two paths must emit the same payload, so a field added to
 * one cannot silently diverge on the other.
 *
 * On bootReason: the field is "reason the station booted"
 * (spec/profiles/core/boot-notification.md:29) — a property of the last boot
 * EPISODE, not of the send. A trigger re-announces an episode; it does not start
 * one. So the truthful value is whatever actually booted the station, which is
 * exactly what retryBoot() reports. See Station.currentBootReason.
 *
 * Fully offline: MqttConnection is stubbed; no broker, no csms.
 */
const publishCalls: Array<{ topic: string; payload: string }> = [];

class MqttConnectionStub extends EventEmitter {
  setTls = vi.fn();
  destroyConnection = vi.fn();
  disconnect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  publish = vi.fn(async (topic: string, payload: string) => {
    publishCalls.push({ topic, payload: String(payload) });
  });
  onMessage = vi.fn();
  getTlsPaths = vi.fn(() => null);
  connect = vi.fn(() => {
    setImmediate(() => this.emit('connect', {}));
  });
}

vi.mock('../../mqtt/MqttConnection.js', () => ({
  MqttConnection: MqttConnectionStub,
}));

// Import AFTER the mock so Station picks up the stub.
const { Station } = await import('../../station/Station.js');
const { TriggerMessageHandler } = await import('../../handlers/TriggerMessageHandler.js');
const {
  OsppAction,
  MessageType,
  MessageSource,
  BootReason,
  OSPP_PROTOCOL_VERSION,
} = await import('@ospp/protocol');

type BootPayload = {
  uptimeSeconds: number;
  bootReason: string;
  capabilities: Record<string, boolean | undefined>;
};

function buildStation(): InstanceType<typeof Station> {
  return new Station(
    {
      stationId: 'stn_test0001',
      firmwareVersion: '1.0.0',
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      serialNumber: 'SN-TEST0001',
      bayCount: 1,
      timezone: 'UTC',
      bays: [{ bayId: 'bay_test0001', bayNumber: 1, programs: [{ programNumber: 1, label: 'P1', available: true }], services: [] }],
      behavior: {
        acceptRate: 1.0,
        responseDelayMs: [0, 0],
        heartbeatIntervalSec: 60,
        meterValuesIntervalSec: 30,
        autoRetryBoot: true,
      },
    },
    { mqttUrl: 'mqtt://localhost:1883', stationId: 'stn_test0001' },
  );
}

/** A TriggerMessage REQUEST asking for the given message. */
function triggerEnvelope(requestedMessage: string) {
  return {
    messageId: 'cmd_trigger_1',
    messageType: MessageType.REQUEST,
    action: OsppAction.TRIGGER_MESSAGE,
    source: MessageSource.CSMS,
    timestamp: '2026-07-21T10:00:00.000Z',
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: { requestedMessage },
  };
}

/** Every BootNotification REQUEST payload published so far, in order. */
function bootPayloads(): BootPayload[] {
  return publishCalls
    .map(c => JSON.parse(c.payload))
    .filter(
      (e: { action: string; messageType: string }) =>
        e.action === OsppAction.BOOT_NOTIFICATION && e.messageType === MessageType.REQUEST,
    )
    .map((e: { payload: BootPayload }) => e.payload);
}

const POWER_ON_AT = new Date('2026-07-21T08:00:00.000Z');

describe('TriggerMessage → BootNotification is truthful about the station, not the send', () => {
  beforeEach(() => {
    publishCalls.length = 0;
    // Fake ONLY Date so elapsed time is deterministic; setImmediate stays real
    // (the connection stub resolves connect() through it).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(POWER_ON_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the REAL elapsed uptime, not a hardcoded 0 that force-fails live washes', async () => {
    const station = buildStation();
    await station.connect();

    // Two hours into a healthy connection, the server asks for a re-announce.
    vi.setSystemTime(new Date(POWER_ON_AT.getTime() + 7200_000));
    await new TriggerMessageHandler().handle(
      triggerEnvelope('BootNotification') as never,
      station as never,
    );

    const [boot] = bootPayloads();
    expect(boot).toBeDefined();
    // The server computes bootTime = now() - 7200s, so a wash started 10 minutes
    // ago has started_at >= bootTime and SURVIVES. A literal 0 sweeps it.
    expect(boot.uptimeSeconds).toBe(7200);
  });

  it('reports the station\'s actual boot episode, not a hardcoded PowerOn', async () => {
    const station = buildStation();
    await station.connect();

    // A cert renewal re-handshook the link — the station's episode reason is no
    // longer PowerOn. A trigger re-announces that episode; it does not start one.
    vi.setSystemTime(new Date(POWER_ON_AT.getTime() + 7200_000));
    await station.reconnectWithRenewedCertificate();
    await new TriggerMessageHandler().handle(
      triggerEnvelope('BootNotification') as never,
      station as never,
    );

    const [boot] = bootPayloads();
    expect(boot).toBeDefined();
    expect(boot.bootReason).not.toBe(BootReason.POWER_ON);
    expect(boot.bootReason).toBe(BootReason.ERROR_RECOVERY);
  });

  it('a genuine power-on still reports PowerOn — the trigger does not invent a reason', async () => {
    const station = buildStation();
    await station.connect();

    vi.setSystemTime(new Date(POWER_ON_AT.getTime() + 40_000_000));
    await new TriggerMessageHandler().handle(
      triggerEnvelope('BootNotification') as never,
      station as never,
    );

    const [boot] = bootPayloads();
    // True on both counts: the station powered on 40000s ago, and that is still
    // why it is up. Truthful uptime is what preserves the sessions here — the
    // reason is reported because it is the fact, not to buy server behaviour.
    expect(boot.bootReason).toBe(BootReason.POWER_ON);
    expect(boot.uptimeSeconds).toBe(40_000);
  });

  it('declares deviceManagementSupported, so one station does not advertise two capability sets', async () => {
    const station = buildStation();
    await station.connect();

    await new TriggerMessageHandler().handle(
      triggerEnvelope('BootNotification') as never,
      station as never,
    );

    const [boot] = bootPayloads();
    // Omitting it made the CSMS store device_management_supported=false and
    // refuse every config push — see Station.retryBoot().
    expect(boot.capabilities.deviceManagementSupported).toBe(true);
  });

  it('emits the SAME payload as the boot path — the anti-divergence pin', async () => {
    const station = buildStation();
    await station.connect();
    vi.setSystemTime(new Date(POWER_ON_AT.getTime() + 3600_000));

    await new TriggerMessageHandler().handle(
      triggerEnvelope('BootNotification') as never,
      station as never,
    );
    await station.retryBoot();

    const [triggered, direct] = bootPayloads();
    expect(triggered).toBeDefined();
    expect(direct).toBeDefined();
    // Not "these three fields agree" — the whole payload agrees, so a field
    // added to the boot path cannot silently go missing on the trigger path.
    expect(triggered).toEqual(direct);
  });
});
