# Traversal captures — material for the integrator guide

> **STILL CURRENT AS A RECORD OF UAT, 2026-09-07 — and one stage has since been
> re-measured elsewhere.** Dead end #2 (the boot command that arrives before the key)
> was repaired on 2026-09-08 and re-captured against the **local** stack, because the
> instruction that cycle was not to deploy and UAT still runs the old image. Nothing
> below is edited or withdrawn: it is what UAT did, and what UAT still does. See
> [`RERUN-2026-09-08.md`](RERUN-2026-09-08.md) for the before/after pair and for what
> the re-run found that the repair had missed.


One pass through the whole flow against **UAT**, on **2026-09-07**, recording what
actually crossed the wire. Nothing here is written from code or from the spec: every
frame and every HTTP exchange in this directory was captured live. Where I read code
or the spec, it is called out as such and is never the evidence for a claim about
behaviour.

This directory is **material, not documentation.** It deliberately does not explain
the protocol.

## Contents

| file | what |
|---|---|
| `WIRE-FRAMES.md` | Every MQTT packet, both directions, in order, verbatim |
| `wire/*.ndjson` | The same, raw, one JSON record per packet |
| `rest/*.txt` | 45 HTTP request/response pairs, verbatim with headers |
| this file | Stage-by-stage index, the boundaries, and the dead ends |

Station used: `stn_128b63f1`, provisioned for this run and **deleted afterwards**
(see *Teardown*).

## Instruments, and their controls

Two instruments were set up. **One of them failed, and I only know that because I
checked it against the other.**

| instrument | what it captures | control | verdict |
|---|---|---|---|
| `scripts/traversal-capture.ts` (added by this run) | mqtt.js `packetsend`/`packetreceive` — raw MQTT packets incl. all v5 properties | first connect produced CONNACK/SUBSCRIBE/SUBACK, then a full boot exchange | **works**, with one blind spot below |
| EMQX server-side `emqx ctl trace start topic 'ospp/v1/stations/#' … json` | broker's view of the same traffic | **none taken before use** | **BLIND — produced no file at all** |

The EMQX trace was armed at 13:06, stayed listed as active (`Trace(topic=ospp/v1/stations/#,
level=debug, destination="/opt/emqx/data/trace/wire.log")`) for the whole run, and
`/opt/emqx/data/trace/` **never contained `wire.log`** — across ~140 frames that matched
its filter. I did not positive-control it before trusting it; I deferred the control to
"the first real connect", and the first real connect produced nothing. So there is **no
server-side capture in this directory**, and the failure is reported rather than hidden.
The trace was stopped again at the end.

### The client-side blind spot (matters when reading the frames)

The tap attaches to the mqtt.js client object that exists at `connect()` time. At
`#141` the station sent a `DISCONNECT` ~100 ms after `CertificateInstall`, then
reconnected on a **new client object the tap was not attached to**. The server logged
`station_booted` at 13:27:02; **my capture shows nothing for it.** The `-reboot.ndjson`
file is a fresh process started afterwards to capture that second boot properly.

So: the capture is complete from 13:16:56 to **13:27:00.985**, blind from there to
13:31:32, and complete again after. Two independent instruments (the `stations` /
`station_journal` tables) were used to establish that a boot happened in the gap.

## The stages, in order

Frames are cited by `#seq` into `WIRE-FRAMES.md`.

| # | stage | how it happened | evidence |
|---|---|---|---|
| 1 | pre-provisioning | 6 REST calls, no wire traffic | `rest/01`–`rest/07` |
| 2 | provisioning | 1 unauthenticated REST call carrying a CSR | `rest/08-provision.txt` |
| 3 | boot | mTLS CONNECT → SUBSCRIBE → `BootNotification` | `#4`–`#18` |
| 4 | heartbeat & status | implicit, 30 s, armed from the boot response | `#19` onward |
| 5 | catalog & pricing | 3 REST calls, then `UpdateServiceCatalog` on the wire | `rest/12`–`rest/14`, `#48`–`#49` |
| 6 | session | REST start → `StartService`; `MeterValues`; REST stop → `StopService` | `rest/20`, `rest/21`, `#71`–`#94` |
| 7 | offline | pass minted over REST; authorization **refused** | `rest/34`, `rest/36` |
| 8 | firmware | **not traversable** (see below) | `rest/22`, `rest/24` |
| 9 | certificates | renewal ran fully on the wire; revocation **not traversable** | `#129`–`#141`, `rest/27`, `rest/28` |
| 10 | errors & refusals | collected throughout | see *Error shapes* |

