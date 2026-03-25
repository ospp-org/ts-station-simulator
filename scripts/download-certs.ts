#!/usr/bin/env tsx
/**
 * Download mTLS certificates for all stations in a target's station_pool.
 *
 * Usage: tsx scripts/download-certs.ts <target>
 * Example: tsx scripts/download-certs.ts sandbox
 */

import { loadTarget } from '../src/cli/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const targetName = process.argv[2];
if (!targetName) {
  console.error('Usage: tsx scripts/download-certs.ts <target>');
  process.exit(1);
}

interface AuthResponse {
  token: string;
}

interface CertificatesResponse {
  sandbox_deviation?: string;
  ca: string;
  stations: Record<string, { cert: string; key: string }>;
}

async function main(): Promise<void> {
  const target = await loadTarget(targetName);

  if (!target.credentials) {
    console.error('Target "%s" has no credentials configured', targetName);
    process.exit(1);
  }

  if (!target.stationPool?.length) {
    console.error('Target "%s" has no station_pool configured', targetName);
    process.exit(1);
  }

  console.log('Target: %s (%s)', targetName, target.csmsUrl);
  console.log('Stations: %d in pool', target.stationPool.length);
  console.log();

  // Authenticate
  console.log('Authenticating as %s...', target.credentials.email);
  const authRes = await fetch(`${target.csmsUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: target.credentials.email,
      password: target.credentials.password,
    }),
  });

  if (!authRes.ok) {
    console.error('Auth failed: %d %s', authRes.status, await authRes.text());
    process.exit(1);
  }

  const auth = await authRes.json() as AuthResponse;
  console.log('Authenticated. Token received.');
  console.log();

  // Download certificates
  console.log('Downloading certificates...');
  const certsRes = await fetch(`${target.csmsUrl}/api/v1/simulator/certificates`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });

  if (!certsRes.ok) {
    console.error('Certificate download failed: %d %s', certsRes.status, await certsRes.text());
    process.exit(1);
  }

  const data = await certsRes.json() as CertificatesResponse;
  const stationIds = Object.keys(data.stations);
  console.log('Received %d station certificates', stationIds.length);
  console.log();

  const certsDir = path.resolve(`certs/${targetName}`);
  await fs.mkdir(certsDir, { recursive: true });

  // Save shared CA cert
  const caPath = path.join(certsDir, 'ca.pem');
  await fs.writeFile(caPath, data.ca, 'utf-8');
  console.log('  CA: %s', caPath);

  // Save per-station certs: {stationId}.pem and {stationId}-key.pem
  let saved = 0;
  for (const [stationId, bundle] of Object.entries(data.stations)) {
    const certPath = path.join(certsDir, `${stationId}.pem`);
    const keyPath = path.join(certsDir, `${stationId}-key.pem`);

    await fs.writeFile(certPath, bundle.cert, 'utf-8');
    await fs.writeFile(keyPath, bundle.key, { mode: 0o600, encoding: 'utf-8' } as fs.WriteFileOptions);

    saved++;
    console.log('  %s: cert + key saved', stationId);
  }

  console.log();
  console.log('Done. %d stations saved to certs/%s/', saved, targetName);
}

main().catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
