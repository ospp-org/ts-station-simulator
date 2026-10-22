import { readFileSync } from 'node:fs';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';
import {
  buildAndroidKeyAttestation,
  createAttestationRoot,
  type AndroidKeyAttestation,
  type AttestationRoot,
  type AttestationSecurityLevel,
} from '../../offline/androidKeyAttestation.js';

/**
 * Attest a fresh device key for an offline pass, as a phone's Android Keystore would.
 *
 * csms-server issues no offline pass for a device key whose hardware backing it has not
 * verified (spec/profiles/offline/app-contract.md 3.6): the first pass request for a key carries
 * the platform's attestation of it, made over a one-time challenge the server issued. This step
 * makes that attestation locally - see androidKeyAttestation.ts for what it carries and why it
 * roots in a test root - and captures what the issuance request sends:
 *
 *   - action: api_call
 *     method: POST
 *     url: "{{target_url}}/api/v1/offline/attestation-challenges"
 *     expect_status: 200
 *     capture:
 *       attestationChallenge: "challenge"
 *   - action: attest_device
 *     challenge: "{{captured.attestationChallenge}}"
 *     capture:
 *       devicePublicKey: devicePublicKey
 *       deviceKeyAttestation: deviceKeyAttestation
 *
 * `capture:` maps a captured name to one of the step's three outputs: `devicePublicKey`,
 * `deviceKeyAttestation` (the request's object, typed) and `devicePrivateKeyPem`.
 *
 * `root: trusted` (the default) roots the chain in the root of SIM_ATTESTATION_ROOT_CERT and
 * SIM_ATTESTATION_ROOT_KEY - the test root the target server trusts; `root: untrusted` in a root
 * minted for this step alone, which no server trusts. `security_level` is `TrustedEnvironment`
 * by default; `Software` is the level a server refuses.
 */
const OUTPUTS = ['devicePublicKey', 'deviceKeyAttestation', 'devicePrivateKeyPem'] as const;
type Output = (typeof OUTPUTS)[number];

const LEVELS: readonly AttestationSecurityLevel[] = ['Software', 'TrustedEnvironment', 'StrongBox'];

function configuredRoot(): AttestationRoot {
  const certPath = process.env.SIM_ATTESTATION_ROOT_CERT;
  const keyPath = process.env.SIM_ATTESTATION_ROOT_KEY;
  if (!certPath || !keyPath) {
    throw new Error(
      'attest_device: a trusted attestation needs the test root the target trusts - set ' +
        'SIM_ATTESTATION_ROOT_CERT and SIM_ATTESTATION_ROOT_KEY to its certificate and key, or ' +
        'declare `root: untrusted` for a refusal.',
    );
  }
  return { certPem: readFileSync(certPath, 'utf-8'), keyPem: readFileSync(keyPath, 'utf-8') };
}

export class AttestDeviceStep implements Step {
  async execute(definition: StepDefinition, context: ScenarioContext, _station: Station): Promise<void> {
    const challenge = definition.challenge;
    if (typeof challenge !== 'string' || challenge === '') {
      throw new Error(
        'attest_device requires a "challenge" - normally "{{captured.<name>}}" from POST ' +
          '/api/v1/offline/attestation-challenges.',
      );
    }

    const capture = definition.capture;
    if (!capture || typeof capture !== 'object' || Array.isArray(capture) || Object.keys(capture).length === 0) {
      throw new Error('attest_device requires a "capture:" map from captured names to its outputs');
    }
    const wanted = Object.entries(capture as Record<string, unknown>).map(([name, output]) => {
      if (typeof output !== 'string' || !(OUTPUTS as readonly string[]).includes(output)) {
        throw new Error(`attest_device: "${String(output)}" is not one of its outputs (${OUTPUTS.join(', ')})`);
      }
      return [name, output as Output] as const;
    });

    const level = definition.security_level ?? 'TrustedEnvironment';
    if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) {
      throw new Error(`attest_device: security_level "${String(level)}" is not one of ${LEVELS.join(', ')}`);
    }

    const rootKind = definition.root ?? 'trusted';
    if (rootKind !== 'trusted' && rootKind !== 'untrusted') {
      throw new Error(`attest_device: root "${String(rootKind)}" is neither trusted nor untrusted`);
    }
    const root =
      rootKind === 'trusted' ? configuredRoot() : await createAttestationRoot('CN=Untrusted attestation root');

    const attestation: AndroidKeyAttestation = await buildAndroidKeyAttestation({
      challenge,
      root,
      securityLevel: level as AttestationSecurityLevel,
    });
    for (const [name, output] of wanted) {
      context.captured.set(name, attestation[output]);
    }
  }
}
