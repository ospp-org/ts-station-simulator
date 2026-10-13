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
import { CatalogStore } from './CatalogStore.js';
import {
  FileSessionStore,
  MemorySessionStore,
  SESSION_CHECKPOINT_INTERVAL_SECONDS,
  STOP_ANSWER_RETENTION_MS,
  type HeldSessionEnded,
  type SessionStore,
  type StoppedSessionAnswer,
  type StoredSessionState,
} from './SessionStore.js';
import { armWashTimer, clearWashTimer, deliveredSeconds, endSession } from './sessionEnd.js';
import type { StationContext } from '../handlers/Handler.js';
import type {
  OsppEnvelope,
  BootNotificationRequest,
  BayId,
  ServiceId,
  StopServiceResponse,
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
import type { FrameJournal } from '../mqtt/FrameJournal.js';
import type { ServiceConfig, StationConfig } from './StationConfig.js';
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
   * time for this session is differenced from (`heartbeat.md §6 Clock Synchronization` rule 5). Kept in
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
  /**
   * The rest of Handler.ts's declaration, kept in step for the reason above: the delivered seconds
   * a restart carried in, the wash timer, the rule-9 record's program and messageId, the advisory
   * price. Optional here because a scenario's sessions (SendStep) carry none of them.
   */
  deliveredBeforeRestartSeconds?: number;
  washTimer?: ReturnType<typeof setTimeout>;
  programNumber?: number;
  startMessageId?: string;
  priceCreditsPerMinute?: number;
}

/**
 * The six boot reasons that keep a session: after any of them the station may resume a wash it
 * held (session-end rule S6). RemoteReset and FirmwareUpdate are the two at which no session may
 * be live - a Reset settles first, an update installs only once its sessions ended - so a session
 * still held at either cannot be resumed.
 */
const SESSION_KEEPING_BOOT_REASONS: ReadonlySet<BootReason> = new Set([
  BootReason.POWER_ON,
  BootReason.WATCHDOG,
  BootReason.ERROR_RECOVERY,
  BootReason.RECONNECT,
  BootReason.MANUAL_RESET,
  BootReason.SCHEDULED_RESET,
]);

/** What a power-on found on disk and did with it (Station.restoreSessions). */
export interface RestoredSessions {
  /** Washes running on for the rest of their booked duration. */
  resumed: string[];
  /** Washes ended at once: SessionEnded Fault (or TimerExpired, for one already fully delivered), held for the boot. */
  ended: string[];
  /** SessionEnded events an earlier process could not send, still held. */
  held: number;
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

  /** See StationContext.terminalReservations — `reserve-bay.md` §5.2 retention. */
  public readonly terminalReservations: Map<string, import('../handlers/bayRefusal.js').TerminalReservation> = new Map();
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

  /** StationContext.heldSessionEnded: the end records waiting for a boot they can be sent after. Mutated in place. */
  public readonly heldSessionEnded: HeldSessionEnded[] = [];
  /** StationContext.lastReportedBayStatus: what the boot report, and every report since, said each bay was. */
  public readonly lastReportedBayStatus: Map<string, BayStatus> = new Map();
  /** The stops answered `Accepted`, by sessionId - the cached RESPONSE a repeated StopService gets (stop-service.md §6 rule 10). */
  private readonly stoppedSessions: Map<string, StoppedSessionAnswer> = new Map();
  /** Where the sessions are kept; built once, on first use (sessionStore()). */
  private sessionStoreInstance: SessionStore | null | undefined = undefined;
  /** Every write of the record, in order: two writers racing on one temporary file would corrupt it. */
  private sessionWrites: Promise<void> = Promise.resolve();
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  /** The socket is up (MqttConnection's `connect` and `close`) - tracked for a station that acts on its link. */
  private linkUp = false;
  /** Inside connect(): the `connect` that follows is the one connect() waits for, not mqtt.js reconnecting on its own. */
  private connectInFlight = false;
  /** One replay at a time: a second Accepted boot must not send the same held events twice. */
  private replayInFlight: Promise<void> | null = null;

  private readonly connection: MqttConnection;

