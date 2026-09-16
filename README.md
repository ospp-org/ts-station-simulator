# OSPP Station Simulator

TypeScript CLI tool that simulates physical car wash self-service stations for testing CSMS (Central Station Management System) implementations of the [OSPP protocol](https://ospp-standard.org).

Replaces the PHP station simulator with native MQTT 5.0 concurrency — each simulated station runs on Node.js event loop, exactly like real hardware.

## Quick Start

```bash
npm install
npm run build

# Download sandbox mTLS certificates
npm run certs:sync

# Run a single scenario
npx simulator run --scenario scenarios/core/happy-boot.yaml --target sandbox

# Run a suite
npx simulator run --suite core --target sandbox

# Run all scenarios
npx simulator run --all --target sandbox
```

## Scenarios

157 YAML-driven test scenarios across 12 categories:

| Suite | Scenarios | Coverage |
|-------|-----------|----------|
| `core` | 16 | Boot (all reasons), Heartbeat, StatusNotification, ConnectionLost, DataTransfer |
| `sessions` | 13 | Full lifecycle, Start/Stop, Rejections, Timeout, Fault, MeterValues |
| `reservations` | 6 | Reserve+Start, Cancel, Expire, Rejections |
| `device-management` | 20 | Firmware, Diagnostics, Configuration, Reset, TriggerMessage, Maintenance |
| `security` | 18 | SecurityEvents, Certificates, OfflinePass, TransactionEvent |
| `chaos` | 7 | Disconnect, Slow responses, Malformed messages, Reconnect |
| `fleet` | 3 | Parallel boot, Mixed workload, Meter flood |

Full inventory: [scenarios/SCENARIOS.md](scenarios/SCENARIOS.md)

## Targets

Configured in `config/targets.yaml`:

| Target | Description |
|--------|-------------|
| `local` | **Cannot connect** — plaintext 1883 is `enabled = false` on the dev broker. Kept for a non-mTLS stack; use `local-mtls`. |
| `local-mtls` | The local dev stack over mTLS on 8883 — the working local target. See [`docs/RUNNING-AGAINST-LOCAL.md`](docs/RUNNING-AGAINST-LOCAL.md). |
| `local-crl` | A throwaway broker with `enable_crl_check` on, for the S7/S7b revocation proof only. |
| `uat` | UAT environment (mTLS) — see [`docs/RUNNING-AGAINST-UAT.md`](docs/RUNNING-AGAINST-UAT.md) |
| `sandbox` | OSPP conformance sandbox (mTLS + MQTT credentials) |

A local run hits **six** pre-existing blockers in a fixed order — disabled listener, a
deliberately-expired fixture cert, the `OSPP_PROTOCOL_VERSION` pin, an empty dev database, a
retired route, and a permission the pool identity does not hold.
[`docs/RUNNING-AGAINST-LOCAL.md`](docs/RUNNING-AGAINST-LOCAL.md) lists them with the fix for
each; reading it first saves rediscovering them one at a time.

Override via `--target` flag or `OSPP_TARGET` env var.

### Environment variables per target

Each target in `config/targets.yaml` can reference env vars with the
`${VAR_NAME}` syntax. Which vars a run actually needs is a property of the
COMMAND, not of the target:

| Target       | Credential env vars                                |
|--------------|----------------------------------------------------|
| `uat`        | `UAT_EMAIL`, `UAT_PASSWORD`                        |
| `sandbox-gm` | `SANDBOX_GM_EMAIL`, `SANDBOX_GM_PASSWORD`, `SANDBOX_GM_MQTT_USER`, `SANDBOX_GM_MQTT_PASS` |

Set these in a local `.env` file at repo root (git-ignored).

**When each one is required.** A placeholder in a URL, a cert path or the station
pool is resolved when the target loads, and an unset one aborts immediately — no
command can work without those. A placeholder in a CREDENTIAL section is resolved
when the credential is READ:

- `run` logs in, so it needs the pair, and fails with the same
  `Environment variable UAT_EMAIL is not set` it always did;
- `connect` needs `mqtt_credentials` only if the target declares them;
- `provision` needs NEITHER. It posts a single-use token in the request body and
  sends no `Authorization` header, so `simulator provision -t uat` runs with
  `UAT_EMAIL` unset. It used to abort on it before reaching its own certs check.

## CLI Reference

```bash
# Run scenarios
npx simulator run --scenario <path>     # Single scenario
npx simulator run --suite <name>        # All in scenarios/<name>/
npx simulator run --all                 # All scenarios
npx simulator run --all --parallel      # Parallel execution
npx simulator run --all --parallel --workers 5

# Target selection
npx simulator run --all --target sandbox
npx simulator run --all --station stn_00000005  # Force specific station

# Output formats
npx simulator run --all --output console         # Default, colored
npx simulator run --all --output junit --output-file results/run.xml
npx simulator run --all --output json --output-file results/run.json
```

> **Running against UAT: read [`docs/RUNNING-AGAINST-UAT.md`](docs/RUNNING-AGAINST-UAT.md)
> first.** On the 2026-08-07 full run, 11 of 18 failures were not defects — missing env,
> missing fixtures, missing `--var`s, or the wrong run mode. That file lists what has to be
> true, which scenarios `--station` cannot run and why, the required `--var`s, and why the
> `session-mutate` rate limit must not be raised.

### connect

Run a station against a target and keep it connected to respond to
server-initiated commands until Ctrl+C.

```bash
simulator connect --target <name> --station <id>
```

Bay IDs come from `<stationId>-bays.json` when the station was provisioned through
this CLI, and are derived deterministically from the station ID otherwise. All 20
OSPP handlers are wired (boot, heartbeat, session lifecycle, configuration,
firmware, diagnostics, maintenance, catalog, trigger, certificates, data transfer,
status, meter, security event).

**Ctrl+C announces the departure.** The station publishes `ConnectionLost` with
`reason: "PlannedShutdown"` and then closes with an ordinary clean DISCONNECT
(`connection-lost.md` §4.3). `SIGTERM` does the same, so `docker stop` is as
truthful as a keyboard. Before this, Ctrl+C said nothing and the server held
`is_online` true over a dead socket until the sweep deduced the absence at
`ceil(interval x 3.5)`.

**Every frame is journalled**, both directions, as JSONL — one object per line
carrying direction, action, messageId, both clocks, topic, byte count and the RAW
payload:

```bash
simulator connect --target local-mtls --station stn_aaaaaaaa      # journal on by default
simulator connect ... --journal results/wire.jsonl                # somewhere specific
simulator connect ... --no-journal                                # off
```

The journal sits at the `MqttConnection` chokepoints, in FRONT of the MAC and
schema gates, so a frame the station refused is still recorded — those are the ones
an adversarial run is looking for. A scenario asserts against it with
`field: journal.*` rather than grepping stdout:

```yaml
- action: assert
  field: journal.counts.out.ConnectionLost
  equals: 1
- action: assert
  field: journal.out[action=ConnectionLost].envelope.payload.reason
  equals: PlannedShutdown
```

**Reporting a topology that disagrees with the declared one.** `--report-bays` sets
what goes on the wire, deliberately allowed to differ from what the station declared
at provisioning — which is what reaches the server's two program-set divergence
arms (`StatusNotificationHandler`, `undeclared` / `omitted`):

```bash
# declared {1,2} on bay 1, reported {1}   -> omitted [2]
# declared {1}   on bay 2, reported {1,7} -> undeclared [7]
simulator connect ... --report-bays '1:1;2:1,7'
```

### provision

Provision an mTLS certificate via the OSPP `/v1/provisioning` flow.
Generates an ECDSA P-256 keypair locally (private key never leaves
this machine), builds a CSR with `CN = stationId`, sends it to the
CSMS server with a single-use provisioning token, and saves the
signed certificate plus the Station CA chain.

```bash
simulator provision <stationId> \
  --target <name> \
  --token <provisioningToken> \
  --bay-count <n>              # dense 1..n, one program each
```

**Declaring a topology.** Exactly one of `--bay-count` or `--bays` is required —
they describe the same field, and passing both states two topologies. `--bays`
declares an explicit one, `<bayNumber>:<programNumber>[,...][;<bay>...]`; neither
set need be dense, and every bound is the schema's (bay 1..64, program 1..32,
unique within its scope):

