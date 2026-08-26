# MEASURED — refusal defects in `csms-server`, from the station's side of the wire

**Read-only, 2026-08-26.** Measured while writing the first refusal scenarios for the entry
path (provisioning / boot / SignCertificate / message layer). Every line reference below was
opened and read in `csms-server` at **`c5878a3d`**; nothing in that repo was modified.

**Who this is for.** A session working in `csms-server`. Each finding names the file:line, what
is there today, what an integrator observes, and what the decision actually is — because three
of the five are **deliberate**, with the rationale written in the code, and the thing to decide
is not "is this a bug" but "who pays for it". Findings 4 and 5 are not: they are plain defects.

**READ IN THE ORDER PRINTED; THE NUMBERS ARE IDENTIFIERS, NOT RANKING.** Finding 5 is first
because it is the cheapest to fix — one `->orderBy` — and because it is the only one that makes
the prose a HUMAN reads vary between runs of the same code on the same input. It is also the
only one of the five not found by reading: a scenario went red on it. The numbers were assigned
when the file was written and are left alone, so the commit that introduced it — which says
"the silent one is first", true of the order it shipped in — stays reconcilable with this file.

**Why they are grouped.** All four share one consequence: **a firmware author who makes a
mistake cannot tell from the wire what he did wrong.** Individually each is defensible.
Together they are the reason an integration week becomes an integration month.

---

## 5. `4015`'s `driftedKeyKinds` has no stable order, and its prose interpolates it

**Where.** `app/Shared/Crypto/CertificateManager.php:1290-1294`:
```php
foreach (array_unique([...array_keys($bound), ...array_keys($presented)]) as $kind) {
    if (($bound[$kind] ?? null) !== ($presented[$kind] ?? null)) { $drifted[] = $kind; }
}
```
`$bound` comes from `DB::table('provisioning_bound_keys')->…->pluck('spki_der_b64', 'key_kind')`
(`:1238-1241`) with **no `ORDER BY`**, so the list's order is whatever Postgres returns for
those rows.

**How it was found.** Not by reading — by a scenario going red on it. A retry with both keys
regenerated asserted `details.driftedKeyKinds: ["tls","receipt"]` and the server answered
`["receipt","tls"]`. Everything else in that response was exactly right: `409`, `4015`,
`PROVISIONING_KEY_MISMATCH`, `details.reason: "key_drift"`.

**Why it reaches the integrator.** `errorDescription` interpolates the same list — the
measured body reads *"bound to a different public key for: receipt, tls"* — so the prose a
human reads and the array a machine matches on both vary between runs of the same code
against the same input. `4015` is `recoverable: false`, which means this is the message a
firmware author reads at the one moment the spec tells him to stop retrying and call an
operator.

**Cost of the fix.** One `->orderBy('key_kind')`, or sorting `$drifted` before it is thrown.
Whether the ORDER is part of the contract is a spec question; whether it should be
*deterministic* is not.

**What the scenario does meanwhile.** `provision-rejected-key-and-topology-rungs.yaml` pins
`errorCode`, `errorText`, `details.reason` and `recoverable`, and deliberately does NOT pin
the list — with a comment saying why, so it is not "strengthened" back into a flake.

---

## 1. A bad or missing MAC is answered with NOTHING — and it is the expensive one

**Where.** `app/Shared/Protocol/MessageDispatcher.php:162-186`. The verification runs at `:162`;
on failure a REQUEST or RESPONSE takes `return null` at `:185`. The three refusal reasons —
`MAC_MISSING`, `SESSION_KEY_UNAVAILABLE`, `MAC_VERIFICATION_FAILED` — are recorded at
`app/Shared/Protocol/Middleware/VerifyIncomingMiddleware.php:69`, `:82`, `:116`.

**What reaches the station.** Nothing. No error frame, no disconnect, no code. `OsppErrorCode`
is never even constructed on this path — the three reasons are strings for a metric and an
event. The station observes only that its REQUEST is never answered.

