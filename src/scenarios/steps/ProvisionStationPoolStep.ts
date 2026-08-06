import { assertBays } from '../../provisioning/assertBays.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';
import { commitProvisioningKeySet } from '../../provisioning/persistedKeySet.js';

interface ProvisioningResponseData {
  clientCert?: string;
  stationCaChain?: string;
  brokerRootCa?: string;
  mqttConfig?: { brokerUri?: string; [key: string]: unknown };
  bays?: unknown;
}

/**
 * Scenario step that provisions N stations into `context.pool`.
 *
 * For each station: generates a TLS + receipt keypair, POSTs to
 * `/api/v1/stations/provision`, persists artifacts under
 * `<artifacts_dir>/pool/<stationId>/`, and registers the result in
 * the pool registry. After this step, scenarios can address pool
 * entries via the `{{ pool.* }}` template namespace.
 *
 * Required YAML fields:
 *   count:     integer >= 1, how many stations to provision
 *   bay_count: integer >= 1, bays per station
 *   token_var: captured-var name holding the shared provisioning token
 *              (single dev/test token reused) OR token_vars (array of N
 *              captured-var names for per-station tokens)
 *
 * Optional YAML fields:
 *   prefix:        stationId prefix (default 'stn_pool_')
 *   token_vars:    array of N captured-var names; takes precedence over token_var
 *   artifacts_dir: base directory (default 'tests/artifacts/uat'). Files
 *                  are written under <artifacts_dir>/pool/<stationId>/.
 *   serial_prefix: serial-number prefix (default 'SIMPOOL-')
 */
