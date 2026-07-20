import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * ADR-0004 TIER 1 (station revocation) observability — RED-first.
 *
 * A disabled station is severed from the broker in two distinct ways the
 * simulator did NOT model before this suite:
 *
 *   KICKED  — the broker force-closes a LIVE connection (EMQX "kick").
 *             Over MQTT 5 that arrives as a server-sent DISCONNECT packet
 *             carrying a reason code (0x98 "Administrative action"). Before
 *             this arc MqttConnection never subscribed to mqtt.js's
 *             'disconnect' event at all, so a kick was indistinguishable
 *             from a self-close or a network blip — all three surfaced as
 *             a bare 'close'.
 *
 *   BANNED  — a subsequent CONNECT is REFUSED by the broker's ban-list.
 *             Over MQTT 5 that is a CONNACK with reason code 0x87
 *             ("Not authorized"). Before this arc the long-lived client's
 *             reconnectPeriod=5000 simply retried it forever, silently:
 *             nothing reported "refused", and nothing stopped the loop.
 *
 * These tests pin the DISCRIMINATION (kick vs self-close vs network drop)
 * and the BOUNDED refusal probe (refused / connected, never an endless
 * retry). They are the sim-side prerequisite for the TIER 1 wire proof.
 */

interface EndCall {
  force: boolean;
  opts: Record<string, unknown>;
}

class FakeMqttClient extends EventEmitter {
  endCalls: EndCall[] = [];
  end = vi.fn((force: boolean, opts: object, cb?: () => void) => {
    this.endCalls.push({ force, opts: opts as Record<string, unknown> });
    cb?.();
  });
  subscribe = vi.fn();
  publish = vi.fn();
  stream = { destroy: vi.fn() };
}

const fakeClients: FakeMqttClient[] = [];
const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

vi.mock('mqtt', () => ({
  connect: vi.fn((url: string, opts: Record<string, unknown>) => {
    const fc = new FakeMqttClient();
    fakeClients.push(fc);
    connectCalls.push({ url, opts });
    return fc;
  }),
}));

const { MqttConnection, DISCONNECT_REASON_ADMIN_ACTION, CONNACK_REASON_NOT_AUTHORIZED } =
  await import('../../mqtt/MqttConnection.js');

/** Unique stationId per test — RECONNECT_GUARD_MS state is module-level + keyed by it. */
let seq = 0;
const nextStationId = (): string => `stn_sever${(seq += 1)}`;

beforeEach(() => {
  fakeClients.length = 0;
  connectCalls.length = 0;
});

describe('MqttConnection — KICK detection (broker-initiated vs self-initiated close)', () => {
  it('reports a server-sent DISCONNECT as a BROKER KICK, carrying its reason code', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    expect(conn.getSeverance().kicked).toBe(false);
    expect(conn.getSeverance().lastCloseCause).toBe('none');

    // EMQX kick over MQTT 5: server-sent DISCONNECT, 0x98 Administrative action.
    fakeClients[0].emit('disconnect', {
      cmd: 'disconnect',
      reasonCode: DISCONNECT_REASON_ADMIN_ACTION,
    });
    fakeClients[0].emit('close');

    const sev = conn.getSeverance();
    expect(sev.kicked).toBe(true);
    expect(sev.lastCloseCause).toBe('broker-kick');
    expect(sev.kickReasonCode).toBe(DISCONNECT_REASON_ADMIN_ACTION);
  });

  it('emits a distinct "kicked" event a scenario can await', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    const kicked = new Promise<number | null>((resolve) => {
      conn.once('kicked', (reasonCode: number | null) => resolve(reasonCode));
    });

    fakeClients[0].emit('disconnect', {
      cmd: 'disconnect',
      reasonCode: DISCONNECT_REASON_ADMIN_ACTION,
    });

    await expect(kicked).resolves.toBe(DISCONNECT_REASON_ADMIN_ACTION);
  });

  it('does NOT report a self-initiated disconnect() as a kick', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    await conn.disconnect();
    // The broker echoes a close after our own DISCONNECT — must stay 'self'.
    fakeClients[0].emit('close');

    const sev = conn.getSeverance();
    expect(sev.kicked).toBe(false);
    expect(sev.lastCloseCause).toBe('self');
    expect(sev.kickReasonCode).toBeNull();
  });

  it('does NOT report a simulated network drop as a kick', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    conn.destroyConnection();
    fakeClients[0].emit('close');

    const sev = conn.getSeverance();
    expect(sev.kicked).toBe(false);
    expect(sev.lastCloseCause).toBe('network');
  });

  it('a reconnect after a kick clears the kicked flag (severance is per-connection)', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    fakeClients[0].emit('disconnect', {
      cmd: 'disconnect',
      reasonCode: DISCONNECT_REASON_ADMIN_ACTION,
    });
    expect(conn.getSeverance().kicked).toBe(true);

    fakeClients[0].emit('connect', { cmd: 'connack', returnCode: 0 });
    expect(conn.getSeverance().kicked).toBe(false);
  });
});

