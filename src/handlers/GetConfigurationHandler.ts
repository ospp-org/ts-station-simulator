import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type GetConfigurationRequest,
  type GetConfigurationResponse,
  type ConfigurationEntry,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';
import { HELD_CONFIG_KEYS, configValue } from '../station/StationConfiguration.js';

export class GetConfigurationHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as GetConfigurationRequest;

    // Build the full configuration map from station config
    const allConfig: ConfigurationEntry[] = [
      { key: 'stationId', value: station.config.stationId, readonly: true },
      { key: 'firmwareVersion', value: station.config.firmwareVersion, readonly: true },
      { key: 'stationModel', value: station.config.stationModel, readonly: true },
      { key: 'stationVendor', value: station.config.stationVendor, readonly: true },
      { key: 'serialNumber', value: station.config.serialNumber, readonly: true },
      { key: 'bayCount', value: String(station.config.bayCount), readonly: true },
      { key: 'timezone', value: station.config.timezone, readonly: false },
      { key: 'heartbeatIntervalSec', value: String(station.config.behavior.heartbeatIntervalSec), readonly: false },
      // The configuration keys this station holds, under the names the spec gives them (08-configuration.md
      // §3) and with the value in force. The interval was reported as `meterValuesIntervalSec`, a name no
      // spec version has, so a GetConfiguration of MeterValuesInterval came back in unknownKeys.
      ...HELD_CONFIG_KEYS.map((key) => ({ key, value: String(configValue(station, key)), readonly: false })),
      { key: 'acceptRate', value: String(station.config.behavior.acceptRate), readonly: false },
    ];

    let configuration: ConfigurationEntry[];
    let unknownKeys: string[] | undefined;

    if (request.keys && request.keys.length > 0) {
      const configMap = new Map(allConfig.map(e => [e.key, e]));
      configuration = [];
      unknownKeys = [];

      for (const key of request.keys) {
        const entry = configMap.get(key);
        if (entry) {
          configuration.push(entry);
        } else {
          unknownKeys.push(key);
        }
      }

      if (unknownKeys.length === 0) {
        unknownKeys = undefined;
      }
    } else {
      configuration = allConfig;
    }

    const response: GetConfigurationResponse = {
      configuration,
      ...(unknownKeys ? { unknownKeys } : {}),
    };

    await station.sender.send<GetConfigurationResponse>(
      OsppAction.GET_CONFIGURATION,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[GetConfiguration] Responded with %d entries%s',
      configuration.length,
      unknownKeys ? `, ${unknownKeys.length} unknown keys` : '',
    );
  }
}
