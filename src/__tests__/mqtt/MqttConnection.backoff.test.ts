import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/*
 * THE LIVE CONNECTION RECONNECTS ON THE BACKOFF OF 02-transport.md §4.5 (2026-10-25).
 *
 * It retried every 5 s, on mqtt.js's own `reconnectPeriod` - a fixed interval mqtt.js arms once and keeps
 * until a connection succeeds, so no backoff can be expressed through it. The connection now builds its
 * client with no retry period and paces its own attempts: 1 s after the link drops, then 2, 4, 8, 16 and
 * ReconnectBackoffMax seconds while each attempt fails, each with up to 30 % of jitter, and from 1 s again
 * once it is back. A close the station asked for - disconnect(), a sever - is not retried.
 */

class FakeClient extends EventEmitter {
  disconnecting = false;
  connected = false;
  incomingStore = { name: 'incoming' };
  outgoingStore = { name: 'outgoing' };
  outgoing: Record<number, unknown> = {};
  stream = { destroy: vi.fn() };
  reconnect = vi.fn();
  removeOutgoingMessage = vi.fn();
  subscribe = vi.fn((_t: string, _o: object, cb?: (e?: Error) => void) => cb?.());
  publish = vi.fn((_t: string, _p: string | Buffer, _o: object, cb?: (e?: Error) => void) => cb?.());
  end = vi.fn((_force?: boolean, _opts?: object, cb?: () => void) => {
    this.disconnecting = true;
    this.emit('close');
    cb?.();
  });
}

const fakes: FakeClient[] = [];
const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

vi.mock('mqtt', () => ({
  connect: vi.fn((url: string, opts: Record<string, unknown>) => {
    connectCalls.push({ url, opts });
    const fake = new FakeClient();
    fakes.push(fake);
    return fake;
  }),
}));

const { MqttConnection } = await import('../../mqtt/MqttConnection.js');

let n = 0;
const stationId = (): string => `stn_backoff${String(++n).padStart(3, '0')}`;

beforeEach(() => {
  fakes.length = 0;
  connectCalls.length = 0;
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Advance to just before `ms`, then to it: the attempt comes at `ms`, not a millisecond earlier. */
async function attemptsAt(client: FakeClient, ms: number): Promise<void> {
  const before = client.reconnect.mock.calls.length;
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(client.reconnect.mock.calls.length, `an attempt before ${ms} ms`).toBe(before);
  await vi.advanceTimersByTimeAsync(1);
  expect(client.reconnect.mock.calls.length, `no attempt at ${ms} ms`).toBe(before + 1);
}

describe('MqttConnection - the reconnect backoff', () => {
  it('builds the live client with no fixed retry period: the connection paces its own attempts', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: stationId() });
    conn.connect();

    expect(connectCalls[0].opts.reconnectPeriod).toBe(0);
  });

  it('tries a dropped link again after 1 s, then 2, 4, 8, 16 and 30 s while each attempt fails, and from 1 s again after a connection', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: stationId() });
    conn.connect();
    const client = fakes[0];
    client.emit('connect', {});

    client.emit('close');
    await attemptsAt(client, 1000);
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
      client.emit('close'); // the attempt failed
      await attemptsAt(client, delay);
    }

    client.emit('connect', {});
    client.emit('close');
    await attemptsAt(client, 1000);
  });

  it('adds the jitter to each wait', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: stationId() });
    conn.connect();
    const client = fakes[0];
    client.emit('connect', {});

    client.emit('close');
    await attemptsAt(client, 1150);
    client.emit('close');
    await attemptsAt(client, 2300);
  });

  it('caps the wait at the ReconnectBackoffMax the station holds', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: stationId(), reconnectBackoffMaxSeconds: () => 60 });
    conn.connect();
    const client = fakes[0];
    client.emit('connect', {});

    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      client.emit('close');
      await attemptsAt(client, delay);
    }
  });

  it('keeps the stores at a reconnect, so a message in flight is neither lost nor left waiting', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: stationId() });
    conn.connect();
    const client = fakes[0];
    client.emit('connect', {});

    client.emit('close');
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.reconnect).toHaveBeenCalledWith({ incomingStore: client.incomingStore, outgoingStore: client.outgoingStore });
  });

  it('does not retry a close the station asked for: disconnect()', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: stationId() });
    conn.connect();
    const client = fakes[0];
    client.emit('connect', {});

    await conn.disconnect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(client.reconnect).not.toHaveBeenCalled();
  });

  it('does not retry a close the station asked for: a sever', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: stationId() });
    conn.connect();
    const client = fakes[0];
    client.emit('connect', {});

    conn.severConnection();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(client.reconnect).not.toHaveBeenCalled();
  });

  it('a disconnect() while an attempt is pending cancels it', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: stationId() });
    conn.connect();
    const client = fakes[0];
    client.emit('connect', {});

    client.emit('close');
    await vi.advanceTimersByTimeAsync(500);
    await conn.disconnect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(client.reconnect).not.toHaveBeenCalled();
  });

  it('retries a network drop the station simulates: destroyConnection()', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: stationId() });
    conn.connect();
    const client = fakes[0];
    client.emit('connect', {});

    conn.destroyConnection();
    client.emit('close');
    await attemptsAt(client, 1000);
  });
});
