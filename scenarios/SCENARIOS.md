# OSPP Station Simulator — Scenario Inventory

**Total scenarios: 148** across 11 categories, counted on disk
(`find scenarios -name '*.yaml' | wc -l`).

> The header said 116 from the moment it was written until 2026-08-11, then 113
> until 2026-09-05. It was true when written and false three commits later:
> `5219baa` deleted `reset-rejected-active-sessions` and `session-seqno-monotonic`,
> and `57063cc` deleted `session-final-seqno-terminal` — each for a stated reason,
> none of which reached back to this line. A count is a claim with an expiry date,
> and this one is the only claim on the page a reader would take as current.
> **The 113 rotted the same way and by a wider margin: 35 files.** The number is now
> pinned by `ScenarioCoverageClaims.test.ts`, so it fails rather than drifts.

> **The per-category tables below this line are STALE and are left as-is
> deliberately.** They describe 88 scenarios across 7 categories — the
> `e2e`, `multiunit-e2e`, `provisioning` and `tls-floor` directories are missing
> entirely, and every count is low. Correcting them is a sweep of its own.
> Measured on disk 2026-09-05: chaos 8, core 24, device-management 38, e2e 3,
> fleet 3, multiunit-e2e 3, provisioning 2, reservations 6, security 26,
> sessions 25, tls-floor 10.
> (The previous edition of this very note was itself stale — it read chaos 7,
> core 18, device-management 22, security 24, sessions 21, tls-floor 6 and omitted
> `provisioning` altogether. A note recording that the numbers below are wrong is
> not exempt from being wrong.)

## The firmware family — added 2026-08-17, measured on the wire

Eleven files now cover the firmware update cycle. They are documented here rather
than in the stale tables below because they were measured, not migrated.

**Measured against csms-server `9896108` on a real broker (EMQX, mTLS on 8883,
`signing_mode: All`), every message HMAC-signed.** Not against UAT: UAT was 15
commits behind and carried neither of the two migrations this cycle added, so it
cannot exhibit any of the causes in the table.

`csms-server` 0fd0150 added a `failure_reason` column carrying **eight** causes
(`app/Shared/Enums/FirmwareFailureReason.php` — its own docblock says "seven" and
is wrong; `FirmwareFailureReasonTest.php:334-353` asserts eight). All eight now
have a wire scenario, and each asserts its own token read back off
`GET /api/v1/admin/stations/{id}/firmware`:

| file | `failure_reason` | what drives it |
|---|---|---|
| `firmware-update-full-cycle-reboot` | *(none — `activated`)* | full spec cadence, then a real reconnect and a boot at the new version |
| `firmware-rejected-by-station` | `rejected_by_station` | `Rejected` + **integer** `errorCode` — the form that used to throw |
| `firmware-update-download-failure` | `reported_by_station` | `Downloading(45) -> Failed` |
| `firmware-update-install-failure` | `reported_by_station` | `Downloaded -> Installing(50) -> Failed` |
| `firmware-signature-invalid` | `reported_by_station` | `Downloading -> Failed` with **no** `Downloaded`, + `FirmwareIntegrityFailure` |
| `firmware-unexpected-version-at-boot` | `unexpected_version` | boots 1.5.0 with `PowerOn` while `rebooting` |
| `firmware-rollback-detected` | `rollback_detected` | boots 1.0.0 with `ErrorRecovery` while `rebooting` |
| `firmware-rebooted-during-update` | `rebooted_during_update` | boots while the row is `downloading` |
| `firmware-superseded-by-second-push` | `superseded` | a second operator push; **no station input at all** |
| `firmware-stalled-after-accept` ⏱ | `stalled` | accepts, then ~16 min of silence while staying online |
| `firmware-command-timeout-no-response` ⏱ | `command_timeout` | never answers the command; ~7 min |

**Three of the eleven share `reported_by_station`, and that is correct rather than
a gap.** One line writes it for anything a station reports as `Failed`
(`FirmwareStatusNotificationHandler.php:133-144`), whatever phase it was in. The
column separates the SERVER's judgements from each other; it was never built to
split the station's account of itself into phases. What separates those three is
`progress` (45 / 50 / 100) and, for the signature file, a `FirmwareIntegrityFailure`
SecurityEvent in a different table.

