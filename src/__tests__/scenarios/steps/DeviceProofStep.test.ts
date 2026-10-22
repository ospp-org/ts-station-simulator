import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { deviceProofInput, verifyDeviceProof } from '@ospp/protocol';
import { DeviceProofStep } from '../../../scenarios/steps/DeviceProofStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * The Partial-B presentation of spec v0.45.0 (authorize-offline-pass.md §3, check #4; 06-security.md §6.5.4):
 * the station forwards no deviceId, and carries the phone's `deviceProof` - a signature by the pass's device
 * key over the proof input of the presentation at this station - with the handshake's `transcriptHash`. On
 * BLE the app signs it inside the handshake; the simulator plays the app and the station at once, so this
 * step signs it with the device key `attest_device` minted, over a transcript hash it draws itself.
 */

const station = { config: { stationId: 'stn_a1b2c3d4e5f6' } } as unknown as Station;

function deviceKey(): { pem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const point = spki.subarray(spki.length - 65);
  const compressed = Buffer.concat([Buffer.from([point[64] % 2 === 0 ? 0x02 : 0x03]), point.subarray(1, 33)]);
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: compressed.toString('base64') };
}

const presentation = {
  offline_pass_id: 'opass_0123456789abcdef',
  counter: 3,
  bay_id: 'bay_0011223344',
  service_id: 'svc_eco',
  requested_duration_seconds: 300,
};

async function run(definition: Record<string, unknown>) {
  const ctx = createContext();
  await new DeviceProofStep().execute(
    { action: 'device_proof', ...definition, capture: { proof: 'deviceProof', hash: 'transcriptHash' } },
    ctx,
    station,
  );
  return { proof: ctx.captured.get('proof') as { format: string; signature: string }, hash: String(ctx.captured.get('hash')) };
}

function inputFor(hash: string, overrides: Partial<Record<string, string | number>> = {}): Uint8Array {
  return deviceProofInput({
    transcriptHash: Buffer.from(hash, 'base64'),
    stationId: String(overrides.stationId ?? 'stn_a1b2c3d4e5f6'),
    passId: String(overrides.passId ?? presentation.offline_pass_id),
    counter: Number(overrides.counter ?? presentation.counter),
    bayId: String(overrides.bayId ?? presentation.bay_id),
    serviceId: String(overrides.serviceId ?? presentation.service_id),
    requestedDurationSeconds: Number(overrides.duration ?? presentation.requested_duration_seconds),
  });
}

describe('DeviceProofStep', () => {
  it('signs the presentation at the station it runs on with the device key, an android-key proof the pass key verifies', async () => {
    const key = deviceKey();
    const { proof, hash } = await run({ device_private_key: key.pem, ...presentation });

    expect(proof.format).toBe('android-key');
    expect(Buffer.from(hash, 'base64')).toHaveLength(32);
    expect(verifyDeviceProof({ deviceProof: proof as never, devicePublicKey: key.publicKey, proofInput: inputFor(hash) })).toEqual({ ok: true });
  });

  it('binds every member of the presentation, so the proof verifies for nothing else', async () => {
    const key = deviceKey();
    const { proof, hash } = await run({ device_private_key: key.pem, ...presentation });

    for (const overrides of [{ stationId: 'stn_ffffffffffff' }, { counter: 4 }, { bayId: 'bay_9999999999' }, { serviceId: 'svc_other' }, { duration: 900 }, { passId: 'opass_ffffffffffffffff' }]) {
      expect(verifyDeviceProof({ deviceProof: proof as never, devicePublicKey: key.publicKey, proofInput: inputFor(hash, overrides) }).ok, JSON.stringify(overrides)).toBe(false);
    }
    expect(verifyDeviceProof({ deviceProof: proof as never, devicePublicKey: deviceKey().publicKey, proofInput: inputFor(hash) }).ok).toBe(false);
  });

  it('draws a fresh transcript hash each time, as each handshake has its own', async () => {
    const key = deviceKey();
    const a = await run({ device_private_key: key.pem, ...presentation });
    const b = await run({ device_private_key: key.pem, ...presentation });

    expect(a.hash).not.toBe(b.hash);
  });

  it('signs for the station a scenario names, a presentation made at another station', async () => {
    const key = deviceKey();
    const { proof, hash } = await run({ device_private_key: key.pem, ...presentation, station_id: 'stn_0000aaaa1111' });

    expect(verifyDeviceProof({ deviceProof: proof as never, devicePublicKey: key.publicKey, proofInput: inputFor(hash, { stationId: 'stn_0000aaaa1111' }) })).toEqual({ ok: true });
  });

  it('refuses a definition that misses a member, an apple-appattest proof it cannot make, and a key that is not a P-256 private key', async () => {
    const key = deviceKey();
    await expect(run({ ...presentation })).rejects.toThrow(/device_private_key/);
    await expect(run({ device_private_key: key.pem, ...presentation, counter: undefined })).rejects.toThrow(/counter/);
    await expect(run({ device_private_key: key.pem, ...presentation, format: 'apple-appattest' })).rejects.toThrow(/android-key/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    await expect(run({ ...presentation, device_private_key: rsa })).rejects.toThrow(/P-256/);
  });
});