**Scope.** Every action except the three structural signing exemptions
(`BootNotification:Request`, `BootNotification:Response`, `ConnectionLost:Event` —
`vendor/ospp/protocol/src/Crypto/MessageSigningRegistry.php:44-48`), whenever the effective
`SigningMode` is not `None`.

**THE DECISION IS ALREADY DOCUMENTED, AND IT IS NOT AN OVERSIGHT.** The comment at `:171-178`
gives the reason: a critical EVENT is failed CLOSED into the DLQ because dropping it would be
silent loss of a billing event, while "a critical REQUEST/RESPONSE stays a benign drop (the
station retries / the command times out) so a sustained bad-MAC flood cannot fill the DLQ with
non-billable noise."

That reasoning is about the SERVER's exposure. It is silent on the STATION's: a station whose
key derivation, canonicalisation or byte order is wrong retries forever and is told nothing.
"The station retries" is true and is exactly the failure mode — it retries a message that can
never be accepted, and the retry looks identical to a network problem.

**What to decide.** Not "publish an error" — that has its own cost, and finding 2 explains why
a generic error frame is currently unshippable. The question is whether there is ANY channel
that reaches the integrator: a `SecurityEvent` back-channel, a counter exposed per station, or
a documented statement that silence on a critical action means MAC. Today the only observable
is a Prometheus series with no station dimension.

**Proof on the wire exists**: `scenarios/security/mac-missing-drops-request.yaml` and
`mac-verification-failed-drops-request.yaml` both assert the silence with a clean control.

---

## 2. `1006 UNKNOWN_ACTION` is computed, logged, and can never reach the wire

**Where.** `app/Shared/Protocol/MessageDispatcher.php:328-368`. The code is built at `:336-339`;
`buildRejectionPayload()` is asked for a shape at `:342`; when it answers `null` the branch logs
"no schema-valid rejection shape, dropping" at `:350-355` and returns `null`.

**Why it can never fire.** `buildRejectionPayload()` (`:415-432`) is a five-arm match on the
ACTION: `BootNotification`, `DataTransfer`, `SignCertificate`, `TransactionEvent`,
`AuthorizeOfflinePass`; `default => null`. All five already have registered handlers
(`OfflineServiceProvider.php:131-132`, `DeviceManagementServiceProvider.php:78,86`,
`StationServiceProvider.php:57`), so an action that is genuinely unknown can only ever land on
`default`. **The one code whose entire purpose is to answer an unrecognised action is
structurally unreachable.**

**Again the rationale is in the code and it is sound** (`:344-349`): a generic `{error: …}`
payload would violate `additionalProperties: false` on every response schema and "would be
dropped by a conformant station anyway", so the server logs rather than ships a
schema-violating frame.

**Which makes this a SPEC gap, not a server bug.** There is no action-agnostic error frame in
the protocol. Until one exists, `1006` is a code the registry defines and the wire cannot
carry. **Recommendation: raise it in `ospp/spec` as a missing envelope-level error response,
and until then mark `1006` in the registry as not-emittable rather than leaving code that reads
as if it sends.**

---

## 3. `3005 BAY_NOT_FOUND` — the server's most-emitted code, and most of it is dead or mislabelled

`grep -rn "BAY_NOT_FOUND" app/` gives **15 emission sites** (plus one comment at
`SetMaintenanceModeAction.php:85` and three catalog-only entries in `ErrorCodeRegistry.php`).
Three separate problems live in that set.

### 3a. Seven sites mean "STATION not found" while carrying the BAY code

```
app/Modules/DeviceManagement/Actions/TriggerCertificateRenewalAction.php:39
app/Modules/DeviceManagement/Actions/TriggerMessageAction.php:37
app/Modules/DeviceManagement/Actions/InstallCertificateAction.php:37
app/Modules/DeviceManagement/Actions/SetMaintenanceModeAction.php:39
app/Modules/DeviceManagement/Actions/ResetStationAction.php:40
app/Modules/DeviceManagement/Actions/SendDataTransferAction.php:37
app/Modules/DeviceManagement/Actions/UpdateServiceCatalogAction.php:236
```