**Three groups are each other's controls, so none needs a source mutation to
mean anything:**

- one boot message, three outcomes — `activated` / `unexpected_version` /
  `rollback_detected`, chosen by `firmwareVersion` and `bootReason` alone
- three silences — `command_timeout` (never answers) / `superseded` (never
  answers, second push) / `stalled` (answers, then goes quiet)
- refusal at the door (`progress: 0`) vs failure mid-transfer (`progress: 45`)

⏱ **The two marked files run for ~16 and ~7 minutes and REQUIRE a running
scheduler** (`docker exec -d csms-app php artisan schedule:work`). Both wait on
server constants with no config behind them —
`DetectStalledFirmwareUpdates::STALL_FAILURE_MINUTES = 10` swept
`everyFiveMinutes()`, and a 300s command TIMEOUT — plus a 120s grace before the
Redis key expires, which is the span the sweep must land in — scanned
`everyMinute()`. Calling that 300s "the TTL" is the conflation that made the
timeout file non-deterministic until csms-server `d1e5881`. Without the
scheduler both go red with the row untouched, which reads exactly like a broken
sweep. `ScenarioRunner.scenarioTimeout.test.ts` pins their budgets against those
constants and requires each file to state its own runtime.

**What none of them prove.** No firmware image is ever fetched, no checksum or
ECDSA image signature is ever verified, and no partition is written — those
failures are *reported*, not *discovered*. The reboot is `fault: disconnect` +
`wait_for_connect` + a fresh BootNotification: the simulator process does not
restart, though every input the server reads is a field on that message, so the
approximation is in the station's interior rather than on the wire. And the
outbound `UpdateFirmware` payload is pinned by three hand-written `assert` steps,
not schema-validated — the simulator validates nothing it receives (the only Ajv
in the repo is the linter, which checks what scenarios SEND).

## What each file states about itself

Every scenario states what it proves and what it cannot. Measured by YAML key —
`expect_body` / `expect_body_text` / `expect_body_absent` in a step's value
position, never a substring of the file's own prose, which inflates the count by
11 because the ceiling notes name the very keys they say are unavailable:

| | Count |
|---|---|
| Carry a server-state assertion | 82 |
| Carry an explicit ceiling label with file:line evidence | 20 |
| Skip transparently (`skip` / `skip_when_pooled`) | 14 |
| Are pool-only (`requires_pool` — invisible to the skip-age report) | 6 |

## Branch-targeted variations

These nine were written against a named csms-server branch each, rather than
against a message type. Each file's header cites the `file.php:line` it reaches
and states what its assertion is read off. They exist because a scenario that
sends a distinct value but asserts only `payload.status == "Accepted"` covers no
branch that `core/happy-boot.yaml` does not.

| File | csms-server branch reached | Asserted on |
|------|----------------------------|-------------|
| `core/boot-reconnect-preserves-live-session` | `BootNotificationHandler.php:343` preserve arm (`Reconnect`) | `GET /sessions/{id}` → `status: active` |
| `core/boot-poweron-fails-live-session` | `BootNotificationHandler.php:355` + the force-fail UPDATE at `:425` | `status: failed`, `fail_error_code: 1010` |
| `security/mac-verification-failed-drops-request` | `VerifyIncomingMiddleware.php:82` MAC_VERIFICATION_FAILED | silence + a clean control round trip |
| `security/mac-missing-drops-request` | `VerifyIncomingMiddleware.php:51` MAC_MISSING | silence + a clean control round trip |
| `sessions/start-service-refused-program-not-declared` | `StartServiceResponseHandler.php:172` `handleRejected` | server-sent `programNumber`; `status: failed`, `fail_error_code: 3017` |
| `sessions/meter-values-seqno-gap-still-ingested` | `MeterValuesHandler.php:112` gap check | the three `meter_values` rows the server wrote |
| `sessions/meter-values-seqno-out-of-order-still-ingested` | `MeterValuesHandler.php:112` + the watermark rule at `:126` | four rows — the repeated ordinal is not deduplicated |
| `device-management/reset-graceful-refused-with-active-session` | `ResetStationAction.php:91` pre-flight | `409` + `ospp_code 6005`, and no Reset on the wire |
| `device-management/reset-forced-settles-session-as-operator-stop` | `ResetStationAction.php:100`, `SessionEndedHandler.php:111`, `BootNotificationHandler.php:355` | server-sent `force: true`; `completed`, surviving the reboot |
| `sessions/session-rejected-insufficient-balance` | `StartSessionAction.php:241-250` money gate | `402` + `ospp_code 4001`, and the `500` the server derived from a `300`s request — on an identity it declares unfunded (`wallet_balance: 0`) |

