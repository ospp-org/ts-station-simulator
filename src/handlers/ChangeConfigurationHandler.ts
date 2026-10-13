import {
  ConfigKey,
  OsppAction,
  MessageType,
  OsppErrorCode,
  type OsppEnvelope,
  type ChangeConfigurationRequest,
  type ChangeConfigurationResponse,
  type ChangeConfigurationResult,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';
import { errorName } from './bayRefusal.js';
import {
  configValue,
  describeConfigRange,
  isHeldConfigKey,
  parseConfigValue,
  type HeldConfigKey,
} from '../station/StationConfiguration.js';

export class ChangeConfigurationHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as ChangeConfigurationRequest;

    // EVERY KEY VALIDATED FIRST, NONE APPLIED UNLESS ALL PASS (08-configuration.md §8.2;
    // change-configuration.md §6 rules 1-2). A key this station holds - MeterValuesInterval,
    // MeterValuesSampleInterval - must be an integer in its range, or its entry is Rejected with
    // 5109 INVALID_CONFIGURATION_VALUE (rule 6). Each entry is a per-key verdict on validation: a key
    // that passed reads Accepted beside a Rejected one, and the batch applies nothing (§8.2).
    //
    // Every other key is answered Accepted, unvalidated, as before - RevocationEpoch is applied, the
    // rest are not held (docs/CONFORMANCE-GAPS.md). MeterValuesInterval was one of them: answered
    // Accepted and ignored, while the server recorded it as the value in force.
    const held: Array<[HeldConfigKey, number]> = [];
    const refused: string[] = [];
    const results: ChangeConfigurationResult[] = request.keys.map((kv) => {
      if (isHeldConfigKey(kv.key)) {
        const value = parseConfigValue(kv.key, kv.value);
        if (value === null) {
          refused.push(`${kv.key}=${JSON.stringify(kv.value)} (not an integer in ${describeConfigRange(kv.key)})`);
          return {
            key: kv.key,
            status: 'Rejected' as const,
            errorCode: OsppErrorCode.INVALID_CONFIGURATION_VALUE,
            errorText: errorName(OsppErrorCode.INVALID_CONFIGURATION_VALUE),
          };
        }
        held.push([kv.key, value]);
      }
      return { key: kv.key, status: 'Accepted' as const };
    });

    if (refused.length === 0) {
      // Both keys are Dynamic: applied at once (§8.2 rule 5). The meter reads its interval when it
      // schedules its next event, so a wash running now takes it from the next scheduled event
      // (meter-values.md §5.1 rule 6).
      for (const [key, value] of held) {
        const previous = configValue(station, key);
        station.configuration?.set(key, value);
        console.log('[ChangeConfiguration] %s applied: %d (was %d)', key, value, previous);
      }

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
    }

    const response: ChangeConfigurationResponse = { results };

    await station.sender.send<ChangeConfigurationResponse>(
      OsppAction.CHANGE_CONFIGURATION,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    if (refused.length === 0) {
      console.log(
        '[ChangeConfiguration] Accepted %d configuration changes: %s',
        results.length,
        request.keys.map(kv => `${kv.key}=${kv.value}`).join(', '),
      );
    } else {
      console.log(
        '[ChangeConfiguration] Rejected %s - nothing in the batch of %d applied (08-configuration.md §8.2)',
        refused.join(', '),
        results.length,
      );
    }
  }
}
