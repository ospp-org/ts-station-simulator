# Sprint B3 — Plan

**Brief**: Rewrite the 27 scenario YAMLs that currently call the non-existent `/api/v1/stations/{stationId}/trigger-command` path to use the real CSMS endpoints landed in Sprint A3 (csms-server commit `5eb08b6`, follow-up final report `REPORT-SPRINT-A3-2026-05-19T052845Z.md`).

**Authored**: 2026-05-19 (UTC)

---

## Sprint A3 reality check — scope mismatch with brief

Sprint A3 landed **one** test-dispatch endpoint: `POST /api/v1/testing/trigger-command/{stationId}`. It accepts exactly **5 server→station commands**: `GetConfiguration`, `ChangeConfiguration`, `Reset`, `SetMaintenance`, `TriggerMessage`. Any other `command` value → 422 `selected command is invalid`.

The 39 calls in the 27 scenarios in scope use **6 distinct command shapes**, but only **2 of them are supported by the new testing endpoint**:

| Command | Count | New endpoint | Note |
|---------|-------|--------------|------|
| StartService | 23 | `POST /api/v1/sessions/start` | customer-side production route |
| ReserveBay | 8 | `POST /api/v1/reservations` | customer-side production route |
| StopService | 5 | `POST /api/v1/sessions/{id}/stop` | customer-side production route |
| CancelReservation | 1 | `POST /api/v1/reservations/{id}/cancel` | customer-side production route |
| Reset | 1 | `POST /api/v1/testing/trigger-command/{stationId}` | testing route |
| ChangeConfiguration | 1 | `POST /api/v1/testing/trigger-command/{stationId}` | testing route |
| **Total** | **39** | | |

The brief assumed a uniform URL-only path rewrite. That assumption is wrong: this is a **2-endpoint-family bifurcation** with per-command body-shape, capture, expect_status, and `background` flag changes.

All required endpoints exist in csms-server today — no upstream blockers. Sprint A4 is not required for B3 completion.

## Constraints reaffirmed

- ScenarioRunner already injects `Authorization: Bearer <jwt>` automatically (`ApiCallStep.ts:208`, `ensureAuth()` lazy-logs in via `POST /api/v1/auth/login` with target credentials). No YAML auth wiring needed.
- ScenarioRunner already injects `X-Idempotency-Key: <uuid>` for any POST/PUT/PATCH (`ApiCallStep.ts:225`). No YAML wiring needed.
- ScenarioRunner injects `X-Organization-Id` only for `/api/v1/admin/*` URLs (`ApiCallStep.ts:184`). The new endpoints (`/sessions/*`, `/reservations/*`, `/testing/*`) do NOT match. Customer-side routes per Sprint A3 research have **no `org.context` middleware** — Authorization JWT is sufficient. The `/testing/trigger-command` route DOES carry `org.context`, but it auto-resolves when the JWT user has a single org membership; UAT test users typically do.
- `--var auth_jwt=...` is unviable: `userVars.ts` regex `^[A-Za-z0-9_-]+$` rejects JWT `.` separators. Don't attempt.
- No ScenarioRunner / ApiCallStep code changes required. The rewrite is YAML-only.

## Per-command transformation rules

### StartService → POST /api/v1/sessions/start

```yaml
# BEFORE
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/stations/{{stationId}}/trigger-command"
  body:
    action: "StartService"
    payload:
      sessionId: "sess_00000001"
      bayId: "{{bayId_1}}"
      serviceId: "{{serviceId_1}}"
      durationSeconds: 300
      sessionSource: "MobileApp"
      reservationId: "{{captured.reservationId}}"   # optional
  expect_status: 200

# AFTER
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/sessions/start"
  background: true                                  # POST /sessions/start blocks on SessionReadySignal::wait
  body:
    bay_id: "{{bayId_1}}"
    service_id: "{{serviceId_1}}"
    duration_seconds: 300
    reservation_id: "{{captured.reservationId}}"    # optional, drop line if not present
  expect_status: 201
```