## Summary

| Category | Count | Coverage |
|----------|-------|----------|
| Core | 16 | Boot (all 6 reasons), Heartbeat, StatusNotification, ConnectionLost, DataTransfer, Reconnect |
| Sessions | 18 | Full lifecycle, Start/Stop, Rejections (4 types), Timeout, Fault, Local, LocalOutOfCredit, Deauthorized, seqNo, finalSeqNo, MeterValues, Reservation, WebPayment |
| Reservations | 6 | Reserve+Start, Cancel, Expire, Rejected (3 types) |
| Device Management | 20 | Firmware (3), Diagnostics (2), Config (5), Reset (3), TriggerMessage (3), Maintenance (3), ServiceCatalog (1) |
| Security | 18 | SecurityEvent (11 types), Certificates (3), OfflinePass (3), TransactionEvent (1) |
| Chaos | 7 | Disconnect (3), Timeout, Slow responses, Malformed, Out-of-order |
| Fleet | 3 | Parallel boot, Mixed workload, Meter flood |

---

## Core (20 scenarios)

<!-- COUNT IS THE FILE COUNT, and the table below does not yet match it. Pre-existing
     drift, recorded rather than silently patched: `boot-rejected.yaml` has a row but no
     file, and `boot-disabled-station-boots-and-stays-gated.yaml`,
     `boot-poweron-fails-live-session.yaml` and `boot-reconnect-preserves-live-session.yaml`
     have files but no row (the last two are described in the table at the top of this
     file instead). Nothing gates this document, which is why it drifted. -->


| File | Name | What it tests | Status |
|------|------|---------------|--------|
| `core/happy-boot.yaml` | Happy Boot | BootNotification PowerOn → Accepted | migrated |
| `core/boot-rejected.yaml` | Boot Rejected | Boot → Rejected → API reactivate → retry → Accepted | migrated |
| `core/boot-pending-retry.yaml` | Boot Pending Retry | Boot → Pending → retry → Accepted | new |
| `core/boot-watchdog.yaml` | Boot Watchdog | bootReason: Watchdog | new |
| `core/boot-firmware-update.yaml` | Boot Firmware Update | bootReason: FirmwareUpdate, new version | new |
| `core/boot-manual-reset.yaml` | Boot Manual Reset | bootReason: ManualReset | new |
| `core/boot-scheduled-reset.yaml` | Boot Scheduled Reset | bootReason: ScheduledReset, 24h uptime | new |
| `core/boot-error-recovery.yaml` | Boot Error Recovery | ErrorRecovery re-boot PRESERVES a live session — pins the second member of the preserve set that the Reconnect proof does not cover | new |
| `core/heartbeat-cycle.yaml` | Heartbeat Cycle | 3 heartbeat request/response cycles | migrated |
| `core/heartbeat-timeout.yaml` | Heartbeat Timeout | Heartbeat with very short timeout — the CLIENT's wait budget, not a server behaviour | new |
| `core/heartbeat-silence-offline-sweep.yaml` | Heartbeat Silence Offline Sweep | 175s of APPLICATION silence on a live socket → `station:check-heartbeats` marks the station offline (`cause: heartbeat_timeout`). Nothing is disconnected; declares its own timeout | new |
| `core/status-notification.yaml` | Status Notification | StatusNotification Available with services | migrated |
| `core/status-all-bay-states.yaml` | Status All Bay States | StatusNotification for the 6 REPORTABLE bay statuses; 4 persist, Occupied/Finishing are session-gated and discarded | new |
| `core/connection-lost-lwt.yaml` | Connection Lost LWT | `fault: sever` under `clean_session: false` → the BROKER publishes the will and the server marks the station offline (`cause: broker_will`). Swap to `disconnect` and it goes red | new |
| `core/reconnect-recovery.yaml` | Reconnect Recovery | Disconnect → reconnect → ErrorRecovery boot, with `isOnline` asserted at all THREE points (true → false → true) rather than only at the end | migrated |
| `core/boot-resets-bays-to-unknown.yaml` | Boot Resets Bays To Unknown | Arm both bays to `available`, then Boot and read `unknown` back — twice, PowerOn and Reconnect, so the reset is proven to FIRE and to be unconditional | new |
| `core/data-transfer.yaml` | Data Transfer | Station sends DataTransfer event | migrated |
| `core/data-transfer-response.yaml` | Data Transfer Response | Wait for DataTransfer from server | new |

