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
  mqttCredentials?: {
    usernameTemplate: string;
    passwordTemplate: string;
  };
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
  const resolved = resolveEnvVarsDeep(raw) as typeof raw;

  const config: TargetConfig = {
    mqttUrl: resolved.mqtt_url,
    mqttTls: resolved.mqtt_tls,
    csmsUrl: resolved.csms_url,
  };

  if (resolved.credentials) {
    config.credentials = {
      email: resolved.credentials.email,
      password: resolved.credentials.password,
    };
  }

  if (resolved.mqtt_credentials) {
    config.mqttCredentials = {
      usernameTemplate: resolved.mqtt_credentials.username_template,
      passwordTemplate: resolved.mqtt_credentials.password_template ?? resolved.mqtt_credentials.password ?? '',
    };
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

  if (target.mqttCredentials) {
    runnerTarget.mqttCredentials = {
      usernameTemplate: target.mqttCredentials.usernameTemplate,
      passwordTemplate: target.mqttCredentials.passwordTemplate,
    };
  }

  if (target.stationPool) {
    runnerTarget.stationPool = target.stationPool;
  }

  if (target.credentials) {
    runnerTarget.credentials = target.credentials;
  }

  return runnerTarget;
}
