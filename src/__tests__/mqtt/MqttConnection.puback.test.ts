import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/*
 * WHAT THE BROKER SAID OF A MESSAGE (2026-10-25, freeze item 33 decided by Gabi).
 *
 * A message the broker did not acknowledge with success - PUBACK 0x00 - stays in the station's buffer and is
 * resent after the next reconnection: a PUBACK 0x10 "No matching subscribers" (a success code to MQTT, which
 * mqtt.js settles the publish on without saying which), any PUBACK refusing it, and a message still in flight
 * when the station reconnects to a broker that kept no session (CONNACK Session Present 0), which MQTT 5 has
 * the client discard from its session state [MQTT-3.2.2-5]. So publish() resolves with the reason code of the
 * PUBACK, read off the PUBACK packet itself, or with null for a message the broker kept no record of; and at
 * Session Present 0 the messages in flight leave mqtt.js's store, so mqtt.js does not resend them at the
 * CONNACK, ahead of the BootNotification every reconnection opens with (connection-lost.md §6 step 1).
 */

type Callback = (err?: Error, packet?: { messageId?: number }) => void;

class FakeClient extends EventEmitter {
  disconnecting = false;
  incomingStore = {};
  outgoingStore = {};
  outgoing: Record<number, { volatile: boolean; cb: Callback }> = {};
  stream = { destroy: vi.fn() };
  reconnect = vi.fn();
  end = vi.fn();
  subscribe = vi.fn();
  private nextId = 1;
  /** The publishes mqtt.js holds: what it would resend at the next CONNACK. */
  publishes: Array<{ messageId: number; cb: Callback }> = [];
  publish = vi.fn((_t: string, _p: string | Buffer, opts: { qos: number }, cb: Callback) => {
    if (opts.qos === 0) {
      cb();
      return;
    }
    const messageId = this.nextId++;
    this.outgoing[messageId] = { volatile: false, cb };
    this.publishes.push({ messageId, cb });
  });
  removeOutgoingMessage = vi.fn((messageId: number) => {
    const entry = this.outgoing[messageId];
    delete this.outgoing[messageId];
    entry?.cb(new Error('Message removed'));
  });

  /** The broker's PUBACK: mqtt.js emits the packet, then settles the publish - with an error for a refusal. */
  puback(messageId: number, reasonCode?: number): void {
    this.emit('packetreceive', { cmd: 'puback', messageId, reasonCode });
    const entry = this.outgoing[messageId];
    delete this.outgoing[messageId];
    if (reasonCode !== undefined && reasonCode >= 0x80) {
      entry?.cb(Object.assign(new Error('Publish error: refused'), { code: reasonCode }), { messageId });
    } else {
      entry?.cb(undefined, { messageId });
    }
  }
}

let fake: FakeClient;
vi.mock('mqtt', () => ({ connect: vi.fn(() => fake) }));

const { MqttConnection } = await import('../../mqtt/MqttConnection.js');

let n = 0;
function connected(): InstanceType<typeof MqttConnection> {
  fake = new FakeClient();
  const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: `stn_puback${String(++n).padStart(3, '0')}` });
  conn.connect();
  fake.emit('connect', { sessionPresent: false });
  return conn;
}

describe('MqttConnection.publish - the reason code of the PUBACK', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves 0x00 for a message the broker acknowledged with success', async () => {
    const conn = connected();
    const sent = conn.publish('t', 'a', 1);
    fake.puback(1, 0);

    await expect(sent).resolves.toBe(0);
  });

  it('resolves 0x00 for a PUBACK with no reason code, which MQTT 5 reads as Success', async () => {
    const conn = connected();
    const sent = conn.publish('t', 'a', 1);
    fake.puback(1);

    await expect(sent).resolves.toBe(0);
  });

  it('resolves 0x10 for a message the broker acknowledged and delivered to no one', async () => {
    const conn = connected();
    const sent = conn.publish('t', 'a', 1);
    fake.puback(1, 0x10);

    await expect(sent).resolves.toBe(0x10);
  });

  it('resolves the code of a PUBACK that refuses the message, not a rejection', async () => {
    const conn = connected();
    const sent = conn.publish('t', 'a', 1);
    fake.puback(1, 0x87);

    await expect(sent).resolves.toBe(0x87);
  });

  it('reads each PUBACK for its own message', async () => {
    const conn = connected();
    const first = conn.publish('t', 'a', 1);
    const second = conn.publish('t', 'b', 1);
    fake.puback(2, 0);
    fake.puback(1, 0x10);

    await expect(first).resolves.toBe(0x10);
    await expect(second).resolves.toBe(0);
  });
});

describe('MqttConnection - a message in flight when the broker kept no session', () => {
  it('leaves mqtt.js at a CONNACK with Session Present 0 and resolves null: the broker kept no record of it', async () => {
    const conn = connected();
    const inFlight = conn.publish('t', 'a', 1);
    fake.emit('close');

    fake.emit('packetreceive', { cmd: 'connack', sessionPresent: false });

    expect(fake.removeOutgoingMessage).toHaveBeenCalledWith(1);
    await expect(inFlight).resolves.toBeNull();
  });

  it('stays with mqtt.js at Session Present 1, which MQTT has resend it with its packet id', async () => {
    const conn = connected();
    const inFlight = conn.publish('t', 'a', 1);
    fake.emit('close');

    fake.emit('packetreceive', { cmd: 'connack', sessionPresent: true });
    fake.puback(1, 0);

    expect(fake.removeOutgoingMessage).not.toHaveBeenCalled();
    await expect(inFlight).resolves.toBe(0);
  });

  it('takes nothing that is not its own: an entry of mqtt.js no publish of this connection made stays', () => {
    connected();
    const foreign: Callback = vi.fn();
    fake.outgoing[99] = { volatile: false, cb: foreign };

    fake.emit('packetreceive', { cmd: 'connack', sessionPresent: false });

    expect(fake.removeOutgoingMessage).not.toHaveBeenCalledWith(99);
  });
});
