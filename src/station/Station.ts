import { EventEmitter } from 'node:events';
import type {
  OsppEnvelope,
  BayStatus,
  BootNotificationRequest,
  BayId,
  ServiceId,
} from '@ospp/protocol';
import {
  OsppAction,
  MessageType,
  BayStateMachine,
  BootReason,
  toStationTopic,
} from '@ospp/protocol';
import { MqttConnection, type MqttConnectionOptions } from '../mqtt/MqttConnection.js';
import { MessageRouter } from '../mqtt/MessageRouter.js';
import { MessageSender } from '../mqtt/MessageSender.js';
import type { StationConfig } from './StationConfig.js';
import { StationLifecycle } from './StationLifecycle.js';

export interface Handler {
  handle(envelope: OsppEnvelope, station: Station): Promise<void>;
}

export interface SessionInfo {
  sessionId: string;
  bayId: BayId;
  serviceId: ServiceId;
  startedAt: Date;
  durationSeconds: number;
  seqNo: number;
}

export interface ReservationInfo {
  reservationId: string;
  bayId: string;
  expirationTime: string;
  timer: ReturnType<typeof setTimeout>;
}

export class Station extends EventEmitter {
  public readonly config: StationConfig;
  public readonly sender: MessageSender;
  public readonly router: MessageRouter;
  public lifecycle: StationLifecycle = StationLifecycle.OFFLINE;
  public readonly sessions: Map<string, SessionInfo> = new Map();
  public readonly reservations: Map<string, ReservationInfo> = new Map();
  public currentRevocationEpoch: number = 0;

  private readonly connection: MqttConnection;
  public bootAccepted: boolean = false;

  private readonly handlers: Map<OsppAction, Handler> = new Map();
  private readonly registeredListeners: Set<OsppAction> = new Set();
  private readonly bayMachines: Map<string, BayStateMachine> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: StationConfig, mqttOptions: MqttConnectionOptions) {
    super();
    this.config = config;
    this.connection = new MqttConnection(mqttOptions);
    this.router = new MessageRouter();
    this.sender = new MessageSender(this.connection, config.stationId);

    for (const bay of config.bays) {
      this.bayMachines.set(bay.bayId, new BayStateMachine());
    }
  }

  async connect(): Promise<void> {
    this.connection.connect();

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.connection.removeListener('connect', onConnect);
        this.connection.removeListener('error', onError);
      };
      this.connection.once('connect', onConnect);
      this.connection.once('error', onError);
    });

    const topic = toStationTopic(this.config.stationId);
    await this.connection.subscribe(topic, 1);

    this.connection.onMessage((inboundTopic: string, payload: Buffer) => {
      this.router.route(inboundTopic, payload);
    });

    for (const action of this.handlers.keys()) {
      this.registerRouterListener(action);
    }

    this.lifecycle = StationLifecycle.ONLINE;
    this.bootAccepted = false;

    if (this.config.behavior.autoBoot) {
      const bootPayload: BootNotificationRequest = {
        stationId: this.config.stationId,
        firmwareVersion: this.config.firmwareVersion,
        stationModel: this.config.stationModel,
        stationVendor: this.config.stationVendor,
        serialNumber: this.config.serialNumber,
        bayCount: this.config.bayCount,
        uptimeSeconds: 0,
        pendingOfflineTransactions: 0,
        timezone: this.config.timezone,
        bootReason: BootReason.POWER_ON,
        capabilities: {
          bleSupported: false,
          offlineModeSupported: false,
          meterValuesSupported: true,
        },
        networkInfo: {
          connectionType: 'Ethernet',
        },
      };

      await this.sender.send(
        OsppAction.BOOT_NOTIFICATION,
        MessageType.REQUEST,
        bootPayload,
      );
    }

    this.emit('connected');
  }

  /** Simulate network drop — TCP destroyed, client auto-reconnects. */
  destroyConnection(): void {
    this.connection.destroyConnection();
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    await this.connection.disconnect();
    this.lifecycle = StationLifecycle.OFFLINE;
    this.emit('disconnected');
  }

  handleMessage(envelope: OsppEnvelope): void {
    // Boot gate: before boot is accepted, only allow BootNotification responses through
    if (!this.bootAccepted && envelope.action !== OsppAction.BOOT_NOTIFICATION) {
      console.warn('[Station] Ignoring %s — boot not yet accepted', envelope.action);
      return;
    }

    // Set bootAccepted when BootNotification Accepted is received
    if (envelope.action === OsppAction.BOOT_NOTIFICATION) {
      const payload = envelope.payload as { status?: string };
      if (payload.status === 'Accepted') {
        this.bootAccepted = true;
      }
    }

    const handler = this.handlers.get(envelope.action);
    if (!handler) {
      this.emit('unhandled', envelope);
      return;
    }
    handler.handle(envelope, this).catch((err: unknown) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  registerHandler(action: OsppAction, handler: Handler): void {
    this.handlers.set(action, handler);
    this.registerRouterListener(action);
  }

  /**
   * Update TLS material on the underlying MqttConnection before connect().
   * Used by E2E scenarios that provision a station mid-run.
   */
  setTls(tls: { key?: string; cert?: string; serverCa?: string } | undefined): void {
    this.connection.setTls(tls);
  }

  startHeartbeat(intervalSec: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sender
        .send(OsppAction.HEARTBEAT, MessageType.REQUEST, {})
        .catch((err: unknown) => {
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        });
    }, intervalSec * 1000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async retryBoot(): Promise<void> {
    console.log('[Station] Retrying BootNotification...');
    const bootPayload: BootNotificationRequest = {
      stationId: this.config.stationId,
      firmwareVersion: this.config.firmwareVersion,
      stationModel: this.config.stationModel,
      stationVendor: this.config.stationVendor,
      serialNumber: this.config.serialNumber,
      bayCount: this.config.bayCount,
      uptimeSeconds: 0,
      pendingOfflineTransactions: 0,
      timezone: this.config.timezone,
      bootReason: BootReason.POWER_ON,
      capabilities: {
        bleSupported: false,
        offlineModeSupported: false,
        meterValuesSupported: true,
      },
      networkInfo: {
        connectionType: 'Ethernet',
      },
    };

    await this.sender.send(
      OsppAction.BOOT_NOTIFICATION,
      MessageType.REQUEST,
      bootPayload,
    );
  }

  getBayState(bayId: string): BayStatus {
    const machine = this.bayMachines.get(bayId);
    if (!machine) {
      throw new Error(`Unknown bay: ${bayId}`);
    }
    return machine.state;
  }

  setBayState(bayId: string, status: BayStatus): void {
    const machine = this.bayMachines.get(bayId);
    if (!machine) {
      throw new Error(`Unknown bay: ${bayId}`);
    }
    machine.transition(status);
  }

  private registerRouterListener(action: OsppAction): void {
    if (this.registeredListeners.has(action)) return;
    this.registeredListeners.add(action);
    this.router.onAction(action, (envelope: OsppEnvelope) => {
      this.handleMessage(envelope);
    });
  }
}
