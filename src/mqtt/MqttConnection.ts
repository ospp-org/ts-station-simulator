import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { SecureVersion } from 'node:tls';
import { connect, type MqttClient, type IClientOptions } from 'mqtt';
import {
  OsppAction,
  MessageType,
  MessageSource,
  createEnvelope,
  toServerTopic,
} from '@ospp/protocol';

/**
 * mqtt.js's IClientOptions (ISecureClientOptions) does not model TLS
 * minVersion/maxVersion, but mqtt.js forwards the ENTIRE opts object
 * straight through to Node's tls.connect() for `mqtts:`/`wss:` targets
 * (see node_modules/mqtt/build/lib/connect/tls.js: `tls.connect(opts)`) —
 * so these fields reach Node's real TLS negotiation even though mqtt.js's
 * own types don't enumerate them. This augmentation just lets TypeScript
 * see what already flows through at runtime.
 */
type TlsVersionClientOptions = IClientOptions & {
  minVersion?: SecureVersion;
  maxVersion?: SecureVersion;
};

export interface MqttConnectionOptions {
  mqttUrl: string;
  stationId: string;
  tls?: {
    key?: string;      // file path — station client key (mTLS)
    cert?: string;     // file path — station client cert (mTLS)
    serverCa?: string; // file path — custom CA for server cert verification (private CA only)
    /**
     * TLS floor/ceiling for this connection, Node tls.connect() semantics
     * ('TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3'). Omit both to keep the
     * default (TLSv1.3 minimum, unchanged from before this knob existed —
     * see doConnect()). Added for the TLS-1.2-floor conformance arc: the
     * CSMS broker floor is moving to 1.2+ (1.3 recommended) so TLS-1.2-only
     * cellular modems (e.g. SIMCom A7608E-H) can connect; a scenario can
     * pin an exact version to prove that against a live broker without
     * changing the simulator's own default posture.
     */
    minVersion?: SecureVersion;
    maxVersion?: SecureVersion;
  };
  mqttCredentials?: {
    username: string;
    password: string;
  };
  cleanSession?: boolean;
}

/**
 * Maximum wall time, in milliseconds, the graceful disconnect path is
 * allowed before we force-end the client. Sequential scenarios with the
 * same stationId (and historically the same clientId) sometimes blocked
 * indefinitely on the graceful DISCONNECT round-trip; the force-end
 * fallback caps that latency so the next scenario can proceed.
 */
const DISCONNECT_TIMEOUT_MS = 3000;

/**
 * Minimum wall time, in milliseconds, between a clean DISCONNECT and the
 * next CONNECT on the SAME stationId. With the broker configured to
 * derive client_id from cert CN (peer_cert_as_clientid="cn") sequential
 * reconnects target the same broker-side session record; even though
 * the DISCONNECT carries Session Expiry Interval = 0 to flush state,
 * the broker's bookkeeping needs a beat to settle before accepting a
 * fresh session under the same identity. Module-level + keyed by
 * stationId so it survives across MqttConnection instances (scenarios
 * recreate the wrapper per cycle).
 */
const RECONNECT_GUARD_MS = 500;
const lastDisconnectAt = new Map<string, number>();

export class MqttConnection extends EventEmitter {
  private client: MqttClient | null = null;
  private readonly mqttUrl: string;
  private readonly stationId: string;
  // tlsConfig is mutable to support post-construction TLS swap during E2E
  // scenarios that provision a station mid-scenario. The cert files are read
  // at connect() time, so updating tlsConfig before connect() is sufficient.
  private tlsConfig?: MqttConnectionOptions['tls'];
  private readonly mqttCredentials?: MqttConnectionOptions['mqttCredentials'];
  private readonly cleanSession: boolean;
  private isDestroyingConnection = false;
  /**
   * The MQTT clientId actually sent to the broker on the most recent
   * connect() call. Per OSPP spec §02-transport §1.2 / §06-security §3.3
   * the client_id MUST equal the cert CN (= stationId). The CSMS EMQX
   * deployment (alignment sprint v0.4.0, G-EMQX-CLIENTID) sets
   * peer_cert_as_clientid="cn" so the broker DERIVES client_id from
   * the cert CN regardless of what the client sends — so the
   * historical V4 Finding #6 workaround (UUID suffix to disambiguate
   * sequential reconnects) is no longer load-bearing. The B4 cycle of
   * (client_id mismatch → broker rewrite → sim/broker out of sync) is
   * solved instead by the clean-disconnect + reconnect-guard logic
   * elsewhere in this file.
   */
  private currentClientId: string | null = null;

