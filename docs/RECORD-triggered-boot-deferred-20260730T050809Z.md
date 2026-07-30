# Deferred items surfaced by the triggered-BootNotification repair

Date: 2026-07-30
Branch: `cp/trigger-truthful-boot`
Commits: `ede8865` (handler consolidation), `35a2e08` (scenario)

What was repaired is in those commit messages. This file records what was
deliberately **not** built, so the next person finds it before it costs
something rather than after.

---

## 1. `pendingOfflineTransactions: 0` — the last literal in the boot payload

`Station.retryBoot()` derives every field from live state except this one.

It is truthful **only by construction**: the same payload declares
`offlineModeSupported: false`, so this simulator never buffers a transaction
and the count really is zero.

It is nonetheless the same class of defect as the `uptimeSeconds: 0` that this
arc repaired — a self-reported fact hardcoded rather than derived — and the
construction that makes it true is one line away in the same object literal.
**The moment `offlineModeSupported` becomes `true`, this becomes a lie**, and
it will be a quiet one: the server has no way to detect a station
under-reporting its own backlog.

Action: whoever flips `offlineModeSupported` derives this from the real buffer
in the same commit. Noted inline at the literal so it is unmissable at the
point of change.

## 2. Spec `trigger-message.md` §5 — no rule for a triggered BootNotification

§5 gives per-message rules for StatusNotification (3), MeterValues (4),
SignCertificate (5) and Diagnostics/FirmwareStatus (6). It gives none for
BootNotification, Heartbeat or SecurityEvent, so only the generic rule 2
applies:

> The triggered message is a normal message instance — it uses the same format,
> topic, and processing rules as if it were sent on schedule.

Rule 2 governs **form** — format, topic, processing rules — not content. And
its comparison case has no referent for this message: BootNotification is never
"sent on schedule". So it does not answer what a station should assert in
`bootReason` on a send where nothing booted.

This repair resolved the question **inside the simulator** by reading
`bootReason` as a property of the last boot *episode* rather than of the send
— which is what `boot-notification.md:29` ("Reason the station booted") and
the schema's own `uptimeSeconds` description ("Seconds elapsed since the
station last booted") both say, and what the repo already does for
Rejected/Pending retries.

**Deliberately not proposed as a spec change.** A spec edit made to justify a
simulator change is the wrong direction, and the reading above needs no edit to
be correct. If the ambiguity is ever closed upstream it should be closed on its
own merits, by someone looking at all three uncovered messages, not just this
one.

Related, already logged upstream: spec `KNOWN-ISSUES.md:84` **V2-047** —
"Flow 10: mqtt_reconnect→ErrorRecovery in narrative". Both normative
`ErrorRecovery` uses attach it to an actual restart (`01-architecture.md:394`,
`profiles/device-management/update-firmware.md:74`); the session-preserving
reading lives only in `examples/flows/10-error-recovery.md:273`, and
`examples/README.md:7` declares that directory informative (non-normative).
The csms-server carve-out at
`app/Modules/Station/Handlers/BootNotificationHandler.php:293` depends on that
non-normative reading and says so in its own comment.

## 3. `@ospp/protocol` version skew

The simulator resolves **0.9.0**; csms-server installs **0.10.0**. Spec repo is
tagged v0.9.0 and csms-server's `.spec-ref` is v0.9.0.

Not touched here and not diagnosed. Recorded only so that "the simulator and
the server agree on the protocol package" is not assumed.

## 4. Other known simulator gaps — untouched, not investigated this session

Carried forward from the brief, listed so they stay visible:

- no boot-response timeout
- ignores `response.configuration`
- flat reconnect period
- discards `mqttConfig` fields

None of these were examined; their descriptions are inherited, not verified at
HEAD.

## 5. Scenario mode cannot assert on a station's own outbound message

Found while repairing `trigger-message-boot.yaml`, and it bounds what any
scenario can prove about station-side behaviour:

- `ScenarioRunner` registers exactly one handler
  (`BootNotificationHandler(false)`, purely to capture the sessionKey), because
  the scenario is expected to script every outbound message. No other handler
  runs in scenario mode — so **no scenario exercises any handler's payload
  construction.**
- `WaitForStep` observes `station.router`, which carries **inbound** messages
  only. A station's own sends go `MessageSender.send()` → `connection.publish()`
  and never reach the router.
- `AssertStep` reads `context.receivedMessages` (or `connection.*`), so it
  cannot target an outbound payload either.

Consequence: a scenario can prove the server *accepts* a given payload, but
never that the station *produces* it. Station-side payload correctness is
provable only by offline tests against the real handler — e.g.
`src/__tests__/handlers/TriggerMessageHandler.bootTruthful.test.ts`.

Closing this would mean registering handlers in scenario mode (a change to its
contract) **and** adding an outbound-assertion step type. Out of proportion to
this repair, and the offline test covers the same wire bytes. Recorded, not
built.
