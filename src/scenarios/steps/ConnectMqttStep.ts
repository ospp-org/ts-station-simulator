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
 *                  and an absent file falls back to the target's, then to
 *                  leaf-only / the system trust store.
 *   min_version / max_version: TLS floor/ceiling for this connection (Node
 *                  tls.connect() semantics) — the mid-scenario-provisioning
 *                  equivalent of ScenarioDefinition.tls.{min,max}_version
 *                  for scenarios that connect via the automatic pre-steps
 *                  connect instead. Omit both to inherit the target's, and
 *                  then MqttConnection's own default, unchanged.
 *
 * ── THE TARGET IS THE LAST RUNG, AND IT HAD NO RUNG AT ALL ──────────────────
 *
 * This step ends at `station.setTls()`, which REPLACES the connection's TLS
 * config rather than merging it (`MqttConnection.ts:395-401`). So everything
 * `config/targets.yaml` declares — the broker anchor above all — was dropped
 * the moment a scenario connected from a step instead of letting the runner
 * connect for it. The automatic connect on the same target kept it, which is
 * why the two disagreed.
 *
 * THE BROKER ANCHOR CANNOT BE REBUILT FROM `certs_dir` IN GENERAL.
 * `ProvisionStep` writes `<stationId>-broker-ca.pem` only when the provisioning
 * response carries `brokerRootCa`, and csms-server emits that field only under
 * `OSPP_BROKER_DEPLOYMENT=private_ca`. Under the `public_ca` default the file is
 * never written, so the derived path never exists and the connection fell
 * through to a system trust store that cannot hold a private CA. Over
 * `local-mtls`, whose broker presents `CN=emqx` issued by `OneStopPay MQTT CA`
 * ALONE, that is "unable to verify the first certificate".
 *
 * PRECEDENCE, for the two paths that have three sources:
 *   1. the step's own `chain_path` / `broker_ca_path` — an explicit request
 *   2. what PROVISIONING wrote into `certs_dir` — what the server told THIS
 *      station to trust, and the only per-station one of the three
 *   3. the target's `certs.station_ca_chain` / `certs.ca`, via
 *      `ScenarioContext.connectTls`
 * First one that EXISTS ON DISK wins, so a rung that names a file which is not
 * there falls to the next — the behaviour rungs 1 and 2 already had between
 * them. `key`/`cert` keep plain `??` precedence instead: when `certs_dir` is
 * set, a missing provisioned key must stay the loud `fs.access` throw it is
 * today and must NOT quietly borrow the target's fixture identity.
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

    // The target's cert block, resolved for this station by the runner. Undefined for a
    // plaintext target, which declares none.
    const targetTls = context.connectTls;

    const keyPath =
      (definition.key_path as string | undefined) ??
      (certsDir ? path.join(certsDir, `${stationId}-key.pem`) : undefined) ??
      targetTls?.key;
    const certPath =
      (definition.cert_path as string | undefined) ??
      (certsDir ? path.join(certsDir, `${stationId}.pem`) : undefined) ??
      targetTls?.cert;

    if (!keyPath || !certPath) {
      throw new Error(
        'ConnectMqttStep: unable to resolve key/cert paths (provide certs_dir_var, or explicit key_path/cert_path)',
      );
    }

    await fs.access(keyPath);
    await fs.access(certPath);

    /** The first candidate that is on disk. Absent everywhere is not an error here. */
    const firstOnDisk = async (
      ...candidates: Array<string | undefined>
    ): Promise<string | undefined> => {
      for (const candidate of candidates) {
        if (candidate === undefined) continue;
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          // this rung does not exist for this station; try the next
        }
      }
      return undefined;
    };

    // The chain is optional: a pass-form-only or pre-chain station may not have
    // one on disk, and leaf-only is still a valid (if weaker) presentation.
    const chain = await firstOnDisk(
      definition.chain_path as string | undefined,
      certsDir ? path.join(certsDir, `${stationId}-chain.pem`) : undefined,
      targetTls?.chain,
    );

    // The broker anchor. Optional in the same sense — on a public-CA broker the system
    // trust store is the right answer and every rung below is legitimately absent.
    const serverCa = await firstOnDisk(
      definition.broker_ca_path as string | undefined,
      certsDir ? path.join(certsDir, `${stationId}-broker-ca.pem`) : undefined,
      targetTls?.serverCa,
    );

    const minVersion =
      (definition.min_version as SecureVersion | undefined) ?? targetTls?.minVersion;
    const maxVersion =
      (definition.max_version as SecureVersion | undefined) ?? targetTls?.maxVersion;

    station.setTls({ key: keyPath, cert: certPath, chain, serverCa, minVersion, maxVersion });
    await station.connect();

    console.log(
      `[ConnectMqttStep] ${stationId} MQTT-connected (key=${keyPath}, cert=${certPath}${chain ? `, chain=${chain}` : ''}${serverCa ? `, ca=${serverCa}` : ''}${minVersion ? `, minVersion=${minVersion}` : ''}${maxVersion ? `, maxVersion=${maxVersion}` : ''})`,
    );
  }
}