Each throws `BAY_NOT_FOUND` with the message `"Station {$stationId} not found"`. A reader who
looks the code up reads "bay" and goes looking at bays.

### 3b. And all seven are UNREACHABLE — every caller resolves the station first

Every HTTP entry point hand-rolls its own station lookup and returns a **404 with no `ospp_code`
at all** before the action runs:

```
app/Http/Controllers/Api/V1/Admin/StationManagementController.php:277-288
    findStationByOsppIdOrFail() -> {"message":"Station not found","station_id":…}, 404
app/Http/Controllers/Api/V1/Testing/TriggerCommandController.php:47-53      (same body)
app/Http/Controllers/Api/V1/Admin/StationServiceCatalogController.php:66-68, 95-97, 198-200
app/Http/Controllers/Api/V1/Dashboard/DashboardStationController.php:184     firstOrFail()
```

So the branch carrying the wrong noun is dead, **and what a caller actually receives for an
unknown station is a code-less 404** — on a surface where every other refusal carries
`error.ospp_code`. Counted exactly: **five hand-rolled copies of the same code-less 404 body
across three controllers** (`StationManagementController:281-284`,
`TriggerCommandController:49-52`, `StationServiceCatalogController:68`, `:97`, `:200`), plus a
bare `firstOrFail()` in a fourth (`DashboardStationController:184`) that yields Laravel's own
404. None of the six goes through `OsppException`, which is the only path that attaches a
code (`bootstrap/app.php:254-269`).

### 3c. One site has no caller at all

`app/Modules/Payment/Actions/GenerateQrCodeAction.php:52`.
`grep -rn 'GenerateQrCodeAction' app/ routes/` returns only the class declaration.

### What is left, and it is now covered

The sites that genuinely mean "bay": `SessionController.php:54`, `ReserveBayAction.php:39`,
`StartSessionAction.php:63`, `StopSessionAction.php:80`, `SessionCommandAdapter.php:54`,
`AuthorizeOfflineSessionAction.php:105`, `SetMaintenanceModeAction.php:90`.
`scenarios/sessions/session-rejected-bay-not-found.yaml` now proves the first of them
(404 + `error.ospp_code: 3005` + `error.code: BAY_NOT_FOUND`) with a positive control.

**What to decide.** Three separable repairs: give the station-lookup failures their own code
(`2001 STATION_NOT_REGISTERED` is the obvious candidate) or delete the dead branches; route the
four hand-rolled 404s through `OsppException` so they carry a code; and delete
`GenerateQrCodeAction` or wire it.

---

## 4. A malformed `messageId` breaks the correlation of its own refusal

**Where.** `app/Shared/Protocol/MessageDispatcher.php:544-552`. When a message-layer refusal is
turned into a Response, the original `messageId` is echoed only if it parses; on
`InvalidArgumentException` the builder falls through to an **auto-generated** id.

**What the station observes.** It sent a Request with a `messageId` the server rejected
(`MessageFactory.php:108-115` — empty, or over 64 characters), and the refusal comes back
carrying a **different** id. A station correlating replies to requests by id — which is the
contract — cannot match it, so the refusal is indistinguishable from silence and the original
request times out.

**Why this one is the least defensible of the four.** The other three have a rationale written
beside them. This one has a bare comment, `// Invalid messageId format — use auto-generated
one`, and the alternative is available: the raw string is in hand, and echoing it verbatim in
the refusal is what lets the station learn WHICH message was bad. Generating a fresh id makes
the answer unattributable — the server tells the station something, on a channel the station
cannot connect to anything.