export class ProvisionStationPoolStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    _station: Station,
  ): Promise<void> {
    const count = definition.count as number | undefined;
    if (typeof count !== 'number' || count < 1) {
      throw new Error('ProvisionStationPoolStep: "count" field is required (integer >= 1)');
    }

    const bayCount = definition.bay_count as number | undefined;
    // Dense 1..bayCount with one program each — what the pre-0.11.0 scalar meant.
    const declaredBays = Array.from({ length: (definition.bay_count as number | undefined) ?? 0 }, (_, b) => ({
      bayNumber: b + 1,
      programs: [{ programNumber: 1, label: 'Basic Wash' }],
    }));
    if (typeof bayCount !== 'number' || bayCount < 1) {
      throw new Error('ProvisionStationPoolStep: "bay_count" field is required (integer >= 1)');
    }

    if (!context.apiBaseUrl) {
      throw new Error('ProvisionStationPoolStep: context.apiBaseUrl is not set');
    }

    const prefix = (definition.prefix as string | undefined) ?? 'stn_pool_';
    const serialPrefix = (definition.serial_prefix as string | undefined) ?? 'SIMPOOL-';
    const artifactsBase =
      (definition.artifacts_dir as string | undefined) ?? 'tests/artifacts/uat';

    const tokens = resolveTokens(definition, context, count);

    for (let i = 0; i < count; i++) {
      const stationId = `${prefix}${randomHex8()}`;
      const token = tokens[i];

      // Keys COMMITTED DURABLY BEFORE THE POST — spec/04-flows.md:253 step 6b.
      // This used to generate here and write after the response, so a crash in
      // between left the server holding a cert bound to keys this process no
      // longer had, and the retry was answered 4015 (recoverable:false).
      const stationDir = path.resolve(artifactsBase, 'pool', stationId);
      const keySet = await commitProvisioningKeySet(stationDir, stationId);
      const csrPem = keySet.csrPem;
      const receiptPubPem = keySet.receiptPubPem;

      const url = `${context.apiBaseUrl}/api/v1/stations/provision`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          provisioningToken: token,
          serialNumber: `${serialPrefix}${randomHex8()}`,
          // v0.11.0: the station declares bays and the programs each one has.
          bays: declaredBays,
          tlsCsr: csrPem,
          receiptSigningPublicKey: receiptPubPem,
        }),
      });

      // OSPP §2 provisioning success is 200 OK (update semantics) — see
      // provisioning-response.schema.json + 04-flows.md §2. (Was 201 — wrong.)
      if (response.status !== 200) {
        const body = await response.text();
        throw new Error(
          `ProvisionStationPoolStep[${i + 1}/${count}]: /api/v1/stations/provision returned ${response.status} — ${body.slice(0, 500)}`,
        );
      }

      // F-05: provisioning response is the FLAT normative body (no `data`
      // envelope) — see provisioning-response.schema.json.
      const data = (await response.json()) as ProvisioningResponseData;

      const cert = data.clientCert;
      if (typeof cert !== 'string' || cert.length === 0) {
        throw new Error(
          `ProvisionStationPoolStep[${i + 1}/${count}]: response missing clientCert`,
        );
      }
      const bayPairs = assertBays(data.bays, {
        context: `ProvisionStationPoolStep[${i + 1}/${count}]`,
        declaredBayNumbers: declaredBays.map(b => b.bayNumber),
      });
      // 0-indexed template array, sorted by bayNumber — see ProvisioningArtifact.
      const bayIds = [...bayPairs].sort((a, b) => a.bayNumber - b.bayNumber).map(p => p.bayId);

      const keyPath = keySet.paths.tlsKeyPath;
      const certPath = path.join(stationDir, `${stationId}.pem`);
      const chainPath = path.join(stationDir, `${stationId}-chain.pem`);
      const receiptKeyPath = keySet.paths.receiptKeyPath;
      const receiptPubPath = keySet.paths.receiptPubPath;
      const brokerCaPath = path.join(stationDir, `${stationId}-broker-ca.pem`);
      const baysJsonPath = path.join(stationDir, 'bays.json');

      await Promise.all([
        fs.writeFile(certPath, cert),
        fs.writeFile(
          chainPath,
          typeof data.stationCaChain === 'string' ? cert + data.stationCaChain : cert,
        ),
      ]);

      let registeredBrokerCaPath: string | undefined;
      if (typeof data.brokerRootCa === 'string' && data.brokerRootCa.length > 0) {
        await fs.writeFile(brokerCaPath, data.brokerRootCa);
        registeredBrokerCaPath = brokerCaPath;
      }

      await fs.writeFile(
        baysJsonPath,
        JSON.stringify({ stationId, bayIds }, null, 2),
      );

      context.pool.register({
        stationId,
        bayIds,
        certPath,
        keyPath,
        chainPath,
        brokerCaPath: registeredBrokerCaPath,
      });
    }

    const indexJsonPath = path.resolve(artifactsBase, 'pool', 'index.json');
    await fs.writeFile(
      indexJsonPath,
      JSON.stringify(
        {
          target: artifactsBase,
          stations: context.pool.list().map((e) => ({
            stationId: e.stationId,
            bayIds: e.bayIds,
            certPath: e.certPath,
          })),
        },
        null,
        2,
      ),
    );

    console.log(
      `[ProvisionStationPoolStep] provisioned ${count} station(s) into pool under ${path.resolve(artifactsBase, 'pool')}`,
    );
  }
}

function resolveTokens(
  definition: StepDefinition,
  context: ScenarioContext,
  count: number,
): string[] {
  const tokenVars = definition.token_vars as string[] | undefined;
  if (Array.isArray(tokenVars)) {
    if (tokenVars.length !== count) {
      throw new Error(
        `ProvisionStationPoolStep: token_vars length ${tokenVars.length} does not match count ${count}`,
      );
    }
    return tokenVars.map((varName, i) => {
      const t = context.captured.get(varName);
      if (typeof t !== 'string' || t.length === 0) {
        throw new Error(
          `ProvisionStationPoolStep: token_vars[${i}] "${varName}" not in captured context`,
        );
      }
      return t;
    });
  }
  const tokenVar = (definition.token_var as string | undefined) ?? 'provisioning_token';
  const token = context.captured.get(tokenVar);
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      `ProvisionStationPoolStep: token_var "${tokenVar}" not in captured context`,
    );
  }
  return Array.from({ length: count }, () => token);
}

function randomHex8(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
