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

  constructor(
    connection: MqttConnection,
    stationId: string,
    getSessionKey: () => string | null = () => null,
    signingMode: MessageSigningMode = 'Critical',
  ) {
    this.connection = connection;
    this.stationId = stationId;
    this.getSessionKey = getSessionKey;
    this.signingMode = signingMode;
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
