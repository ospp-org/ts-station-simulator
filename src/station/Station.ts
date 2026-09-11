import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SequenceCounter } from './SequenceCounter.js';
import { monotonicNowMs } from './monotonicClock.js';
import {
  recordHeartbeatArmed,
  recordHeartbeatFailed,
  recordHeartbeatPublished,
} from './heartbeatStats.js';
import { TopologyStore, type DeclaredBay } from './TopologyStore.js';
import type {
  OsppEnvelope,
  BootNotificationRequest,
  BayId,
  ServiceId,
} from '@ospp/protocol';
import {
  EffectedBy,
  OsppAction,
  type ConnectionLostPayload,
  MessageType,
  BayStatus,
  BayStateMachine,
  BootReason,
  SessionEndReason,
  type SessionEndedPayload,
  toStationTopic,
} from '@ospp/protocol';
import {
  MqttConnection,
  type MqttConnectionOptions,
  type SeveranceState,
  type ReconnectProbeResult,
} from '../mqtt/MqttConnection.js';
import { MessageRouter } from '../mqtt/MessageRouter.js';
import { resolveInboundSchemaMode } from '../mqtt/inboundSchema.js';
import { MessageSender } from '../mqtt/MessageSender.js';
import type { StationConfig } from './StationConfig.js';
import { StationLifecycle } from './StationLifecycle.js';

export interface Handler {
  handle(envelope: OsppEnvelope, station: Station): Promise<void>;
}

export interface SessionInfo {
  sessionId: string;
  bayId: BayId;
  serviceId: ServiceId;
  /**
   * ISO-8601, as StartServiceHandler stores it (`new Date().toISOString()`).
   *
   * This said `Date` and was wrong for as long as it existed. TWO interfaces
   * named SessionInfo describe this map — Handler.ts's (string, correct) and this
   * one — and TypeScript never saw the conflict because handlers write through
   * the StationContext shape while Station declares its own. Nothing read the
   * field back off a Station-held session until the forced-reset settle needed
   * it, and then it threw on a live wire.
   */
  startedAt: string;
  /**
   * The monotonic reading taken at the same moment — the origin every elapsed
   * time for this session is differenced from (`heartbeat.md:44` rule 5). Kept in
   * step with Handler.ts's declaration DELIBERATELY: the two interfaces already
   * disagreed once about `startedAt` (see above) and it cost a live throw, so a
   * field added to one must be added to the other.
   */
  startedAtMonotonicMs: number;
  durationSeconds: number;
  /**
   * The station's ordering counter for this session. Was a bare number the
   * scenario read, wrote and advanced; see SequenceCounter for what that cost.
   */
  seq: SequenceCounter;
}

export interface ReservationInfo {
  reservationId: string;
  bayId: string;
  expirationTime: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * How long a station waits for its goodbye to be acknowledged before leaving anyway.
 *
 * `connection-lost.md` §4.3 rule 3 makes the wait a SHOULD and the abandonment a MAY,
 * and names the backstop: the §4.2 heartbeat timeout still detects the departure. Two
 * seconds is long enough for a live broker to PUBACK a 100-byte frame and short enough
 * that a silent one costs a teardown two seconds rather than a scenario's whole budget.
 */
export const PLANNED_SHUTDOWN_ANNOUNCE_TIMEOUT_MS = 2000;

export class Station extends EventEmitter {
  public readonly config: StationConfig;
  public readonly sender: MessageSender;
  public readonly router: MessageRouter;
  public lifecycle: StationLifecycle = StationLifecycle.OFFLINE;
  public readonly sessions: Map<string, SessionInfo> = new Map();
  public readonly reservations: Map<string, ReservationInfo> = new Map();
  public currentRevocationEpoch: number = 0;
  /**
   * The catalog version this station currently holds. Empty until the server has
   * pushed one and this station has answered `Accepted`.
   *
   * `''` is a VALUE, not a placeholder for "unknown": spec v0.25.0 made
   * `previousCatalogVersion` required on the `Accepted` arm and states that the
   * empty string is the conforming answer from a station that has never held a
   * catalog. Absent and `''` are two different statements on the wire and only one
   * of them is allowed there, so this field must never be optional.
   */
  public currentCatalogVersion: string = '';
  public sessionKey: string | null = null;
  // Device-held key for an in-flight cert renewal (ADR-0002 T1): set by
  // TriggerCertificateRenewalHandler, consumed by CertificateInstallHandler.
  public pendingRenewalKeyPem: string | null = null;

  private readonly connection: MqttConnection;
  public bootAccepted: boolean = false;