## Sessions (18 scenarios)

| File | Name | What it tests | Status |
|------|------|---------------|--------|
| `sessions/full-session-lifecycle.yaml` | Full Session Lifecycle | Boot → Start → MeterValues → Stop → SessionEnded → Available | migrated |
| `sessions/start-service.yaml` | Start Service | Boot → wait StartService → Accepted | migrated |
| `sessions/stop-service.yaml` | Stop Service | Start → Stop with duration/credits → SessionEnded | migrated |
| `sessions/meter-values-streaming.yaml` | Meter Values Streaming | 3 MeterValues EVENTs with cumulative values | migrated |
| `sessions/session-rejected-faulted-bay.yaml` | Session Rejected - Faulted Bay | Faulted bay rejects StartService (3002) | migrated |
| `sessions/session-rejected-bay-busy.yaml` | Session Rejected - Bay Busy | Second session on occupied bay (3001) | new |
| `sessions/session-rejected-maintenance.yaml` | Session Rejected - Maintenance | Unavailable bay rejects StartService (3011) | new |
| `sessions/session-rejected-invalid-service.yaml` | Session Rejected - Invalid Service | Unknown serviceId rejected (3004) | new |
| `sessions/session-rejected-insufficient-balance.yaml` | Session Rejected - Insufficient Balance | Unfunded wallet refused pre-dispatch (402 / 4001); declares `wallet_balance: 0` | new 2026-08-14 |
| `sessions/session-timeout-timer-expired.yaml` | Session Timeout Timer Expired | SessionEnded reason: TimerExpired | migrated |
| `sessions/session-fault-during-service.yaml` | Session Fault During Service | Hardware fault → SessionEnded reason: Fault | new |
| `sessions/session-with-reservation.yaml` | Session With Reservation | ReserveBay → StartService with reservationId | new |
| `sessions/session-web-payment.yaml` | Session Via Web Payment | StartService with sessionSource: WebPayment | new |
| `sessions/stop-service-rejected.yaml` | Stop Service Rejected | StopService for unknown session (3006) | new |
| `sessions/session-stop-local.yaml` | Session Stop Local (v0.4.0) | User physical stop → SessionEnded reason: Local; pro-rated charge | new |
| `sessions/session-local-out-of-credit.yaml` | Session Local Out Of Credit (v0.4.0) | Offline credit pool exhausted → SessionEnded reason: LocalOutOfCredit; creditsCharged=0 | new |
| `sessions/session-deauthorized-revocation-epoch.yaml` | Session Deauthorized via RevocationEpoch (v0.4.0) | RevocationEpoch bump → SessionEnded reason: Deauthorized; creditsCharged=0 | new |
| `sessions/session-final-seqno-terminal.yaml` | Session finalSeqNo Terminal Marker | Sends StopService Response finalSeqNo=3 (the only writer of `sessions.final_seq_no`); a control frame at seqNo=3 is ingested, seqNo 99/100 are discarded — asserted on the server-written `meter_values` collection | rewritten 2026-08-10 |

## Reservations (6 scenarios)

