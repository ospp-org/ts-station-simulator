import crypto from 'node:crypto';
import {
  OsppAction,
  MessageType,
  MessageSource,
  createEnvelope,
  toServerTopic,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { MqttConnection } from './MqttConnection.js';

export class MessageSender {
  private readonly connection: MqttConnection;
  private readonly stationId: string;

  constructor(connection: MqttConnection, stationId: string) {
    this.connection = connection;
    this.stationId = stationId;
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

    await this.connection.publish(
      toServerTopic(this.stationId),
      JSON.stringify(envelope),
      1,
    );

    return envelope;
  }

  async sendEnvelope<T>(envelope: OsppEnvelope<T>): Promise<void> {
    await this.connection.publish(
      toServerTopic(this.stationId),
      JSON.stringify(envelope),
      1,
    );
  }
}
