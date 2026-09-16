import { parse as parseYaml } from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SecureVersion } from 'node:tls';
import type { TargetConfig as RunnerTargetConfig } from '../scenarios/ScenarioRunner.js';

export interface TargetConfig {
  mqttUrl: string;
  mqttTls: boolean;
  csmsUrl: string;
  credentials?: {
    email: string;
    password: string;
  };
  /**
   * Why `credentials` is absent although targets.yaml declares it: a `${VAR}` in it
   * could not be resolved from this process's environment.
   *
   * Recorded instead of thrown at load, because the requirement belongs to the
   * COMMAND, not to the target. `provision` posts a single-use token in the body and
   * sends no Authorization header at all, and `UAT_EMAIL` has no executable reader
   * anywhere in `src/` — the only consumer of the resolved pair is the scenario
   * runner's login chain. Resolving the whole node eagerly made the provisioning
   * door unusable against uat over a credential it never reads.
   *
   * Read it through `requireCredentials()`, which turns it back into the original
   * throw. Reading `credentials` directly and finding it undefined is indistinguishable
   * from a target that declares none, which is why the accessor exists.
   */
  credentialsError?: string;
  mqttCredentials?: {
    usernameTemplate: string;
    passwordTemplate: string;
  };
  /** See credentialsError. */
  mqttCredentialsError?: string;
  certs?: {
    key?: string;
    cert?: string;
    keyPattern?: string;
    certPattern?: string;
    serverCa?: string;
    stationCaChain?: string;
    /** Config-level TLS floor/ceiling (Node tls.connect() semantics) — see ScenarioRunner's TargetConfig.tls / ScenarioDefinition.tls for how this flows through to a connection. */
    minVersion?: SecureVersion;
    maxVersion?: SecureVersion;
  };
  stationPool?: string[];
}

