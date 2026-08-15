# MEASURED — a restricted (`Pending`) station's `SignCertificate` is accepted

**Date:** 2026-08-15, 04:48–04:49 UTC
**Target:** UAT, csms-server `99cab60`
**Simulator:** `79b1e50`, `@ospp/protocol ^0.19.0`, `.spec-ref v0.19.0`
**Result:** the server **accepts** it. 13/13 steps.

Answers the question left open at `csms-server/docs/ghid-firmware-ospp.md` §16: does the server
accept a `SignCertificate` [MSG-022] originated by a station in a restricted state? Spec `v0.19.0`
§1.4 makes this **MAY** in `Pending`; every earlier version forbade it.

**This is a procedure with an operator step, not a test.** It is written up here rather than added
to `scenarios/` for the reason in *Why this is not in the corpus* below — please read that section
before moving it.

---

## Why this measurement needed a method at all

Three things had to be solved before the wire could answer anything.

**1. The restricted state is not reachable the obvious way.** The server writes
`StationState::PENDING` from exactly one place — `BootNotificationHandler.php:306`, inside the
`config('ospp.enforce_boot_topology') === true` branch at `:302`. That flag is `false` on UAT
(**measured at runtime**, `artisan config:show ospp` — not read from `.env`) and `false` on
`master` (`config/ospp.php:74`). The spec's *other* entry into `Pending` — an outstanding operator
approval — **is not implemented on this server at all**. Turning the flag on is not an option: it
puts the entire fleet into `Pending` on next boot, because `bay_programs` is written only by
provisioning.

**The door: `station_state` is written by two lines and read by none.** `Station::transitionTo` has
exactly two callers (`:306` PENDING, `:326` OPERATIONAL) and the column appears nowhere else in
`app/`. So setting it by hand produces **the byte-identical server-side condition** `:306` would
have written — no flag, no code change, no fixture.

**2. A negative result would have been ambiguous.** A MAC-verification failure on an inbound
REQUEST is a **silent drop**: `MessageDispatcher.php:185` returns `null`, and nothing goes back on
the wire. So a bare timeout in the `Pending` arm could not distinguish *"a state gate refused it"*
from *"the session key went away"*. **The positive control is therefore mandatory, and it must run
on the same station and the same connection**, seconds before the test arm.

**3. The session key had to survive the window.** The server's sweep marks a station offline after
`3.5 × heartbeatIntervalSec` of application silence and **drops the session-key cache with it**.
UAT's interval is 30s ⇒ 105s. The scenario's 60s delay crosses enough of that window that
`start_heartbeat` is required, not decorative.

**Discriminating on the code, not just the status.** The CSR is deliberately a truncated PKCS#10:
it clears the wire schema (it matches `^-----BEGIN CERTIFICATE REQUEST-----`) and therefore
**reaches the handler**, which answers **`4010 CSR_INVALID`**. A schema-layer refusal would have
been `1005 INVALID_MESSAGE_FORMAT` instead. So asserting `4010` proves the message traversed
dispatcher → handler → `CertificateManager` — while minting no certificate, writing no
`certificates` row, and putting no serial on the served CRL.

---

## Result

| arm | `station_state` when handled | response | latency |
|---|---|---|---|
| **A — control** | `Operational` | `Rejected` / **`4010 CSR_INVALID`** | 139 ms |
| **B — test** | **`Pending`** | `Rejected` / **`4010 CSR_INVALID`** | **55 ms** |

Identical answers. **No hop on the signing path reads station state**: `MessageDispatcher.php:122`
is parse → MAC-verify → dedup → route, with `:328` a bare action-name array lookup;
`SignCertificateHandler` never loads a `Station`; `CertificateManager.php:832` queries only
`certificates`. The predicates that would implement §1.4 — `StationState::mayOriginate()`,
`Station::isRestricted()` / `mayReceiveCommands()` / `mayStartNewService()` — exist and have **zero
callers** outside tests.

So the server is conformant with `v0.19.0` §1.4 **by accident**: it never implemented the
prohibition the release removed, so it had nothing to take out.

### Three independent confirmations

```
scenario     13/13 steps passed, 61100ms
DB read-back 04:48:29  Pending      (after the flip)
DB read-back 04:49:15  Pending      (spanning arm B)
server log   04:49:12  SignCertificateHandler: CSR received   stn_1e2d601d
             04:49:12  CSR validation or signing failed — "CSR is malformed: failed to parse PKCS#10 structure"
```