| File | Name | What it tests | Status |
|------|------|---------------|--------|
| `reservations/reserve-and-start.yaml` | Reserve and Start | ReserveBay → StartService with reservationId | migrated |
| `reservations/reserve-cancel.yaml` | Reserve and Cancel | ReserveBay → CancelReservation → Available | migrated |
| `reservations/reserve-expire.yaml` | Reserve and Expire | ReserveBay → TTL expiry → Available | migrated |
| `reservations/reserve-rejected-bay-busy.yaml` | Reserve Rejected - Bay Busy | SERVER refuses `POST /reservations` on an occupied bay, 409 + `ospp_code 3001`; nothing on the wire | new |
| `reservations/reserve-rejected-maintenance.yaml` | Reserve Rejected - Maintenance | SERVER refuses `POST /reservations` on a bay in maintenance, 409 + `ospp_code 3011`; nothing on the wire | new |
| `reservations/reserve-rejected-already-reserved.yaml` | Reserve Rejected - Already Reserved | First reservation ACCEPTED on the wire; SERVER refuses the second, 409 + `ospp_code 3014` | new |

## Device Management (20 scenarios)

| File | Name | What it tests | Status |
|------|------|---------------|--------|
| `device-management/firmware-update-success.yaml` | Firmware Update Success | Downloading → Downloaded → Installing → Installed | migrated |
| `device-management/firmware-update-download-failure.yaml` | Firmware Download Failure | Downloading → Failed | migrated |
| `device-management/firmware-update-install-failure.yaml` | Firmware Install Failure | Downloaded → Installing → Failed (checksum) | new |
| `device-management/diagnostics-upload.yaml` | Diagnostics Upload | Collecting → Uploading → Uploaded | migrated |
| `device-management/diagnostics-failure.yaml` | Diagnostics Failure | Collecting → Uploading → Failed | new |
| `device-management/get-configuration.yaml` | Get Configuration | Return all config entries | migrated |
| `device-management/get-configuration-filtered.yaml` | Get Configuration Filtered | Specific keys + unknownKeys | new |
| `device-management/change-configuration-accepted.yaml` | Change Config Accepted | Config key changed successfully | migrated |
| `device-management/change-configuration-reboot-required.yaml` | Change Config Reboot Required | Config change needs reboot | new |
| `device-management/change-configuration-rejected.yaml` | Change Config Rejected | Readonly key rejected (5108) | new |
| `device-management/soft-reset.yaml` | Soft Reset | Reset Soft → reboot → re-register | migrated |
| `device-management/hard-reset.yaml` | Hard Reset | Reset Hard → full restart → re-register | new |
| `device-management/trigger-message-heartbeat.yaml` | Trigger Heartbeat | TriggerMessage → Heartbeat sent | migrated |
| `device-management/trigger-message-status.yaml` | Trigger StatusNotification | TriggerMessage → StatusNotification sent | new |
| `device-management/trigger-message-boot.yaml` | Trigger BootNotification | TriggerMessage → BootNotification sent | new |
| `device-management/maintenance-mode-on.yaml` | Maintenance Mode On | SetMaintenanceMode enabled → Unavailable | migrated |
| `device-management/maintenance-mode-off.yaml` | Maintenance Mode Off | SetMaintenanceMode disabled → Available | new |
| `device-management/maintenance-mode-all-bays.yaml` | Maintenance All Bays | SetMaintenanceMode (no bayId) → all Unavailable | new |
| `device-management/service-catalog-update.yaml` | Service Catalog Update | UpdateServiceCatalog → Accepted | migrated |

## Security (18 scenarios)

