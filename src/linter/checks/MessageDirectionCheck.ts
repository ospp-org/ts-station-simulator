import type { LintIssue, LintCheck, ParsedScenario } from '../types.js';

// Station->Server: station sends Request, gets Response
const STATION_TO_SERVER = new Set([
  'BootNotification', 'Heartbeat', 'StatusNotification', 'MeterValues',
  'SessionEnded', 'ConnectionLost', 'SecurityEvent', 'FirmwareStatusNotification',
  'DiagnosticsNotification', 'TransactionEvent', 'SignCertificate', 'AuthorizeOfflinePass',
]);

// Server->Station: server sends Request, station sends Response
const SERVER_TO_STATION = new Set([
  'StartService', 'StopService', 'ReserveBay', 'CancelReservation',
  'Reset', 'UpdateFirmware', 'GetDiagnostics', 'GetConfiguration',
  'ChangeConfiguration', 'SetMaintenanceMode', 'UpdateServiceCatalog',
  'TriggerMessage', 'CertificateInstall', 'TriggerCertificateRenewal',
]);

// Events (no response)
const _EVENTS = new Set([
  'StatusNotification', 'MeterValues', 'SessionEnded', 'ConnectionLost',
  'SecurityEvent', 'FirmwareStatusNotification', 'DiagnosticsNotification',
]);

// Bidirectional
const BIDIRECTIONAL = new Set(['DataTransfer']);

export class MessageDirectionCheck implements LintCheck {
  name = 'message-direction';

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const action = step.action as string;
      const message = step.message as string | undefined;
      const messageType = step.messageType as string | undefined;

      if (!message || (action !== 'send' && action !== 'wait_for')) continue;
      if (BIDIRECTIONAL.has(message)) continue;

      if (action === 'send') {
        // Station is sending
        if (SERVER_TO_STATION.has(message) && messageType !== 'Response') {
          // Station can only SEND Response for Server->Station messages
          issues.push({
            file: scenario.filePath,
            step: i,
            stepAction: action,
            message: `Station sends ${message} but it is Server->Station; station can only send Response (got messageType: ${messageType ?? 'undefined'})`,
          });
        }
        if (STATION_TO_SERVER.has(message) && messageType === 'Response') {
          // Station cannot send Response for Station->Server messages
          issues.push({
            file: scenario.filePath,
            step: i,
            stepAction: action,
            message: `Station sends ${message} Response but ${message} is Station->Server -- station sends Request, not Response`,
          });
        }
      }

      if (action === 'wait_for') {
        // Station is waiting
        if (STATION_TO_SERVER.has(message) && messageType === 'Request') {
          // Station can't wait for Request on its own messages (it sends the Request)
          issues.push({
            file: scenario.filePath,
            step: i,
            stepAction: action,
            message: `Station waits for ${message} Request but ${message} is Station->Server -- server doesn't send Request for this`,
          });
        }
        if (SERVER_TO_STATION.has(message) && messageType === 'Response') {
          // Station can't wait for Response on server messages (it sends the Response)
          issues.push({
            file: scenario.filePath,
            step: i,
            stepAction: action,
            message: `Station waits for ${message} Response but ${message} is Server->Station -- station sends the Response, not receives it`,
          });
        }
      }
    }

    return issues;
  }
}
