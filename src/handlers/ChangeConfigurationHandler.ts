import {
  ConfigKey,
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

    // The key by the name the spec gives it: RevocationEpoch (08-configuration.md, section 3), which
    // csms-server pushes at every boot and on every epoch bump. It was compared as `revocationEpoch`,
    // so the push was answered Accepted and never applied (CW95).
    for (const kv of request.keys) {
      if (kv.key === ConfigKey.REVOCATION_EPOCH) {
        const epoch = Number(kv.value);
        if (Number.isFinite(epoch)) {
          const previous = station.currentRevocationEpoch;
          station.currentRevocationEpoch = epoch;
          console.log('[ChangeConfiguration] %s applied: %d (was %d)', ConfigKey.REVOCATION_EPOCH, epoch, previous);
        }
      }
    }

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
