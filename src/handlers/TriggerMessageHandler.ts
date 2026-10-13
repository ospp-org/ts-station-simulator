import crypto from 'node:crypto';
import {
  isReportableBayStatus,
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type TriggerMessageRequest,
  type TriggerMessageResponse,
  type HeartbeatRequest,
  type DiagnosticsNotificationPayload,
  type FirmwareStatusNotificationPayload,
  type SecurityEventPayload,
  type SignCertificateRequest,
} from '@ospp/protocol';
import type { Handler, SessionInfo, StationContext } from './Handler.js';
import { reportBayStatus } from '../station/bayReport.js';
import { sendMeterValues } from '../station/sessionMeter.js';

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
        // bootReason: `Reconnect`, the uptime running on. boot-notification.md
        // §5.2 names this case: "`Reconnect` therefore covers both cases of no boot
        // occurred: a re-dialled session, and a Boot the server asked for." This
        // path used to report the reason of the last real boot - `PowerOn` after a
        // power-on - with an uptime that never reset: a power-on that did not
        // happen, which the server's rule-3 cross-check refuses on every trigger.
        await station.bootOnRequest();
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
        // Every bay, or only the one asked for (trigger-message.md §5 rule 3) - reported with its own
        // bayNumber. It took the FIRST bay's, so a trigger for bay 2 named bay 2's id with bay 1's number.
        for (const bay of this.baysAskedFor(request, station)) {
          const bayState = station.getBayState(bay.bayId);

          // Same rule as the post-boot report: a station reports a determinate
          // state or it does not report. `Unknown` is not a wire value
          // (05-state-machines.md §1.2), and a triggered report is no exception —
          // TriggerMessage asks the station what a bay IS, not what the server has
          // forgotten.
          if (!isReportableBayStatus(bayState)) {
            throw new Error(
              `[TriggerMessage] bay ${bay.bayId} is in state ${bayState}, which a station must not ` +
                'report. Resolve the bay before reporting it (05-state-machines.md §1.2).',
            );
          }

          // The one bay reporter: previousStatus only when the bay is not what it was last reported as
          // (status-notification.md §5 rule 2), and the report recorded as the last one.
          await reportBayStatus(station, bay.bayId, bayState);
        }
        console.log('[TriggerMessage] StatusNotification sent');
        break;
      }

      case 'MeterValues': {
        // A normal message instance (rule 2): the session's reading now, with its next seqNo on its one
        // counter, persisted before the publish - built where every MeterValues is (sessionMeter.ts). It
        // sent constant zeros, with no seqNo, for every session whatever bayId was asked.
        const sessions = this.sessionsAskedFor(request, station);
        for (const session of sessions) {
          await sendMeterValues(station, session);
        }
        console.log('[TriggerMessage] MeterValues sent for %d session(s)', sessions.length);
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
        // Rule 4: Rejected when no session is active on the bay asked for, or on any bay.
        if (this.sessionsAskedFor(request, station).length === 0) {
          return request.bayId !== undefined ? `no session on bay ${request.bayId}` : 'no active sessions';
        }
        return null;
      case 'StatusNotification':
        // A bay this station does not have: nothing it could send after an Accepted.
        if (this.baysAskedFor(request, station).length === 0) return `no bay ${request.bayId}`;
        return null;
      default:
        return null;
    }
  }

  private baysAskedFor(request: TriggerMessageRequest, station: StationContext) {
    return request.bayId === undefined
      ? station.config.bays
      : station.config.bays.filter((b) => b.bayId === request.bayId);
  }

  /** The running sessions on the bay asked for, or on every bay - not one whose end is already under way. */
  private sessionsAskedFor(request: TriggerMessageRequest, station: StationContext): SessionInfo[] {
    return [...station.sessions.values()].filter(
      (s) => s.ending !== true && (request.bayId === undefined || s.bayId === request.bayId),
    );
  }
}
