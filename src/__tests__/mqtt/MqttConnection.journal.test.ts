import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeClient extends EventEmitter {
  publishCalls: Array<{ topic: string; payload: string | Buffer; opts: { qos: number } }> = [];
  end = vi.fn((_force: boolean, _opts: object, cb?: () => void) => cb?.());
  subscribe = vi.fn((_t: string, _o: object, cb?: (e?: Error) => void) => cb?.());
  publish = vi.fn((topic: string, payload: string | Buffer, opts: { qos: number }, cb?: (e?: Error) => void) => {
    this.publishCalls.push({ topic, payload, opts });
    cb?.();
  });
}

const lastFake: { instance: FakeClient | null } = { instance: null };

vi.mock('mqtt', () => ({
  connect: vi.fn(() => lastFake.instance),
}));

const { MqttConnection } = await import('../../mqtt/MqttConnection.js');
const { FrameJournal } = await import('../../mqtt/FrameJournal.js');

const OUTBOUND = JSON.stringify({
  messageId: 'out-1',
  messageType: 'Event',
  action: 'Heartbeat',
  payload: {},
});
const INBOUND = JSON.stringify({
  messageId: 'in-1',
  messageType: 'Request',
  action: 'GetConfiguration',
  payload: { keys: [] },
});

describe('MqttConnection journals BOTH chokepoints', () => {
  let fake: FakeClient;

  beforeEach(() => {
    fake = new FakeClient();
    lastFake.instance = fake;
  });

  it('publish() journals the outbound frame verbatim, with its topic and qos', async () => {
    const journal = new FrameJournal();
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_j', journal });
    conn.connect();

    await conn.publish('ospp/stations/stn_j/server', OUTBOUND, 1);

    expect(journal.count({ direction: 'out' })).toBe(1);
    const [f] = journal.select({ direction: 'out' });
    expect(f.topic).toBe('ospp/stations/stn_j/server');
    expect(f.action).toBe('Heartbeat');
    expect(f.messageId).toBe('out-1');
    expect(f.qos).toBe(1);
    expect(f.payload).toBe(OUTBOUND);
  });

  it("the client's 'message' event journals the inbound frame verbatim", () => {
    const journal = new FrameJournal();
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_j', journal });
    conn.connect();

    fake.emit('message', 'ospp/stations/stn_j/station', Buffer.from(INBOUND), { qos: 1 });

    expect(journal.count({ direction: 'in' })).toBe(1);
    const [f] = journal.select({ direction: 'in' });
    expect(f.action).toBe('GetConfiguration');
    expect(f.messageId).toBe('in-1');
    expect(f.payload).toBe(INBOUND);
  });

  it('journals an inbound frame the router would REFUSE — the gates are downstream', () => {
    // A parse failure, a MAC failure and a schema failure each make MessageRouter
    // emit nothing. Those are the frames an adversarial run is looking for, so the
    // journal has to sit in front of the gates, not behind them.
    const journal = new FrameJournal();
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_j', journal });
    conn.connect();

    fake.emit('message', 'ospp/stations/stn_j/station', Buffer.from('}{ not json'), { qos: 1 });

    expect(journal.count({ direction: 'in' })).toBe(1);
    expect(journal.frames[0].action).toBeNull();
    expect(journal.frames[0].payload).toBe('}{ not json');
  });

  it('wire order across both directions is one sequence', async () => {
    const journal = new FrameJournal();
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_j', journal });
    conn.connect();

    await conn.publish('t', OUTBOUND, 1);
    fake.emit('message', 't', Buffer.from(INBOUND), { qos: 1 });
    await conn.publish('t', OUTBOUND, 0);

    expect(journal.frames.map(f => [f.seq, f.direction])).toEqual([
      [1, 'out'],
      [2, 'in'],
      [3, 'out'],
    ]);
  });

  it('a connection with no journal behaves exactly as before', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_j' });
    conn.connect();
    await expect(conn.publish('t', OUTBOUND, 1)).resolves.toBeUndefined();
    expect(fake.publishCalls).toHaveLength(1);
  });

  it('a publish the client then fails IS journalled — the record is of the ATTEMPT, in order', async () => {
    // Recorded at CALL time, not on settle, and the ordering is the reason. A QoS-1
    // publish resolves on PUBACK, which can land AFTER an inbound frame that the
    // outbound one caused; recording on settle would put effect before cause in the
    // file and silently corrupt every causal assertion built on it. So a journalled
    // `out` frame means "this process handed these bytes to the client, at this
    // instant, in this order" — delivery is the client's business, and a failure is
    // reported to the CALLER as a rejected publish, which is the signal that pairs
    // with the journal rather than being replaced by it.
    const journal = new FrameJournal();
    fake.publish = vi.fn((_t: string, _p: string | Buffer, _o: object, cb?: (e?: Error) => void) =>
      cb?.(new Error('broker said no')));
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_j', journal });
    conn.connect();

    await expect(conn.publish('t', OUTBOUND, 1)).rejects.toThrow('broker said no');
    expect(journal.count({ direction: 'out' })).toBe(1);
  });

  it('a publish with NO client rejects and journals nothing — nothing was handed over', async () => {
    const journal = new FrameJournal();
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_j', journal });
    // connect() deliberately not called: there is no client to hand bytes to.
    await expect(conn.publish('t', OUTBOUND, 1)).rejects.toThrow('not connected');
    expect(journal.count({ direction: 'out' })).toBe(0);
  });
});