  /**
   * Every frame this station sent or received, when the caller asked for one.
   *
   * `undefined` on a station built without a journal, and a reader must treat that
   * as "not measured" rather than as an empty wire — an absence asserted against a
   * station that journals nothing is a vacuous pass, which is the failure mode this
   * whole instrument exists to remove.
   */
  public readonly journal: FrameJournal | undefined;

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
   *
   * Not readonly any more: restart() is the in-process power cycle (a Reset, an
   * installed update), and the uptime of the boot that follows it starts again at 0.
   */
  private poweredOnAt: number = monotonicNowMs();

  /**
   * Why the station is sending its CURRENT BootNotification. Defaults to
   * POWER_ON (this instance did just power on), or to the reason the process was
   * started with (`config.bootReason`), and is updated by whatever re-boots the
   * station — a cert-renewal re-handshake or a reconnect (`Reconnect`), a restart()
   * (its reason). Retries of the same boot re-send the same reason, since a retry
   * is not a new boot episode.
   */
  private currentBootReason: BootReason;

  private readonly handlers: Map<OsppAction, Handler> = new Map();
  private readonly registeredListeners: Set<OsppAction> = new Set();
  private readonly bayMachines: Map<string, BayStateMachine> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: StationConfig, mqttOptions: MqttConnectionOptions) {
    super();
    this.config = config;
    this.currentBootReason = config.bootReason ?? BootReason.POWER_ON;
    this.connection = new MqttConnection(mqttOptions);
    this.journal = mqttOptions.journal;
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

    // THE LINK, AS THE STATION SEES IT. Wired once here, like the two above - and only for a station
    // that drives its own sessions (`rebootOnReconnect`, connect mode). A scenario's YAML sends the
    // boot a reconnect needs as a step of its own, so a scenario's station must not send a second
    // one, and its canTransmit() does not read the link.
    if (config.rebootOnReconnect === true) {
      this.wireLinkEvents();
    }

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

  /** The link's two events, for a station that acts on them (constructor). */
  private wireLinkEvents(): void {
    this.connection.on('close', () => {
      this.linkUp = false;
      // A dead link carries nothing. A Heartbeat or an event handed to mqtt.js now would be queued
      // and flushed on the next connection AHEAD of the BootNotification that must open it
      // (connection-lost.md §6 step 1), signed with a key the server discarded on the will. So the
      // station stops beating, drops the key, and holds every SessionEnded until the next boot.
      this.stopHeartbeat();
      this.bootAccepted = false;
      this.sessionKey = null;
    });
    this.connection.on('connect', () => {
      this.linkUp = true;
      if (this.connectInFlight) return;
      // mqtt.js reconnected on its own: the firmware did not restart, so this is `Reconnect`, with the
      // uptime running on (boot-notification.md §5.2 rule 1), and it is the first message on the new
      // connection. The bays are reported and the held SessionEnded events sent once it is Accepted
      // (BootNotificationHandler).
      this.lifecycle = StationLifecycle.ONLINE;
      this.bootAccepted = false;
      this.currentBootReason = Station.RECONNECT_BOOT_REASON;
      console.log('[Station] %s reconnected - booting again (Reconnect)', this.config.stationId);
      this.retryBoot().catch((err: unknown) => {
        console.error('[Station] the BootNotification after the reconnect failed: %s', err instanceof Error ? err.message : String(err));
      });
    });
  }

  async connect(): Promise<void> {
    this.connectInFlight = true;
    this.connection.connect();

    try {
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
    } finally {
      this.connectInFlight = false;
    }

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

    // THE KEY DIES WITH THE MQTT SESSION. `06-security.md §5.8, "What the MAC still buys"` rule 2 — "Both
    // peers MUST discard it when the MQTT session ends — the station on
    // disconnect, the server on the LWT or on any broker-reported disconnect."
    // The server holds up its half already; this station kept a dead session's
    // key, because `sessionKey` had exactly one writer and no clear. Note the
    // company it now keeps: `bootAccepted` is already reset on connect and on
    // `kicked`, and this field was simply left out of both.
    //
    // Any reconnect produces a BootNotification, which issues a new key (rule
    // 4), so nothing here needs a re-key path of its own.
    this.sessionKey = null;

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

  /**
   * Hold again the catalog this station last accepted, before it boots - what a real station reads
   * back from NVS at power-on (update-service-catalog.md rule 5). Only when the config asks for it
   * (`persistCatalog`, connect mode) and the station has a certificate directory to keep it in.
   * Returns whether a catalog was restored; a station that never accepted one keeps its seed and
   * reports `''` as it always has.
   */
  async restoreCatalog(): Promise<boolean> {
    const store = this.catalogStore();
    if (store === null) {
      return false;
    }

    const stored = await store.load();
    if (stored === null) {
      return false;
    }

    for (const bay of this.config.bays) {
      bay.services = stored.services.map(svc => ({ ...svc }));
    }
    this.currentCatalogVersion = stored.catalogVersion;

    return true;
  }

  /** StationContext.persistCatalog: the catalog just accepted, kept for the next process. */
  async persistCatalog(catalogVersion: string, services: ServiceConfig[]): Promise<void> {
    await this.catalogStore()?.save(catalogVersion, services);
  }

  /** Where this station keeps its catalog - null when it keeps none (a scenario's station, a unit test's). */
  catalogStore(): CatalogStore | null {
    if (this.config.persistCatalog !== true) {
      return null;
    }

    const dir = this.topologyDir();

    return dir === null ? null : new CatalogStore(dir, this.config.stationId);
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
   * reset-request.schema.json (spec v0.44.0), `force`: the station "settles every
   * active session under the operator-disable policy FIRST (04-flows.md, 'The
   * operator-disable policy') — the session is stopped, metered from the time
   * ACTUALLY DELIVERED, and reported as SessionEnded with reason OperatorStopped,
   * which the server settles by service kind (pro-rata on delivered time for
   * UserDuration, a full refund for FixedDuration and MultiUnit; 04-flows.md,
   * 'Settlement by Service Kind') — and only then reboots."
   *
   * Metered from the session's real elapsed time, not from its requested
   * duration: the report states what ran, and reporting the full request would
   * claim a wash the reset cut short — the delivered time is what the server
   * bills a UserDuration session on. The station does not know the kind and
   * decides no money; its report is the same whatever the kind.
   *
   * "Real elapsed time" means the MONOTONIC one — `session-ended.md §5 Processing Rules` rule 2,
   * the same obligation StopService carries at `stop-service.md §6 Processing Rules` rule 5. This
   * differenced the wall clock, and the `Math.max(0, ...)` below made the
   * backwards direction WORSE than it is on the StopService carrier: a -1h
   * correction produced a schema-VALID SessionEnded reporting 0 seconds and 0
   * credits for a wash that was delivered, so nothing downstream could see it.
   */
  async settleSessionAsOperatorStop(sessionId: string): Promise<void> {
    // The ONE end path (sessionEnd.ts): the delivered time on the monotonic clock, the bay
    // Occupied -> Finishing -> Available (a hiccup there is logged, never thrown - the forced reset
    // iterates every running session and must not strand the rest), the SessionEnded held on disk
    // until it is published. It was this method's own body, the only SessionEnded the simulator sent
    // on its own; the wash timer and a restart now end sessions through the same path.
    //
    // 03-messages.md §5.4 (spec v0.44.0): `OperatorStopped` is the member for a session an operator
    // ended deliberately (a forced Reset, a station disable). It carries the delivered time; the
    // server settles it by service kind - pro-rata on delivered time for UserDuration, a full refund
    // for FixedDuration and MultiUnit. It was `Deauthorized` until the member existed, and that
    // carries "Session MUST be billed at zero", which erased the delivered time UserDuration bills on.
    const ended = await endSession(this.asContext(), sessionId, SessionEndReason.OPERATOR_STOPPED);
    if (ended !== null) {
      console.log(
        '[Reset] settled session %s as an operator stop — %ds, %d credits',
        sessionId, ended.actualDurationSeconds, ended.creditsCharged,
      );
    }
  }

  /** This station as the context its handlers and the end path read - one object, two declared shapes. */
  private asContext(): StationContext {
    return this as unknown as StationContext;
  }

  // ---------------------------------------------------------------------------
  // THE SESSIONS ACROSS A RESTART (session-end rule S2, S3) - connect mode
  // ---------------------------------------------------------------------------

  /**
   * Where this station keeps its sessions: beside its certificates (FileSessionStore), or in memory
   * for a station that has no certificate directory - it then survives restart() and not a new
   * process. Null when the config does not ask (a scenario's station keeps nothing).
   */
  sessionStore(): SessionStore | null {
    if (this.sessionStoreInstance === undefined) {
      if (this.config.persistSessions !== true) {
        this.sessionStoreInstance = null;
      } else {
        const dir = this.topologyDir();
        this.sessionStoreInstance = dir === null
          ? new MemorySessionStore()
          : new FileSessionStore(dir, this.config.stationId);
      }
    }
    return this.sessionStoreInstance;
  }

  /**
   * StationContext.persistSessions: write the whole record - the live sessions with their delivered
   * time as of now, the held SessionEnded events, the stops answered within the horizon. Writes are
   * queued so two never race on the temporary file; a failure reaches the caller (StartService
   * refuses 5103 on it). Keeps the checkpoint timer running exactly while a session does.
   */
  async persistSessions(): Promise<void> {
    const store = this.sessionStore();
    if (store === null) return;
    const write = this.sessionWrites.then(() => store.save(this.sessionSnapshot()));
    this.sessionWrites = write.catch(() => undefined);
    this.syncCheckpointing();
    await write;
  }

  private sessionSnapshot(): StoredSessionState {
    const now = monotonicNowMs();
    const horizon = Date.now() - STOP_ANSWER_RETENTION_MS;
    for (const [id, answer] of this.stoppedSessions) {
      if (Date.parse(answer.answeredAt) < horizon) this.stoppedSessions.delete(id);
    }
    return {
      stationId: this.config.stationId,
      savedAt: new Date().toISOString(),
      sessions: [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        bayId: s.bayId,
        serviceId: s.serviceId,
        ...(s.startMessageId !== undefined ? { startMessageId: s.startMessageId } : {}),
        ...(s.programNumber !== undefined ? { programNumber: s.programNumber } : {}),
        startedAt: s.startedAt,
        durationSeconds: s.durationSeconds,
        deliveredSeconds: Math.min(s.durationSeconds, deliveredSeconds(s, now)),
        checkpointedAt: new Date().toISOString(),
        seqNo: s.seq.peek(),
        priceCreditsPerMinute: s.priceCreditsPerMinute ?? 100,
      })),
      heldSessionEnded: [...this.heldSessionEnded],
      stoppedSessions: [...this.stoppedSessions.values()],
    };
  }

  /** The checkpoint: the delivered time on disk is never more than SESSION_CHECKPOINT_INTERVAL_SECONDS old while a wash runs. */
  private syncCheckpointing(): void {
    if (this.sessions.size > 0 && this.checkpointTimer === null) {
      this.checkpointTimer = setInterval(() => {
        this.persistSessions().catch((err: unknown) => {
          console.error('[Session] checkpoint not written: %s', err instanceof Error ? err.message : String(err));
        });
      }, SESSION_CHECKPOINT_INTERVAL_SECONDS * 1000);
      if (typeof (this.checkpointTimer as { unref?: () => void }).unref === 'function') {
        (this.checkpointTimer as { unref: () => void }).unref();
      }
    } else if (this.sessions.size === 0 && this.checkpointTimer !== null) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
  }

  /** StationContext.canTransmit. Only a station that holds and replays its end records decides it (connect mode). */
  canTransmit(): boolean {
    if (this.config.rebootOnReconnect !== true) return true;
    return this.lifecycle === StationLifecycle.ONLINE && this.linkUp && this.bootAccepted && this.sessionKey !== null;
  }

  /** StationContext.stopAnswerFor: the cached RESPONSE of a stop answered within the retention horizon. */
  stopAnswerFor(sessionId: string): Extract<StopServiceResponse, { status: 'Accepted' }> | undefined {
    const answer = this.stoppedSessions.get(sessionId);
    if (answer === undefined) return undefined;
    if (Date.parse(answer.answeredAt) < Date.now() - STOP_ANSWER_RETENTION_MS) {
      this.stoppedSessions.delete(sessionId);
      return undefined;
    }
    return answer.response;
  }

  /** StationContext.rememberStopAnswer. */
  rememberStopAnswer(sessionId: string, bayId: string, response: Extract<StopServiceResponse, { status: 'Accepted' }>): void {
    this.stoppedSessions.set(sessionId, { sessionId, bayId, response, answeredAt: new Date().toISOString() });
  }

  /**
   * What a power-on does with the sessions on disk, before its boot (session-end rule S3): for every
   * session the station held, resume the wash - its bay Occupied in the boot report, its timer
   * re-armed for the rest of its booked duration, its SessionEnded sent at the end - or, when it
   * cannot resume, end it at once with SessionEnded `Fault` and the delivered time the record holds,
   * sent right after the boot is Accepted. `Fault` is "a hardware fault, or a restart the station
   * could not resume the wash after" (Gabi, 2026-10-13).
   *
   * Resumed after the six boot reasons that keep a session unless `behavior.onRestart` is
   * `interrupt`; never after RemoteReset or FirmwareUpdate, at which no session may be live. A wash
   * the record says was fully delivered ends TimerExpired. Held SessionEnded events an earlier
   * process could not send stay held, and the answered stops stay cached.
   */
  async restoreSessions(): Promise<RestoredSessions> {
    const restored: RestoredSessions = { resumed: [], ended: [], held: 0 };
    const store = this.sessionStore();
    if (store === null) return restored;
    const state = await store.load();
    if (state === null) return restored;

    this.heldSessionEnded.splice(0, this.heldSessionEnded.length, ...state.heldSessionEnded);
    restored.held = this.heldSessionEnded.length;
    this.stoppedSessions.clear();
    for (const answer of state.stoppedSessions) this.stoppedSessions.set(answer.sessionId, answer);

    const mayResume = SESSION_KEEPING_BOOT_REASONS.has(this.currentBootReason)
      && this.config.behavior.onRestart !== 'interrupt';

    for (const record of state.sessions) {
      const seq = new SequenceCounter();
      if (record.seqNo > 0) seq.forceTo(record.seqNo);
      const session: SessionInfo = {
        sessionId: record.sessionId,
        bayId: record.bayId as BayId,
        serviceId: record.serviceId as ServiceId,
        startedAt: record.startedAt,
        // The origin of what THIS process delivers: now. What came before is carried in seconds.
        startedAtMonotonicMs: monotonicNowMs(),
        deliveredBeforeRestartSeconds: record.deliveredSeconds,
        durationSeconds: record.durationSeconds,
        seq,
        priceCreditsPerMinute: record.priceCreditsPerMinute,
        ...(record.programNumber !== undefined ? { programNumber: record.programNumber } : {}),
        ...(record.startMessageId !== undefined ? { startMessageId: record.startMessageId } : {}),
      };
      this.sessions.set(session.sessionId, session);

      const fullyDelivered = record.deliveredSeconds >= record.durationSeconds;
      if (mayResume && !fullyDelivered && this.bayAvailableForResume(record.bayId)) {
        this.setBayState(record.bayId, BayStatus.OCCUPIED);
        armWashTimer(this.asContext(), session);
        restored.resumed.push(session.sessionId);
        console.log(
          '[Session] resumed %s on bay %s after %s - %ds of %ds delivered, %ds left',
          session.sessionId, session.bayId, this.currentBootReason,
          record.deliveredSeconds, record.durationSeconds, record.durationSeconds - record.deliveredSeconds,
        );
        continue;
      }

      // Not resumed: the end record goes out right after the Accepted boot (it is held now - no boot
      // has been answered yet).
      const reason = fullyDelivered ? SessionEndReason.TIMER_EXPIRED : SessionEndReason.FAULT;
      await endSession(this.asContext(), session.sessionId, reason, {
        deliveredSeconds: Math.min(record.deliveredSeconds, record.durationSeconds),
      });
      restored.ended.push(session.sessionId);
      console.log(
        '[Session] could not resume %s after %s - SessionEnded %s with %ds delivered, sent after the boot',
        session.sessionId, this.currentBootReason, reason, Math.min(record.deliveredSeconds, record.durationSeconds),
      );
    }

    await this.persistSessions();
    return restored;
  }

  /** A resumed wash needs its bay idle at power-on - and a bay this station still declares. */
  private bayAvailableForResume(bayId: string): boolean {
    const machine = this.bayMachines.get(bayId);
    return machine !== undefined && machine.state === BayStatus.AVAILABLE;
  }

  /**
   * StationContext.restart - the in-process power cycle (a Reset, an installed update, a test).
   *
   * What a power loss takes: every timer (the heartbeat, each wash's, the checkpoint), the live
   * session map, the held events and answered stops in memory, the boot verdict, the session key,
   * the bays' state (back to Available, as at power-on) and the socket. What it leaves: the disk.
   * The uptime starts again at 0 and the next BootNotification carries `reason`; then
   * restoreSessions() decides each kept session exactly as for a new process, which is the point -
   * one restart path, whether the process survived it or not. `Reconnect` is refused: it names the
   * case where the firmware did NOT restart.
   */
  async restart(reason: BootReason): Promise<void> {
    if (reason === BootReason.RECONNECT) {
      throw new Error('Station.restart: Reconnect names a reconnection without a restart; a restart needs a restart reason');
    }
    console.log('[Station] %s restarting (%s)', this.config.stationId, reason);

    this.stopHeartbeat();
    for (const session of this.sessions.values()) clearWashTimer(session);
    if (this.checkpointTimer !== null) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    // Nothing leaves from here on. An end record already being published finishes and is released;
    // a write already handed to the disk completes (it is an atomic rename). Then the memory goes,
    // and what the disk holds is all the next boot knows - held records included, sent once.
    this.bootAccepted = false;
    this.sessionKey = null;
    while (this.replayInFlight !== null) await this.replayInFlight;
    await this.sessionWrites;
    this.sessions.clear();
    this.heldSessionEnded.splice(0, this.heldSessionEnded.length);
    this.stoppedSessions.clear();
    this.lastReportedBayStatus.clear();
    for (const bay of this.config.bays) {
      this.bayMachines.set(bay.bayId, new BayStateMachine(EffectedBy.STATION, BayStatus.AVAILABLE));
    }

    await this.connection.disconnect();
    this.lifecycle = StationLifecycle.OFFLINE;

    this.poweredOnAt = monotonicNowMs();
    this.currentBootReason = reason;
    const restored = await this.restoreSessions();
    if (restored.resumed.length + restored.ended.length + restored.held > 0) {
      console.log(
        '[Station] after %s: %d resumed, %d ended at once, %d end records held for the boot',
        reason, restored.resumed.length, restored.ended.length, restored.held,
      );
    }

    await this.connect();
    await this.retryBoot();
  }

  /**
   * StationContext.replayHeldSessionEnded - the ONE publisher of held SessionEnded events: after an
   * Accepted boot and its bay reports, and after endSession() holds a new one. Sends every held
   * SessionEnded, oldest first, with its original values and messageId (session-ended.md §5 rule 3;
   * connection-lost.md §6 step 4), each released from the record once published. Stops at the first
   * one that cannot leave - the rest wait for the next boot.
   */
  async replayHeldSessionEnded(): Promise<void> {
    // Behind a pass already running, then a pass of its own: a record held after that pass looked
    // at the list for the last time must not wait for the next boot.
    while (this.replayInFlight !== null) await this.replayInFlight;
    // Stored BEFORE anything can clear it, and cleared only by the pass it names: a pass with
    // nothing to send finishes synchronously, and a `finally` inside it would run before the
    // assignment and leave a settled promise behind that every later caller awaits for ever.
    const pass = this.sendHeldSessionEnded();
    this.replayInFlight = pass;
    try {
      await pass;
    } finally {
      if (this.replayInFlight === pass) this.replayInFlight = null;
    }
  }

  private async sendHeldSessionEnded(): Promise<void> {
    while (this.heldSessionEnded.length > 0 && this.canTransmit()) {
      const held = this.heldSessionEnded[0];
      try {
        await this.sender.send<SessionEndedPayload>(OsppAction.SESSION_ENDED, MessageType.EVENT, held.payload, held.messageId);
      } catch (err) {
        console.log(
          '[Session] the held SessionEnded of %s could not be sent (%s) - kept for the next boot',
          held.payload.sessionId, err instanceof Error ? err.message : String(err),
        );
        return;
      }
      const at = this.heldSessionEnded.indexOf(held);
      if (at !== -1) this.heldSessionEnded.splice(at, 1);
      console.log('[Session] sent the held SessionEnded of %s (%s)', held.payload.sessionId, held.payload.reason);
      await this.persistSessions().catch((err: unknown) => {
        console.error('[Session] could not record the release on disk: %s', err instanceof Error ? err.message : String(err));
      });
    }
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
      // told to be, which is what §05-state-machines.md §1.4 The Restricted States forbids.
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
