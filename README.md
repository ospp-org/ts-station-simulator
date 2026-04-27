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

83 YAML-driven test scenarios across 7 categories:

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
| `local` | Local development (mqtt://localhost:1883) |
| `uat` | UAT environment (mTLS) |
| `sandbox` | OSPP conformance sandbox (mTLS + MQTT credentials) |

Override via `--target` flag or `OSPP_TARGET` env var.

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

### connect

Run a station against a target and keep it connected to respond to
server-initiated commands until Ctrl+C.

```bash
simulator connect --target <name> --station <id>
```

Bay IDs are derived deterministically from station ID. All 20 OSPP
handlers are wired (boot, heartbeat, session lifecycle, configuration,
firmware, diagnostics, maintenance, catalog, trigger, certificates,
data transfer, status, meter, security event).

Press Ctrl+C to disconnect cleanly.

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
- **Linter** — 5 checks: captured vars, message direction, enum values, wait_for completeness, payload schema
- **Parallel execution** — Semaphore-based, station pool allocation for sandbox

## Protocol Conformance

Tested against OSPP spec v0.2.5 (wire version 0.2.1). All 26 MQTT actions covered.

## License

MIT
