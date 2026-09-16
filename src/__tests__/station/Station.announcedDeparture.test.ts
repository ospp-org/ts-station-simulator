import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    setTimeout(() => this.emit('connect', { cmd: 'connack' }), 0);
  }
  end = vi.fn((_force?: boolean, _opts?: object, cb?: () => void) => { cb?.(); return this; });
  subscribe = vi.fn((_t: string, _o: object, cb?: (e?: Error) => void) => { cb?.(); return this; });
  publish = vi.fn((_t: string, _p: unknown, _o: object, cb?: (e?: Error) => void) => { cb?.(); return this; });
  stream = { destroy: vi.fn() };
}

vi.mock('mqtt', () => ({
  connect: vi.fn(() => new FakeMqttClient()),
}));

const { Station } = await import('../../station/Station.js');
const { FrameJournal, resolveJournalSink, DEFAULT_JOURNAL_DIR } = await import('../../mqtt/FrameJournal.js');
const { BayStatus } = await import('@ospp/protocol');

function buildStation(journal?: InstanceType<typeof FrameJournal>) {
  return new Station(
    {
      stationId: 'stn_deadbeef',
      firmwareVersion: '1.0.0',
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      serialNumber: 'SN-TEST',
      bayCount: 1,
      timezone: 'Europe/Bucharest',
      bays: [{
        bayId: 'bay_deadbeef01',
        bayNumber: 1,
        programs: [{ programNumber: 1, label: 'Basic Wash', available: true }],
        services: [{ serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', available: true }],
      }],
      behavior: {
        acceptRate: 1, responseDelayMs: [0, 0], heartbeatIntervalSec: 60,
        meterValuesIntervalSec: 30, autoRetryBoot: false,
      },
    },
    { mqttUrl: 'mqtt://x', stationId: 'stn_deadbeef', ...(journal ? { journal } : {}) },
  );
}

describe('the announced departure lands on the frame journal', () => {
  let journal: InstanceType<typeof FrameJournal>;

  beforeEach(() => {
    journal = new FrameJournal();
  });

  it('disconnect({announceDeparture:true}) journals exactly one outbound PlannedShutdown', async () => {
    const station = buildStation(journal);
    await station.connect();
    // A station only announces from ONLINE — the lifecycle guard in
    // announcePlannedShutdown() is what keeps a refused connection from hanging
    // the teardown. connect() leaves it ONLINE.
    await station.disconnect({ announceDeparture: true });

    expect(journal.count({ direction: 'out', action: 'ConnectionLost' })).toBe(1);
    const [bye] = journal.select({ direction: 'out', action: 'ConnectionLost' });
    const envelope = JSON.parse(bye.payload) as { messageType: string; payload: { reason: string; stationId: string } };
    expect(envelope.messageType).toBe('Event');
    expect(envelope.payload.reason).toBe('PlannedShutdown');
    expect(envelope.payload.stationId).toBe('stn_deadbeef');
  });

  it('the goodbye is the LAST frame out — it is published after everything still owed', async () => {
    const station = buildStation(journal);
    await station.connect();
    await station.retryBoot();
    await station.disconnect({ announceDeparture: true });

    const outbound = journal.select({ direction: 'out' });
    expect(outbound.length).toBeGreaterThanOrEqual(2);
    expect(outbound[outbound.length - 1].action).toBe('ConnectionLost');
  });

  it('the default disconnect still says NOTHING — `fault: disconnect` is that arm', async () => {
    const station = buildStation(journal);
    await station.connect();
    await station.disconnect();
    expect(journal.count({ direction: 'out', action: 'ConnectionLost' })).toBe(0);
  });

  it('a station that never came ONLINE announces nothing', async () => {
    const station = buildStation(journal);
    await station.disconnect({ announceDeparture: true });
    expect(journal.count({ direction: 'out', action: 'ConnectionLost' })).toBe(0);
  });

  it('announcing TWICE publishes once — a second Ctrl+C must not duplicate the departure', async () => {
    // Two ConnectionLost frames about one departure is a false statement on the
    // wire: the server keeps whichever lands second, and the first one is then a
    // report of a departure that had not happened yet.
    const station = buildStation(journal);
    await station.connect();
    await station.disconnect({ announceDeparture: true });
    await station.disconnect({ announceDeparture: true });
    expect(journal.count({ direction: 'out', action: 'ConnectionLost' })).toBe(1);
  });
});

describe('resolveJournalSink — what --journal / --no-journal mean', () => {
  it('absent (commander default with --no-journal declared) journals to the default path', () => {
    const sink = resolveJournalSink(true, 'stn_deadbeef', new Date('2026-09-16T10:11:12.345Z'));
    expect(sink).toBe(`${DEFAULT_JOURNAL_DIR}/stn_deadbeef-2026-09-16T10-11-12-345Z.jsonl`);
  });

  it('--no-journal turns it off', () => {
    expect(resolveJournalSink(false, 'stn_deadbeef')).toBeNull();
  });

  it('--journal <path> is used verbatim', () => {
    expect(resolveJournalSink('/tmp/mine.jsonl', 'stn_deadbeef')).toBe('/tmp/mine.jsonl');
  });

  it('undefined is treated as ON, so a journal is never missing by accident', () => {
    // The default has to be ON: an adversarial run that forgets the flag and then
    // cannot assert anything on the wire is the exact failure this closes.
    expect(resolveJournalSink(undefined, 'stn_deadbeef')).toContain(DEFAULT_JOURNAL_DIR);
  });

  it('an empty string is refused rather than silently meaning the default', () => {
    expect(() => resolveJournalSink('', 'stn_deadbeef')).toThrow(/--journal/);
  });
});

describe('the bay state machine is untouched by any of this', () => {
  it('bays still construct AVAILABLE', async () => {
    const station = buildStation();
    expect(station.getBayState('bay_deadbeef01')).toBe(BayStatus.AVAILABLE);
  });
});
