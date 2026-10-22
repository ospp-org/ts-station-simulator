import { createPrivateKey, randomBytes } from 'node:crypto';
import { DEVICE_PROOF_FORMATS, deviceProofInput, signDeviceProof } from '@ospp/protocol';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

/**
 * The phone's proof of possession of the pass's device key, over a Partial-B presentation at a station -
 * the `deviceProof` and `transcriptHash` an AuthorizeOfflinePass REQUEST carries at spec v0.45.0
 * (authorize-offline-pass.md §3, check #4; 06-security.md §6.5.4). Until then the station forwarded the
 * pass's `deviceId`, a string any station that held the pass could copy; the frozen request carries none.
 *
 *   - action: device_proof
 *     device_private_key: "{{captured.devicePrivateKeyPem}}"   # attest_device's output
 *     offline_pass_id: "{{captured.offlinePassId}}"
 *     counter: 1
 *     bay_id: "{{bayId_1}}"
 *     service_id: "{{serviceId_1}}"
 *     requested_duration_seconds: 300
 *     station_id: "stn_..."                                    # optional, the station this step runs on
 *     capture:
 *       proof: deviceProof
 *       hash: transcriptHash
 *
 * On BLE the app signs the proof inside the handshake, whose transcript hash both ends hold. The
 * simulator plays the app and the station at once and runs no handshake, so it draws the transcript hash
 * here, 32 random bytes per presentation as each handshake has its own, and the AuthorizeOfflinePass that
 * follows forwards it. `android-key` only: the device key `attest_device` mints is an Android Keystore
 * key, and an `apple-appattest` proof needs an App Attest key's authenticator data, which nothing here has.
 */

const OUTPUTS = ['deviceProof', 'transcriptHash'] as const;
type Output = (typeof OUTPUTS)[number];

function requireString(definition: StepDefinition, member: string): string {
  const value = definition[member];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`device_proof requires "${member}", a non-empty string`);
  }
  return value;
}

function requireInteger(definition: StepDefinition, member: string, minimum: number): number {
  const value = definition[member];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new Error(`device_proof requires "${member}", an integer of at least ${minimum}`);
  }
  return value;
}

/** The 32-byte scalar of a PKCS#8 P-256 private key. */
function p256Scalar(pem: string): Uint8Array {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('device_proof: "device_private_key" is not a P-256 private key');
  }
  const d = key.export({ format: 'jwk' }).d;
  if (typeof d !== 'string') {
    throw new Error('device_proof: "device_private_key" exports no private scalar');
  }
  return new Uint8Array(Buffer.from(d, 'base64url'));
}

export class DeviceProofStep implements Step {
  async execute(definition: StepDefinition, context: ScenarioContext, station: Station): Promise<void> {
    const capture = definition.capture;
    if (!capture || typeof capture !== 'object' || Array.isArray(capture) || Object.keys(capture).length === 0) {
      throw new Error('device_proof requires a "capture:" map from captured names to its outputs');
    }
    const wanted = Object.entries(capture as Record<string, unknown>).map(([name, output]) => {
      if (typeof output !== 'string' || !(OUTPUTS as readonly string[]).includes(output)) {
        throw new Error(`device_proof: "${String(output)}" is not one of its outputs (${OUTPUTS.join(', ')})`);
      }
      return [name, output as Output] as const;
    });

    const privateKeyPem = requireString(definition, 'device_private_key');
    const passId = requireString(definition, 'offline_pass_id');
    const counter = requireInteger(definition, 'counter', 0);
    const bayId = requireString(definition, 'bay_id');
    const serviceId = requireString(definition, 'service_id');
    const requestedDurationSeconds = requireInteger(definition, 'requested_duration_seconds', 1);
    const stationId = definition.station_id === undefined ? station.config.stationId : requireString(definition, 'station_id');
    const format = definition.format ?? DEVICE_PROOF_FORMATS.android;
    if (format !== DEVICE_PROOF_FORMATS.android) {
      throw new Error(
        `device_proof: format "${String(format)}" - the simulator signs android-key proofs only; an ` +
          'apple-appattest proof needs the authenticator data of an App Attest key',
      );
    }

    const transcriptHash = new Uint8Array(randomBytes(32));
    const deviceProof = signDeviceProof({
      format,
      devicePrivateKey: p256Scalar(privateKeyPem),
      proofInput: deviceProofInput({ transcriptHash, stationId, passId, counter, bayId, serviceId, requestedDurationSeconds }),
    });

    const outputs: Record<Output, unknown> = {
      deviceProof,
      transcriptHash: Buffer.from(transcriptHash).toString('base64'),
    };
    for (const [name, output] of wanted) {
      context.captured.set(name, outputs[output]);
    }
  }
}
