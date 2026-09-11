import { type OsppEnvelope, type BootNotificationResponse, OsppAction, MessageType, type StatusNotificationPayload, isReportableBayStatus } from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class BootNotificationHandler implements Handler {
  /**
   * @param autoReact When true (default — `connect` mode), the station emits a
   *   StatusNotification per bay after a successful boot. Scenario mode passes
   *   `false`: scenarios drive those explicitly, with the PROVISIONED bayIds and
   *   empirically-tuned timing, so auto-firing there would both duplicate the
   *   scenario's own messages and send them for the pre-provision (wrong) bayIds.
   *
   * @param autoHeartbeat When true (the default in BOTH modes), an accepted boot
   *   arms the background Heartbeat at the interval the SERVER declared in the
   *   Response. Scenario mode passes `false` only for a file that declares
   *   `suppress_heartbeat:`.
   *
   *   WHY THIS IS A SECOND PARAMETER RATHER THAN THE SAME ONE. It used to be the
   *   same one, and that conflated two unrelated decisions. Not emitting
   *   StatusNotifications for bayIds the scenario has not provisioned yet is
   *   correct and still is. Not beating is a NON-CONFORMANCE: 02-transport.md §4.2
   *   makes the Heartbeat the station's liveness signal, and the csms
   *   `station:check-heartbeats` sweep marks a station offline after `3.5 x
   *   heartbeatIntervalSec` of application silence — 105s against the deployed 30.
   *   Measured on disk the day this split landed, **140 of 148** scenario files
   *   booted and then never beat again, so the suite exercised a station no
   *   integrator will ever operate, and the long files papered over it one at a
   *   time with an explicit `start_heartbeat` step (8 of 148).
   *
   *   Only an ACCEPTED boot arms it, and firmware in any other state is retrying
   *   its boot rather than beating — 05-state-machines.md:129 lists Heartbeat
   *   among the messages a restricted station may not send.
   *
   *   CORRECTED 2026-09-11. This used to justify that with "A Rejected or Pending
   *   station has no session to keep alive", which is false for Pending and was
   *   the rationale under the missing `station.sessionKey` write in that branch.
   *   A Pending station DOES hold a session key — 05-state-machines.md:57, "the
   *   response that put it here carries one — because every command it answers is
   *   signed" — it simply does not beat. Not beating and holding no key are two
   *   different things, and only `Rejected` is both.
   */
  constructor(
    private readonly autoReact: boolean = true,
    private readonly autoHeartbeat: boolean = true,
  ) {}

  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const response = envelope.payload as BootNotificationResponse;

    switch (response.status) {
      case 'Accepted': {
        console.log(
          '[BootNotification] Accepted. Heartbeat interval: %ds',
          response.heartbeatIntervalSec,
        );

        // Persist the session key from the response so the MessageSender can
        // HMAC-sign critical outbound messages (over the whole envelope).
        station.sessionKey = response.sessionKey ?? null;

        // The station beats — in BOTH modes, at the interval the server just
        // declared. This is the one thing real firmware always does after an
        // accepted boot, so it is the default and a file that needs silence turns
        // it off by name. See the constructor for what that cost while it was tied
        // to `autoReact`.
        if (this.autoHeartbeat) {
          station.startHeartbeat(response.heartbeatIntervalSec);
        }

        // Connect-mode auto-pilot only (see constructor). Scenario mode drives
        // its StatusNotifications explicitly.
        if (this.autoReact) {
          // Send StatusNotification for every bay (BOOT-012, SN-001).
          //
          // `previousStatus` is deliberately absent: this is the post-boot report,
          // and the state it leaves behind is `Unknown`, which the field cannot
          // carry. Its absence is what marks the message as the boot report
          // (status-notification.md §5 rule 2).
          for (const bay of station.config.bays) {
            const bayState = station.getBayState(bay.bayId);

            // The station reports what it resolved TO, never `Unknown` itself. Bays
            // are constructed AVAILABLE and nothing station-side moves them back —
            // the transitions INTO `Unknown` are the server's LWT bookkeeping, which
            // a station never observes. So this cannot fire; it is here because the
            // alternative is publishing a non-conforming message, and a loud local
            // failure beats a message the server will reject and drop entirely.
            if (!isReportableBayStatus(bayState)) {
              throw new Error(
                `[BootNotification] bay ${bay.bayId} is in state ${bayState}, which a station ` +
                  'must not report. Resolve the bay before reporting it (05-state-machines.md §1.2).',
              );
            }

            const statusPayload: StatusNotificationPayload = {
              bayId: bay.bayId,
              bayNumber: bay.bayNumber,
              status: bayState,
              // PROGRAMS, not services — status-notification.schema.json. A station
              // cannot originate knowledge of a service, only echo one it was pushed.
              programs: bay.programs.map(p => ({ programNumber: p.programNumber, available: p.available })),
            };
            await station.sender.send(OsppAction.STATUS_NOTIFICATION, MessageType.EVENT, statusPayload);
          }
        }

        // Clock sync from serverTime (HB-010 -- also done on boot)
        const serverTime = new Date(response.serverTime).getTime();
        const drift = Math.abs(serverTime - Date.now());
        if (drift > 300_000) {
          console.warn('[BootNotification] Clock drift exceeds 5 minutes (%dms). CLOCK_ERROR', drift);
        }

        break;
      }

      case 'Rejected': {
        const retryInterval = response.retryInterval;
        console.log('[BootNotification] Rejected. retryInterval: %ds', retryInterval);
        if (station.config.behavior.autoRetryBoot) {
          setTimeout(() => {
            station.retryBoot().catch((err: unknown) => {
              console.error('[BootNotification] Retry failed:', err instanceof Error ? err.message : String(err));
            });
          }, retryInterval * 1000);
        }
        break;
      }

      case 'Pending': {
        const retryInterval = response.retryInterval;
        console.log('[BootNotification] Pending. retryInterval: %ds', retryInterval);

        // A PENDING STATION HOLDS A KEY, AND IT IS THE WHOLE POINT OF THE STATE.
        // `boot-notification.md:71` rule 5 — "On `Pending`: the station MUST store
        // the `sessionKey` — a `Pending` station answers signed commands and needs
        // it (§5.3)". §5.3 at :115 makes the server's half unconditional, and :117
        // says what withholding it costs: "the server may not send the command, the
        // station may not accept it, and the station may not answer it — which
        // closes the exact channel the `Pending` window exists to keep open."
        // Pending is where an operator repairs whatever is outstanding, and the
        // repair usually needs a command.
        //
        // MEASURED 2026-09-11: without this the station refused
        // `UpdateServiceCatalog` and `ChangeConfiguration` with `1013 MAC_MISSING`.
        // `Rejected` deliberately does NOT do this — it accepts no commands and
        // holds no key (05-state-machines.md:58).
        station.sessionKey = response.sessionKey ?? null;

        if (station.config.behavior.autoRetryBoot) {
          setTimeout(() => {
            station.retryBoot().catch((err: unknown) => {
              console.error('[BootNotification] Retry failed:', err instanceof Error ? err.message : String(err));
            });
          }, retryInterval * 1000);
        }
        break;
      }
    }
  }
}
