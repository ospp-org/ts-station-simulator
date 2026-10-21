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
import { errorName } from './bayRefusal.js';
import { StationConfiguration } from '../station/StationConfiguration.js';

export class ChangeConfigurationHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as ChangeConfigurationRequest;

    // EVERY KEY JUDGED FIRST, NONE APPLIED UNLESS ALL PASS (08-configuration.md §8.2;
    // change-configuration.md §6 rules 1-6), by the registry the station holds every key of
    // (StationConfiguration.judge): unknown - NotSupported; ReadOnly - Rejected 5108; a value of the
    // wrong type or out of its range - Rejected 5109; valid - Accepted for a Dynamic key, in force at
    // once, RebootRequired for a Static one, in force from the next boot. Each entry is a per-key
    // verdict: a key that passed reads Accepted beside a Rejected one, and the batch applies nothing.
    //
    // Every key but the two meter keys and RevocationEpoch was answered Accepted, unvalidated, and held
    // nowhere until 2026-10-21. A context with no configuration of its own (a handler test's) judges the
    // batch against the defaults and keeps it nowhere.
    const configuration = station.configuration ?? new StationConfiguration();
    const before = Object.fromEntries(request.keys.map((kv) => [kv.key, configuration.value(kv.key)]));
    const { verdicts, applied } = configuration.applyBatch(request.keys);
    const results: ChangeConfigurationResult[] = request.keys.map((kv, i) => ({
      key: kv.key,
      status: verdicts[i].status,
      ...(verdicts[i].errorCode === undefined ? {} : { errorCode: verdicts[i].errorCode, errorText: errorName(verdicts[i].errorCode!) }),
    }));

    if (applied) {
      for (const kv of request.keys) {
        // The two keys with behaviour beyond holding the value. RevocationEpoch by the name the spec
        // gives it (08-configuration.md §3), which csms-server pushes at every boot and on every epoch
        // bump; HeartbeatIntervalSeconds re-arms a running heartbeat at its new interval.
        if (kv.key === ConfigKey.REVOCATION_EPOCH) {
          const previous = station.currentRevocationEpoch;
          station.currentRevocationEpoch = Number(kv.value);
          console.log('[ChangeConfiguration] %s applied: %d (was %d)', kv.key, Number(kv.value), previous);
          continue;
        }
        if (configuration.value(kv.key) !== before[kv.key]) {
          console.log('[ChangeConfiguration] %s applied: %s (was %s)', kv.key, kv.value, before[kv.key] ?? 'unset');
        }
        if (kv.key === ConfigKey.HEARTBEAT_INTERVAL_SECONDS) {
          station.heartbeatIntervalChanged?.(Number(kv.value));
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

    if (applied) {
      console.log(
        '[ChangeConfiguration] Applied %d configuration changes: %s',
        results.length,
        request.keys.map((kv, i) => `${kv.key}=${kv.value} (${verdicts[i].status})`).join(', '),
      );
    } else {
      console.log(
        '[ChangeConfiguration] Refused %s - nothing in the batch of %d applied (08-configuration.md §8.2)',
        results.filter((r) => r.status === 'Rejected' || r.status === 'NotSupported').map((r) => `${r.key} ${r.status}${r.errorCode === undefined ? '' : ` ${r.errorCode}`}`).join(', '),
        results.length,
      );
    }
  }
}