The handler ran at **04:49:12**, between two read-backs that both said `Pending`. The read-back is
what makes the flip a measurement rather than an assumption.

---

## Why this is not in the corpus

**Both arms assert the same thing.** Against an `Operational` station — i.e. run by anyone who does
not perform the database write — **all 13 steps pass**. Dropped into `scenarios/security/`, a
pooled or `--all` run would report it **green while measuring nothing** about the restricted state.

That is a symmetric fake pass: the scenario cannot tell you it did not do its job. It is the same
class the corpus already guards against elsewhere — an instrument that runs on nothing and looks
clean. The corpus contract is *runnable unattended against a target*; this file is not, and
`skip: true` would only convert the problem into an unread sentence (see
`boot-pending-retry.yaml`'s history, and the audit note at the end of this document).

**If it is ever moved into `scenarios/`, the two arms must be made to assert different things**, so
that a missing flip fails rather than passes. There is no such assertion available today: the
server's answer is identical in both states, which is the finding.

---

## Reproducing it

### 1. The scenario

Save outside `scenarios/` (the runner takes any absolute path via `--scenario`).

```yaml
name: "SignCertificate from a restricted (Pending) station — server-side gate probe"
description: >
  ARM A is the positive control and is NOT optional: a MAC failure on an inbound REQUEST is a
  SILENT DROP (MessageDispatcher.php:185 returns null), so a bare timeout in ARM B would not
  distinguish "a state gate refused it" from "the session key went away".
  start_heartbeat is REQUIRED: the offline sweep drops the SESSION KEY CACHE after
  3.5 x heartbeatIntervalSec, and the delay below crosses that window.
  The CSR is deliberately malformed: it clears the wire schema, so it REACHES the handler, which
  answers 4010 CSR_INVALID. A schema-layer refusal would be 1005 instead. Mints no certificate.

scenario_timeout_ms: 240000

station:
  stationId: "{{stationId}}"
  bayCount: 2
  stationModel: "WashPro X200"
  stationVendor: "SimCorp"
  behavior:
    accept_rate: 1.0
    response_delay_ms: [50, 200]

steps:
  - action: send
    message: BootNotification
    payload:
      stationId: "{{stationId}}"
      firmwareVersion: "1.0.0"
      stationModel: "WashPro X200"
      stationVendor: "SimCorp"
      serialNumber: "{{serialNumber}}"
      bays:
        - bayNumber: 1
          programNumbers: [1]
        - bayNumber: 2
          programNumbers: [1]
      uptimeSeconds: 0
      pendingOfflineTransactions: 0
      timezone: "Europe/Bucharest"
      bootReason: "PowerOn"
      capabilities:
        bleSupported: false
        offlineModeSupported: false
        meterValuesSupported: true
      networkInfo:
        connectionType: "Ethernet"

  - action: wait_for
    message: BootNotification
    messageType: Response
    timeout_ms: 15000

  - action: assert
    field: "payload.status"
    equals: "Accepted"

  # Keeps the session key alive across the delay below.
  - action: start_heartbeat
    interval_sec: 20

  # ============ ARM A — control, station_state = 'Operational' ============
  - action: send
    message: SignCertificate
    messageType: Request
    payload:
      certificateType: "StationCertificate"
      csr: "-----BEGIN CERTIFICATE REQUEST-----\nMIIBIjCByAIBADBmMQswCQYDVQQGEwJVUzELMAkGA1UECAwCQ0ExFDASBgNVBAcM\nC0xvcyBBbmdlbGVzMRIwEAYDVQQKDAlBY21lQ29ycDEgMB4GA1UEAwwXc3RuX2Ex\nYjJjM2Q0LmV4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END CERTIFICATE REQUEST-----"

  - action: wait_for
    message: SignCertificate
    messageType: Response
    timeout_ms: 15000

  - action: assert
    field: "payload.status"
    equals: "Rejected"

  - action: assert
    field: "payload.errorCode"
    equals: 4010

  # ============ the window in which station_state is flipped to 'Pending' ============
  - action: delay
    ms: 60000

  # ============ ARM B — station_state = 'Pending' (restricted) ============
  - action: send
    message: SignCertificate
    messageType: Request
    payload:
      certificateType: "StationCertificate"
      csr: "-----BEGIN CERTIFICATE REQUEST-----\nMIIBIjCByAIBADBmMQswCQYDVQQGEwJVUzELMAkGA1UECAwCQ0ExFDASBgNVBAcM\nC0xvcyBBbmdlbGVzMRIwEAYDVQQKDAlBY21lQ29ycDEgMB4GA1UEAwwXc3RuX2Ex\nYjJjM2Q0LmV4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END CERTIFICATE REQUEST-----"

  - action: wait_for
    message: SignCertificate
    messageType: Response
    timeout_ms: 15000

  - action: assert
    field: "payload.status"
    equals: "Rejected"

  - action: assert
    field: "payload.errorCode"
    equals: 4010
```

### 2. The flip, which must run concurrently

It polls for the boot rather than sleeping a guessed interval, holds 15s so **arm A completes
against `Operational`**, then flips — and reads back on both sides of arm B.

```bash
#!/bin/bash
set -u
H=gabi@89.33.25.117
ssh_do() { SSH_AUTH_SOCK= ssh -i "$HOME/.ssh/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes "$H" "$@"; }
psql_q() { ssh_do "docker exec csms-postgres-uat psql -U csms_uat -d csms_uat -t -A -c \"$1\""; }
ts() { date -u '+%H:%M:%S'; }

echo "[$(ts)] waiting for the probe station to reach Operational..."
SID=""
for i in $(seq 1 120); do
  SID=$(psql_q "SELECT station_id FROM stations WHERE created_at > now() - interval '1 hour' AND station_state = 'Operational' LIMIT 1;" | tr -d '[:space:]')
  [ -n "$SID" ] && break
  sleep 3
done
[ -z "$SID" ] && { echo "FAIL: no new Operational station appeared"; exit 1; }
echo "[$(ts)] probe station = $SID"

# Let ARM A (the positive control) complete before changing anything.
sleep 15
psql_q "UPDATE stations SET station_state = 'Pending' WHERE station_id = '$SID';"
echo "[$(ts)] read-back after flip: $(psql_q "SELECT station_state FROM stations WHERE station_id = '$SID';" | tr -d '[:space:]')"

sleep 45   # ARM B fires at delay-end
echo "[$(ts)] read-back spanning ARM B: $(psql_q "SELECT station_state FROM stations WHERE station_id = '$SID';" | tr -d '[:space:]')"

sleep 20
psql_q "UPDATE stations SET station_state = 'Operational' WHERE station_id = '$SID';"
echo "[$(ts)] restored. STATION_ID=$SID"
```

### 3. Running both

```bash
set -a && . ~/.config/osp-e2e-secrets.env && set +a
SSH_AUTH_SOCK= UAT_SSH_KEY=$HOME/.ssh/id_ed25519 UAT_EMAIL=placeholder UAT_PASSWORD=placeholder \
  node dist/cli/index.js run --scenario /path/to/probe.yaml --target uat \
  --bootstrap-pool --pool-size 1 --pool-bays 2 --no-offline-enable --keep-pool &
bash /path/to/flip-state.sh
node dist/cli/index.js teardown-pool     # SSH_AUTH_SOCK= as always
```

`SSH_AUTH_SOCK=` is not optional — see the CSF ban note in `RUNNING-AGAINST-UAT.md`.

### 4. Leave it clean

Teardown removes the station, org, location, ephemeral owner and identities. Verify against the
baseline taken **before** bootstrapping; the run above returned UAT to exactly
**20 stations / 14 organizations / 19 certificates**, with the probe station gone. The flip script
restores `station_state` before teardown anyway, so an aborted run does not leave a station in a
state the server cannot itself produce.

---

## What this measurement walked past — reported in csms-server, not fixed

Both are in `csms-server/docs/KNOWN-ISSUES.md`.

- **The restricted state has no teeth.** `is_online = true` is written at
  `BootNotificationHandler.php:224`, *before* the branch that would make the station restricted, and
  the money gates key on `is_active`/`is_online`. `REJECTED` is never written at all. Latent today,
  and it arms on exactly the day someone flips `enforce_boot_topology`.
- **The server does not enforce the other half of §1.4 either** — a `Pending` station's `Heartbeat`
  or `StatusNotification` is processed normally. That half is a *station* obligation, so it is not a
  server defect; but it means **there is no server-side backstop for firmware conformance**, and a
  firmware test of the form "I sent it and it worked" proves nothing.