  /**
   * The station's power-on instant, as a MONOTONIC reading, fixed when this
   * instance is constructed. A simulated station's process lifetime IS its power
   * cycle, so `monotonicNowMs() - poweredOnAt` is its true uptime; a genuine
   * power-cycle means a new process and therefore a new Station, which resets
   * this. BootNotification.uptimeSeconds is derived from it rather than hardcoded
   * — see currentUptimeSeconds().
   *
   * Monotonic and not `Date.now()`, for the same reason session duration is: this
   * is a value that gets DIFFERENCED, and a wall-clock step between construction
   * and a boot corrupted it. It is a per-process reading and is never serialised;
   * what goes on the wire is the difference, in seconds.
   */
  private readonly poweredOnAt: number = monotonicNowMs();

  /**
   * Why the station is sending its CURRENT BootNotification. Defaults to
   * POWER_ON (this instance did just power on) and is updated by whatever
   * non-power-on event re-boots the station — today only a cert-renewal
   * re-handshake (see reconnectWithRenewedCertificate). Retries of the same
   * boot re-send the same reason, since a retry is not a new boot episode.
   */
  private currentBootReason: BootReason = BootReason.POWER_ON;

  private readonly handlers: Map<OsppAction, Handler> = new Map();
  private readonly registeredListeners: Set<OsppAction> = new Set();
  private readonly bayMachines: Map<string, BayStateMachine> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: StationConfig, mqttOptions: MqttConnectionOptions) {
    super();
    this.config = config;
    this.connection = new MqttConnection(mqttOptions);
    // The getter, not a captured value: the session key arrives in the
    // BootNotification response, necessarily AFTER this router exists. Passing
    // `this.sessionKey` here would freeze null forever.
    // The inbound schema gate is armed HERE, on the wire path, and reads the
    // environment at construction so a measuring run can lower it to `warn`
    // without a code change. Unit tests that build a MessageRouter directly get
    // the same `strict` default; nothing about this station's wiring is softer
    // than what those tests exercise.
    this.router = new MessageRouter(() => this.sessionKey, {
      schemaMode: resolveInboundSchemaMode(),
    });
    this.sender = new MessageSender(this.connection, config.stationId, () => this.sessionKey);

    // Wire inbound MQTT messages to the router ONCE, here — NOT per connect().
    // The MqttConnection wrapper persists across client reconnects and re-emits
    // 'message' from whichever underlying client is live, so a single listener
    // routes every inbound message across any number of (re)connects. Doing this
    // in connect() instead would stack a listener per connect(); a cert-renewal
    // re-handshake (disconnect()+connect()) would then route each message twice
    // (ADR-0002 T1 — see Station.messageBridge.test.ts).
    this.connection.onMessage((inboundTopic: string, payload: Buffer) => {
      this.router.route(inboundTopic, payload);
    });

    // A broker kick (ADR-0004 TIER 1) really does take the station off the
    // wire, so reflect it in the lifecycle rather than leaving it reading
    // ONLINE while severed. Wired once here for the same reason as the
    // message bridge above: the wrapper outlives individual clients.
    this.connection.on('kicked', (reasonCode: number | null) => {
      this.lifecycle = StationLifecycle.OFFLINE;
      this.bootAccepted = false;
      this.emit('kicked', reasonCode);
    });

    // Bays start AVAILABLE, not at the FSM's `Unknown` default.
    //
    // `Unknown` is the state a station holds between power-on and the end of its
    // self-test. It is never transmitted (spec 05-state-machines.md §1.2), and a
    // station leaves it by reporting what the self-test found. This simulator has
    // no hardware and therefore no self-test to run — and the spec's own boot
    // sequence puts that step three steps before the network (01-architecture.md
    // §7.3: bays initialise, then TLS, then subscribe, then BootNotification), so
    // a station whose power-on checks completed before the radio came up is
    // exactly what a hardware-less station should model.
    //
    // Constructing at `Unknown` and leaving it there meant the post-boot
    // StatusNotification — built by reading getBayState() straight into the
    // payload — put a non-reportable value on the wire.
    for (const bay of config.bays) {
      // EffectedBy.STATION is REQUIRED and is the point: "a station machine that
      // silently accepted the Server rows would model the server's job — which is
      // exactly the merge §2.3 exists to undo." A station may never effect the six
      // inferences to Unknown.
      this.bayMachines.set(bay.bayId, new BayStateMachine(EffectedBy.STATION, BayStatus.AVAILABLE));
    }
  }

