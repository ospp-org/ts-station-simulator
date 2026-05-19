import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';
import {
  generateEcdsaP256KeyPair,
  buildCsr,
  exportPrivateKeyPkcs8Pem,
  exportPublicKeySpkiPem,
} from '../../cli/provision.js';

interface ProvisioningResponseData {
  certificate?: string;
  stationCaChain?: string;
  brokerRootCa?: string;
  mqttConfig?: { brokerUri?: string; [key: string]: unknown };
  bayIds?: string[];
}

interface ProvisioningResponse {
  data?: ProvisioningResponseData;
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

      const tlsKeys = await generateEcdsaP256KeyPair();
      const csr = await buildCsr(stationId, tlsKeys);
      const csrPem = csr.toString('pem');
      const tlsKeyPem = exportPrivateKeyPkcs8Pem(tlsKeys.privateKey);

      const receiptKeys = await generateEcdsaP256KeyPair();
      const receiptKeyPem = exportPrivateKeyPkcs8Pem(receiptKeys.privateKey);
      const receiptPubPem = exportPublicKeySpkiPem(receiptKeys.publicKey);

      const url = `${context.apiBaseUrl}/api/v1/stations/provision`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          provisioningToken: token,
          serialNumber: `${serialPrefix}${randomHex8()}`,
          bayCount,
          tlsCsr: csrPem,
          receiptSigningPublicKey: receiptPubPem,
        }),
      });

      if (response.status !== 201) {
        const body = await response.text();
        throw new Error(
          `ProvisionStationPoolStep[${i + 1}/${count}]: /api/v1/stations/provision returned ${response.status} — ${body.slice(0, 500)}`,
        );
      }

      const parsed = (await response.json()) as ProvisioningResponse;
      const data = parsed.data;
      if (!data) {
        throw new Error(
          `ProvisionStationPoolStep[${i + 1}/${count}]: response missing "data" envelope`,
        );
      }
      const cert = data.certificate;
      if (typeof cert !== 'string' || cert.length === 0) {
        throw new Error(
          `ProvisionStationPoolStep[${i + 1}/${count}]: response missing data.certificate`,
        );
      }
      const bayIds = data.bayIds;
      if (!Array.isArray(bayIds) || bayIds.length === 0) {
        throw new Error(
          `ProvisionStationPoolStep[${i + 1}/${count}]: response missing data.bayIds`,
        );
      }

      const stationDir = path.resolve(artifactsBase, 'pool', stationId);
      await fs.mkdir(stationDir, { recursive: true });

      const keyPath = path.join(stationDir, `${stationId}-key.pem`);
      const certPath = path.join(stationDir, `${stationId}.pem`);
      const chainPath = path.join(stationDir, `${stationId}-chain.pem`);
      const receiptKeyPath = path.join(stationDir, `${stationId}-receipt-key.pem`);
      const receiptPubPath = path.join(stationDir, `${stationId}-receipt-pub.pem`);
      const brokerCaPath = path.join(stationDir, `${stationId}-broker-ca.pem`);
      const baysJsonPath = path.join(stationDir, 'bays.json');

      await Promise.all([
        fs.writeFile(keyPath, tlsKeyPem, { mode: 0o600 }),
        fs.writeFile(certPath, cert),
        fs.writeFile(
          chainPath,
          typeof data.stationCaChain === 'string' ? cert + data.stationCaChain : cert,
        ),
        fs.writeFile(receiptKeyPath, receiptKeyPem, { mode: 0o600 }),
        fs.writeFile(receiptPubPath, receiptPubPem),
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
