import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveStationTemplate } from './provision.js';

export interface ProvisioningArtifacts {
  brokerRootCa?: string;
  mqttConfig?: { brokerUri?: string; [key: string]: unknown };
}

export interface LoadResult {
  brokerRootCaPath?: string;
  brokerUri?: string;
}

function derivePaths(keyPath: string): { brokerCaPath: string; mqttJsonPath: string } {
  return {
    brokerCaPath: keyPath.replace(/-key\.pem$/, '-broker-ca.pem'),
    mqttJsonPath: keyPath.replace(/-key\.pem$/, '-mqtt.json'),
  };
}

export async function persistBrokerArtifacts(
  keyPath: string,
  data: ProvisioningArtifacts,
): Promise<{ brokerCaPath?: string; mqttJsonPath?: string }> {
  const { brokerCaPath, mqttJsonPath } = derivePaths(keyPath);
  const result: { brokerCaPath?: string; mqttJsonPath?: string } = {};
  await fs.mkdir(path.dirname(keyPath), { recursive: true });

  if (typeof data.brokerRootCa === 'string' && data.brokerRootCa.length > 0) {
    await fs.writeFile(brokerCaPath, data.brokerRootCa);
    result.brokerCaPath = brokerCaPath;
  }

  if (data.mqttConfig && typeof data.mqttConfig.brokerUri === 'string') {
    await fs.writeFile(mqttJsonPath, JSON.stringify(data.mqttConfig, null, 2));
    result.mqttJsonPath = mqttJsonPath;
  }

  return result;
}

export async function loadBrokerArtifacts(
  stationId: string,
  certs: { key?: string } | undefined,
): Promise<LoadResult> {
  if (!certs?.key) return {};
  const keyPath = resolveStationTemplate(certs.key, stationId);
  const { brokerCaPath, mqttJsonPath } = derivePaths(keyPath);
  const result: LoadResult = {};

  try {
    await fs.access(brokerCaPath);
    result.brokerRootCaPath = brokerCaPath;
  } catch {
    /* missing → leave undefined */
  }

  try {
    const raw = await fs.readFile(mqttJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { brokerUri?: string };
    if (typeof parsed.brokerUri === 'string') {
      result.brokerUri = parsed.brokerUri;
    }
  } catch {
    /* missing or unparseable → leave undefined */
  }

  return result;
}
