import { assertBays } from '../../provisioning/assertBays.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';
import { commitProvisioningKeySet } from '../../provisioning/persistedKeySet.js';
import { getNestedValue } from './ApiCallStep.js';

interface ProvisioningResponseData {
  clientCert?: string;
  stationCaChain?: string;
  brokerRootCa?: string;
  mqttConfig?: { brokerUri?: string; [key: string]: unknown };
  bays?: unknown;
}

/**
 * Scenario step that performs canonical OSPP §2 station provisioning:
 *  1. Generates ECDSA P-256 TLS keypair and CSR (CN=stationId).
 *  2. Generates ECDSA P-256 receipt-signing keypair.
 *  3. POSTs /api/v1/stations/provision with the captured provisioning token.
 *  4. Persists key + cert + chain + broker-ca + mqtt.json + receipt keys to
 *     tests/artifacts/uat/<stationId>/ (or a configurable base path).
 *  5. Captures server-assigned bayIds into context.captured.bayId_1..bayId_N.
 *
 * Required YAML fields:
 *   token_var:    captured-var name holding the raw provisioning token
 *   serial_number: serial number for the station (typically {{serialNumber}})
 *   bay_count:    integer matching the bayCount used at admin/stations registration
 *
 * Optional YAML fields:
 *   artifacts_dir: base directory (default: tests/artifacts/uat). Files are
 *                  written under <artifacts_dir>/<stationId>/.
 *   capture_certs_path_into: variable name to receive the directory where
 *                            artifacts were persisted (for downstream
 *                            connect_mqtt step). Default: "certs_dir".
 *   station_id:    provision THIS station rather than the scenario's `{{stationId}}` — for a
 *                  file that registers a station of its own (`{{runStationId}}`).
 *
 * REFUSAL MODE — `expect_status` (+ optional `expect_body`).
 *
 * Until 2026-08-26 this step THREW on any status other than 200, so a provisioning
 * REFUSAL could not be asserted through it in any run. That was not a gap in the
 * corpus, it was a gap in the instrument: the provisioning door has eight reachable
 * refusals and the only step that can produce a well-formed request for it could not
 * observe any of them. Reaching them another way is not possible either — rungs 4-8 of
 * the precedence chain need a CSR that PARSES, self-verifies and carries `CN=<stationId>`,
 * and a station id is generated per run, so no static literal in a YAML file can serve.
 *
 * With `expect_status` set, the step asserts the status (and each dotted path in
 * `expect_body`) and RETURNS — it persists nothing, captures nothing and does not touch
 * `context.provisioning`, because a refused request issued no certificate and there is
 * nothing to write. The key set is still committed to disk BEFORE the request, exactly as
 * on the success path: spec/04-flows.md:253 step 6b is about what the device did before
 * the bytes left, not about what the server answered.
 *
 * KEY-SHAPE KNOBS, one per refusal that is ABOUT the keys:
 *   csr_override:          send this string as `tlsCsr` instead of the generated CSR
 *                          (4010 CSR_INVALID — a schema-valid, unparseable PEM).
 *   receipt_key_override:  send this as `receiptSigningPublicKey` (4019 PUBLIC_KEY_INVALID).
 *   receipt_key_from_tls:  send the TLS keypair's OWN public key as the receipt key, so the
 *                          two are not pairwise distinct (4016 PROVISIONING_KEY_REUSE).
 *
 * There is deliberately NO `fresh_keys` knob for 4015 PROVISIONING_KEY_MISMATCH: pointing
 * the retry at a different `artifacts_dir` already produces a second, independent key set
 * for the same station id, because reuse is decided by whether the key files exist at the
 * resolved paths (persistedKeySet.ts:167-176). A second knob would be a second way to say
 * the same thing.
 */
