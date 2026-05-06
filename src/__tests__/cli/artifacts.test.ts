import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { persistBrokerArtifacts, loadBrokerArtifacts } from '../../cli/artifacts.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ospp-artifacts-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const stationId = 'stn_test1234';
const keyPathFor = (root: string) => path.join(root, `${stationId}-key.pem`);
const keyTemplateFor = (root: string) => path.join(root, '{{stationId}}-key.pem');

describe('persistBrokerArtifacts', () => {
  it('writes both files when brokerRootCa and mqttConfig.brokerUri are present', async () => {
    const keyPath = keyPathFor(tmpRoot);
    const result = await persistBrokerArtifacts(keyPath, {
      brokerRootCa: '-----BEGIN CERTIFICATE-----\nMIIBroker\n-----END CERTIFICATE-----\n',
      mqttConfig: { brokerUri: 'mqtts://broker.example:8883' },
    });

    expect(result.brokerCaPath).toBe(path.join(tmpRoot, `${stationId}-broker-ca.pem`));
    expect(result.mqttJsonPath).toBe(path.join(tmpRoot, `${stationId}-mqtt.json`));

    const pem = await fs.readFile(result.brokerCaPath!, 'utf-8');
    expect(pem).toMatch(/BEGIN CERTIFICATE/);

    const json = JSON.parse(await fs.readFile(result.mqttJsonPath!, 'utf-8'));
    expect(json.brokerUri).toBe('mqtts://broker.example:8883');
  });

  it('writes only the PEM when mqttConfig is absent', async () => {
    const keyPath = keyPathFor(tmpRoot);
    const result = await persistBrokerArtifacts(keyPath, {
      brokerRootCa: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',
    });

    expect(result.brokerCaPath).toBeDefined();
    expect(result.mqttJsonPath).toBeUndefined();
    await expect(fs.access(path.join(tmpRoot, `${stationId}-mqtt.json`))).rejects.toThrow();
  });

  it('writes only the JSON when brokerRootCa is absent', async () => {
    const keyPath = keyPathFor(tmpRoot);
    const result = await persistBrokerArtifacts(keyPath, {
      mqttConfig: { brokerUri: 'mqtts://only.example:8883' },
    });

    expect(result.brokerCaPath).toBeUndefined();
    expect(result.mqttJsonPath).toBeDefined();
    await expect(fs.access(path.join(tmpRoot, `${stationId}-broker-ca.pem`))).rejects.toThrow();
  });

  it('writes nothing when neither field is present', async () => {
    const keyPath = keyPathFor(tmpRoot);
    const result = await persistBrokerArtifacts(keyPath, {});

    expect(result.brokerCaPath).toBeUndefined();
    expect(result.mqttJsonPath).toBeUndefined();
    await expect(fs.access(path.join(tmpRoot, `${stationId}-broker-ca.pem`))).rejects.toThrow();
    await expect(fs.access(path.join(tmpRoot, `${stationId}-mqtt.json`))).rejects.toThrow();
  });

  it('treats empty brokerRootCa string as absent', async () => {
    const keyPath = keyPathFor(tmpRoot);
    const result = await persistBrokerArtifacts(keyPath, { brokerRootCa: '' });
    expect(result.brokerCaPath).toBeUndefined();
  });

  it('persists the full mqttConfig object, not just brokerUri', async () => {
    const keyPath = keyPathFor(tmpRoot);
    const result = await persistBrokerArtifacts(keyPath, {
      mqttConfig: { brokerUri: 'mqtts://x:8883', clientIdPrefix: 'sim_', extra: 42 },
    });

    const json = JSON.parse(await fs.readFile(result.mqttJsonPath!, 'utf-8'));
    expect(json).toEqual({ brokerUri: 'mqtts://x:8883', clientIdPrefix: 'sim_', extra: 42 });
  });
});

describe('loadBrokerArtifacts', () => {
  it('returns both fields when both files are present', async () => {
    const keyPath = keyPathFor(tmpRoot);
    await persistBrokerArtifacts(keyPath, {
      brokerRootCa: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',
      mqttConfig: { brokerUri: 'mqtts://both.example:8883' },
    });

    const result = await loadBrokerArtifacts(stationId, { key: keyTemplateFor(tmpRoot) });
    expect(result.brokerRootCaPath).toBe(path.join(tmpRoot, `${stationId}-broker-ca.pem`));
    expect(result.brokerUri).toBe('mqtts://both.example:8883');
  });

  it('returns only brokerRootCaPath when only the PEM exists', async () => {
    const keyPath = keyPathFor(tmpRoot);
    await persistBrokerArtifacts(keyPath, {
      brokerRootCa: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',
    });

    const result = await loadBrokerArtifacts(stationId, { key: keyTemplateFor(tmpRoot) });
    expect(result.brokerRootCaPath).toBeDefined();
    expect(result.brokerUri).toBeUndefined();
  });

  it('returns only brokerUri when only the JSON exists', async () => {
    const keyPath = keyPathFor(tmpRoot);
    await persistBrokerArtifacts(keyPath, {
      mqttConfig: { brokerUri: 'mqtts://only.example:8883' },
    });

    const result = await loadBrokerArtifacts(stationId, { key: keyTemplateFor(tmpRoot) });
    expect(result.brokerRootCaPath).toBeUndefined();
    expect(result.brokerUri).toBe('mqtts://only.example:8883');
  });

  it('returns empty when neither file exists', async () => {
    const result = await loadBrokerArtifacts(stationId, { key: keyTemplateFor(tmpRoot) });
    expect(result).toEqual({});
  });

  it('returns empty when certs.key is undefined', async () => {
    const result = await loadBrokerArtifacts(stationId, { key: undefined });
    expect(result).toEqual({});
  });

  it('returns empty when certs is undefined', async () => {
    const result = await loadBrokerArtifacts(stationId, undefined);
    expect(result).toEqual({});
  });

  it('ignores malformed JSON in the mqtt.json file', async () => {
    const keyPath = keyPathFor(tmpRoot);
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, `${stationId}-mqtt.json`), '{not valid json');

    const result = await loadBrokerArtifacts(stationId, { key: keyTemplateFor(tmpRoot) });
    expect(result.brokerUri).toBeUndefined();
  });
});
