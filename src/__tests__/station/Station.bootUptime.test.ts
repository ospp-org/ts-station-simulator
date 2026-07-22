import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * A cert renewal is NOT a power-cycle — the BootNotification must say so.
 *
 * CertificateInstallHandler installs the renewed leaf, re-handshakes mTLS
 * (disconnect()+connect()) and re-boots. The station never rebooted: it only
 * reconnected. Reporting `uptimeSeconds: 0` + `bootReason: PowerOn` there tells
 * the CSMS it just power-cycled, and the server's uptime-continuity gate
 * (csms BootNotificationHandler.php — bootTime = now() - uptimeSeconds; sessions
 * with started_at < bootTime are force-failed) then kills and refunds EVERY live
 * wash on the station mid-service.
 *
 * The gate is deliberate and correct — it exists to PRESERVE sessions across a
 * mere reconnect. These tests pin that the simulator stops lying to it, while
 * keeping the genuine power-on path (uptime ~0 + PowerOn) intact, because the
 * server MUST still force-fail sessions a real reboot interrupted.
 *
 * Fully offline: MqttConnection is stubbed; no broker, no csms.
 */
const publishCalls: Array<{ topic: string; payload: string }> = [];

let tlsPaths: { key: string; cert: string } | null = null;

class MqttConnectionStub extends EventEmitter {
  setTls = vi.fn();
  destroyConnection = vi.fn();
  disconnect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  publish = vi.fn(async (topic: string, payload: string) => {
    publishCalls.push({ topic, payload: String(payload) });
  });
  onMessage = vi.fn();
  getTlsPaths = vi.fn(() => tlsPaths);
  connect = vi.fn(() => {
    setImmediate(() => this.emit('connect', {}));
  });
}

vi.mock('../../mqtt/MqttConnection.js', () => ({
  MqttConnection: MqttConnectionStub,
}));

// Import AFTER the mock so Station picks up the stub.
const { Station } = await import('../../station/Station.js');
const { OsppAction, BootReason } = await import('@ospp/protocol');
const { CertificateInstallHandler } = await import(
  '../../handlers/CertificateInstallHandler.js'
);
const { MessageType, MessageSource, OSPP_PROTOCOL_VERSION } = await import('@ospp/protocol');

type BootPayload = { uptimeSeconds: number; bootReason: string };

function buildStation() {
  return new Station(
    {
      stationId: 'stn_test0001',
      firmwareVersion: '1.0.0',
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      serialNumber: 'SN-TEST0001',
      bayCount: 1,
      timezone: 'UTC',
      bays: [{ bayId: 'bay_test0001', bayNumber: 1, services: [] }],
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

describe('BootNotification uptime/bootReason truthfulness', () => {
  beforeEach(() => {
    publishCalls.length = 0;
    tlsPaths = null;
    // Fake ONLY Date so elapsed time is deterministic; setImmediate stays real
    // (the connection stub resolves connect() through it).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(POWER_ON_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initial power-on reports uptime ~0 and PowerOn (the genuine power-cycle path, unchanged)', async () => {
    const station = buildStation();
    await station.connect();

    await station.retryBoot();

    const [boot] = bootPayloads();
    expect(boot.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(boot.uptimeSeconds).toBeLessThanOrEqual(1);
    expect(boot.bootReason).toBe(BootReason.POWER_ON);
  });

  it('renewal reconnect reports the REAL elapsed uptime and a non-PowerOn reason', async () => {
    const station = buildStation();
    await station.connect();
    await station.retryBoot(); // initial boot at T0

    // Station runs for two hours, then the CSMS renews its certificate.
    vi.setSystemTime(new Date(POWER_ON_AT.getTime() + 7200_000));
    await station.reconnectWithRenewedCertificate();
    await station.retryBoot();

    const renewalBoot = bootPayloads()[1];
    // Truthful: the station has been powered on for 7200s. The server's gate
    // computes bootTime = now() - 7200s, so a wash started 10 minutes ago has
    // started_at >= bootTime and SURVIVES.
    expect(renewalBoot.uptimeSeconds).toBe(7200);
    // A reconnect is not a power-cycle.
    expect(renewalBoot.bootReason).not.toBe(BootReason.POWER_ON);
    expect(renewalBoot.bootReason).toBe(BootReason.ERROR_RECOVERY);
  });

  it('CertificateInstallHandler end-to-end: the boot it triggers carries truthful uptime on the wire', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'renew-boot-'));
    tlsPaths = {
      key: path.join(dir, 'stn.key.pem'),
      cert: path.join(dir, 'stn.cert.pem'),
    };
    await writeFile(tlsPaths.key, 'OLD-KEY');
    await writeFile(tlsPaths.cert, 'OLD-CERT');

    const station = buildStation();
    await station.connect();
    await station.retryBoot(); // initial boot at T0
    station.pendingRenewalKeyPem = '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----';

    // 90 minutes of uptime, then the server pushes the renewed leaf.
    vi.setSystemTime(new Date(POWER_ON_AT.getTime() + 5400_000));
    await new CertificateInstallHandler().handle(
      {
        messageId: 'cmd_install_1',
        messageType: MessageType.REQUEST,
        action: OsppAction.CERTIFICATE_INSTALL,
        source: MessageSource.CSMS,
        timestamp: '2026-07-21T09:30:00.000Z',
        protocolVersion: OSPP_PROTOCOL_VERSION,
        payload: {
          certificateType: 'StationCertificate',
          certificate: '-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----',
        },
      } as never,
      station as never,
    );

    const renewalBoot = bootPayloads()[1];
    expect(renewalBoot).toBeDefined();
    expect(renewalBoot.uptimeSeconds).toBe(5400);
    expect(renewalBoot.bootReason).not.toBe(BootReason.POWER_ON);
  });

  it('a genuine power-cycle (fresh Station) is back to uptime ~0 and PowerOn — the server MUST still fail interrupted sessions', async () => {
    const first = buildStation();
    await first.connect();
    vi.setSystemTime(new Date(POWER_ON_AT.getTime() + 7200_000));
    await first.reconnectWithRenewedCertificate();
    await first.retryBoot();
    publishCalls.length = 0;

    // Power-cycle: the process restarts, so a NEW Station is constructed. Its
    // power-on instant is now, and the renewal reason does not survive it.
    const rebooted = buildStation();
    await rebooted.connect();
    await rebooted.retryBoot();

    const [boot] = bootPayloads();
    expect(boot.uptimeSeconds).toBeLessThanOrEqual(1);
    expect(boot.bootReason).toBe(BootReason.POWER_ON);
  });

  it('a plain boot retry (Rejected/Pending) keeps PowerOn but still reports real elapsed uptime', async () => {
    const station = buildStation();
    await station.connect();
    await station.retryBoot();

    // Server answered Rejected with retryInterval=30; the handler retries.
    vi.setSystemTime(new Date(POWER_ON_AT.getTime() + 30_000));
    await station.retryBoot();

    const retryBootPayload = bootPayloads()[1];
    // A retry re-sends the SAME boot episode — the reason is unchanged...
    expect(retryBootPayload.bootReason).toBe(BootReason.POWER_ON);
    // ...and the uptime is still the truth, which stays safely near zero right
    // after a real power-on, so an interrupted session is still force-failed.
    expect(retryBootPayload.uptimeSeconds).toBe(30);
  });
});
