import crypto from 'node:crypto';
import {
  OsppAction,
  MessageType,
  MessageSource,
  createEnvelope,
  toServerTopic,
  requiresHmac,
  type MessageSigningMode,
  type OsppEnvelope,
} from '@ospp/protocol';
import { signMessage } from '@ospp/protocol/server';
import type { MqttConnection } from './MqttConnection.js';

export class MessageSender {
  private readonly connection: MqttConnection;
  private readonly stationId: string;
  private readonly getSessionKey: () => string | null;
  private readonly signingMode: MessageSigningMode;
  private readonly protocolVersion: string | undefined;

  constructor(
    connection: MqttConnection,
    stationId: string,
    getSessionKey: () => string | null = () => null,
    signingMode: MessageSigningMode = 'Critical',
    // Overridable OSPP wire protocolVersion for every outgoing envelope. Omitted → the SDK default
    // (OSPP_PROTOCOL_VERSION, currently 0.2.1), which a local-HEAD cascade negotiates fine (MAJOR-0
    // matches dev/testing/prod-example). Set OSPP_PROTOCOL_VERSION in the env to target a server pinned
    // to a different MAJOR (e.g. UAT 1.x) — otherwise those messages would be rejected 1007. Never
    // hardcoded here so the same build can be pointed at either without an edit.
    protocolVersion: string | undefined = process.env.OSPP_PROTOCOL_VERSION || undefined,
  ) {
    this.connection = connection;
    this.stationId = stationId;
    this.getSessionKey = getSessionKey;
    this.signingMode = signingMode;
    this.protocolVersion = protocolVersion;
  }

  async send<T>(
    action: OsppAction,
    messageType: MessageType,
    payload: T,
    correlationId?: string,
  ): Promise<OsppEnvelope<T>> {
    const envelope = createEnvelope<T>({
      messageId: correlationId ?? crypto.randomUUID(),
      messageType,
      action,
      source: MessageSource.STATION,
      payload,
      // undefined → the SDK default (OSPP_PROTOCOL_VERSION); an env/explicit override negotiates
      // against a server pinned to a different MAJOR.
      protocolVersion: this.protocolVersion,
    });

    // HMAC-sign the WHOLE envelope (not envelope.payload) when the message
    // requires it — this mirrors the server's MacSigner, which signs the full
    // envelope minus `mac`. signMessage adds the `mac` field.
    const sessionKey = this.getSessionKey();
    const outgoing: OsppEnvelope<T> =
      sessionKey !== null && requiresHmac(action, messageType, this.signingMode)
        ? (signMessage(
            sessionKey,
            envelope as unknown as Record<string, unknown>,
          ) as unknown as OsppEnvelope<T>)
        : envelope;

    await this.connection.publish(toServerTopic(this.stationId), JSON.stringify(outgoing), 1);

    return outgoing;
  }

  async sendEnvelope<T>(envelope: OsppEnvelope<T>): Promise<void> {
    await this.connection.publish(toServerTopic(this.stationId), JSON.stringify(envelope), 1);
  }
}
