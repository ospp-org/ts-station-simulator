import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { persistBrokerArtifacts } from '../../cli/artifacts.js';

/**
 * THE RESTART PROOF for `serverVerifyKey`.
 *
 * `spec/04-flows.md` §2 names five fields a station MUST write exactly as
 * received. `serverVerifyKey` is the one that cannot be recovered: it is the
 * public key the server signs with, so it is what an `OfflinePass` signature and a
 * `ServerSignedAuth` are verified against, it travels on ZERO of the MQTT schemas,
 * and the only other way to obtain it is a fresh provisioning response — which
 * costs an operator-issued token. Lose it and a real pass is indistinguishable
 * from a fabricated one.
 *
 * The existing coverage (artifacts.test.ts) writes and reads inside ONE process.
 * That proves the pair of functions agree; it does not prove the value survives a
 * restart, because a same-process read could be answered from anything the module
 * still holds. This file spawns a REAL second process — cold module registry,
 * nothing shared but the filesystem — so the only thing that can carry the value
 * across is the file itself.
 */
let dir: string;

const KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5',
  'd6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7',
  '-----END PUBLIC KEY-----',
  '',
].join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-key-restart-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Read the artifacts back in a brand-new node process.
 *
 * `tsx` rather than the built `dist/`, so the proof is about the source in this
 * working tree and cannot be answered by a stale build.
 */
function readBackFromAFreshProcess(stationId: string, keyTemplate: string): {
  serverVerifyKey?: string;
  serverVerifyKeyPath?: string;
  rootCaThumbprint?: string;
  brokerUri?: string;
} {
  // A FILE, not `tsx -e`: the eval path compiles to CJS, where a top-level await is
  // a transform error. `.mts` also makes the child unambiguously ESM, which is what
  // the module under test is.
  const probe = join(dir, 'probe.mts');
  writeFileSync(
    probe,
    [
      `import { loadBrokerArtifacts } from ${JSON.stringify(resolve('src/cli/artifacts.ts'))};`,
      `const result = await loadBrokerArtifacts(${JSON.stringify(stationId)}, { key: ${JSON.stringify(keyTemplate)} });`,
      'process.stdout.write(JSON.stringify(result));',
      '',
    ].join('\n'),
    'utf-8',
  );
  const out = execFileSync('npx', ['tsx', probe], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return JSON.parse(out) as ReturnType<typeof readBackFromAFreshProcess>;
}

describe('serverVerifyKey survives a restart', () => {
  it('a SECOND process reads back the exact bytes the first one was given', () => {
    const stationId = 'stn_restart01';
    const keyPath = join(dir, `${stationId}-key.pem`);

    // Process 1: persist, exactly as `provision` does with a live response.
    const written = persistBrokerArtifacts(keyPath, {
      serverVerifyKey: KEY_PEM,
      rootCaThumbprint: 'AA:BB:CC',
      brokerRootCa: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',
      mqttConfig: { brokerUri: 'mqtts://broker.test:8883' },
    });

    return written.then(paths => {
      expect(paths.serverVerifyKeyPath).toBe(join(dir, `${stationId}-server-verify-key.pem`));

      // Process 2: a different node process, cold module state.
      const readBack = readBackFromAFreshProcess(stationId, join(dir, '{{stationId}}-key.pem'));

      expect(readBack.serverVerifyKey).toBe(KEY_PEM);
      expect(readBack.serverVerifyKeyPath).toBe(paths.serverVerifyKeyPath);
      // The other two of the five, in the same breath — the restart is one event.
      expect(readBack.rootCaThumbprint).toBe('AA:BB:CC');
      expect(readBack.brokerUri).toBe('mqtts://broker.test:8883');
    });
  }, 180_000);

  it('the bytes on disk are VERBATIM — no re-armouring, no newline normalisation', async () => {
    const stationId = 'stn_restart02';
    const keyPath = join(dir, `${stationId}-key.pem`);
    await persistBrokerArtifacts(keyPath, { serverVerifyKey: KEY_PEM });

    // "exactly as received": a PEM this process rewrote is no longer the bytes the
    // server sent, and a signature check against a re-encoded key is a different
    // check.
    const onDisk = readFileSync(join(dir, `${stationId}-server-verify-key.pem`), 'utf-8');
    expect(onDisk).toBe(KEY_PEM);
  });

  it('CONTROL — a fresh process finds NOTHING when nothing was persisted', () => {
    // The positive result above means something only if this one comes back empty:
    // otherwise the reader could be answering from a path that happens to exist for
    // another reason.
    const readBack = readBackFromAFreshProcess('stn_neverwritten', join(dir, '{{stationId}}-key.pem'));
    expect(readBack.serverVerifyKey).toBeUndefined();
    expect(readBack.serverVerifyKeyPath).toBeUndefined();
    expect(readBack.rootCaThumbprint).toBeUndefined();
    expect(readBack.brokerUri).toBeUndefined();
  }, 180_000);
});