**Note the asymmetry it creates.** For every OTHER message-layer refusal the correlation holds
and `security/sign-certificate-empty-csr-rejected-correlated.yaml` proves it. This is the one
input for which the guarantee quietly does not apply, and it is the input a firmware bug in
id generation produces.

---

# PART TWO — the operating phase: refusals that ARRIVE but cannot be told apart

Added 2026-08-26 while scoping the second group of scenarios (state, heartbeat, catalog,
commands, sessions). Findings 1-5 above are about refusals that never reach the station.
These are the opposite failure: the answer arrives, carries a code, and still does not
identify which of several conditions produced it. Every one was measured by reading the
files in full; counts are from exhaustive enumeration, not sampling.

## 6. `3002 BAY_NOT_READY` — three different bay states produce a BYTE-IDENTICAL body

`SessionStateMachine::validateBayForStart()` maps `FINISHING`, `FAULTED` and `UNKNOWN` all to
`BayValidationResult::rejected(3002, 'BAY_NOT_READY')` (lines 77, 78, 80). The DTO carries no
per-branch text, so all three answer the same `ospp_code`, the same HTTP 409, `error.code`
`BAY_NOT_READY`, `error.message` the literal string **`"BAY_NOT_READY"`**, and no `details`
object at all.

"The bay is finishing the previous wash", "the bay is broken" and "the bay has never reported
since boot" are three different operator actions, and the response cannot distinguish them.
This is the sharpest collision in the taxonomy: the others below at least differ by prose.
`ReservationTransitions::validateBayForReservation()` has the identical three-way collapse on
the reservation door.

**Cost of the fix.** A `details.reason` naming the bay status, on the one `rejected()` call.

## 7. `StopSessionAction`'s five refusals are ALL unreachable from `POST /sessions/{id}/stop`

Enumerated per caller, not assumed. `SessionController::stop()` (`:117-141`) re-implements the
first three checks before calling the action, so `SESSION_NOT_FOUND` (`:36`),
`SESSION_GENERIC`/not-active (`:40`) and the ownership check (`:48`) are all shadowed. The
remaining two are dead by construction: `:61` needs `ACTIVE → STOPPING` to be an invalid
transition, which the vendor table always allows, and `:79` needs an orphaned bay FK.

**And "you do not own this session" is implemented twice, with different codes.** The live one
is the controller's `SESSION_MISMATCH` 3007 / **403** (`:128-132`). The dead one is the
action's `ACTION_NOT_PERMITTED` 2008 / **401** (`:48-51`). A client — or a test — written
against the action would learn the wrong code and the wrong status for what actually appears
on the wire.

Sibling of the same shape in `CancelReservationAction`: three of its four refusal sites are
dead behind its controllers, and the only live one is reachable through just one of its two
REST callers.

## 8. `3000 SESSION_GENERIC` is five conditions, and its HTTP status is not consistent

Five sites: `StopSessionAction:40`, `:61`, `SessionController:89` ("Station rejected: …"),
`:95` ("Session failed: …"), `:136` ("cannot be stopped in current state"). None carries
`details`. The status depends on which builder emitted it — `ErrorCodeRegistry` resolves
`SESSION_GENERIC` to **500** (it has no arm in the vendor `httpStatus()` and falls to the
default), while `SessionController::errorResponse()` passes a hard-coded **422** or **409**.
So the same `ospp_code` reaches the client as three different HTTP statuses depending on the
path, and a client branching on status alone gets a different answer per condition while one
branching on the code gets none.

`SessionController::errorResponse()` (`:248-260`) also **structurally cannot emit `details`** —
its signature has no parameter for it. Across the four session files there are 37 refusal
sites and exactly ONE carries `details`: `SERVICE_NOT_BOUND` (`StartSessionAction:315`).

## 9. The capability guard is copied seven times and the seven are indistinguishable