- `sessionId` is server-generated → drop hardcoded `sess_00000001` from body
- `sessionSource` field is dropped (not in StartSessionRequest)
- `reservationId` retained when present (used for reserve→start chains)
- `background: true` is REQUIRED — the server blocks on station MQTT ACK
- For rejected-path scenarios (bay busy / faulted / invalid service / maintenance): use `expect_status: 422` (server propagates station's Rejected as 422)

### ReserveBay → POST /api/v1/reservations

```yaml
# BEFORE
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/stations/{{stationId}}/trigger-command"
  body:
    action: "ReserveBay"
    payload:
      bayId: "{{bayId_1}}"
      reservationId: "rsv_00000001"
      expirationTime: "2099-01-01T00:00:00.000Z"
      sessionSource: "MobileApp"
  expect_status: 200

# AFTER
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/reservations"
  body:
    bay_id: "{{bayId_1}}"
    duration_minutes: 5
    session_source: "MobileApp"
  expect_status: 201
```

- `reservationId` is server-generated → drop hardcoded `rsv_*`
- `expirationTime` replaced by `duration_minutes` (1..15)
- Rejected-path scenarios: `expect_status: 422`

### StopService → POST /api/v1/sessions/{id}/stop

```yaml
# BEFORE
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/stations/{{stationId}}/trigger-command"
  body:
    action: "StopService"
    payload:
      bayId: "{{captured.bayId}}"
      sessionId: "{{captured.sessionId}}"
  expect_status: 200

# AFTER
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/sessions/{{captured.sessionId}}/stop"
  expect_status: 200
```

- Body is empty (no `body:` key)
- `sessionId` flows into URL path via captured-from-MQTT-StartService-Request
- Not synchronous-blocking → no `background: true`
- For `stop-service-rejected.yaml`: SEMANTIC CHANGE — the new endpoint pre-validates sessionId server-side and returns 404 before any MQTT dispatch. The original station-rejection test (`status: Rejected`, errorCode 3006) is no longer reachable via this path. The scenario will be marked with a comment explaining the architecture change and updated to either (a) `expect_status: 404` without `wait_for StopService`, or (b) deleted as semantically obsolete. Decision: keep file, change to test the 404 server-side validation.

### CancelReservation → POST /api/v1/reservations/{id}/cancel

```yaml
# BEFORE
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/stations/{{stationId}}/trigger-command"
  body:
    action: "CancelReservation"
    payload:
      bayId: "{{bayId_1}}"
      reservationId: "{{captured.reservationId}}"
  expect_status: 200

# AFTER
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/reservations/{{captured.reservationId}}/cancel"
  expect_status: 200
```

- Body empty
- `reservationId` flows into URL path via captured-from-MQTT-ReserveBay-Request

### Reset → POST /api/v1/testing/trigger-command/{stationId}

```yaml
# BEFORE
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/stations/{{stationId}}/trigger-command"
  body:
    action: "Reset"
    payload:
      type: "Soft"
  expect_status: 200

# AFTER
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/testing/trigger-command/{{stationId}}"
  body:
    command: "Reset"
    payload:
      type: "Soft"
  expect_status: 202
```

- URL path: `stations/{id}/trigger-command` → `testing/trigger-command/{id}` (id moves to end)
- Body field rename: `action` → `command`
- Status: 200 → 202 (async dispatch enqueued)

### ChangeConfiguration → POST /api/v1/testing/trigger-command/{stationId}

```yaml
# BEFORE
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/stations/{{stationId}}/trigger-command"
  body:
    action: "ChangeConfiguration"
    payload:
      keys:
        - key: "revocationEpoch"
          value: "1"
  expect_status: 200

# AFTER
- action: api_call
  method: POST
  url: "{{target_url}}/api/v1/testing/trigger-command/{{stationId}}"
  body:
    command: "ChangeConfiguration"
    payload:
      key: "revocationEpoch"
      value: "1"
  expect_status: 202
```

- URL + body rename as Reset
- Payload shape: `keys: [{key, value}]` → flat `{key, value}` (single key per call; testing endpoint takes one at a time)

## Phase-by-phase execution

### Phase 1 — 2 testing-trigger calls (Reset + ChangeConfiguration)

Files:
- `scenarios/device-management/reset-rejected-active-sessions.yaml` — 1 Reset call (also has 1 StartService — handled in Phase 3)
- `scenarios/sessions/session-deauthorized-revocation-epoch.yaml` — 1 ChangeConfiguration call (also has 1 StartService — handled in Phase 3)

Approach: per-file Edit. 2 trivial edits.

### Phase 2 — 9 reservation calls

Files (8 ReserveBay + 1 CancelReservation, in 7 distinct files):
- `scenarios/reservations/reserve-and-start.yaml` — 1 ReserveBay
- `scenarios/reservations/reserve-cancel.yaml` — 1 ReserveBay + 1 CancelReservation
- `scenarios/reservations/reserve-expire.yaml` — 1 ReserveBay
- `scenarios/reservations/reserve-rejected-already-reserved.yaml` — 2 ReserveBay
- `scenarios/reservations/reserve-rejected-bay-busy.yaml` — 1 ReserveBay (+ 1 StartService in Phase 3)
- `scenarios/reservations/reserve-rejected-maintenance.yaml` — 1 ReserveBay
- `scenarios/sessions/session-with-reservation.yaml` — 1 ReserveBay (+ 1 StartService in Phase 3)

Approach: per-file Edit. Some files have one call only, others two. Sub-agent parallelization keyed by command type works well.

### Phase 3 — 28 session calls

Files (23 StartService + 5 StopService, across 18+ distinct files). Largest phase. Most files have a single StartService.

Approach: sub-agent delegation. Spawn 2-3 parallel sub-agents to handle subsets:
- Agent A: chaos/* (2 files) + device-management/* (1 file)
- Agent B: fleet/* (2 files) + reservations/* (already covered Phase 2 — pick up the +StartService leftovers)
- Agent C: sessions/* (15 files)

### Phase 4 — Lint + test + build

- `npm run lint:scenarios` — baseline was 86 OK / 5 errors. After rewrite, expect 86 OK / 5 errors (same pre-existing). Iterate any NEW failures.
- `npm test` — 157 baseline; expect no delta (no src changes).
- `npm run build` — clean.

### Phase 5 — Atomic commits

Commit cadence:
1. `docs(sprint-b3): scenario rewrite plan` — this plan file (Block A close)
2. `fix(scenarios): rewrite api_call paths to canonical CSMS endpoints (sessions/reservations/testing-trigger-command)` — Phase 1 + 2 + 3 combined (the bifurcation makes them logically one change)
3. `chore: bump version 0.3.0 → 0.4.0` — Phase 6
4. `docs(sprint-b3): final sprint report` — Block C

Plus `v0.4.0` annotated tag push after commit 3.

### Phase 6 — Version bump v0.3.0 → v0.4.0 + tag

Minor bump (scenario shapes changed — semver minor for a CLI that ships YAML library + binary).

### Phase 7 — Final report

`docs/SPRINT-B3-REPORT-{UTC}.md` covering scope mismatch discovery, bifurcated rewrite, per-file outcome, test/lint deltas, version+tag, and the recommendation that V4 (sim accept-loops against UAT) can now proceed since scenarios are wired to real endpoints.

## Out of scope

- ANY csms-server changes
- Sprint A4 (separate)
- 15 additional sister scenarios timeout sweep (Sprint C)
- 5 pre-existing schema-lint failures
- Bay-Id persistence across scenarios (deferred from B2)
- E2E UAT execution validation (Sprint V4)
- Test coverage for `stop-service-rejected.yaml` semantic regression (filed as follow-up)
