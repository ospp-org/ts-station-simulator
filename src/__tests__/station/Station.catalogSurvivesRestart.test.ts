import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * A STATION KEEPS ITS SERVICE CATALOG ACROSS A RESTART - connect mode, the fixes session 2026-09-28.
 *
 * spec/profiles/device-management/update-service-catalog.md rule 5: "The station MUST persist the
 * catalog to non-volatile storage so it survives reboots" - the obligation a server relies on "when it
 * declines to re-push after a station reboot". And csms-server does decline: PublishFirstCatalogOnBoot
 * pushes a catalog only to a station that has never been sent one. No message lets a station ask for it
 * (UpdateServiceCatalog is Server -> Station; BootNotification's response carries none), so persisting
 * is the only conforming way to hold it.
 *
 * The simulator held the catalog in memory only. A `connect` station restarted after "Publica pe statie"
 * came back with its seed (`svc_wash_basic`) and refused the pay page's StartService 3004
 * INVALID_SERVICE; the payment was refunded in full (UAT, the fixes session's harness trap).
 *
 * A restart is a new process and therefore a new Station: that is what each case builds. Offline -
 * MqttConnection is stubbed, the certificate directory is a temp dir.
 */

const published: Array<{ topic: string; payload: string }> = [];
let tlsPaths: { key: string; cert: string } | null = null;

class MqttConnectionStub extends EventEmitter {
  setTls = vi.fn();
  destroyConnection = vi.fn();
  disconnect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  publish = vi.fn(async (topic: string, payload: string) => {
    published.push({ topic, payload: String(payload) });
  });
  onMessage = vi.fn();
  getTlsPaths = vi.fn(() => tlsPaths);
  connect = vi.fn(() => {
    setImmediate(() => this.emit('connect', {}));
  });
}

vi.mock('../../mqtt/MqttConnection.js', () => ({ MqttConnection: MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { UpdateServiceCatalogHandler } = await import('../../handlers/UpdateServiceCatalogHandler.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
const { OsppAction, MessageType, MessageSource, OSPP_PROTOCOL_VERSION, OsppErrorCode } = await import('@ospp/protocol');

const SESSION_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const STATION_ID = 'stn_cafe0001';
const BAY_ID = 'bay_cafe0001';

type StationInstance = InstanceType<typeof Station>;
type Restorable = { restoreCatalog?: () => Promise<boolean> };

/** One process's station, as `connect` builds it (persistCatalog) or as a scenario does (not). */
function power(persistCatalog: boolean): StationInstance {
  const station = new Station(
    {
      stationId: STATION_ID,
      firmwareVersion: '1.0.0',
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      serialNumber: 'SN-CAFE0001',
      bayCount: 1,
      timezone: 'Europe/Bucharest',
      bays: [
        {
          bayId: BAY_ID,
          bayNumber: 1,
          programs: [{ programNumber: 1, label: 'P1', available: true }],
          // The seed connect mode gives every bay (connectBays.ts) - what a restart came back with.
          services: [{ serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', available: true }],
        },
      ],
      behavior: { acceptRate: 1.0, responseDelayMs: [0, 0], heartbeatIntervalSec: 60, meterValuesIntervalSec: 30, autoRetryBoot: false },
      ...(persistCatalog ? { persistCatalog: true } : {}),
    },
    { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID },
  );
  station.sessionKey = SESSION_KEY;
  return station;
}

function request(action: string, payload: Record<string, unknown>) {
  return {
    messageId: `cmd_${action}_${published.length}`,
    messageType: MessageType.REQUEST,
    action,
    source: MessageSource.SERVER,
    timestamp: new Date().toISOString(),
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload,
  } as never;
}

async function publishCatalog(station: StationInstance): Promise<void> {
  await new UpdateServiceCatalogHandler().handle(
    request(OsppAction.UPDATE_SERVICE_CATALOG, {
      catalogVersion: '7',
      services: [
        {
          serviceId: 'svc_foam_deluxe',
          serviceName: 'Spuma Deluxe',
          pricingType: 'Fixed',
          priceFixedLocal: 1500,
          available: true,
          bindings: [{ bayNumber: 1, programNumber: 1 }],
        },
      ],
    }),
    station as never,
  );
}

/** The StartService answer the station publishes for `serviceId`. */
async function startAnswer(station: StationInstance, serviceId: string): Promise<Record<string, unknown>> {
  const before = published.length;
  await new StartServiceHandler().handle(
    request(OsppAction.START_SERVICE, {
      sessionId: 'sess_cafe0001',
      bayId: BAY_ID,
      serviceId,
      durationSeconds: 300,
      sessionSource: 'WebPayment',
      programNumber: 1,
    }),
    station as never,
  );
  const answer = published.slice(before).map((p) => JSON.parse(p.payload)).find((e) => e.action === OsppAction.START_SERVICE);
  return answer?.payload ?? {};
}

let dir: string;

beforeEach(async () => {
  published.length = 0;
  dir = await mkdtemp(path.join(tmpdir(), 'catalog-restart-'));
  const cert = path.join(dir, `${STATION_ID}.crt`);
  const key = path.join(dir, `${STATION_ID}.key`);
  await writeFile(cert, 'stub');
  await writeFile(key, 'stub');
  tlsPaths = { cert, key };
});

afterEach(async () => {
  tlsPaths = null;
  await rm(dir, { recursive: true, force: true });
});

describe('connect mode: the catalog a station accepted survives its restart', () => {
  it('RED: after a restart the station still sells the published service - StartService is not refused 3004', async () => {
    const before = power(true);
    await publishCatalog(before);
    // CONTROL: before the restart the station sells it.
    expect((await startAnswer(before, 'svc_foam_deluxe')).status).toBe('Accepted');

    const after = power(true);
    await (after as unknown as Restorable).restoreCatalog?.();

    const answer = await startAnswer(after, 'svc_foam_deluxe');
    expect(answer.errorCode, 'the restarted station refused the service it had accepted').not.toBe(OsppErrorCode.INVALID_SERVICE);
    expect(answer.status).toBe('Accepted');
  });

  it('RED: the restarted station reports the version it holds, not the empty string of a station that never held one', async () => {
    await publishCatalog(power(true));

    const after = power(true);
    await (after as unknown as Restorable).restoreCatalog?.();

    expect(after.currentCatalogVersion).toBe('7');
  });

  it('CONTROL - a station built without persistence, as a scenario builds it, keeps nothing on disk', async () => {
    await publishCatalog(power(false));

    expect((await readdir(dir)).filter((f) => f.includes('catalog'))).toEqual([]);
  });
});
