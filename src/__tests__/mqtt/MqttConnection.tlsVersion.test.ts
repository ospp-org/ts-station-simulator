import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Captures the IClientOptions argument passed to each mqtt.connect() call.
const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];
const fakeClients: FakeMqttClient[] = [];

class FakeMqttClient extends EventEmitter {
  // Stand-in for mqtt.js's underlying net/tls socket, exposed as `.stream`
  // (see MqttConnection.destroyConnection(), which already reads this same
  // property). getNegotiatedTlsProtocol() reads Node's TLSSocket.getProtocol()
  // off the same place.
  stream?: { getProtocol?: () => string | null };
  end = vi.fn((_force: boolean, _opts: object, cb?: () => void) => {
    cb?.();
  });
  subscribe = vi.fn();
  publish = vi.fn();
}

vi.mock('mqtt', () => ({
  connect: vi.fn((url: string, opts: Record<string, unknown>) => {
    const fc = new FakeMqttClient();
    fakeClients.push(fc);
    connectCalls.push({ url, opts });
    return fc;
  }),
}));

const { MqttConnection } = await import('../../mqtt/MqttConnection.js');

describe('MqttConnection — TLS min/max version knob (C3 TLS-1.2-floor arc)', () => {
  beforeEach(() => {
    connectCalls.length = 0;
    fakeClients.length = 0;
  });

  it('forwards an explicit minVersion into the mqtt/tls connect options', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: 'stn_tls12',
      tls: { minVersion: 'TLSv1.2' },
    });
    conn.connect();
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].opts.minVersion).toBe('TLSv1.2');
  });

  it('forwards an explicit maxVersion into the mqtt/tls connect options', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: 'stn_tls11cap',
      tls: { maxVersion: 'TLSv1.1' },
    });
    conn.connect();
    expect(connectCalls[0].opts.maxVersion).toBe('TLSv1.1');
  });

  it('forwards minVersion === maxVersion when a scenario pins an exact version (S1/S3 shape)', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: 'stn_tls12pin',
      tls: { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' },
    });
    conn.connect();
    expect(connectCalls[0].opts.minVersion).toBe('TLSv1.2');
    expect(connectCalls[0].opts.maxVersion).toBe('TLSv1.2');
  });

  // THE DEFAULT FLOOR IS THE SPEC'S FLOOR, NOT THE TOOL'S PREFERENCE.
  //
  // `spec/02-transport.md` §1.3 is titled "TLS (1.2 floor, 1.3 recommended)" and reads:
  // "All MQTT connections MUST use TLS 1.2 or higher; TLS 1.3 is RECOMMENDED and MUST be
  // negotiated whenever both peers support it." The amendment that lowered it (spec 0.7.0,
  // `00-introduction.md`) says why in one line: it "admit[s] constrained cellular modems
  // (e.g. SIMCom A7608E-H) with no firmware path to 1.3".
  //
  // This test used to assert TLSv1.3 and pass, and that is what made it the wrong test: a
  // floor of 1.3 REFUSES a conforming broker that offers only 1.2, and it cannot model the
  // integrator's board — the very modem the amendment was written for. The simulator's job
  // is to be a reference STATION, so its default posture has to be the one the protocol
  // requires of a station, not a stricter one it happens to be able to afford.
  //
  // The recommendation half is kept by the ABSENCE of a ceiling: with no maxVersion, a peer
  // that supports 1.3 still negotiates 1.3, which is what "MUST be negotiated whenever both
  // peers support it" asks for. Floor and ceiling are different claims.
  it('DEFAULT: tls configured with no version pin floors at the SPEC floor, TLSv1.2, with no ceiling', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: 'stn_default',
      tls: {},
    });
    conn.connect();
    expect(connectCalls[0].opts.minVersion).toBe('TLSv1.2');
    expect(connectCalls[0].opts.maxVersion).toBeUndefined();
  });

  it('DEFAULT: an explicit 1.3 floor is still available to a scenario that wants to prove it', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: 'stn_pin13',
      tls: { minVersion: 'TLSv1.3' },
    });
    conn.connect();
    expect(connectCalls[0].opts.minVersion).toBe('TLSv1.3');
    expect(connectCalls[0].opts.maxVersion).toBeUndefined();
  });

  it('DEFAULT unchanged: no tls block at all (plaintext) sets neither minVersion nor maxVersion', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtt://x',
      stationId: 'stn_notls',
    });
    conn.connect();
    expect(connectCalls[0].opts.minVersion).toBeUndefined();
    expect(connectCalls[0].opts.maxVersion).toBeUndefined();
  });

  describe('getNegotiatedTlsProtocol()', () => {
    it('returns null before connect() has run', () => {
      const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: 'stn_neg_pre' });
      expect(conn.getNegotiatedTlsProtocol()).toBeNull();
    });

    it('reads the negotiated protocol off the underlying TLS socket after connect()', () => {
      const conn = new MqttConnection({
        mqttUrl: 'mqtts://x',
        stationId: 'stn_neg_post',
        tls: { minVersion: 'TLSv1.2' },
      });
      conn.connect();
      // Simulate mqtt.js's client having an established TLS socket that
      // negotiated TLSv1.3 — independent of the minVersion FLOOR we requested
      // (a floor of 1.2 does not mean 1.2 was NEGOTIATED; the broker may
      // still prefer 1.3).
      fakeClients[0].stream = { getProtocol: () => 'TLSv1.3' };
      expect(conn.getNegotiatedTlsProtocol()).toBe('TLSv1.3');
    });

    it('returns null when the underlying stream has no TLS protocol (plaintext transport)', () => {
      const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_neg_plain' });
      conn.connect();
      fakeClients[0].stream = { getProtocol: () => null };
      expect(conn.getNegotiatedTlsProtocol()).toBeNull();
    });
  });
});
