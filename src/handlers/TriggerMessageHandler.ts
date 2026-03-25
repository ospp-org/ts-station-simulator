import crypto from 'node:crypto';
import {
  OsppAction,
  MessageType,
  BootReason,
  type OsppEnvelope,
  type TriggerMessageRequest,
  type TriggerMessageResponse,
  type HeartbeatRequest,
  type StatusNotificationPayload,
  type BootNotificationRequest,
  type MeterValuesPayload,
  type DiagnosticsNotificationPayload,
  type FirmwareStatusNotificationPayload,
  type SecurityEventPayload,
  type SignCertificateRequest,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class TriggerMessageHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as TriggerMessageRequest;

    // For messages that may be rejected, check before responding
    const needsReject = this.shouldReject(request, station);
    if (needsReject) {
      const rejected: TriggerMessageResponse = { status: 'Rejected' };
      await station.sender.send<TriggerMessageResponse>(
        OsppAction.TRIGGER_MESSAGE, MessageType.RESPONSE, rejected, envelope.messageId,
      );
      console.log('[TriggerMessage] Rejected — %s (%s)', request.requestedMessage, needsReject);
      return;
    }

    // Respond Accepted
    const response: TriggerMessageResponse = { status: 'Accepted' };

    await station.sender.send<TriggerMessageResponse>(
      OsppAction.TRIGGER_MESSAGE,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[TriggerMessage] Accepted — will send %s',
      request.requestedMessage,
    );

    // Now send the requested message
    switch (request.requestedMessage) {
      case 'BootNotification': {
        const bootPayload: BootNotificationRequest = {
          stationId: station.config.stationId,
          firmwareVersion: station.config.firmwareVersion,
          stationModel: station.config.stationModel,
          stationVendor: station.config.stationVendor,
          serialNumber: station.config.serialNumber,
          bayCount: station.config.bayCount,
          uptimeSeconds: 0,
          pendingOfflineTransactions: 0,
          timezone: station.config.timezone,
          bootReason: BootReason.POWER_ON,
          capabilities: {
            bleSupported: false,
            offlineModeSupported: false,
            meterValuesSupported: true,
          },
          networkInfo: {
            connectionType: 'Ethernet',
          },
        };
        await station.sender.send<BootNotificationRequest>(
          OsppAction.BOOT_NOTIFICATION, MessageType.REQUEST, bootPayload,
        );
        console.log('[TriggerMessage] BootNotification sent');
        break;
      }

      case 'Heartbeat': {
        const heartbeatPayload: HeartbeatRequest = {} as HeartbeatRequest;
        await station.sender.send<HeartbeatRequest>(
          OsppAction.HEARTBEAT,
          MessageType.REQUEST,
          heartbeatPayload,
        );
        console.log('[TriggerMessage] Heartbeat sent');
        break;
      }

      case 'StatusNotification': {
        // Send status for all configured bays
        for (const bay of station.config.bays) {
          const bayId = request.bayId ?? bay.bayId;
          const statusPayload: StatusNotificationPayload = {
            bayId,
            bayNumber: bay.bayNumber,
            status: station.getBayState(bayId),
            services: bay.services.map(s => ({
              serviceId: s.serviceId,
              available: s.available,
            })),
          };
          await station.sender.send<StatusNotificationPayload>(
            OsppAction.STATUS_NOTIFICATION,
            MessageType.EVENT,
            statusPayload,
          );
          // If a specific bayId was requested, only send for that one
          if (request.bayId) break;
        }
        console.log('[TriggerMessage] StatusNotification sent');
        break;
      }

      case 'MeterValues': {
        // Send MeterValues for all active sessions
        for (const session of station.sessions.values()) {
          const meterPayload: MeterValuesPayload = {
            bayId: session.bayId,
            sessionId: session.sessionId,
            timestamp: new Date().toISOString(),
            values: {
              liquidMl: 0,
              energyWh: 0,
            },
          };
          await station.sender.send<MeterValuesPayload>(
            OsppAction.METER_VALUES, MessageType.EVENT, meterPayload,
          );
        }
        console.log('[TriggerMessage] MeterValues sent for %d sessions', station.sessions.size);
        break;
      }

      case 'DiagnosticsNotification': {
        // No active diagnostics operation — send idle status
        const diagPayload: DiagnosticsNotificationPayload = {
          status: 'Uploaded',
        };
        await station.sender.send<DiagnosticsNotificationPayload>(
          OsppAction.DIAGNOSTICS_NOTIFICATION, MessageType.EVENT, diagPayload,
        );
        console.log('[TriggerMessage] DiagnosticsNotification sent');
        break;
      }

      case 'FirmwareStatusNotification': {
        // No active firmware operation — send idle status
        const fwPayload: FirmwareStatusNotificationPayload = {
          status: 'Installed',
          firmwareVersion: station.config.firmwareVersion,
        };
        await station.sender.send<FirmwareStatusNotificationPayload>(
          OsppAction.FIRMWARE_STATUS_NOTIFICATION, MessageType.EVENT, fwPayload,
        );
        console.log('[TriggerMessage] FirmwareStatusNotification sent');
        break;
      }

      case 'SecurityEvent': {
        const secPayload: SecurityEventPayload = {
          eventId: crypto.randomUUID(),
          type: 'SoftwareFault',
          severity: 'Info',
          timestamp: new Date().toISOString(),
          details: { trigger: 'TriggerMessage' },
        };
        await station.sender.send<SecurityEventPayload>(
          OsppAction.SECURITY_EVENT, MessageType.EVENT, secPayload,
        );
        console.log('[TriggerMessage] SecurityEvent sent');
        break;
      }

      case 'SignCertificate': {
        const signPayload: SignCertificateRequest = {
          certificateType: 'StationCertificate',
          csr: 'triggered-csr-placeholder',
        };
        await station.sender.send<SignCertificateRequest>(
          OsppAction.SIGN_CERTIFICATE, MessageType.REQUEST, signPayload,
        );
        console.log('[TriggerMessage] SignCertificate request sent');
        break;
      }
    }
  }

  private shouldReject(request: TriggerMessageRequest, station: StationContext): string | null {
    switch (request.requestedMessage) {
      case 'MeterValues':
        if (station.sessions.size === 0) return 'no active sessions';
        return null;
      default:
        return null;
    }
  }
}
