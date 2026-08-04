import fs from 'node:fs/promises';
import path from 'node:path';
import type { SecureVersion } from 'node:tls';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

/**
 * Scenario step that establishes the station's MQTT connection AFTER an
 * earlier `provision` step has persisted TLS artifacts. Used together with
 * `defer_mqtt_connect: true` at the scenario level: the runner skips the
 * automatic station.connect(), and this step is called once cert material
 * is available on disk.
 *
 * Optional YAML fields:
 *   certs_dir_var: captured-var name holding the artifacts directory
 *                  (default: "certs_dir"; set by ProvisionStep).
 *   key_path / cert_path / chain_path / broker_ca_path: explicit overrides.
 *                  If absent, derived from certs_dir + stationId per the
 *                  `<dir>/<stationId>-{key,,chain,broker-ca}.pem` convention.
 *                  `chain_path` is the Station CA chain PRESENTED alongside
 *                  the leaf (CONS-133); like broker_ca_path it is optional,
 *                  and an absent file falls back to leaf-only.
 *   min_version / max_version: TLS floor/ceiling for this connection (Node
 *                  tls.connect() semantics) — the mid-scenario-provisioning
 *                  equivalent of ScenarioDefinition.tls.{min,max}_version
 *                  for scenarios that connect via the automatic pre-steps
 *                  connect instead. Omit both to inherit MqttConnection's
 *                  own default unchanged.
 */
export class ConnectMqttStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const stationId = context.variables.get('stationId');
    if (typeof stationId !== 'string') {
      throw new Error('ConnectMqttStep: stationId not found in scenario variables');
    }

    const certsDirVar =
      (definition.certs_dir_var as string | undefined) ?? 'certs_dir';
    const certsDirRaw = context.captured.get(certsDirVar);
    const certsDir =
      typeof certsDirRaw === 'string' && certsDirRaw.length > 0
        ? certsDirRaw
        : undefined;

    const keyPath =
      (definition.key_path as string | undefined) ??
      (certsDir ? path.join(certsDir, `${stationId}-key.pem`) : undefined);
    const certPath =
      (definition.cert_path as string | undefined) ??
      (certsDir ? path.join(certsDir, `${stationId}.pem`) : undefined);
    const chainPath =
      (definition.chain_path as string | undefined) ??
      (certsDir ? path.join(certsDir, `${stationId}-chain.pem`) : undefined);
    const brokerCaPath =
      (definition.broker_ca_path as string | undefined) ??
      (certsDir ? path.join(certsDir, `${stationId}-broker-ca.pem`) : undefined);

    if (!keyPath || !certPath) {
      throw new Error(
        'ConnectMqttStep: unable to resolve key/cert paths (provide certs_dir_var, or explicit key_path/cert_path)',
      );
    }

    await fs.access(keyPath);
    await fs.access(certPath);

    // The chain is optional: a pass-form-only or pre-chain station may not have
    // one on disk, and leaf-only is still a valid (if weaker) presentation.
    let chain: string | undefined;
    if (chainPath) {
      try {
        await fs.access(chainPath);
        chain = chainPath;
      } catch {
        // no chain persisted for this station; present the leaf alone
      }
    }

    let serverCa: string | undefined;
    if (brokerCaPath) {
      try {
        await fs.access(brokerCaPath);
        serverCa = brokerCaPath;
      } catch {
        // broker-ca is optional (public CA path); skip if absent
      }
    }

    const minVersion = definition.min_version as SecureVersion | undefined;
    const maxVersion = definition.max_version as SecureVersion | undefined;

    station.setTls({ key: keyPath, cert: certPath, chain, serverCa, minVersion, maxVersion });
    await station.connect();

    console.log(
      `[ConnectMqttStep] ${stationId} MQTT-connected (key=${keyPath}, cert=${certPath}${chain ? `, chain=${chain}` : ''}${serverCa ? `, ca=${serverCa}` : ''}${minVersion ? `, minVersion=${minVersion}` : ''}${maxVersion ? `, maxVersion=${maxVersion}` : ''})`,
    );
  }
}