`grep -rn 'device_management_not_declared' app/` gives seven sites — `ReadConfiguration:56`,
`WriteConfiguration:87`, `ResetStation:69`, `SetMaintenanceMode:59`, `RequestDiagnostics:71`,
`UpdateServiceCatalog:257`, `InitiateFirmwareUpdate:97` — with no shared trait or base class.
All seven answer the identical `(6008, details.wouldBe 2007, details.reason
device_management_not_declared)`, and six of the seven carry byte-identical `message` text
(only `RequestDiagnostics` differs, by appending the stationId). `OsppError::toArray()` has no
action or command field, so **nothing in the body says which of the seven commands was
refused** — that fact exists only in which endpoint was called.

**And the check immediately above it disagrees with itself across the same seven files.** For
the identical "station row not found" condition, `SetMaintenanceMode` / `UpdateServiceCatalog`
/ `ResetStation` throw `BAY_NOT_FOUND` 3005 → 404, while `ReadConfiguration` /
`WriteConfiguration` / `RequestDiagnostics` / `InitiateFirmwareUpdate` throw
`STATION_NOT_REGISTERED` 2001 → 422. Same condition, two codes, two statuses, seven adjacent
files. (Both are also unreachable — see finding 3's pattern: every controller resolves the
station and 404s first.)

## 10. `ReserveBayAction` cannot distinguish "disconnected" from "disabled"

`:45-53` — two `OsppError::from()` calls with **no third argument**, so neither carries
`details`:
```php
if (! $station->is_online) { throw … STATION_OFFLINE, 'Station is offline'  … }
if (! $station->is_active) { throw … STATION_OFFLINE, 'Station is disabled' … }
```
Same code 6003, same HTTP 502; the only discriminator is the prose. `StartSessionAction:68`
and `:76` are the same pair on the session door, and there the source comment states it is
deliberate — "the disabled-vs-offline distinction is surfaced in the dashboard, not the
protocol reject". Recorded so the decision is visible rather than rediscovered: an operator
who disabled a station and an integrator whose link dropped get the same code.

## 11. Four refusals are dead behind a FormRequest or a duplicated controller check

Not defects on their own — listed because each is a branch that reads as live and is not, and
because three of them cost a scenario author an afternoon to discover.

| site | shadowed by |
|---|---|
| `StartSessionAction:63` `BAY_NOT_FOUND` | `SessionController:52-55`, identical lookup, runs first |
| `StartSessionAction:107` `DURATION_INVALID` | `StartSessionRequest` rule `min:60` |
| `StartSessionAction:145` `INVALID_SERVICE` | `SessionController:59` + the shared INNER JOIN |
| `ReserveBayAction:68-74` `DURATION_INVALID` | `CreateReservationRequest` rule `min:1,max:15` — bounds identical to the action's own |

`SessionStateMachine::validateBayForStop()` (3006) has **zero production callers** — its only
caller is its own unit test.

---

## Two things that are NOT findings, recorded so they are not re-litigated

**`2001` covers two different causes, deliberately.** `BootNotificationHandler.php:81-95`
(payload `stationId` ≠ authenticated topic) and `:158-164` (station has no row) answer the same
code, and the comment at `:88-93` gives the reason: answering "not registered" declines to tell
the caller whether the station it named exists — the same non-disclosure the spec applies to
`2019`. A scenario cannot discriminate them on the code and must not try; the control in
`scenarios/core/boot-rejected-station-id-spoof.yaml` attributes the refusal by changing exactly
one field instead.

**`4018 PROVISIONING_TOKEN_CONSUMED` is not constructible over HTTP.** A consumed token that
issued a certificate REPLAYS (200) rather than being refused; the `consumed_without_certificate`
arm needs a row inserted directly, and `already_consumed` needs a genuine concurrent race
(`ProvisioningController.php:125-151`, `ProvisioningTokenConsumer.php:87-102`, `:216-223`). This
is a testability limit, not a defect — recorded so the next person does not spend an afternoon
trying to reach it from a scenario.
