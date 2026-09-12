import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveStationTemplate } from './provision.js';

export interface ProvisioningArtifacts {
  brokerRootCa?: string;
  serverVerifyKey?: string;
  rootCaThumbprint?: string;
  mqttConfig?: { brokerUri?: string; [key: string]: unknown };
}

export interface LoadResult {
  brokerRootCaPath?: string;
  serverVerifyKeyPath?: string;
  serverVerifyKey?: string;
  rootCaThumbprint?: string;
  brokerUri?: string;
}

/**
 * WHY `serverVerifyKey` AND `rootCaThumbprint` ARE HERE.
 *
 * `spec/04-flows.md` §2, *Persisting the response*, names five fields the station MUST write
 * exactly as received, on every successful response including a replay: `stationCaChain`,
 * `brokerRootCa`, `rootCaThumbprint`, `serverVerifyKey`, `mqttConfig`. This module owned two
 * of them. `serverVerifyKey` was declared in the response interface and written nowhere —
 * one occurrence repo-wide, a type — and `rootCaThumbprint` was printed to the console and
 * then dropped with the process.
 *
 * `serverVerifyKey` is the one that cannot be recovered. It is the public key the server
 * signs with, so it is what an `OfflinePass` signature and a `ServerSignedAuth` are verified
 * against; it never travels on MQTT (zero of the 47 `mqtt/` schemas carry it) and the only
 * other way to obtain it is a fresh provisioning response, which costs an operator-issued
 * token. Losing it makes a real pass indistinguishable from a fabricated one.
 *
 * Same file-per-artifact shape as the broker CA, and the same reason: `connect` reads these
 * back by deriving the name from the key path, so a station provisioned through this CLI
 * carries its own trust material instead of having it re-derived or invented.
 */
function derivePaths(keyPath: string): {
  brokerCaPath: string;
  serverVerifyKeyPath: string;
  rootCaThumbprintPath: string;
  mqttJsonPath: string;
} {
  return {
    brokerCaPath: keyPath.replace(/-key\.pem$/, '-broker-ca.pem'),
    serverVerifyKeyPath: keyPath.replace(/-key\.pem$/, '-server-verify-key.pem'),
    rootCaThumbprintPath: keyPath.replace(/-key\.pem$/, '-root-ca-thumbprint.txt'),
    mqttJsonPath: keyPath.replace(/-key\.pem$/, '-mqtt.json'),
  };
}

export async function persistBrokerArtifacts(
  keyPath: string,
  data: ProvisioningArtifacts,
): Promise<{
  brokerCaPath?: string;
  serverVerifyKeyPath?: string;
  rootCaThumbprintPath?: string;
  mqttJsonPath?: string;
}> {
  const { brokerCaPath, serverVerifyKeyPath, rootCaThumbprintPath, mqttJsonPath } =
    derivePaths(keyPath);
  const result: {
    brokerCaPath?: string;
    serverVerifyKeyPath?: string;
    rootCaThumbprintPath?: string;
    mqttJsonPath?: string;
  } = {};
  await fs.mkdir(path.dirname(keyPath), { recursive: true });

  if (typeof data.brokerRootCa === 'string' && data.brokerRootCa.length > 0) {
    await fs.writeFile(brokerCaPath, data.brokerRootCa);
    result.brokerCaPath = brokerCaPath;
  }

  // Written verbatim — no re-armouring, no trailing-newline normalisation. The spec says
  // "exactly as received", and a PEM this process rewrote is no longer the bytes the server
  // sent.
  if (typeof data.serverVerifyKey === 'string' && data.serverVerifyKey.length > 0) {
    await fs.writeFile(serverVerifyKeyPath, data.serverVerifyKey);
    result.serverVerifyKeyPath = serverVerifyKeyPath;
  }

  if (typeof data.rootCaThumbprint === 'string' && data.rootCaThumbprint.length > 0) {
    await fs.writeFile(rootCaThumbprintPath, data.rootCaThumbprint);
    result.rootCaThumbprintPath = rootCaThumbprintPath;
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
  const { brokerCaPath, serverVerifyKeyPath, rootCaThumbprintPath, mqttJsonPath } =
    derivePaths(keyPath);
  const result: LoadResult = {};

  try {
    await fs.access(brokerCaPath);
    result.brokerRootCaPath = brokerCaPath;
  } catch {
    /* missing → leave undefined */
  }

  // The CONTENT, not only the path: this key is verified against, not handed to a TLS
  // library by filename the way the broker CA is.
  try {
    const raw = await fs.readFile(serverVerifyKeyPath, 'utf-8');
    if (raw.length > 0) {
      result.serverVerifyKeyPath = serverVerifyKeyPath;
      result.serverVerifyKey = raw;
    }
  } catch {
    /* missing → leave undefined */
  }

  try {
    const raw = await fs.readFile(rootCaThumbprintPath, 'utf-8');
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      result.rootCaThumbprint = trimmed;
    }
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