| File | Name | What it tests | Status |
|------|------|---------------|--------|
| `security/security-event-mac-failure.yaml` | SecurityEvent: MacVerificationFailure | Critical severity | migrated |
| `security/security-event-certificate-error.yaml` | SecurityEvent: CertificateError | Critical severity | new |
| `security/security-event-unauthorized-access.yaml` | SecurityEvent: UnauthorizedAccess | Warning severity | new |
| `security/security-event-tamper-detected.yaml` | SecurityEvent: TamperDetected | Critical severity | new |
| `security/security-event-firmware-integrity.yaml` | SecurityEvent: FirmwareIntegrityFailure | Critical severity | new |
| `security/security-event-firmware-downgrade.yaml` | SecurityEvent: FirmwareDowngradeAttempt | Warning severity | new |
| `security/security-event-hardware-fault.yaml` | SecurityEvent: HardwareFault | Critical severity | new |
| `security/security-event-software-fault.yaml` | SecurityEvent: SoftwareFault | Critical severity | new |
| `security/security-event-clock-skew.yaml` | SecurityEvent: ClockSkew | Warning severity | new |
| `security/security-event-brute-force.yaml` | SecurityEvent: BruteForceAttempt | Warning severity | new |
| `security/security-event-offline-pass-rejected.yaml` | SecurityEvent: OfflinePassRejected | Warning severity | new |
| `security/certificate-install.yaml` | Certificate Install Accepted | CertificateInstall → Accepted | migrated |
| `security/certificate-install-rejected.yaml` | Certificate Install Rejected | CertificateInstall → Rejected (4011) | new |
| `security/trigger-cert-renewal.yaml` | Trigger Certificate Renewal | TriggerCertRenewal → SignCertificate CSR | migrated |
| `security/offline-pass-authorize.yaml` | Offline Pass Authorized | AuthorizeOfflinePass → Accepted | migrated |
| `security/offline-pass-rejected.yaml` | Offline Pass Rejected | AuthorizeOfflinePass expired → Rejected | new |
| `security/offline-transaction-reconcile.yaml` | Offline Transaction Reconcile | TransactionEvent with receipt → Accepted | migrated |
| `security/offline-fraud-rapid-transactions.yaml` | Offline Fraud: Rapid Transactions | 5 rapid TransactionEvents (fraud pattern) | migrated |

> **Not in this table, and deliberately not in the corpus — `SignCertificate` originated from a
> restricted (`Pending`) station.** Measured on the wire 2026-08-15 against csms-server `99cab60`:
> the server **accepts** it. The probe lives in
> [`docs/MEASURED-signcertificate-while-pending-20260815T044900Z.md`](../docs/MEASURED-signcertificate-while-pending-20260815T044900Z.md)
> instead of here, because **both of its arms assert the same thing**: run without the out-of-band
> `station_state` write it depends on, it passes while measuring nothing. Read that document's
> *Why this is not in the corpus* section before moving it.

> **Skip reasons were audited 2026-08-15 — all three in the corpus.** Two stated a system fact and
> **both were false**: `security/offline-pass-rejected.yaml` (it needs no sandbox fixture — the
> expired pass is a literal in the file; left skipped **and marked**, because its assertion is too
> weak to carry its name) and `core/boot-pending-retry.yaml` (Pending has been implemented since
> `c5c6e59`; three real blockers named in its place). The third,
> `chaos/connection-timeout.yaml`, states a design intent rather than a system fact and is still
> true. **A skip reason is the least-verified sentence in the corpus** — nothing runs it, so nothing
> checks it, and it survives exactly the change that falsifies it.

## Chaos (7 scenarios)

| File | Name | What it tests | Status |
|------|------|---------------|--------|
| `chaos/disconnect-during-session.yaml` | Disconnect During Session | LWT + orphaned session | migrated |
| `chaos/disconnect-during-boot.yaml` | Disconnect During Boot | Incomplete boot handshake | new |
| `chaos/slow-responses.yaml` | Slow Responses | 3-5s response delays | migrated |
| `chaos/malformed-messages.yaml` | Malformed Messages | Unusual/minimal payloads | migrated |
| `chaos/rapid-reconnect.yaml` | Rapid Reconnect | Multiple disconnect/reconnect cycles | new |
| `chaos/out-of-order-messages.yaml` | Out-of-Order Messages | Orphaned MeterValues/SessionEnded | migrated |
| `chaos/connection-timeout.yaml` | Connection Timeout | Very short heartbeat timeout | new |

## Fleet (3 scenarios)

| File | Name | What it tests | Status |
|------|------|---------------|--------|
| `fleet/10-station-parallel-boot.yaml` | 10-Station Parallel Boot | Run with `--parallel --workers 10` | migrated |
| `fleet/fleet-mixed-workload.yaml` | Fleet Mixed Workload | Full lifecycle per station (run many parallel) | new |
| `fleet/fleet-stress-meter-flood.yaml` | Fleet Stress Meter Flood | 10 rapid MeterValues (100ms apart) | new |

---

## Migration Summary

| Status | Count |
|--------|-------|
| Migrated from PHP simulator | 33 |
| New (not in PHP simulator) | 50 |
| **Total** | **83** |