  constructor(options: MqttConnectionOptions) {
    super();
    this.mqttUrl = options.mqttUrl;
    this.stationId = options.stationId;
    this.tlsConfig = options.tls;
    this.mqttCredentials = options.mqttCredentials;
    this.cleanSession = options.cleanSession ?? false;
  }

  /**
   * Returns the MQTT clientId sent on the most recent connect() call,
   * or null if connect() has not yet run. Exposed primarily for tests.
   */
  getClientId(): string | null {
    return this.currentClientId;
  }

  /**
   * The TLS protocol version actually NEGOTIATED on the current/most-recent
   * connection (e.g. 'TLSv1.3', 'TLSv1.2') — independent of whatever
   * minVersion/maxVersion FLOOR/CEILING we requested (a minVersion of 1.2
   * does not mean 1.2 was negotiated; the broker may still prefer 1.3).
   * Read straight off the underlying TLS socket's own
   * `getProtocol()` (Node tls.TLSSocket), the same `.stream` mqtt.js
   * exposes that destroyConnection() already reaches into. Returns null
   * before connect(), or over a non-TLS transport.
   *
   * Added for the TLS-1.2-floor conformance arc so a scenario can assert
   * `connection.tlsProtocol` (see AssertStep) rather than just trusting
   * that what it requested is what it got.
   */
  getNegotiatedTlsProtocol(): string | null {
    const stream = (
      this.client as unknown as { stream?: { getProtocol?(): string | null } } | null
    )?.stream;
    return stream?.getProtocol?.() ?? null;
  }

  /**
   * Update TLS material before connect(). Required for E2E scenarios that
   * generate a CSR + receive a cert mid-run (provision step). Throws if the
   * connection is already established to prevent silent inconsistency.
   */
  setTls(tls: MqttConnectionOptions['tls']): void {
    if (this.client !== null) {
      throw new Error(
        'MqttConnection.setTls: cannot change TLS after connect(); disconnect first',
      );
    }
    this.tlsConfig = tls;
  }

  connect(): void {
    const last = lastDisconnectAt.get(this.stationId) ?? 0;
    const elapsed = Date.now() - last;
    if (last !== 0 && elapsed < RECONNECT_GUARD_MS) {
      const wait = RECONNECT_GUARD_MS - elapsed;
      setTimeout(() => this.doConnect(), wait);
      return;
    }
    this.doConnect();
  }

