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
 *   key_path / cert_path / broker_ca_path: explicit overrides. If absent,
 *                  derived from certs_dir + stationId per the
 *                  `<dir>/<stationId>-{key,,broker-ca}.pem` convention.
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

    station.setTls({ key: keyPath, cert: certPath, serverCa, minVersion, maxVersion });
    await station.connect();

    console.log(
      `[ConnectMqttStep] ${stationId} MQTT-connected (key=${keyPath}, cert=${certPath}${serverCa ? `, ca=${serverCa}` : ''}${minVersion ? `, minVersion=${minVersion}` : ''}${maxVersion ? `, maxVersion=${maxVersion}` : ''})`,
    );
  }
}