## PHP Scenarios Not Migrated (Deprecated)

| PHP Scenario | Reason |
|-------------|--------|
| `fleet/50-station-mixed.yaml` | Redundant — `fleet-mixed-workload.yaml` with `--workers 50` achieves the same |
| `fleet/100-station-stress.yaml` | Redundant — `fleet-stress-meter-flood.yaml` with `--workers 100` achieves the same |
| `security/hmac-verification.yaml` | HMAC signing is SDK-level behavior, not scenario-testable via message exchange |

## Spec Coverage

All **27** MQTT actions are covered by at least one scenario.

> **The number was 26 and the table under it had 27 rows** — audit A9-40. The
> denominator is `OsppAction`, which carries 27 members in the pinned
> `@ospp/protocol` (`dist/actions/OsppAction.d.ts`); the header was never
> re-derived from it. `ScenarioCoverageClaims.test.ts` now reads the enum, the
> table and the corpus and requires all three to agree, so this line cannot
> drift from the thing it counts.

> **A9-40's two named gaps have both closed, and neither closed by being fixed —
> they closed by being outgrown, which is why nothing propagated back here.**
> The row said `UpdateServiceCatalog` had "a single `requires_pool` scenario":
> **five** files name it today (`service-catalog-update` and
> `catalog-publish-refused-two-ways-under-one-code` are `requires_pool`; the three
> `e2e/*` files are `skip_when_pooled`), so it is exercised in BOTH run modes —
> the two pool-only files in a pooled run, the three e2e files standalone. The row
> also said the `AuthorizeOfflinePass` refusal branch was `skip: true`: it is not
> any more. `offline-pass-refused-the-three-a-station-meets.yaml` drives three
> refusals and is unskipped. `offline-pass-rejected.yaml` is still `skip: true`,
> but it is no longer the only refusal on that action.

**Read the scenario names below as a guide, not an index.** They are file stems
without paths and some are prefixes of several real files; `boot-rejected` is no
longer any file's stem at all (it is `boot-rejected-station-id-spoof` and
`boot-rejected-malformed-payload`). What is machine-checked is the ACTION column
against the enum, and coverage against the corpus — not these stems.


| Action | Direction | Scenarios |
|--------|-----------|-----------|
| BootNotification | Station→Server | happy-boot, boot-rejected, boot-pending-retry, boot-watchdog, boot-firmware-update, boot-manual-reset, boot-scheduled-reset, boot-error-recovery, trigger-message-boot |
| Heartbeat | Station→Server | heartbeat-cycle, heartbeat-timeout, trigger-message-heartbeat |
| StatusNotification | Station→Server | status-notification, status-all-bay-states, trigger-message-status, full-session-lifecycle, +many others |
| ConnectionLost | Broker→Server | connection-lost-lwt, disconnect-during-session |
| DataTransfer | Bidirectional | data-transfer, data-transfer-response |
| TriggerMessage | Server→Station | trigger-message-heartbeat, trigger-message-status, trigger-message-boot |
| ReserveBay | Server→Station | reserve-and-start, reserve-cancel, reserve-expire, reserve-rejected-already-reserved (**Accepted only** — the station has never REFUSED a ReserveBay in this corpus; `reserve-rejected-bay-busy` and `-maintenance` put nothing on this wire at all and are SERVER-side REST refusals) |
| CancelReservation | Server→Station | reserve-cancel |
| StartService | Server→Station | start-service, full-session-lifecycle, session-rejected-*, session-with-reservation, session-web-payment |
| StopService | Server→Station | stop-service, stop-service-rejected, full-session-lifecycle |
| MeterValues | Station→Server | meter-values-streaming, fleet-stress-meter-flood |
| SessionEnded | Station→Server | session-timeout-timer-expired, session-fault-during-service, stop-service |
| TransactionEvent | Station→Server | offline-transaction-reconcile, offline-fraud-rapid-transactions |
| SecurityEvent | Station→Server | 11 security-event-* scenarios |
| ChangeConfiguration | Server→Station | change-configuration-accepted, -reboot-required, -rejected |
| GetConfiguration | Server→Station | get-configuration, get-configuration-filtered |
| Reset | Server→Station | soft-reset, hard-reset, reset-graceful-refused-with-active-session, reset-forced-settles-session-as-operator-stop |
| UpdateFirmware | Server→Station | firmware-update-success, -download-failure, -install-failure |
| FirmwareStatusNotification | Station→Server | firmware-update-success, -download-failure, -install-failure |
| GetDiagnostics | Server→Station | diagnostics-upload, diagnostics-failure |
| DiagnosticsNotification | Station→Server | diagnostics-upload, diagnostics-failure |
| SetMaintenanceMode | Server→Station | maintenance-mode-on, -off, -all-bays |
| UpdateServiceCatalog | Server→Station | service-catalog-update, catalog-publish-refused-two-ways-under-one-code (both `requires_pool`), and the three `e2e/*` files (`skip_when_pooled`) — covered in both run modes, neither in both |
| SignCertificate | Station→Server | trigger-cert-renewal |
| CertificateInstall | Server→Station | certificate-install, certificate-install-rejected |
| TriggerCertificateRenewal | Server→Station | trigger-cert-renewal |
| AuthorizeOfflinePass | Station→Server | offline-pass-authorize, offline-pass-refused-the-three-a-station-meets (three refusals, runnable), offline-pass-rejected (**`skip: true`** — 163d, see the skip-age report) |

