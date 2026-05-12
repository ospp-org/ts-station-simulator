import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { connect, type MqttClient, type IClientOptions } from 'mqtt';
import {
  OsppAction,
  MessageType,
  MessageSource,
  createEnvelope,
  toServerTopic,
} from '@ospp/protocol';

export interface MqttConnectionOptions {
  mqttUrl: string;
  stationId: string;
  tls?: {
    key?: string;      // file path — station client key (mTLS)
    cert?: string;     // file path — station client cert (mTLS)
    serverCa?: string; // file path — custom CA for server cert verification (private CA only)
  };
  mqttCredentials?: {
    username: string;
    password: string;
  };
  cleanSession?: boolean;
}

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

  constructor(options: MqttConnectionOptions) {
    super();
    this.mqttUrl = options.mqttUrl;
    this.stationId = options.stationId;
    this.tlsConfig = options.tls;
    this.mqttCredentials = options.mqttCredentials;
    this.cleanSession = options.cleanSession ?? false;
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
    const opts: IClientOptions = {
      clientId: this.stationId,
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
      // TLS 1.3 minimum per OSPP spec §1.3 — passed through to Node tls.connect()
      (opts as Record<string, unknown>)['minVersion'] = 'TLSv1.3';
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
    return new Promise<void>((resolve, reject) => {
      if (!this.client) {
        resolve();
        return;
      }
      this.client.end(false, {}, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
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
