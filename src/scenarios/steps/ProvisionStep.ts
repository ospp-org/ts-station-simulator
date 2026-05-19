import fs from 'node:fs/promises';
import path from 'node:path';
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
    if (typeof bayCount !== 'number' || bayCount < 1) {
      throw new Error('ProvisionStep: "bay_count" field is required (integer ≥ 1)');
    }

    const stationId = context.variables.get('stationId');
    if (typeof stationId !== 'string') {
      throw new Error('ProvisionStep: stationId not found in scenario variables');
    }

    if (!context.apiBaseUrl) {
      throw new Error('ProvisionStep: context.apiBaseUrl is not set');
    }

    // 1. TLS keypair + CSR
    const tlsKeys = await generateEcdsaP256KeyPair();
    const csr = await buildCsr(stationId, tlsKeys);
    const csrPem = csr.toString('pem');
    const tlsKeyPem = exportPrivateKeyPkcs8Pem(tlsKeys.privateKey);

    // 2. Receipt keypair
    const receiptKeys = await generateEcdsaP256KeyPair();
    const receiptKeyPem = exportPrivateKeyPkcs8Pem(receiptKeys.privateKey);
    const receiptPubPem = exportPublicKeySpkiPem(receiptKeys.publicKey);

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
        bayCount,
        tlsCsr: csrPem,
        receiptSigningPublicKey: receiptPubPem,
      }),
    });

    if (response.status !== 201) {
      const body = await response.text();
      throw new Error(
        `ProvisionStep: /api/v1/stations/provision returned ${response.status} — ${body.slice(0, 500)}`,
      );
    }

    const parsed = (await response.json()) as ProvisioningResponse;
    const data = parsed.data;
    if (!data) {
      throw new Error(
        'ProvisionStep: provisioning response missing "data" envelope',
      );
    }

    const cert = data.certificate;
    if (typeof cert !== 'string' || cert.length === 0) {
      throw new Error('ProvisionStep: response missing data.certificate');
    }

    const bayIds = data.bayIds;
    if (!Array.isArray(bayIds) || bayIds.length === 0) {
      throw new Error('ProvisionStep: response missing data.bayIds');
    }

    // 4. Persist artifacts
    const artifactsBase =
      (definition.artifacts_dir as string | undefined) ?? 'tests/artifacts/uat';
    const stationDir = path.resolve(artifactsBase, stationId);
    await fs.mkdir(stationDir, { recursive: true });

    const keyPath = path.join(stationDir, `${stationId}-key.pem`);
    const certPath = path.join(stationDir, `${stationId}.pem`);
    const chainPath = path.join(stationDir, `${stationId}-chain.pem`);
    const receiptKeyPath = path.join(stationDir, `${stationId}-receipt-key.pem`);
    const receiptPubPath = path.join(stationDir, `${stationId}-receipt-pub.pem`);
    const brokerCaPath = path.join(stationDir, `${stationId}-broker-ca.pem`);
    const mqttJsonPath = path.join(stationDir, `${stationId}-mqtt.json`);

    await Promise.all([
      fs.writeFile(keyPath, tlsKeyPem, { mode: 0o600 }),
      fs.writeFile(certPath, cert),
      fs.writeFile(
        chainPath,
        typeof data.stationCaChain === 'string'
          ? cert + data.stationCaChain
          : cert,
      ),
      fs.writeFile(receiptKeyPath, receiptKeyPem, { mode: 0o600 }),
      fs.writeFile(receiptPubPath, receiptPubPem),
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

    // 5. Capture bayIds into context for downstream steps
    for (let i = 0; i < bayIds.length; i++) {
      context.captured.set(`bayId_${i + 1}`, bayIds[i]);
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
    context.provisioning = {
      stationId,
      bayIds: [...bayIds],
      certPath,
      keyPath,
    };

    // 7. Persist bays.json alongside the certs so future runs can hydrate
    //    via ScenarioRunner without re-running the provision step.
    const baysJsonPath = path.join(stationDir, 'bays.json');
    await fs.writeFile(
      baysJsonPath,
      JSON.stringify({ stationId, bayIds }, null, 2),
    );

    console.log(
      `[ProvisionStep] provisioned ${stationId} — ${bayIds.length} bay(s), artifacts at ${stationDir}`,
    );
  }
}
