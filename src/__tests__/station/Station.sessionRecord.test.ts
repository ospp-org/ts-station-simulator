import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  elapse, wire, resetWire, fakeClock, certDir, connectConfig, startService, until,
  SESSION_KEY, STATION_ID, BAY_ID, SERVICE_ID,
} from '../helpers/stationHarness.js';

/*
 * M2 - THE SESSION RECORD, ON DISK (DESIGN-A2 S2).
 *
 * After any restart the station MUST report every session it held (S3), so it MUST keep every
 * live session across one: its sessionId, bayId, start, booked duration and the delivered time,
 * updated as it delivers - at least every 10 s, the bound the reported time after a power loss
 * carries. And the record is written BEFORE the StartService Accepted leaves: start-service.md §6
 * rule 9, "before energising anything, the station MUST durably record the command".
 *
 * Connect mode kept its sessions in an in-memory Map and nothing else (M-SIM 1.1): a restarted
 * process held none of them, its bays reported Available, and the sessions were left to the sweep.
 *
 * Where it lives: beside the station's certificates, as the catalog does (CatalogStore) - the
 * state a station already keeps on disk.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');

interface StoredRecord {
  sessionId: string;
  bayId: string;
  serviceId: string;
  startedAt: string;
  durationSeconds: number;
  deliveredSeconds: number;
}

let dir: string;
let cleanup: () => Promise<void>;

function recordFile(): string {
  return path.join(dir, `${STATION_ID}-sessions.json`);
}

function storedSessions(): StoredRecord[] {
  if (!existsSync(recordFile())) return [];
  return (JSON.parse(readFileSync(recordFile(), 'utf-8')) as { sessions?: StoredRecord[] }).sessions ?? [];
}

beforeEach(async () => {
  resetWire();
  fakeClock();
  ({ dir, cleanup } = await certDir());
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await cleanup();
});

describe('M2 - a connect-mode station keeps every live session on disk', () => {
  it('RED: the session is recorded before the StartService Accepted leaves, and its delivered time is kept at most 10 s old while it runs', async () => {
    const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
    await station.connect();
    station.sessionKey = SESSION_KEY;
    station.bootAccepted = true;

    // Read the disk AT THE INSTANT the RESPONSE is handed to the link - not after it.
    let atResponse: StoredRecord[] | null = null;
    wire.onPublish = (f) => {
      if (f.action === 'StartService' && f.messageType === 'Response') atResponse = storedSessions();
    };

    await new StartServiceHandler().handle(startService('sess_m2record', 60), station as never);

    expect(atResponse, 'no session record on disk when the StartService Accepted left').not.toBeNull();
    const [record] = atResponse as unknown as StoredRecord[];
    expect(record, `nothing at ${recordFile()} when the RESPONSE left`).toBeDefined();
    expect(record).toMatchObject({
      sessionId: 'sess_m2record',
      bayId: BAY_ID,
      serviceId: SERVICE_ID,
      durationSeconds: 60,
      deliveredSeconds: 0,
    });
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);

    // 25 s into the wash the record must say at least 15 s were delivered: never more than 10 s behind.
    await elapse(25_000);
    await until(() => (storedSessions()[0]?.deliveredSeconds ?? 0) >= 15, 'a delivered-time checkpoint at most 10 s old');
    const delivered = storedSessions()[0].deliveredSeconds;
    expect(delivered).toBeGreaterThanOrEqual(15);
    expect(delivered).toBeLessThanOrEqual(25);
  });

  it('RED: once its SessionEnded is published the session leaves the record', async () => {
    const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
    await station.connect();
    station.sessionKey = SESSION_KEY;
    station.bootAccepted = true;

    await new StartServiceHandler().handle(startService('sess_m2gone', 30), station as never);
    await until(() => storedSessions().some((s) => s.sessionId === 'sess_m2gone'), 'the record of the running wash');

    await elapse(30_000);
    await until(() => wire.frames.some((f) => f.action === 'SessionEnded'), 'the SessionEnded at the booked end');
    // The end is written twice: held before it is published (a power loss in between must still find
    // it), released after. Read once both have landed.
    const held = (): unknown[] =>
      (JSON.parse(readFileSync(recordFile(), 'utf-8')) as { heldSessionEnded?: unknown[] }).heldSessionEnded ?? [];
    await until(() => existsSync(recordFile()) && storedSessions().length === 0 && held().length === 0, 'the record emptied after the SessionEnded');

    expect(storedSessions()).toEqual([]);
    expect(held(), 'a published SessionEnded is still held for a replay').toEqual([]);
  });
});