export class ProvisionStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const tokenVar = (definition.token_var as string) ?? 'provisioning_token';
    const rawToken = context.captured.get(tokenVar);
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      throw new Error(
        `ProvisionStep: token_var "${tokenVar}" not found in captured context`,
      );
    }

    const serialNumber = definition.serial_number as string | undefined;
    if (typeof serialNumber !== 'string' || serialNumber.length === 0) {
      throw new Error('ProvisionStep: "serial_number" field is required');
    }

    const bayCount = definition.bay_count as number | undefined;
    // A scenario still says bay_count; the topology it stands for is dense
    // 1..bayCount with one program each, which is what the pre-0.11.0 scenarios
    // meant by the scalar. A scenario needing a NON-DENSE set — the case the
    // positional shape could not express — declares `bays` explicitly.
    const declaredBays =
      (definition.bays as Array<{ bayNumber: number; programs: Array<{ programNumber: number; label: string }> }> | undefined) ??
      Array.from({ length: (definition.bay_count as number | undefined) ?? 0 }, (_, i) => ({
        bayNumber: i + 1,
        programs: [{ programNumber: 1, label: 'Basic Wash' }],
      }));
    if (typeof bayCount !== 'number' || bayCount < 1) {
      throw new Error('ProvisionStep: "bay_count" field is required (integer ≥ 1)');
    }

    // WHICH STATION. Default is the scenario's own `{{stationId}}` — which in a pooled run
    // is the POOL's station, and that is right for every file that provisions the identity it
    // then connects as. A file that must register a station OF ITS OWN cannot use it: the
    // pool already registered that id, so the registration answers 409, which is exactly why
    // the three `e2e/*` parcours are `skip_when_pooled`. `station_id:` lets such a file name
    // `{{runStationId}}` — generated fresh per scenario and never replaced by the pool — so
    // it owns what it creates instead of standing on the pool's identity.
    const stationId = (definition.station_id as string | undefined)
      ?? context.variables.get('stationId');
    if (typeof stationId !== 'string' || stationId.length === 0) {
      throw new Error(
        'ProvisionStep: no station id — set `station_id:` on the step or provide `stationId` ' +
          'in the scenario variables',
      );
    }

    if (!context.apiBaseUrl) {
      throw new Error('ProvisionStep: context.apiBaseUrl is not set');
    }

    const artifactsBase =
      (definition.artifacts_dir as string | undefined) ?? 'tests/artifacts/uat';
    const stationDir = path.resolve(artifactsBase, stationId);

    // The key material lands on disk BEFORE the POST (see below), so the directory is
    // recorded before it can exist half-written. A crash between the commit and the
    // response still leaves keys behind; recording here is what lets the scenario's
    // teardown remove them either way.
    context.created.recordArtifactDir(stationDir);

    // 1-2. TLS + receipt keypairs, COMMITTED DURABLY BEFORE THE POST.
    // spec/04-flows.md:253 step 6b — "Before step 7 leaves the device, the SSP
    // MUST commit every private key generated in steps 5-6a to non-volatile
    // storage, durably". This used to generate here and write at step 4, after
    // the response: a crash in between left the server holding a cert bound to
    // keys the simulator no longer had, and the retry was answered 4015.
    // A key set already on disk is REUSED, which is the other half of :307.
    const keySet = await commitProvisioningKeySet(stationDir, stationId);
    const csrPem = keySet.csrPem;
    const receiptPubPem = keySet.receiptPubPem;

    // The three key-shape knobs. Each exists for exactly one refusal, and each replaces a
    // field the generated set would otherwise supply — so a scenario using one is malformed
    // in ONE dimension and the refusal it provokes is attributable to that dimension.
    const csrPemToSend = (definition.csr_override as string | undefined) ?? csrPem;
    const receiptPubToSend =
      definition.receipt_key_from_tls === true
        ? keySet.tlsPubPem
        : (definition.receipt_key_override as string | undefined) ?? receiptPubPem;

    // 3. POST /api/v1/stations/provision
    const url = `${context.apiBaseUrl}/api/v1/stations/provision`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        provisioningToken: rawToken,
        serialNumber,
        // v0.11.0: the station DECLARES its topology — bays, and the programs
        // each one physically has. provisioning-request.schema.json:8 makes
        // `bays` required and `bayCount` is gone. §01-architecture.md:238 — this
        // is the declaration that carries LABELS, because it is "the moment the
        // server creates the bay records and the moment an operator needs the
        // labels to build the service bindings".
        bays: declaredBays,
        tlsCsr: csrPemToSend,
        receiptSigningPublicKey: receiptPubToSend,
      }),
    });

    // REFUSAL MODE. Settled here, before the success path's `status !== 200` throw, so a
    // scenario asserting a refusal never reaches code that assumes a certificate came back.
    const expectStatus = definition.expect_status as number | undefined;
    if (expectStatus !== undefined) {
      const raw = await response.text();
      if (response.status !== expectStatus) {
        throw new Error(
          `ProvisionStep: expected status ${expectStatus} from /api/v1/stations/provision, ` +
            `got ${response.status} — ${raw.slice(0, 500)}`,
        );
      }

      const expectBody = definition.expect_body as Record<string, unknown> | undefined;
      if (expectBody !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(
            `ProvisionStep: expect_body is set but the response body is not JSON — ${raw.slice(0, 500)}`,
          );
        }
        for (const [path, want] of Object.entries(expectBody)) {
          const got = getNestedValue(parsed, path);
          const same =
            got === want ||
            (typeof got === 'object' && got !== null && JSON.stringify(got) === JSON.stringify(want));
          if (!same) {
            throw new Error(
              `ProvisionStep: expected body "${path}" to equal ${JSON.stringify(want)}, ` +
                `but got ${JSON.stringify(got)} (full body: ${raw.slice(0, 800)})`,
            );
          }
        }
      }

      console.log(
        `[ProvisionStep] refusal asserted for ${stationId} — ${response.status}, ` +
          `no certificate issued and nothing persisted`,
      );

      return;
    }

    // OSPP §2 provisioning is an UPDATE of an already-registered station
    // (registration via POST /admin/stations precedes this), so the contract
    // success code is 200 OK — see spec/schemas/provisioning-response.schema.json
    // ("HTTP 200 response body…") and spec/spec/04-flows.md §2 sequence
    // ("Server-->>SSP: 200 OK ProvisioningResponse"). The live endpoint returns
    // 200 (ProvisioningController). (Was 201 — wrong; masked by a 201 test mock.)
    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(
        `ProvisionStep: /api/v1/stations/provision returned ${response.status} — ${body.slice(0, 500)}`,
      );
    }

    // F-05: provisioning response is the FLAT normative body (no `data`
    // envelope) — see provisioning-response.schema.json.
    const data = (await response.json()) as ProvisioningResponseData;

    const cert = data.clientCert;
    if (typeof cert !== 'string' || cert.length === 0) {
      throw new Error('ProvisionStep: response missing clientCert');
    }

    const bays = assertBays(data.bays, {
      context: 'ProvisionStep',
      declaredBayNumbers: declaredBays.map(b => b.bayNumber),
    });

    // 4. Persist the RESPONSE. The private keys are already on disk and flushed.
    const keyPath = keySet.paths.tlsKeyPath;
    const certPath = path.join(stationDir, `${stationId}.pem`);
    const chainPath = path.join(stationDir, `${stationId}-chain.pem`);
    const receiptKeyPath = keySet.paths.receiptKeyPath;
    const receiptPubPath = keySet.paths.receiptPubPath;
    const brokerCaPath = path.join(stationDir, `${stationId}-broker-ca.pem`);
    const mqttJsonPath = path.join(stationDir, `${stationId}-mqtt.json`);

    await Promise.all([
      fs.writeFile(certPath, cert),
      fs.writeFile(
        chainPath,
        typeof data.stationCaChain === 'string'
          ? cert + data.stationCaChain
          : cert,
      ),
    ]);

    if (typeof data.brokerRootCa === 'string' && data.brokerRootCa.length > 0) {
      await fs.writeFile(brokerCaPath, data.brokerRootCa);
    }

    if (data.mqttConfig && typeof data.mqttConfig.brokerUri === 'string') {
      await fs.writeFile(
        mqttJsonPath,
        JSON.stringify(data.mqttConfig, null, 2),
      );
    }

    // 5. Capture the pairs into context for downstream steps, keyed by the
    // DECLARED bayNumber rather than by array position. `bayId_3` is now bay
    // number 3's id, not the third element's — which for a non-dense {1,3} set
    // are different bays.
    for (const pair of bays) {
      context.captured.set(`bayId_${pair.bayNumber}`, pair.bayId);
    }

    const capturePathVar =
      (definition.capture_certs_path_into as string | undefined) ?? 'certs_dir';
    context.captured.set(capturePathVar, stationDir);
    context.captured.set('cert_path', certPath);
    context.captured.set('key_path', keyPath);

    // 6. Populate structured provisioning artifact so scenarios can reference
    //    {{ provisioning.bayIds[N] }}, {{ provisioning.stationId }}, etc.
    //    Fixes V4 Finding #1 by giving scenarios an explicit, fail-loud
    //    template namespace for real bayIds (no silent fallback to random).
    // The WIRE now pairs explicitly; the TEMPLATE namespace stays a 0-indexed
    // array, because that is what 20 scenario references say and because
    // {{ provisioning.bayIds[0] }} means "the scenario's first bay", not "bay
    // number 1". Sorted by bayNumber so the order is the station's declaration
    // rather than whatever order the server answered in — which under the old
    // contract was the same thing only by luck.
    const orderedBayIds = [...bays].sort((a, b) => a.bayNumber - b.bayNumber).map(p => p.bayId);

    context.provisioning = {
      stationId,
      bays: [...bays],
      bayIds: orderedBayIds,
      certPath,
      keyPath,
    };

    // 7. Persist bays.json alongside the certs so future runs can hydrate
    //    via ScenarioRunner without re-running the provision step.
    const baysJsonPath = path.join(stationDir, 'bays.json');
    await fs.writeFile(
      baysJsonPath,
      JSON.stringify({ stationId, bays, bayIds: orderedBayIds }, null, 2),
    );

    console.log(
      `[ProvisionStep] provisioned ${stationId} — ${bays.length} bay(s), artifacts at ${stationDir}`,
    );
  }
}
