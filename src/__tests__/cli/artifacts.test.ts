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

/*
 * THE ONE THAT CANNOT BE RECOVERED.
 *
 * `spec/04-flows.md` §2, *Persisting the response*, names five fields the station MUST write
 * exactly as received: `stationCaChain`, `brokerRootCa`, `rootCaThumbprint`,
 * `serverVerifyKey`, `mqttConfig`. This module owned two of them, and `serverVerifyKey` —
 * the public key an `OfflinePass` signature is verified against — was declared in the
 * response type and written nowhere: one occurrence in the whole repository, and it was the
 * declaration. `rootCaThumbprint` was printed to the console and then lost with the process.
 *
 * `serverVerifyKey` is not merely inconvenient to lose. It never travels on MQTT — zero of
 * the 47 `mqtt/` schemas carry it — so the only way to obtain it again is a fresh
 * provisioning response, which costs an operator-issued token. A station that lost it cannot
 * distinguish a real pass from a fabricated one.
 */
describe('the trust material the offline path needs', () => {
  const VERIFY_KEY = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHserververify\n-----END PUBLIC KEY-----\n';
  const THUMBPRINT = 'sha256:b6ec67bcded1d48fd92f5147948bbc6f0ab36b2076ef16442845a5135419b95c';

  it('persists serverVerifyKey and rootCaThumbprint, each at its own derived path', async () => {
    const keyPath = keyPathFor(tmpRoot);
    const result = await persistBrokerArtifacts(keyPath, {
      serverVerifyKey: VERIFY_KEY,
      rootCaThumbprint: THUMBPRINT,
    });

    expect(result.serverVerifyKeyPath).toBe(
      path.join(tmpRoot, `${stationId}-server-verify-key.pem`),
    );
    expect(result.rootCaThumbprintPath).toBe(
      path.join(tmpRoot, `${stationId}-root-ca-thumbprint.txt`),
    );

    // Byte-for-byte, because the spec says "exactly as received": a PEM this process
    // re-armoured or newline-normalised is no longer the bytes the server sent.
    expect(await fs.readFile(result.serverVerifyKeyPath!, 'utf-8')).toBe(VERIFY_KEY);
    expect(await fs.readFile(result.rootCaThumbprintPath!, 'utf-8')).toBe(THUMBPRINT);
  });

  it('reads serverVerifyKey back as CONTENT, not only as a path', async () => {
    // The broker CA is handed to a TLS library by filename; this key is verified AGAINST,
    // so a loader that returned only a path would leave every caller to re-read the file.
    await persistBrokerArtifacts(keyPathFor(tmpRoot), {
      serverVerifyKey: VERIFY_KEY,
      rootCaThumbprint: THUMBPRINT,
    });

    const loaded = await loadBrokerArtifacts(stationId, { key: keyTemplateFor(tmpRoot) });

    expect(loaded.serverVerifyKey).toBe(VERIFY_KEY);
    expect(loaded.serverVerifyKeyPath).toBe(
      path.join(tmpRoot, `${stationId}-server-verify-key.pem`),
    );
    expect(loaded.rootCaThumbprint).toBe(THUMBPRINT);
  });

  it('CONTROL — a response carrying neither field writes neither file and loads neither', async () => {
    // Without this the two tests above are also satisfied by a writer that writes those
    // files unconditionally, from whatever happens to be in scope.
    const result = await persistBrokerArtifacts(keyPathFor(tmpRoot), {
      brokerRootCa: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',
    });

    expect(result.serverVerifyKeyPath).toBeUndefined();
    expect(result.rootCaThumbprintPath).toBeUndefined();
    await expect(
      fs.access(path.join(tmpRoot, `${stationId}-server-verify-key.pem`)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(tmpRoot, `${stationId}-root-ca-thumbprint.txt`)),
    ).rejects.toThrow();

    const loaded = await loadBrokerArtifacts(stationId, { key: keyTemplateFor(tmpRoot) });
    expect(loaded.serverVerifyKey).toBeUndefined();
    expect(loaded.rootCaThumbprint).toBeUndefined();
    // ...while the field that WAS present still loads, so the control is scored on the
    // right axis rather than on the loader having stopped working.
    expect(loaded.brokerRootCaPath).toBeDefined();
  });

  it('CONTROL — an empty string is not a key, and is not written', async () => {
    const result = await persistBrokerArtifacts(keyPathFor(tmpRoot), {
      serverVerifyKey: '',
      rootCaThumbprint: '',
    });

    expect(result.serverVerifyKeyPath).toBeUndefined();
    expect(result.rootCaThumbprintPath).toBeUndefined();
  });
});