## The boundaries — what each stage produces, what the next needs, who connects them

This is the part that matters more than the frames.

| boundary | produced by | required by | who connects them |
|---|---|---|---|
| `organization` id | `POST /organizations` (platform_admin) | every tenant route, as `X-Organization-Id` | the caller, by hand |
| `tenant_owner` JWT | `POST /auth/login` as the owner | station registration, token minting | **the owner must be `POST /auth/register`-ed FIRST**; an org created for a non-existent owner_email yields an account that cannot log in |
| `provisioningToken` (`rawToken`) | `POST /admin/stations/{id}/provisioning-tokens` | `POST /stations/provision` | **returned exactly once, never again**; 24 h TTL |
| TLS keypair + CSR | the station, locally | `POST /stations/provision` | the station. Keys must be **flushed to disk before the POST** — the token is single-use, so a crash between POST and write leaves a cert bound to keys nobody holds |
| `clientCert` + `stationCaChain` | `POST /stations/provision` | the MQTT CONNECT | the station writes them; **the leaf must be presented leaf-first concatenated with the chain** |
| `bayId[]` | `POST /stations/provision` (server-assigned, opaque `bay_`+32 hex) | `StatusNotification`, `StartService`, `POST /sessions/start` | **NOBODY — see dead end #1** |
| `sessionKey` | `BootNotification` **Response** | the MAC on every subsequent message | **races the first command — see dead end #2** |
| `heartbeatIntervalSec` | `BootNotification` Response | the heartbeat timer | armed implicitly by the station; no separate signal |
| `serviceId` | `POST /admin/stations/{id}/services` | `POST /sessions/start`, catalog publish | the caller. Enum values (`UserDuration`/`FixedDuration`/`MultiUnit`, `PerMinute`/`Fixed`) are **not named by the 422** — I had to read them out of Postgres |
| service↔bay binding | `POST /admin/stations/{id}/services/{ssid}/binding` | `StartService.programNumber` | the caller, supplying `programNumber` (undocumented in the first 422, which asks only for `bayId`) |
| wallet credits | **nothing reachable — see dead end #3** | `POST /sessions/start` | nobody |
| `users.offline_enabled` | `PUT /api/v1/offline/preference` (the customer's own call) | `POST /admin/offline-passes` | the customer. *(The repo runbook says this needs raw SQL — **that is stale**, the route works.)* |
| `offline_mode_supported` | the station's **BootNotification capabilities** | `POST /sessions/offline-auth` | the station's firmware only. **No admin route can set it** — `PATCH /admin/stations/{id}/offline` writes `offline_enabled`, a different column |
| `appNonce` for offline auth | a **BLE `Hello` exchange** between phone and station | `POST /sessions/offline-auth` | out of band, off-protocol. The 422 names it: *"equal to the Hello appNonce"* |
| firmware `signature` | **nothing in the system** | `POST /admin/stations/{id}/firmware` | nobody — see *Not traversable* |
| new certificate | `CertificateInstall` command (not the `SignCertificate` Response) | the next TLS CONNECT | the station writes it and **immediately disconnects to reconnect** (`#141`) |

## Dead ends

Four, of the shape you named — stage N produces something stage N+1 needs, and the
answer to *who hands it over* is "nobody".

### 1. Bay ids: provisioning assigns them, `simulator connect` invents different ones

Provisioning returned `bay_dad554b98823f7f82ece181e0105a6ba` / `bay_70ecda0b84fb2b558526a68afc5b066d`.
`deriveBays()` (`src/cli/connectBays.ts:18`) computes `bay_<stationHex><NN>` — for this
station `bay_128b63f101` / `bay_128b63f102`. **The two never match**, and `connect` mode
uses the derived ones, which the server never issued. The `--var bayId_<N>=` flag exists
purely so an operator can paste the real ids in by hand. That hand-copy is a precondition,
not a convenience. My capture script reads `<stationId>-bays.json` instead; the
`meta bay-ids` record at the top of each capture file records `"match": false`.

### 2. The first command after boot cannot be verified, by construction

At every boot the server pushes `ChangeConfiguration {RevocationEpoch}`. It carries a
`mac`. The MAC is verified with the `sessionKey` that arrives in the `BootNotification`
**Response** — and the `ChangeConfiguration` **arrives first**:

* run 1: `ChangeConfiguration` `13:17:21.945` received at `#11`, Boot Response at `#13`
* run 2: `ChangeConfiguration` `13:31:42.076` at `#10`, Boot Response `13:31:42.100` at `#12`

The station refuses it, in its own words:

```
[MessageRouter] REFUSED ChangeConfiguration on ospp/v1/stations/stn_128b63f1/to-station:
no session key held, so it cannot be verified (1013 MAC_MISSING)
```

and publishes **no error response** — the command simply dies. Server-side it sat at
`status='pending'` until it expired.

Measured over the whole deployment (after my own rows were removed):

* `ChangeConfiguration`: **617 expired / 641 total = 96.3 %**
* every one of the 641 was sent **within 5 s of a `station_booted`** (641/641) — it is
  exclusively a boot-time push
* all commands, all actions: **960 expired / 1697 = 56.6 %**

Reproduced twice, deterministically, in this run.

### 3. Credits: a session needs them and nothing can mint them

`POST /sessions/start` refuses at zero balance with `402 / 4001 INSUFFICIENT_BALANCE`,
whose `recommendedAction` reads *"redirect to payment page. The user must purchase more
credits"*. Following that:

* `GET /api/v1/payments/packages` → `{"data": []}`
* `POST /api/v1/payments/start` → `422`, requires `package_id`
* `credit_packages` table: **0 rows**
* **no route creates a package** — `GET /api/v1/payments/packages` is the only packages route

So the documented recovery path terminates. The only way to fund a wallet is a direct
`INSERT` into `wallets`/`wallet_entries`, which is what this run did and what the pool
bootstrap does. Note also `GET /api/v1/wallet/balance` advertises `"can_go_negative": true`
while start refuses at 0 — the two disagree.

### 4. An online session charges credits that never move

The full happy path completed: `StartService` accepted, two `MeterValues`, `StopService`
answered with `actualDurationSeconds: 82, creditsCharged: 137`, session row `completed`
with `credits_charged = 137`. Then:

* wallet balance before: 1000 — **after: 1000**
* `wallet_entries` for that wallet: one row, my own out-of-band credit. **No debit.**
* `settlement_outbox` did get a `SessionCompleted` row (`refundAmount 63, creditsCharged 137`),
  `state = published`

Across the deployment:

* `payment_ledger`: **0 rows, database-wide**
* `wallet_entries` of type `debit`: **6**, and **all 6** carry `reference_type = 'offline_transaction'`
* completed sessions with `credits_charged > 0`: **36**, totalling **2606 credits**

**Not one debit in the database references a session.** The only path that ever moves
money is the offline one.

## Not traversable, and why

| stage | blocker |
|---|---|
| **firmware** | `POST /admin/stations/{id}/firmware` requires `firmwareUrl`, `firmwareVersion`, `checksum`, **`signature`**. Nothing in the system produces that signature, and the firmware catalogue (`GET /admin/device-management/firmware`) is empty with no route to sign or upload. Not attempted further. |
| **certificate revocation** | `POST /admin/stations/{id}/revoke-certificate` needs `certificates.revoke`; `install-certificate` and `trigger-cert-renewal` need `platform.certificates.manage`. Per `routes/api/v1/admin.php:20-27` these are *"granted only to platform_super_admin"*. There is **1** such user on UAT and I do not have its password. I did not reset it — that would change UAT auth state. Revocation *does* work: the served CRL carries 2 revoked serials (`012C`, `012D`). |
| **offline authorization** | Refused `403 / 2008` — *"Station does not support offline operation"*. My boot declared `offlineModeSupported: false`, which is hardcoded in `src/station/Station.ts:675` behind a comment warning that flipping it requires deriving `pendingOfflineTransactions` too. I did not change simulator behaviour. The pass minting half **was** captured (`rest/34`). |
| **the reconnect at 13:27:02** | instrument blind spot, above. |

## Surprises worth carrying into the guide

Things that would surprise a reader, recorded because they surprised me.

1. **The station ignores its own provisioning directive on two fields.** Provisioning
   returned `mqttConfig.cleanStart: false` and `tlsVersion: "1.2"`; the broker's own
   client table shows station sessions as `clean_start=true`, and
   `MqttConnection.ts:481` sets `minVersion = tlsConfig.minVersion ?? 'TLSv1.3'`.
   Both still connect, because the broker accepts 1.2 and 1.3 and does not enforce
   `cleanStart` — but a station built to the provisioning response would behave
   differently from this one.
2. **`peer_cert_as_clientid = "cn"`** — the broker *overwrites* whatever client id the
   station sends with the certificate CN. Two consequences: the simulator's
   `stationId-<uuid>` anti-collision client id is silently discarded, and a second
   connection under the same cert is a **session takeover** that kicks the first. The
   listener has counted `discarded: 478` and `takenover: 43`.
3. **The `sim-`/`SIM-` ACL rules are unreachable.** They key on `${clientid}` (unvalidated)
   rather than `${cert_common_name}` — but since the broker derives the client id from the
   CN, no client can ever present a `sim-*` id unless its cert says so.
4. **MQTT `correlationData` carries the originating HTTP request id.** On `#48` it decodes
   to `01a07c07-0674-732b-a118-ba745528361d`, byte-for-byte the `x-request-id` of the REST
   call that triggered it. The station's Response does **not** echo it back.
5. **There are no MQTT v5 *user* properties anywhere.** All semantics live in the JSON
   envelope. The only MQTT properties in play are `messageExpiryInterval` (10 s on
   `StartService`, 30 s on `UpdateServiceCatalog`, 60 s on `ChangeConfiguration`),
   `correlationData`, the CONNECT set, and `sessionExpiryInterval: 0` on DISCONNECT.
6. **`sessionExpiryInterval: 0` on a clean DISCONNECT suppresses the will.** 35 s after
   my station left cleanly, `stations.is_online` was still `true`. There is no "goodbye"
   message in the protocol; the server only learns via LWT or heartbeat timeout.
7. **73.6 % of all boots are logged as hardware swaps** (897 `serial_changed` / 1218
   `station_booted`). The serial sent at provisioning and the serial reported at
   `BootNotification` are generated independently and differ, so the first boot after
   provisioning always trips it. The journal reason states the consequence: *"its pending
   offline transactions are held for manual review."*
8. **An idempotent status report is an error.** Re-reporting `Available` for an already-
   available bay logs `invalid_transition: available -> available`. 284 in the journal.
9. **The same identity is authorized or not depending on an unrelated header.**
   `POST /admin/stations/{id}/trigger-cert-renewal` as platform_admin:
   **403** with `X-Organization-Id` present, **422** (i.e. past authorization) without it.
10. **`liquidMl` on the wire is stored as `water_ml`**; `chemical_ml` exists in the table
    and no wire field feeds it.
11. **Start waits, stop does not.** `POST /sessions/start` returned `status: "active"`
    after the station's `Accepted` (station replied `.034`, response serialized `.149`).
    `POST /sessions/{id}/stop` returns `status: "stopping"` immediately.
12. **Certificate renewal does not retire the old certificate.** After renewal both serials
    (`956`, `957`) were `status='active'`, neither revoked. The station did write the new
    leaf to disk, then disconnected within 100 ms to reconnect with it.
13. **Teardown has no REST path.** `DELETE /api/v1/organizations/{id}` is **403 for both**
    platform_admin and tenant_owner. Cleanup is FK-ordered SQL.
14. **`OSPP_SUPPORTED_PROTOCOL_VERSIONS` is not set** in the deployed app environment, so
    the accepted set collapses to the single value of `OSPP_PROTOCOL_VERSION` (`0.3.0`).
15. **JWTs last 900 s.** A traversal longer than 15 minutes must re-login mid-flow.

### Error shapes — eight of them, on one API

Counted across the 45 captures; every one appeared in this single run.

| shape | example |
|---|---|
| `{error, message}` | `rest/00-login.txt` — `invalid_credentials` |
| `{message, errors:{field:[…]}}` (Laravel) | `rest/10-create-service-probe.txt` |
| `{errorCode, errorText, errorDescription, severity, recoverable, recommendedAction, timestamp, details}` | `rest/17-session-start-probe.txt` |
| same, without `details` | `rest/18-session-start.txt` — `4001` |
| `{message}` — *"User does not have the right permissions."* (Spatie) | `rest/23-install-cert-probe.txt` |
| `{message}` — *"This action is unauthorized."* (policy) | `rest/41-delete-organization.txt` |
| `{error, ospp_code, message}` | `rest/32-admin-offline-pass.txt` |
| `{error:{code, ospp_code, message}, meta:{timestamp}}` | `rest/36-offline-auth.txt` |

Success bodies are not uniform either: `{data:{…}}`, `{data:{organization:{type,id,attributes}}}`,
`{success, binding}`, and the **flat, unwrapped** provisioning body all appear. Field casing
flips between neighbours — `/sessions/start` takes `bay_id`/`service_id`/`duration_seconds`
while its sibling `/sessions/offline-auth` takes `bayId`/`serviceId`/`requestedDurationSeconds`.
`POST /locations` accepts `latitude` as a number and returns it as the **string** `"44.4268"`.

## Secrets

Redacted, and verified absent from every published file by searching for the literal
values: the platform-admin password, the created owner's password, the `rawToken`
(single-use provisioning token), the `sessionKey` from both boot responses, and all JWTs.
No private key material is present — the CSR is, the keys are not. MACs are left intact:
they are message authentication codes over redacted-key material, not credentials.

## Teardown

UAT was left clean, and it was **checked on data, not assumed**:

* removed this run's org, location, station, 2 certificates, provisioning token, service,
  binding, session, 2 meter values, offline pass, owner user + wallet
* also removed a pre-existing **orphan**: station `stn_ff53a94b` with org `Sim Pool 946fc785`,
  its location and 6 users, left behind by an interrupted pool bootstrap at 11:58 the same day
* verification query returned **0** for all eight residue classes; totals went
  stations 21→20, users 31→25, locations 14→13
* the EMQX topic trace was stopped (`Trace is empty`)
* local key material for the deleted station was removed from `certs/uat/` (50 files
  before, 50 after)
* host disk unchanged at **84 %** (16 G free) — it was 84 % at start, not the 97 % feared

## Reproducing

```bash
set -a; source ~/.config/osp-e2e-secrets.env; set +a
export OSPP_PROTOCOL_VERSION=0.3.0 UAT_EMAIL=x UAT_PASSWORD=x
npx tsx scripts/traversal-capture.ts --station stn_xxxxxxxx --target uat \
  --out docs/traversal-captures/wire/stn_xxxxxxxx.ndjson --ctl /tmp/ctl
# then drive it: echo 'boot' >> /tmp/ctl ; echo 'note ...' >> /tmp/ctl
#                echo 'send MeterValues Event {...}' >> /tmp/ctl ; echo 'quit' >> /tmp/ctl
```

The repo `.env`'s `UAT_EMAIL`/`UAT_PASSWORD` are **stale** (401) — they are only needed to
satisfy `resolveEnvVarsDeep`, so any non-empty value works; the identity that matters is
the platform-admin pair from `~/.config/osp-e2e-secrets.env`.
