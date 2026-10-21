import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type GetConfigurationRequest,
  type GetConfigurationResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';
import { StationConfiguration } from '../station/StationConfiguration.js';

export class GetConfigurationHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as GetConfigurationRequest;

    // THE KEYS THE STATION HOLDS, BY THEIR SPEC NAMES (get-configuration.md §5.1; 08-configuration.md
    // §3): every key of the registry but a WriteOnly one, ReadOnly ones marked so; asked by name, a
    // WriteOnly key appears in neither array and a key the station does not hold is unknown. Until
    // 2026-10-21 it reported names no spec version has - stationId, acceptRate, heartbeatIntervalSec -
    // and two registry keys beside them.
    const configuration = station.configuration ?? new StationConfiguration();
    const asked = request.keys !== undefined && request.keys.length > 0 ? request.keys : undefined;
    const report = configuration.report(asked);

    const response: GetConfigurationResponse = {
      configuration: report.configuration,
      ...(asked !== undefined && report.unknownKeys.length > 0 ? { unknownKeys: report.unknownKeys } : {}),
    };

    await station.sender.send<GetConfigurationResponse>(
      OsppAction.GET_CONFIGURATION,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[GetConfiguration] Responded with %d entries%s',
      report.configuration.length,
      report.unknownKeys.length > 0 ? `, ${report.unknownKeys.length} unknown keys` : '',
    );
  }
}
