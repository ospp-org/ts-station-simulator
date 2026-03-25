import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type ChangeConfigurationRequest,
  type ChangeConfigurationResponse,
  type ChangeConfigurationResult,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class ChangeConfigurationHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as ChangeConfigurationRequest;

    // Simulated: accept all configuration changes
    const results: ChangeConfigurationResult[] = request.keys.map(kv => ({
      key: kv.key,
      status: 'Accepted' as const,
    }));

    const response: ChangeConfigurationResponse = { results };

    await station.sender.send<ChangeConfigurationResponse>(
      OsppAction.CHANGE_CONFIGURATION,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[ChangeConfiguration] Accepted %d configuration changes: %s',
      results.length,
      request.keys.map(kv => `${kv.key}=${kv.value}`).join(', '),
    );
  }
}
