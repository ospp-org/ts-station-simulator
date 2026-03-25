import { parse as parseYaml } from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';

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
    certs?: { key?: string; cert?: string; key_pattern?: string; cert_pattern?: string; ca?: string; server_ca?: string };
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
      serverCa: resolved.certs.server_ca,
    };
  }

  if (resolved.station_pool) {
    config.stationPool = resolved.station_pool;
  }

  return config;
}