  async connect(): Promise<void> {
    this.connection.connect();

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.connection.removeListener('connect', onConnect);
        this.connection.removeListener('error', onError);
      };
      this.connection.once('connect', onConnect);
      this.connection.once('error', onError);
    });

    const topic = toStationTopic(this.config.stationId);
    await this.connection.subscribe(topic, 1);

    // NB: the connection→router 'message' bridge is registered once in the
    // constructor (survives reconnects), so it is deliberately NOT re-added here.

    for (const action of this.handlers.keys()) {
      this.registerRouterListener(action);
    }

    this.lifecycle = StationLifecycle.ONLINE;
    this.bootAccepted = false;

    this.emit('connected');
  }

  /** Simulate network drop — TCP destroyed, client auto-reconnects. */
  destroyConnection(): void {
    this.connection.destroyConnection();
  }

  /**
   * Simulate a station losing power — TCP destroyed with no DISCONNECT packet,
   * and no reconnect. The one teardown that leaves the broker's Last Will armed
   * and lets its `willDelayInterval` actually elapse; see
   * MqttConnection.severConnection().
   */
  severConnection(): void {
    this.connection.severConnection();
  }

  /**
   * Resolve when the MQTT client next emits `connect` (a connack) — i.e. the
   * auto-reconnect that follows `destroyConnection()`. Used by the
   * `wait_for_connect` step so a scenario re-sends on a live connection
   * instead of publishing into the mqtt offline store while still
   * disconnected (a QoS-1 publish there blocks until reconnect and eats the
   * next `wait_for`'s timeout budget). Rejects after `timeoutMs`.
   */
  async waitForConnect(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.connection.removeListener('connect', onConnect);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for MQTT (re)connect after ${timeoutMs}ms`));
      }, timeoutMs);
      this.connection.once('connect', onConnect);
    });
  }

  /**
   * Say goodbye: publish ConnectionLost with `reason: "PlannedShutdown"`.
   *
   * spec 0.36.0, connection-lost.md §4.3. Before that value existed this
   * simulator had the same two options every real station had, and neither was
   * correct:
   *
   *   stay silent      — a clean DISCONNECT discards the will (MQTT 5 §3.14.4)
   *                      and stopHeartbeat() removes the only thing keeping the
   *                      row alive, so `stations.is_online` stays true over a
   *                      dead socket until the sweep DEDUCES the absence at
   *                      ceil(interval x 3.5) = 105 s and writes cause
   *                      `heartbeat_timeout`;
   *   force the will   — `reasonCode 0x04` + `willDelayInterval: 0`, which is
   *                      what this code used to do. It tells the server at the
   *                      right moment, and what it tells it is FALSE: the will
   *                      payload says `UnexpectedDisconnect` about a station
   *                      that said goodbye. This file's own comment said so.
   *
   * Best-effort and bounded. A shutdown must not be blocked by an unreachable
   * server (§4.3 rule 3), and the heartbeat timeout remains the backstop, so a
   * failure here is logged and swallowed rather than propagated.
   *
   * Published LAST, after everything the station still owes (§4.3 rule 2) —
   * this method is called from disconnect(), which every teardown funnels
   * through after its own work is done.
   */
  async announcePlannedShutdown(): Promise<void> {
    // A STATION THAT NEVER CAME ONLINE HAS NOTHING TO ANNOUNCE — AND NO CHANNEL
    // TO ANNOUNCE IT ON. This guard is not defensive tidiness; without it the
    // teardown HANGS, and it hung on UAT.
    //
    // The four TLS-floor scenarios (S3/S4/S5/S5b) exist to have their connection
    // REFUSED. `expect_connect_failure` records the refusal and returns `passed`
    // immediately — but the runner's `finally` still tears the station down, and
    // for a POOL-leased station that teardown asks for this announcement. mqtt.js
    // keeps its client object after a failed handshake, and a QoS-1 publish on an
    // offline client is BUFFERED: the callback waits for a connection that is not
    // coming, MqttConnection.publish()'s promise never settles, and the scenario
    // is killed by the 90 s budget having already proved what it tests. Four green
    // assertions were reported red, which is the shape that makes a suite stop
    // meaning anything.
    //
    // Reported as `lifecycle`, not as a catch: swallowing a hanging publish would
    // still hang. The send is never attempted.
    //
    // It is also what the spec says. connection-lost.md §4.3 rule 1 binds a station
    // that is "about to disconnect deliberately" — one that never connected is not
    // that station, and rule 3 forbids a shutdown being blocked on an unreachable
    // server, which is exactly what this was.
    if (this.lifecycle !== StationLifecycle.ONLINE) {
      return;
    }

    try {
      // BOUNDED, because §4.3 rule 3 says so in terms: the station SHOULD wait for
      // the QoS 1 PUBACK, and "if the PUBACK does not arrive within a bounded time
      // the station MAY disconnect anyway — the heartbeat timeout of §4.2 remains
      // the backstop, and a shutdown MUST NOT be blocked by an unreachable server."
      //
      // The lifecycle guard above covers a station that never connected. This covers
      // the other half: one that connected to a broker which then went quiet. mqtt.js
      // resolves a QoS-1 publish only on PUBACK, so an unacknowledged frame leaves
      // this promise pending forever and takes the caller's teardown with it.
      // Un-awaited would be wrong too — the frame must be given a real chance to
      // leave before the socket closes, which is the whole point of sending it last.
      await Promise.race([
        this.sender.send<ConnectionLostPayload>(
          OsppAction.CONNECTION_LOST,
          MessageType.EVENT,
          { stationId: this.config.stationId as ConnectionLostPayload['stationId'], reason: 'PlannedShutdown' },
        ),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, PLANNED_SHUTDOWN_ANNOUNCE_TIMEOUT_MS);
          // Do not hold the process open on this timer alone: the announcement is
          // best-effort and must never be the reason a run outlives its work.
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
    } catch (err) {
      console.log(
        '[Shutdown] station %s could not announce its planned shutdown (%s) — leaving on the heartbeat timeout instead',
        this.config.stationId, err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Stop beating and close the socket.
   *
   * `announceDeparture: true` publishes the §4.3 goodbye first and then closes
   * with an ORDINARY clean DISCONNECT. It replaces `publishWill`, which asked
   * the broker to fire the Last Will on the way out: that told the server at the
   * right moment and told it the wrong thing, and now that a true value exists
   * there is no reason to publish a false one. The two are mutually exclusive by
   * construction — announcing and then forcing the will would put a
   * `PlannedShutdown` and an `UnexpectedDisconnect` about the same departure on
   * the wire, and the server would keep whichever landed second.
   *
   * Passed by the runner for a pool-leased station, whose id goes straight to
   * another scenario, so a row left online is one that gets corrected inside
   * somebody else's lease. NOT the default: `fault: disconnect` exists precisely
   * to be the arm that says nothing (core/connection-lost-lwt.yaml).
   */
  async disconnect(opts?: { announceDeparture?: boolean }): Promise<void> {
    this.stopHeartbeat();
    if (opts?.announceDeparture) {
      await this.announcePlannedShutdown();
    }
    await this.connection.disconnect();
    this.lifecycle = StationLifecycle.OFFLINE;
    this.emit('disconnected');
  }

  /**
   * Swap the station's client certificate: write the renewed leaf (+ optional
   * issuing chain, full-chain order) and its retained private key to the SAME
   * TLS file paths the connection reads at connect() time. ADR-0002 T1 — the
   * on-the-wire analog of ProvisionStep's cert write, for an already-provisioned
   * station. Throws if the station has no configured TLS cert/key path to swap.
   */
  async installRenewedCertificate(input: {
    certificatePem: string;
    privateKeyPem: string;
    caChainPem?: string;
  }): Promise<void> {
    const paths = this.connection.getTlsPaths();
    if (!paths?.cert || !paths.key) {
      throw new Error(
        'Station.installRenewedCertificate: no TLS cert/key path configured to swap',
      );
    }
    const certOut =
      input.caChainPem !== undefined && input.caChainPem.length > 0
        ? `${input.certificatePem.trimEnd()}\n${input.caChainPem.trimEnd()}\n`
        : input.certificatePem;
    await writeFile(paths.cert, certOut);
    await writeFile(paths.key, input.privateKeyPem, { mode: 0o600 });
    this.emit('certificate-installed');
  }

  /**
   * Re-handshake mTLS presenting the freshly-installed leaf: fully disconnect
   * (nulling the client so the cert files are re-read) then reconnect. A
   * resolved connect() means the broker accepted the renewed client cert — the
   * decisive proof of a completed renewal. ADR-0002 T1.
   *
   * This is a RECONNECT, not a reboot: the station stayed powered on the whole
   * time, so the BootNotification that follows must not claim a power-cycle.
   * Marking the reason here (rather than in CertificateInstallHandler) keeps it
   * attached to the event that actually causes the re-boot, so every caller of
   * this method reports it — and a failed re-handshake leaves the reason alone.
   */
  async reconnectWithRenewedCertificate(): Promise<void> {
    await this.disconnect();
    await this.connect();
    this.currentBootReason = Station.RECONNECT_BOOT_REASON;
  }

  /**
   * The bootReason a station reports on a reconnect that was NOT a power-cycle.
   *
   * THE PREMISE UNDER THIS CHOICE IS FALSE, MEASURED 2026-09-05. It said OSPP's BootReason
   * enum "has no `Reconnect` ... member — the SIX values are PowerOn, Watchdog,
   * FirmwareUpdate, ManualReset, ScheduledReset and ErrorRecovery", and picked ErrorRecovery
   * as "the closest correct value, not an exact one". The enum has EIGHT members and
   * `Reconnect` is one of them — counted on the tarballs of BOTH @ospp/protocol 0.26.0 and
   * 0.29.0, so this was already wrong at the version pinned when it was written, not broken
   * by a bump. It also omitted `RemoteReset`. The exact value existed the whole time.
   *
   * AND 0.31.0 SHARPENS IT AGAINST US. boot-notification-request.schema.json now reads
   * "SEVEN of the eight name an actual boot; `Reconnect` names the case where NONE occurred",
   * and widens `Reconnect` to cover a Boot the server asked for by TriggerMessage. By this
   * docblock's OWN rejection test — "FirmwareUpdate and Watchdog assert events that did not
   * happen" — ErrorRecovery now fails it too: it is in the seven that assert a boot.
   *
   * FLIPPED 2026-09-11, because the deferred call came due on a live run. The paragraph
   * this replaces said "nothing is broken today" and left the constant alone, naming the
   * exact hazard it was leaving armed: the firmware sweep keys on ErrorRecovery
   * SPECIFICALLY, so a certificate-renewal reconnect DURING a firmware update would be
   * misclassified. That is what happened. On UAT a renewal landed on an open firmware row
   * and csms-server closed it `failed` / `rollback_detected` —
   * HandleBootAfterFirmwareUpdate.php:155 branches on ERROR_RECOVERY alone, and `Reconnect`
   * does not enter it. Session preservation is unaffected by the flip: the preserve arm is
   * `[BootReason::RECONNECT, BootReason::ERROR_RECOVERY]` and both members keep live washes
   * alive. So the flip costs nothing and removes the misclassification.
   *
   * The normative rule was there the whole time. boot-notification.md §5.2 rule 1: the
   * station "MUST send `Reconnect` when it re-establishes the MQTT connection without
   * having restarted, and MUST NOT send it when the firmware did restart." A renewal
   * re-does the TLS handshake and re-opens the MQTT session; the firmware did not restart.
   *
   * The supporting citation still stands on its own: examples/flows/10-error-recovery.md has
   * a station that merely re-established its link send `bootReason: "ErrorRecovery"` with a
   * truthful non-zero uptime, and the flow states the server "recognizes this as a
   * reconnection (not a cold boot) ... It does not reset session state."
   *
   * Rejected alternatives: PowerOn is the defect being fixed; FirmwareUpdate and
   * Watchdog assert hardware/firmware events that did not happen; ManualReset and
   * ScheduledReset both claim an actual reset the station never performed.
   */
  private static readonly RECONNECT_BOOT_REASON = BootReason.RECONNECT;

  /**
   * Seconds since this station powered on — the value BootNotification reports.
   *
   * The CSMS treats it as a fact the station asserts about itself: it derives
   * bootTime = now - uptimeSeconds and force-fails (and refunds) every session
   * that started before that instant, on the assumption that a reboot cut them
   * short. Reporting a hardcoded 0 on a mere reconnect therefore destroys live
   * washes, which is why this is computed and never a literal. Clamped at 0
   * because the wire schema requires uptimeSeconds >= 0.
   *
   * Measured on the MONOTONIC clock. On the wall clock the clamp was not a
   * safeguard but the failure itself: a backwards correction of any size drove
   * the difference negative, the clamp reported 0, and 0 is precisely the
   * assertion "I just power-cycled" — so a station that had merely had its clock
   * set back killed every live wash on itself, by the same server gate this
   * docblock describes. A monotonic reading cannot go backwards, so the clamp is
   * now what it was always meant to be: unreachable.
   */
  private currentUptimeSeconds(): number {
    return Math.max(0, Math.floor((monotonicNowMs() - this.poweredOnAt) / 1000));
  }

  handleMessage(envelope: OsppEnvelope): void {
    // Boot gate: before boot is accepted, only allow BootNotification responses through
    if (!this.bootAccepted && envelope.action !== OsppAction.BOOT_NOTIFICATION) {
      console.warn('[Station] Ignoring %s — boot not yet accepted', envelope.action);
      return;
    }

    // Set bootAccepted when BootNotification Accepted is received
    if (envelope.action === OsppAction.BOOT_NOTIFICATION) {
      const payload = envelope.payload as { status?: string };
      if (payload.status === 'Accepted') {
        this.bootAccepted = true;
      }
    }

    const handler = this.handlers.get(envelope.action);
    if (!handler) {
      this.emit('unhandled', envelope);
      return;
    }
    handler.handle(envelope, this).catch((err: unknown) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  registerHandler(action: OsppAction, handler: Handler): void {
    this.handlers.set(action, handler);
    this.registerRouterListener(action);
  }

  /**
   * Update TLS material on the underlying MqttConnection before connect().
   * Used by E2E scenarios that provision a station mid-run, and by
   * TLS-floor conformance scenarios that pin an exact minVersion/maxVersion
   * (or drop the client cert entirely) for a single connection attempt.
   * Reuses MqttConnectionOptions['tls'] directly (rather than a hand-rolled
   * subset) so this stays in sync with whatever MqttConnection accepts.
   */
  setTls(tls: MqttConnectionOptions['tls']): void {
    this.connection.setTls(tls);
  }

  /**
   * The TLS protocol version actually negotiated on the current/most-recent
   * connection (e.g. 'TLSv1.3'), or null before connect() / over a non-TLS
   * transport. See MqttConnection.getNegotiatedTlsProtocol() doc.
   */
  getNegotiatedTlsProtocol(): string | null {
    return this.connection.getNegotiatedTlsProtocol();
  }

  /**
   * Severance state — whether the BROKER kicked us and whether it is refusing
   * to take us back. ADR-0004 TIER 1: a disabled station is kicked off the
   * broker and banned from reconnecting, both reversible on re-enable.
   */
  getSeverance(): SeveranceState {
    return this.connection.getSeverance();
  }

  /**
   * One bounded connect attempt reporting accepted-vs-REFUSED — the ban probe.
   * Observation only: it does NOT make the station operational (no subscribe,
   * no boot). A caller proving un-ban still calls connect() afterwards.
   */
  async probeReconnect(timeoutMs: number): Promise<ReconnectProbeResult> {
    return this.connection.probeReconnect(timeoutMs);
  }

  /**
   * Resolve when the broker force-closes this station (MQTT 5 server-sent
   * DISCONNECT), or reject on timeout. The kick half of the TIER 1 proof:
   * a scenario awaits the sever instead of sleeping and hoping.
   */
  async waitForKick(timeoutMs: number): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      // Already kicked before we started waiting — don't hang for a repeat.
      const current = this.connection.getSeverance();
      if (current.kicked) {
        resolve(current.kickReasonCode);
        return;
      }
      const onKick = (reasonCode: number | null): void => {
        clearTimeout(timer);
        resolve(reasonCode);
      };
      const timer = setTimeout(() => {
        this.connection.removeListener('kicked', onKick);
        reject(new Error(`Timeout waiting for broker kick after ${timeoutMs}ms`));
      }, timeoutMs);
      this.connection.once('kicked', onKick);
    });
  }

  startHeartbeat(intervalSec: number): void {
    this.stopHeartbeat();
    // Counted, because the default's correct behaviour and its total absence print the same
    // thing on a corpus whose files mostly finish inside one interval. See heartbeatStats.ts.
    recordHeartbeatArmed();
    this.heartbeatTimer = setInterval(() => {
      this.sender
        .send(OsppAction.HEARTBEAT, MessageType.REQUEST, {})
        .then(() => {
          recordHeartbeatPublished();
        })
        .catch((err: unknown) => {
          recordHeartbeatFailed();
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        });
    }, intervalSec * 1000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send the BootNotification REQUEST. (Name is historical: this is also the
   * INITIAL boot — see cli/index.ts — and the SERVER-TRIGGERED re-announce, see
   * TriggerMessageHandler.) `uptimeSeconds` and `bootReason` are derived from the
   * station's live state, so the same call reports ~0/PowerOn on a genuine
   * power-on and the real elapsed uptime with a reconnect reason after a
   * cert-renewal re-handshake.
   *
   * This is the ONLY place a BootNotification payload is built. It has to stay
   * that way: the trigger path once carried its own literal and drifted from this
   * one in three fields, two of which cost live washes. Add fields here, never in
   * a caller.
   *
   * @param fixedMessageId Opt-in: reuse this messageId instead of minting a fresh
   *   UUID. Per the OSPP glossary, a station SHOULD retry with the SAME messageId
   *   on timeout; the default (undefined → fresh UUID) is preserved so existing
   *   scenarios are unaffected. Reusing the id is what exercises the server's
   *   duplicate-REQUEST cached-RESPONSE replay path (02-transport §3.3).
   */
  /**
   * The topology this station declares, from its own persisted memory.
   *
   * Falls back to the config shape ONLY when no store directory is configured —
   * i.e. a unit test constructing a Station without a TLS path. That fallback is
   * narrow on purpose: it cannot be reached by a station that has certificates,
   * which is every station that can actually connect.
   */
  private async declaredTopology(): Promise<DeclaredBay[]> {
    const dir = this.topologyDir();
    if (dir === null) {
      return TopologyStore.toWireShape(this.config.bays);
    }

    return new TopologyStore(dir, this.config.stationId).declare(this.config.bays);
  }

  /** Alongside the station's certificates — the state it already keeps on disk. */
  private topologyDir(): string | null {
    // A unit test may hand in a bare fake connection with no TLS surface at all.
    // That is the fallback's only legitimate caller: a station that can actually
    // connect has certificates, so it has a directory and it persists.
    if (typeof this.connection.getTlsPaths !== 'function') {
      return null;
    }

    const certPath = this.connection.getTlsPaths()?.cert;

    return certPath === undefined ? null : dirname(certPath);
  }

  /**
   * Settle one running session as an OPERATOR-INITIATED stop and report it.
   *
   * reset-request.schema.json, `force`: the station "settles every active session
   * under the operator-disable policy FIRST — the session is stopped, metered and
   * reported exactly as an operator-initiated stop, so the customer is billed for
   * what they received — and only then reboots."
   *
   * Metered from the session's real elapsed time, not from its requested
   * duration: the customer receives what ran, and billing the full request would
   * charge for a wash the reset cut short.
   *
   * "Real elapsed time" means the MONOTONIC one — `session-ended.md:61` rule 2,
   * the same obligation StopService carries at `stop-service.md:47` rule 5. This
   * differenced the wall clock, and the `Math.max(0, ...)` below made the
   * backwards direction WORSE than it is on the StopService carrier: a -1h
   * correction produced a schema-VALID SessionEnded reporting 0 seconds and 0
   * credits for a wash that was delivered, so nothing downstream could see it.
   */
  async settleSessionAsOperatorStop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }

    const actualDurationSeconds = Math.max(
      0,
      Math.round((monotonicNowMs() - session.startedAtMonotonicMs) / 1000),
    );
    // Station.SessionInfo carries no price; the SERVER is the authoritative
    // billing engine (§04-flows.md:823-833) and this value is advisory. 100 cr/min
    // is the same default the sim uses elsewhere.
    const creditsCharged = Math.ceil((actualDurationSeconds / 60) * 100);

    this.sessions.delete(sessionId);

    // A bay-transition hiccup must not abort the reboot. The forced reset
    // iterates every running session, and the settle's job is to REPORT the
    // session so the customer is billed for what they received — losing that
    // report because a bay was already Available would be the "drop it on the
    // floor" the clause rules out, and it would strand the remaining sessions
    // too.
    try {
      // Occupied -> Finishing -> Available, the same two steps StopServiceHandler
      // takes. The FSM has no direct Occupied -> Available edge, and a live
      // forced reset proved it: the settle went straight to Available and threw
      // "Invalid bay transition for Station: Occupied → Available". A wash that
      // is ending still passes through Finishing whether an operator ended it or
      // a timer did.
      if (this.getBayState(session.bayId) === BayStatus.OCCUPIED) {
        this.setBayState(session.bayId, BayStatus.FINISHING);
      }
      this.setBayState(session.bayId, BayStatus.AVAILABLE);
    } catch (err) {
      console.log(
        '[Reset] bay %s could not transition to Available (%s) — settling the session anyway',
        session.bayId, err instanceof Error ? err.message : String(err),
      );
    }

    await this.sender.send<SessionEndedPayload>(
      OsppAction.SESSION_ENDED,
      MessageType.EVENT,
      {
        sessionId: session.sessionId,
        bayId: session.bayId,
        // spec v0.11.1 03-messages.md §5.4 — the only reason that bills a NON-ZERO
        // amount for a session the station did not run to completion, which is
        // exactly what a forced reset produces. This was `Deauthorized` until the
        // member existed, and that carries "Session MUST be billed at zero" — so
        // every forced reset delivered a wash and charged nothing for it.
        reason: SessionEndReason.OPERATOR_STOPPED,
        actualDurationSeconds,
        creditsCharged,
        // peek, not next: SessionEnded reports the FINAL position, it does not
        // issue a new one.
        seqNo: session.seq.peek(),
        finalSeqNo: session.seq.peek(),
      },
    );

    console.log(
      '[Reset] settled session %s as an operator stop — %ds, %d credits',
      sessionId, actualDurationSeconds, creditsCharged,
    );
  }

  async retryBoot(fixedMessageId?: string): Promise<void> {
    const bootPayload: BootNotificationRequest = {
      stationId: this.config.stationId,
      firmwareVersion: this.config.firmwareVersion,
      stationModel: this.config.stationModel,
      stationVendor: this.config.stationVendor,
      serialNumber: this.config.serialNumber,
      // The RE-DECLARED PHYSICAL TOPOLOGY, replacing bayCount, which is deleted
      // from the wire. Ordinals only: labels are descriptive and are never
      // compared, so a corrected typo in a firmware constant must not put the
      // station into Pending.
      //
      // Read from what THIS STATION wrote, not from config. First boot writes it;
      // every later boot re-declares the same thing even if config changed —
      // "the declaration MUST be STABLE between boots while the hardware is
      // unchanged" (boot-notification-request.schema.json:50), and a station that
      // re-derives from config each boot is silently agreeing with whatever it is
      // told to be, which is what §05-state-machines.md:126 forbids.
      bays: await this.declaredTopology(),
      // Truthful, never a literal — the CSMS force-fails and refunds every
      // session that predates (now - uptimeSeconds). See currentUptimeSeconds().
      uptimeSeconds: this.currentUptimeSeconds(),
      // A literal, and the last one left in this payload. It is the same class as
      // the `uptimeSeconds: 0` defect — a self-reported fact hardcoded rather
      // than derived.
      //
      // STILL TRUTHFUL UNDER THE OPT-IN BELOW, and this is the reason rather than an
      // assertion: this simulator has no offline buffer at all. It emits
      // AuthorizeOfflinePass and TransactionEvent only when a driver hands it one, live,
      // over the control file — nothing is ever queued and replayed. So the count is 0 by
      // construction whether or not the capability is declared. The moment a real buffer
      // is added, this must be derived from it in the same commit.
      pendingOfflineTransactions: 0,
      timezone: this.config.timezone,
      bootReason: this.currentBootReason,
      // OPTIONAL since spec 0.31.0, and DERIVED — the third field in this payload that is
      // read from live state rather than written down, for the same reason as the other two.
      //
      // WHY IT MATTERS THAT THE SIMULATOR SENDS IT AT ALL. BootNotification REQUEST is one of
      // three structural exemptions from message signing (06-security.md §5.6); the other 44
      // types are signed. So when a station and the server disagree about the mode, this is
      // the ONLY message that still arrives, and this field is the only place the station can
      // state which mode it is in. Without it that state is not undiagnosed, it is
      // inexpressible — csms-server carries the reading half as an open item (M83) and cannot
      // be exercised against a station that never says.
      //
      // NOT in `capabilities`: that object is four booleans about what the station SUPPORTS.
      // This is configuration state — what it is DOING.
      messageSigningMode: this.sender.currentSigningMode,
      capabilities: {
        bleSupported: false,
        // OPT-IN, default false — unchanged for every existing scenario and for
        // `simulator connect`. It exists because the server gate refuses on an EXPLICIT
        // false (`StationQueryService::offlineAvailability`), and BootNotification is the
        // only writer of that column, so a station that hardcodes false can never be
        // driven through the offline arm at all: AuthorizeOfflinePass is unreachable and
        // the refusal is indistinguishable from a misconfigured tenant.
        //
        // Declaring it here is a claim about what this process SUPPORTS, and it is one it
        // can honour: the AuthorizeOfflinePass / TransactionEvent request pair is built and
        // signed on demand. It is NOT a claim that the simulator buffers anything — see
        // `pendingOfflineTransactions` above.
        offlineModeSupported: process.env.OSPP_SIM_OFFLINE_MODE_SUPPORTED === '1',
        meterValuesSupported: true,
        // Truthful: this simulator implements the device-management command set
        // (ChangeConfiguration, GetConfiguration, GetDiagnostics, Reset, UpdateFirmware,
        // SetMaintenanceMode, TriggerMessage). Omitting it made the CSMS store
        // device_management_supported=false, so WriteConfigurationAction refused every
        // config push with "Station does not support device management" — which reads
        // exactly like a gating bug while actually being an unadvertised capability.
        deviceManagementSupported: true,
      },
      networkInfo: {
        connectionType: 'Ethernet',
      },
    };

    await this.sender.send(
      OsppAction.BOOT_NOTIFICATION,
      MessageType.REQUEST,
      bootPayload,
      fixedMessageId,
    );
  }

  getBayState(bayId: string): BayStatus {
    const machine = this.bayMachines.get(bayId);
    if (!machine) {
      throw new Error(`Unknown bay: ${bayId}`);
    }
    return machine.state;
  }

  setBayState(bayId: string, status: BayStatus): void {
    const machine = this.bayMachines.get(bayId);
    if (!machine) {
      throw new Error(`Unknown bay: ${bayId}`);
    }
    machine.transition(status);
  }

  private registerRouterListener(action: OsppAction): void {
    if (this.registeredListeners.has(action)) return;
    this.registeredListeners.add(action);
    this.router.onAction(action, (envelope: OsppEnvelope) => {
      this.handleMessage(envelope);
    });
  }
}