```bash
--bays '1:1,2;2:1'   # bay 1 runs programs {1,2}; bay 2 runs {1}
--bays '1:1;3:1'     # bays {1,3} — bay 2 was never fitted
```

Program labels are derived (`Program <n>`) and are not part of the syntax: `label`
is printable ASCII, which includes the separators, and the schema says the field is
descriptive and never compared at boot. A scenario needing a specific label
declares `bays:` on its provision step, which takes full objects.

The response's bay set is checked against the declared set before anything is
written, so a token that bound `{1,3}` and comes back with another set fails loudly
instead of pairing a bay number with another bay's id.

Provisioning tokens are issued by the CSMS server administrator
(single-use, time-limited). Files are written to the paths configured
in `config/targets.yaml` under `target.certs`:

| Field              | Role                                                                       |
|--------------------|----------------------------------------------------------------------------|
| `key`              | ECDSA P-256 private key, written with `chmod 0600`                         |
| `cert`             | Signed station certificate                                                 |
| `station_ca_chain` | Station CA + Root CA chain (presented by the station to the broker)        |
| `server_ca`        | Broker's TLS CA (used to verify the broker; **not** modified by provision) |

Per-station paths can use `{{stationId}}` as a substitution token —
each station gets its own keypair on disk.

## Development

```bash
npm run build            # TypeScript compilation
npm test                 # Run vitest tests
npm run test:watch       # Watch mode
npm run lint:scenarios   # Validate all scenario YAML files
npm run certs:sync       # Download sandbox certificates
```

## Architecture

- **ESM project** — `"type": "module"`, NodeNext module resolution
- **SDK** — All protocol types from `@ospp/protocol` (never redefined locally)
- **MQTT 5.0** — Two topics per station (`to-server`/`to-station`), action in envelope
- **Scenarios** — YAML-driven with template variables and captured values
- **Linter** — 7 checks: captured vars, message direction, enum values, wait_for completeness, payload schema, multi-unit declaration, pre-empt discriminator
- **Parallel execution** — Semaphore-based, station pool allocation for sandbox

## Protocol Conformance

Built against `@ospp/protocol` (see `package.json`; the spec revision it implements is that
SDK's own `.spec-ref`, which is the only artefact that answers "which spec?"). Emits
**wire version 0.3.0**. All 27 MQTT actions covered.

> **That wire version said `0.2.1` until 2026-09-06, and it is the number that costs a day.**
> `0.2.1` is exactly what this server refuses with `1007 PROTOCOL_VERSION_MISMATCH`, and a
> `Rejected` station accepts no commands — so there is no remote way back from believing it.
> The emitter had already been repaired (`src/mqtt/protocolVersion.ts` returns the SDK's
> constant); only this line still said the old value. Every number in this section is now
> derived by `npm run check:doc-claims`.

## License

MIT