### Uncovered Spec Areas

BLE messages (13 messages) are not covered — they use GATT characteristics, not MQTT, and are outside scope of this MQTT-based simulator.

### What spec `v0.31.0` moved, and what this corpus can reach — measured 2026-09-05

Four wire changes landed on csms-server between the last pooled run and today. **None of
them breaks a scenario**, and the reason is worth stating precisely, because "no failures"
and "covered" are different findings and only one of them is true here.

| what moved | scenarios asserting the OLD form | what this corpus can do about it |
|---|---|---|
| `SessionEndReason` gained **`Inactivity`** (6 → 7 values) | 0 — `Inactivity` appears in no scenario and no source file | **BLOCKED on the SDK pin.** The corpus sends `Local`, `TimerExpired`, `Fault`, `Deauthorized`, `LocalOutOfCredit`, `OperatorStopped`; the seventh does not exist at `@ospp/protocol` `0.26.0` |
| `boot-notification-request` gained OPTIONAL **`messageSigningMode`** | 0 — absent from every boot payload | **BLOCKED on the SDK pin, and hard-blocked:** the pinned boot schema is `additionalProperties: false`, so adding the field fails `lint:scenarios` before it reaches a broker |
| **`3003 SERVICE_UNAVAILABLE` moved `503` → `409`** on `/sessions/start`, `/sessions/offline-auth` and ReserveBay, and now carries a REQUIRED `details.cause` (`station-reported` \| `disabled`) | 0 — **`3003` is asserted nowhere**, in either shape, and no step expects a `503` | Uncovered rather than stale. The corpus asserts 23 distinct REST codes and 4 wire codes; this is not one of them |
| **`1007` is boot-only.** Version divergence on any other message is accepted and journalled instead of refused | 0 assertions — but two source docblocks described the old consequence and are corrected (`src/mqtt/protocolVersion.ts`, `MqttConnection.willProtocolVersion.test.ts`) | The LWT test stands: the dead letter was the symptom, a will that lies about its version is the defect, and the fix removed the signal that used to find it |

A fifth change is not a wire change but lands on this corpus harder than any of them: the
five `OsppErrorSurface`-marked routes now answer the **flat** OSPP Error Object.
**Twelve api_call steps across eleven files read `error.ospp_code` off those routes and
were green the whole time**, because UAT was behind. They are migrated, and
`MarkedRouteErrorShape.test.ts` now checks both directions on every step in the corpus —
it found a THIRD envelope on its first run. See `src/protocol/errorShape.ts`.

**The pin is the blocker for the first two rows, and it cannot move by itself:**
`@ospp/protocol` is pinned `^0.26.0`, which is minor-locked on `0.x`, so it can never
resolve past `0.26.x` — three minors short of the published `0.29.0`. `npm run check:sdk-pin`
reports this. Bumping it is its own change: it moves 172 schemas, and a tightening lands as
new `lint:scenarios` failures rather than as an install error.