describe('MqttConnection — BAN detection (a refused reconnect is REFUSED, not retried forever)', () => {
  it('reports a CONNACK-refused reconnect as refused, with the broker reason code', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });

    const probe = conn.probeReconnect(1000);
    const refusal = Object.assign(new Error('Connection refused: Not authorized'), {
      code: CONNACK_REASON_NOT_AUTHORIZED,
    });
    fakeClients[0].emit('error', refusal);

    const result = await probe;
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') throw new Error('unreachable');
    expect(result.reasonCode).toBe(CONNACK_REASON_NOT_AUTHORIZED);

    const sev = conn.getSeverance();
    expect(sev.reconnectRefused).toBe(true);
    expect(sev.refusalReasonCode).toBe(CONNACK_REASON_NOT_AUTHORIZED);
  });

  it('the probe is a SINGLE bounded attempt — reconnectPeriod 0, never an endless retry', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });

    const probe = conn.probeReconnect(1000);
    fakeClients[0].emit(
      'error',
      Object.assign(new Error('refused'), { code: CONNACK_REASON_NOT_AUTHORIZED }),
    );
    await probe;

    // The long-lived client uses reconnectPeriod 5000; the ban probe MUST NOT,
    // or a banned station silently spins on the broker forever.
    expect(connectCalls[0].opts.reconnectPeriod).toBe(0);
    // ...and it must tear its own client down rather than leave it dangling.
    expect(fakeClients[0].endCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('reports a probe that the broker ACCEPTS as connected (the un-ban case)', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });

    const probe = conn.probeReconnect(1000);
    fakeClients[0].emit('connect', { cmd: 'connack', returnCode: 0 });

    const result = await probe;
    expect(result.outcome).toBe('connected');
    expect(conn.getSeverance().reconnectRefused).toBe(false);
  });

  it('a successful probe CLEARS a previous refusal (banned → un-banned is observable)', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });

    const banned = conn.probeReconnect(1000);
    fakeClients[0].emit(
      'error',
      Object.assign(new Error('refused'), { code: CONNACK_REASON_NOT_AUTHORIZED }),
    );
    await banned;
    expect(conn.getSeverance().reconnectRefused).toBe(true);

    const unbanned = conn.probeReconnect(1000);
    fakeClients[1].emit('connect', { cmd: 'connack', returnCode: 0 });
    await unbanned;

    const sev = conn.getSeverance();
    expect(sev.reconnectRefused).toBe(false);
    expect(sev.refusalReasonCode).toBeNull();
  });

  it('a probe the broker neither accepts nor refuses times out as refused (silent drop)', async () => {
    vi.useFakeTimers();
    try {
      const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
      const probe = conn.probeReconnect(1000);

      // Broker says nothing at all — a TCP-level drop of a banned client.
      await vi.advanceTimersByTimeAsync(1000);

      const result = await probe;
      expect(result.outcome).toBe('refused');
      if (result.outcome !== 'refused') throw new Error('unreachable');
      expect(result.reasonCode).toBeNull();
      expect(result.message).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the LIVE client before probing — no same-clientId session takeover', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();
    const live = fakeClients[0];

    const probe = conn.probeReconnect(1000);
    await Promise.resolve();
    // The live client (same clientId = cert CN) must be torn down first, or the
    // probe's CONNECT is a session takeover that kicks our own connection and we
    // end up measuring self-interference instead of the broker's verdict.
    expect(live.endCalls.length).toBeGreaterThanOrEqual(1);

    fakeClients[1].emit(
      'error',
      Object.assign(new Error('refused'), { code: CONNACK_REASON_NOT_AUTHORIZED }),
    );
    await probe;
  });

  it('KEEPS the kick on record across the probe (kicked AND refused, the TIER 1 pair)', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    fakeClients[0].emit('disconnect', {
      cmd: 'disconnect',
      reasonCode: DISCONNECT_REASON_ADMIN_ACTION,
    });
    expect(conn.getSeverance().kicked).toBe(true);

    const probe = conn.probeReconnect(1000);
    await Promise.resolve();
    fakeClients[1].emit(
      'error',
      Object.assign(new Error('refused'), { code: CONNACK_REASON_NOT_AUTHORIZED }),
    );
    await probe;

    // The probe tears the live client down internally, which would otherwise
    // re-attribute the close to 'self' and lose the kick evidence.
    const sev = conn.getSeverance();
    expect(sev.kicked).toBe(true);
    expect(sev.kickReasonCode).toBe(DISCONNECT_REASON_ADMIN_ACTION);
    expect(sev.reconnectRefused).toBe(true);
  });

  it('does not leak the probe client into the live connection slot', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });

    const probe = conn.probeReconnect(1000);
    fakeClients[0].emit('connect', { cmd: 'connack', returnCode: 0 });
    await probe;

    // The probe observes; it does not become the station's live connection
    // (the scenario still calls connect() to subscribe + boot).
    expect(conn.getClientId()).toBeNull();
  });
});
