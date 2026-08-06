import crypto from 'node:crypto';
import {
  isReportableBayStatus,
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type TriggerMessageRequest,
  type TriggerMessageResponse,
  type HeartbeatRequest,
  type StatusNotificationPayload,
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
        // Delegate rather than build a second payload here. A trigger is not a
        // boot: nothing power-cycles, so every field is a fact about the station,
        // and retryBoot() already derives all of them from live state. A literal
        // built here disagreed with it in three places — uptimeSeconds: 0 (which
        // makes the CSMS force-fail and refund every live wash, since it derives
        // bootTime = now - uptimeSeconds), a hardcoded PowerOn, and an omitted
        // deviceManagementSupported. Calling the shared path means the next field
        // added to the boot payload cannot diverge on this one.
        //
        // bootReason follows from the same premise: the field is "reason the
        // station booted" (spec/profiles/core/boot-notification.md:29) — a
        // property of the last boot EPISODE, not of the send. A trigger
        // re-announces an episode rather than starting one, exactly as a
        // Rejected/Pending retry does, so the truthful value is whatever actually
        // booted the station. That is Station.currentBootReason, and reading it
        // makes this path truthful by construction instead of by picking a value.
        await station.retryBoot();
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
          const bayState = station.getBayState(bayId);

          // Same rule as the post-boot report: a station reports a determinate
          // state or it does not report. `Unknown` is not a wire value
          // (05-state-machines.md §1.2), and a triggered report is no exception —
          // TriggerMessage asks the station what a bay IS, not what the server has
          // forgotten.
          if (!isReportableBayStatus(bayState)) {
            throw new Error(
              `[TriggerMessage] bay ${bayId} is in state ${bayState}, which a station must not ` +
                'report. Resolve the bay before reporting it (05-state-machines.md §1.2).',
            );
          }

          const statusPayload: StatusNotificationPayload = {
            bayId,
            bayNumber: bay.bayNumber,
            status: bayState,
            // PROGRAMS, not services — status-notification.schema.json.
            programs: bay.programs.map(p => ({
              programNumber: p.programNumber,
              available: p.available,
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