export interface TargetsFile {
  targets: Record<string, {
    mqtt_url: string;
    mqtt_tls: boolean;
    csms_url: string;
    credentials?: { email: string; password: string };
    mqtt_credentials?: { username_template: string; password?: string; password_template?: string };
    certs?: {
      key?: string;
      cert?: string;
      key_pattern?: string;
      cert_pattern?: string;
      ca?: string;
      server_ca?: string;
      station_ca_chain?: string;
      min_version?: SecureVersion;
      max_version?: SecureVersion;
    };
    station_pool?: string[];
  }>;
}

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not set`);
    }
    return envValue;
  });
}

function resolveEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return resolveEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => resolveEnvVarsDeep(item));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVarsDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * Target sections whose `${VAR}` placeholders must resolve at LOAD time.
 *
 * Everything no command can do without. Listed rather than derived so the rule is
 * readable and so a new section is a deliberate decision: a key in neither list
 * resolves eagerly by omission from DEFERRED, which is the safe direction.
 */
export const EAGER_TARGET_SECTIONS = [
  'mqtt_url',
  'mqtt_tls',
  'csms_url',
  'certs',
  'station_pool',
] as const;

/** Target sections whose placeholders resolve when the credential is READ. */
export const DEFERRED_TARGET_SECTIONS = ['credentials', 'mqtt_credentials'] as const;

/**
 * Resolve one section, turning an unresolved placeholder into a message rather than
 * a throw. The message names the TARGET and the SECTION, which the bare
 * "Environment variable X is not set" did not — with six placeholders across two
 * targets, that string alone does not say which target was being loaded.
 */
function tryResolveSection<T>(
  section: T,
  targetName: string,
  sectionName: string,
): { value: T; error?: undefined } | { value?: undefined; error: string } {
  try {
    return { value: resolveEnvVarsDeep(section) as T };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      error:
        `Target "${targetName}" declares ${sectionName}, but it cannot be resolved: ${why}. ` +
          'Export it, or use a command that does not need it — `provision` sends a single-use ' +
          'token in the request body and no Authorization header.',
    };
  }
}

export async function loadTarget(name: string): Promise<TargetConfig> {
  const configPath = path.resolve('config', 'targets.yaml');

  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf-8');
  } catch {
    throw new Error(`Cannot read targets config at ${configPath}`);
  }

  const file = parseYaml(content) as TargetsFile;

  if (!file.targets || !file.targets[name]) {
    const available = file.targets ? Object.keys(file.targets).join(', ') : 'none';
    throw new Error(
      `Target "${name}" not found in ${configPath}. Available targets: ${available}`,
    );
  }

  const raw = file.targets[name]!;

  // EAGER vs DEFERRED, and the rule is about who needs the section.
  //
  // A `${VAR}` in a URL, a cert path or the station pool aborts the load: no command
  // can work without those, so deferring the failure only moves the same abort
  // further from its cause. A `${VAR}` in a CREDENTIAL section is deferred, because
  // whether it is needed is a property of the command — see credentialsError.
  const resolved = { ...raw } as typeof raw;
  for (const section of EAGER_TARGET_SECTIONS) {
    if (!(section in raw)) continue;
    (resolved as Record<string, unknown>)[section] =
      resolveEnvVarsDeep((raw as Record<string, unknown>)[section]);
  }

  const config: TargetConfig = {
    mqttUrl: resolved.mqtt_url,
    mqttTls: resolved.mqtt_tls,
    csmsUrl: resolved.csms_url,
  };

  if (raw.credentials) {
    const attempt = tryResolveSection(raw.credentials, name, 'credentials');
    if (attempt.error === undefined) {
      config.credentials = {
        email: attempt.value.email,
        password: attempt.value.password,
      };
    } else {
      config.credentialsError = attempt.error;
    }
  }

  if (raw.mqtt_credentials) {
    const attempt = tryResolveSection(raw.mqtt_credentials, name, 'mqtt_credentials');
    if (attempt.error === undefined) {
      config.mqttCredentials = {
        usernameTemplate: attempt.value.username_template,
        passwordTemplate: attempt.value.password_template ?? attempt.value.password ?? '',
      };
    } else {
      config.mqttCredentialsError = attempt.error;
    }
  }

  if (resolved.certs) {
    config.certs = {
      key: resolved.certs.key,
      cert: resolved.certs.cert,
      keyPattern: resolved.certs.key_pattern,
      certPattern: resolved.certs.cert_pattern,
      serverCa: resolved.certs.server_ca ?? resolved.certs.ca,
      stationCaChain: resolved.certs.station_ca_chain,
      minVersion: resolved.certs.min_version,
      maxVersion: resolved.certs.max_version,
    };
  }

  if (resolved.station_pool) {
    config.stationPool = resolved.station_pool;
  }

  return config;
}

/**
 * Translate the targets.yaml-shaped {@link TargetConfig} into the runner's own
 * {@link RunnerTargetConfig}. The two shapes name the same files differently —
 * `certs.station_ca_chain` here becomes `tls.chain` there, and `certs.ca`
 * becomes `tls.serverCa` — and that renaming gap is where the 2026-08-17
 * broker-CA clobber lived: `PoolBootstrap.certPathsFor` read `tls.serverCa` for
 * a destination that `tls.chain` was the field for.
 *
 * It lives HERE rather than in `cli/index.ts` for one reason: `index.ts` ends in
 * a top-level `program.parse()`, so importing it from a test runs the CLI. This
 * module has no side effects, so the translation every real run depends on can
 * now be asserted against the committed `config/targets.yaml` instead of against
 * a hand-written fixture — which is what let the defect hide.
 */
export function toRunnerTarget(target: TargetConfig): RunnerTargetConfig {
  const runnerTarget: RunnerTargetConfig = {
    mqttUrl: target.mqttUrl,
    apiBaseUrl: target.csmsUrl,
  };

  if (target.certs) {
    runnerTarget.tls = {
      key: target.certs.key,
      cert: target.certs.cert,
      keyPattern: target.certs.keyPattern,
      certPattern: target.certs.certPattern,
      chain: target.certs.stationCaChain,
      serverCa: target.certs.serverCa,
      minVersion: target.certs.minVersion,
      maxVersion: target.certs.maxVersion,
    };
  }

  // Through the accessor, for the same reason as the login pair below: a scenario run
  // against a target that DECLARES broker credentials must not connect anonymously and
  // be refused by the broker for a reason that reads like a server defect.
  const brokerCredentials = requireMqttCredentials(target);
  if (brokerCredentials) {
    runnerTarget.mqttCredentials = {
      usernameTemplate: brokerCredentials.usernameTemplate,
      passwordTemplate: brokerCredentials.passwordTemplate,
    };
  }

  if (target.stationPool) {
    runnerTarget.stationPool = target.stationPool;
  }

  // THROUGH THE ACCESSOR, not the field. `run` genuinely needs the pair, so an
  // unresolvable credential section must still abort — and here, not silently at
  // the first 401 of every scenario in the suite.
  const credentials = requireCredentials(target);
  if (credentials) {
    runnerTarget.credentials = credentials;
  }

  return runnerTarget;
}

/**
 * The credential pair, or `undefined` when the target declares none.
 *
 * THROWS when the target declares one that could not be resolved — with the
 * original message, so a `run --target uat` with no `UAT_EMAIL` fails exactly as it
 * did before the resolution moved. This accessor is the whole safety of the
 * deferral: reading the field directly, a command that needs credentials would find
 * `undefined` and be unable to tell "this target has none" from "this process
 * cannot see them", and the second case would proceed unauthenticated.
 */
export function requireCredentials(target: TargetConfig): TargetConfig['credentials'] {
  if (target.credentialsError !== undefined) throw new Error(target.credentialsError);
  return target.credentials;
}

/** See requireCredentials. */
export function requireMqttCredentials(target: TargetConfig): TargetConfig['mqttCredentials'] {
  if (target.mqttCredentialsError !== undefined) throw new Error(target.mqttCredentialsError);
  return target.mqttCredentials;
}
