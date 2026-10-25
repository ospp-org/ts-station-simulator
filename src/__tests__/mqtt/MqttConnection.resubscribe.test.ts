import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import mqttPacket from 'mqtt-packet';
import { MqttConnection } from '../../mqtt/MqttConnection.js';

/*
 * A RECONNECTED STATION SUBSCRIBES AGAIN (2026-10-25, csms-server TODO A0 item 13).
 *
 * mqtt.js subscribes a client to its topics again after a reconnect that found no session (Session Present 0) - but it
 * records them only while its own `reconnectPeriod` is above 0. Since the connection paces its reconnects itself, on the
 * backoff of 02-transport.md §4.5 with mqtt.js's period at 0 (9722a0f), mqtt.js recorded nothing, and a reconnected
 * station sent its BootNotification on a connection subscribed to nothing: the server's answer reached no one and the
 * station waited for it in vain (UAT, 2026-10-25, EV29 proof 2: "Timeout waiting for BootNotification Response").
 *
 * Against a broker on a socket that answers as EMQX does - CONNACK, SUBACK, PUBACK - and drops the first connection:
 * at Session Present 0 the reconnected connection subscribes to the station's topic again, at the QoS it had, before
 * its first publish; at Session Present 1 it does not, the broker having kept the subscription.
 */

interface Packet { cmd: string; topic?: string; subscriptions?: Array<{ topic: string; qos: number }>; messageId?: number; qos?: number }
interface BrokerConnection { socket: net.Socket; packets: Packet[] }

const STATION = 'stn_c4ed1701';
const TO_STATION = `ospp/v1/stations/${STATION}/to-station`;
const TO_SERVER = `ospp/v1/stations/${STATION}/to-server`;

const servers: net.Server[] = [];
const connections: MqttConnection[] = [];

afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.disconnect().catch(() => undefined);
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A broker that answers each CONNECT with the Session Present `sessionPresent(n)` says for its nth connection. */
async function broker(sessionPresent: (n: number) => boolean): Promise<{ port: number; seen: BrokerConnection[] }> {
  const seen: BrokerConnection[] = [];
  const server = net.createServer((socket) => {
    const conn: BrokerConnection = { socket, packets: [] };
    const n = seen.push(conn) - 1;
    const parser = mqttPacket.parser({ protocolVersion: 5 });
    const send = (packet: Record<string, unknown>): void => {
      socket.write(mqttPacket.generate(packet as unknown as mqttPacket.Packet, { protocolVersion: 5 }));
    };
    parser.on('packet', (packet: Packet) => {
      conn.packets.push(packet);
      if (packet.cmd === 'connect') send({ cmd: 'connack', reasonCode: 0, sessionPresent: sessionPresent(n) });
      if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: (packet.subscriptions ?? []).map((s) => s.qos) });
      if (packet.cmd === 'publish' && packet.qos === 1) send({ cmd: 'puback', messageId: packet.messageId, reasonCode: 0 });
      if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    });
    socket.on('data', (data) => parser.parse(data));
    socket.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as net.AddressInfo).port, seen };
}

async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Connect, subscribe as Station.connect() does, have the broker drop the link, and publish at the reconnect. */
async function reconnectAfterADrop(sessionPresentAtTheReconnect: boolean): Promise<Packet[]> {
  const { port, seen } = await broker((n) => n > 0 && sessionPresentAtTheReconnect);
  const conn = new MqttConnection({ mqttUrl: `mqtt://127.0.0.1:${port}`, stationId: STATION });
  connections.push(conn);
  let connects = 0;
  conn.on('connect', () => {
    connects += 1;
    // What the station sends first at a reconnect: its BootNotification (connection-lost.md §6 step 1).
    if (connects === 2) void conn.publish(TO_SERVER, 'BootNotification', 1);
  });
  conn.connect();
  await until(() => connects === 1, 5000, 'the first connection');
  await conn.subscribe(TO_STATION, 1);
  await until(() => seen[0].packets.some((p) => p.cmd === 'subscribe'), 5000, 'the first SUBSCRIBE');

  seen[0].socket.destroy();
  await until(() => seen.length === 2 && seen[1].packets.some((p) => p.cmd === 'publish'), 8000, 'the reconnect and its first publish');
  return seen[1].packets;
}

describe('MqttConnection - a reconnect subscribes to what the station subscribed to', () => {
  it('at Session Present 0 subscribes to the station topic again, at its QoS, before the first publish', async () => {
    const packets = await reconnectAfterADrop(false);

    const subscribe = packets.findIndex((p) => p.cmd === 'subscribe');
    const publish = packets.findIndex((p) => p.cmd === 'publish');
    expect(subscribe, 'no SUBSCRIBE on the reconnected connection').toBeGreaterThanOrEqual(0);
    expect(packets[subscribe].subscriptions).toEqual([expect.objectContaining({ topic: TO_STATION, qos: 1 })]);
    expect(subscribe).toBeLessThan(publish);
  }, 20_000);

  it('CONTROL: at Session Present 1 the broker kept the subscription, and none is sent', async () => {
    const packets = await reconnectAfterADrop(true);

    expect(packets.filter((p) => p.cmd === 'subscribe')).toEqual([]);
    expect(packets.some((p) => p.cmd === 'publish')).toBe(true);
  }, 20_000);
});