  private doConnect(): void {
    // OSPP spec §02-transport §1.2 / §06-security §3.3: MQTT client_id
    // MUST equal cert CN (= stationId). With peer_cert_as_clientid="cn"
    // enforced broker-side the equality holds regardless of what we send,
    // but we emit the clean form anyway so broker logs + client traces
    // are unambiguous and don't read "WRONG_ID overridden to stn_X".
    this.currentClientId = this.stationId;
    const opts: TlsVersionClientOptions = {
      clientId: this.currentClientId,
      protocolVersion: 5,
      clean: this.cleanSession,
      keepalive: 30,
      reconnectPeriod: 5000,
      properties: {
        sessionExpiryInterval: 3600,
        receiveMaximum: 10,
        maximumPacketSize: 65536,
      },
      will: {
        topic: toServerTopic(this.stationId),
        payload: JSON.stringify(createEnvelope({
          messageId: `lwt-${this.stationId}`,
          messageType: MessageType.EVENT,
          action: OsppAction.CONNECTION_LOST,
          source: MessageSource.SERVER,
          payload: { stationId: this.stationId, reason: 'UnexpectedDisconnect' as const },
        })),
        qos: 1 as const,
        retain: false,
        properties: { willDelayInterval: 10 },
      },
    };

    if (this.mqttCredentials) {
      opts.username = this.mqttCredentials.username;
      opts.password = this.mqttCredentials.password;
    }

    if (this.tlsConfig) {
      if (this.tlsConfig.key) {
        opts.key = readFileSync(this.tlsConfig.key);
      }
      if (this.tlsConfig.cert) {
        opts.cert = readFileSync(this.tlsConfig.cert);
      }
      // Only set opts.ca for private CA servers (server_ca in config).
      // Station CA (ca) is for the broker to verify our client cert — NOT set client-side.
      // For public CA servers (Let's Encrypt), Node.js system store handles verification.
      if (this.tlsConfig.serverCa) {
        opts.ca = readFileSync(this.tlsConfig.serverCa);
      }
      opts.rejectUnauthorized = true;
      // TLS floor/ceiling — passed through to Node tls.connect(). DEFAULT
      // (no minVersion/maxVersion supplied via tlsConfig) is UNCHANGED from
      // before this knob existed: TLSv1.3 minimum per OSPP spec §1.3, no
      // ceiling. A scenario/config that supplies minVersion/maxVersion
      // (C3 TLS-1.2-floor conformance arc) overrides that floor/ceiling for
      // this connection only.
      opts.minVersion = this.tlsConfig.minVersion ?? 'TLSv1.3';
      if (this.tlsConfig.maxVersion) {
        opts.maxVersion = this.tlsConfig.maxVersion;
      }
    }

    this.client = connect(this.mqttUrl, opts);

    this.client.on('connect', (connack) => {
      this.isDestroyingConnection = false;
      this.emit('connect', connack);
    });

    const IGNORED_CODES = new Set(['ERR_STREAM_WRITE_AFTER_END', 'ECONNRESET']);

    this.client.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && IGNORED_CODES.has(code)) return;
      if (err.message.includes('write after end')) return;
      // A client with reconnectPeriod > 0 re-fires the same fatal error on
      // every reconnect attempt. Station.connect() wires its 'error'/'connect'
      // handlers with `.once`, so after the initial attempt settles a later
      // re-emit would reach an EventEmitter with zero 'error' listeners and
      // Node throws it as an *unhandled* 'error', crashing the process. This
      // bit a sub-floor TLS pin (S3): OpenSSL aborts every attempt locally with
      // ERR_SSL_NO_PROTOCOLS_AVAILABLE before any packet leaves. Only forward
      // when a consumer is actually listening; otherwise swallow the repeat.
      if (this.listenerCount('error') === 0) return;
      this.emit('error', err);
    });

    this.client.on('close', () => {
      this.emit('close');
    });

    this.client.on('reconnect', () => {
      this.emit('reconnect');
    });

    this.client.on('message', (topic, payload, packet) => {
      this.emit('message', topic, payload, packet);
    });
  }

  /** Destroy the TCP stream to simulate a network drop. The client stays alive and auto-reconnects via reconnectPeriod. */
  destroyConnection(): void {
    if (this.client) {
      this.isDestroyingConnection = true;
      (this.client as unknown as { stream?: { destroy(): void } }).stream?.destroy();
    }
  }

  disconnect(): Promise<void> {
    return new Promise<void>((resolve) => {
      const client = this.client;
      const stationId = this.stationId;
      if (!client) {
        resolve();
        return;
      }

      let settled = false;
      const finalize = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Record disconnect timestamp so the next connect() on the same
        // stationId honors RECONNECT_GUARD_MS. Recorded BEFORE the wrapper
        // is torn down so a reconnect synchronously chained on the
        // disconnect promise still consults a meaningful value.
        lastDisconnectAt.set(stationId, Date.now());
        this.client = null;
        this.currentClientId = null;
        resolve();
      };

      // MQTT 5 DISCONNECT properties: Session Expiry Interval = 0 forces
      // the broker to discard session state immediately so the next
      // CONNECT under this client_id (= cert CN, after peer_cert_as_clientid
      // derivation) starts fresh. The CONNECT-side default we sent earlier
      // (sessionExpiryInterval=3600) is in effect during the session;
      // sending 0 here overrides it on the way out per MQTT 5 §3.14.2.2.2.
      const disconnectOpts = { properties: { sessionExpiryInterval: 0 } };

      // Force-end fallback: if the graceful DISCONNECT round-trip stalls
      // (broker unresponsive, TLS half-close, etc.) bound the wait so the
      // next scenario does not block. Bumps the same callback as the
      // graceful path; first-to-finish wins.
      const timer = setTimeout(() => {
        try {
          client.end(true, disconnectOpts, () => finalize());
        } catch {
          finalize();
        }
      }, DISCONNECT_TIMEOUT_MS);

      try {
        client.end(false, disconnectOpts, () => finalize());
      } catch {
        finalize();
      }
    });
  }

  subscribe(topic: string, qos: 0 | 1 | 2): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.client) {
        reject(new Error('MQTT client is not connected'));
        return;
      }
      this.client.subscribe(topic, { qos }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  publish(topic: string, payload: string | Buffer, qos: 0 | 1 | 2): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.client) {
        reject(new Error('MQTT client is not connected'));
        return;
      }
      this.client.publish(topic, payload, { qos }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  onMessage(callback: (topic: string, payload: Buffer) => void): void {
    this.on('message', callback);
  }
}
