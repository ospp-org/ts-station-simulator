# OSPP Station Simulator — Scenario Inventory

**Total scenarios: 88** across 7 categories.

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

## Core (16 scenarios)

| File | Name | What it tests | Status |
|------|------|---------------|--------|
| `core/happy-boot.yaml` | Happy Boot | BootNotification PowerOn → Accepted | migrated |
| `core/boot-rejected.yaml` | Boot Rejected | Boot → Rejected → API reactivate → retry → Accepted | migrated |
| `core/boot-pending-retry.yaml` | Boot Pending Retry | Boot → Pending → retry → Accepted | new |
| `core/boot-watchdog.yaml` | Boot Watchdog | bootReason: Watchdog | new |
| `core/boot-firmware-update.yaml` | Boot Firmware Update | bootReason: FirmwareUpdate, new version | new |
| `core/boot-manual-reset.yaml` | Boot Manual Reset | bootReason: ManualReset | new |
| `core/boot-scheduled-reset.yaml` | Boot Scheduled Reset | bootReason: ScheduledReset, 24h uptime | new |
| `core/boot-error-recovery.yaml` | Boot Error Recovery | bootReason: ErrorRecovery, pending offline txns | new |
| `core/heartbeat-cycle.yaml` | Heartbeat Cycle | 3 heartbeat request/response cycles | migrated |
| `core/heartbeat-timeout.yaml` | Heartbeat Timeout | Heartbeat with very short timeout | new |
| `core/status-notification.yaml` | Status Notification | StatusNotification Available with services | migrated |
| `core/status-all-bay-states.yaml` | Status All Bay States | StatusNotification for all 7 bay statuses | new |
| `core/connection-lost-lwt.yaml` | Connection Lost LWT | Disconnect triggers MQTT LWT | new |
| `core/reconnect-recovery.yaml` | Reconnect Recovery | Disconnect → reconnect → ErrorRecovery boot | migrated |
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
| `sessions/session-timeout-timer-expired.yaml` | Session Timeout Timer Expired | SessionEnded reason: TimerExpired | migrated |
| `sessions/session-fault-during-service.yaml` | Session Fault During Service | Hardware fault → SessionEnded reason: Fault | new |
| `sessions/session-with-reservation.yaml` | Session With Reservation | ReserveBay → StartService with reservationId | new |
| `sessions/session-web-payment.yaml` | Session Via Web Payment | StartService with sessionSource: WebPayment | new |
| `sessions/stop-service-rejected.yaml` | Stop Service Rejected | StopService for unknown session (3006) | new |
| `sessions/session-stop-local.yaml` | Session Stop Local (v0.4.0) | User physical stop → SessionEnded reason: Local; pro-rated charge | new |
| `sessions/session-local-out-of-credit.yaml` | Session Local Out Of Credit (v0.4.0) | Offline credit pool exhausted → SessionEnded reason: LocalOutOfCredit; creditsCharged=0 | new |
| `sessions/session-deauthorized-revocation-epoch.yaml` | Session Deauthorized via RevocationEpoch (v0.4.0) | RevocationEpoch bump → SessionEnded reason: Deauthorized; creditsCharged=0 | new |
| `sessions/session-seqno-monotonic.yaml` | Session seqNo Monotonic (v0.4.0) | 5 MeterValues with auto-injected seqNo 0..4; finalSeqNo=5 | new |
| `sessions/session-final-seqno-terminal.yaml` | Session finalSeqNo Terminal (v0.4.0) | Late MeterValues with seqNo > finalSeqNo discarded server-side | new |

## Reservations (6 scenarios)

| File | Name | What it tests | Status |
|------|------|---------------|--------|
| `reservations/reserve-and-start.yaml` | Reserve and Start | ReserveBay → StartService with reservationId | migrated |
| `reservations/reserve-cancel.yaml` | Reserve and Cancel | ReserveBay → CancelReservation → Available | migrated |
| `reservations/reserve-expire.yaml` | Reserve and Expire | ReserveBay → TTL expiry → Available | migrated |
| `reservations/reserve-rejected-bay-busy.yaml` | Reserve Rejected - Bay Busy | Occupied bay rejects reservation (3001) | new |
| `reservations/reserve-rejected-maintenance.yaml` | Reserve Rejected - Maintenance | Maintenance bay rejects reservation (3011) | new |
| `reservations/reserve-rejected-already-reserved.yaml` | Reserve Rejected - Already Reserved | Double reservation rejected (3014) | new |

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
| `device-management/reset-rejected-active-sessions.yaml` | Reset Rejected - Active Sessions | Reset rejected due to active session (3016) | new |
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

All 26 MQTT actions are covered by at least one scenario:

| Action | Direction | Scenarios |
|--------|-----------|-----------|
| BootNotification | Station→Server | happy-boot, boot-rejected, boot-pending-retry, boot-watchdog, boot-firmware-update, boot-manual-reset, boot-scheduled-reset, boot-error-recovery, trigger-message-boot |
| Heartbeat | Station→Server | heartbeat-cycle, heartbeat-timeout, trigger-message-heartbeat |
| StatusNotification | Station→Server | status-notification, status-all-bay-states, trigger-message-status, full-session-lifecycle, +many others |
| ConnectionLost | Broker→Server | connection-lost-lwt, disconnect-during-session |
| DataTransfer | Bidirectional | data-transfer, data-transfer-response |
| TriggerMessage | Server→Station | trigger-message-heartbeat, trigger-message-status, trigger-message-boot |
| ReserveBay | Server→Station | reserve-and-start, reserve-cancel, reserve-expire, reserve-rejected-* |
| CancelReservation | Server→Station | reserve-cancel |
| StartService | Server→Station | start-service, full-session-lifecycle, session-rejected-*, session-with-reservation, session-web-payment |
| StopService | Server→Station | stop-service, stop-service-rejected, full-session-lifecycle |
| MeterValues | Station→Server | meter-values-streaming, fleet-stress-meter-flood |
| SessionEnded | Station→Server | session-timeout-timer-expired, session-fault-during-service, stop-service |
| TransactionEvent | Station→Server | offline-transaction-reconcile, offline-fraud-rapid-transactions |
| SecurityEvent | Station→Server | 11 security-event-* scenarios |
| ChangeConfiguration | Server→Station | change-configuration-accepted, -reboot-required, -rejected |
| GetConfiguration | Server→Station | get-configuration, get-configuration-filtered |
| Reset | Server→Station | soft-reset, hard-reset, reset-rejected-active-sessions |
| UpdateFirmware | Server→Station | firmware-update-success, -download-failure, -install-failure |
| FirmwareStatusNotification | Station→Server | firmware-update-success, -download-failure, -install-failure |
| GetDiagnostics | Server→Station | diagnostics-upload, diagnostics-failure |
| DiagnosticsNotification | Station→Server | diagnostics-upload, diagnostics-failure |
| SetMaintenanceMode | Server→Station | maintenance-mode-on, -off, -all-bays |
| UpdateServiceCatalog | Server→Station | service-catalog-update |
| SignCertificate | Station→Server | trigger-cert-renewal |
| CertificateInstall | Server→Station | certificate-install, certificate-install-rejected |
| TriggerCertificateRenewal | Server→Station | trigger-cert-renewal |
| AuthorizeOfflinePass | Station→Server | offline-pass-authorize, offline-pass-rejected |

### Uncovered Spec Areas

BLE messages (13 messages) are not covered — they use GATT characteristics, not MQTT, and are outside scope of this MQTT-based simulator.
