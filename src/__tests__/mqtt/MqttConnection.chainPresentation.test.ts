import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * CONS-133 — the connect path presented the LEAF ALONE.
 *
 * The Station CA chain returned by provisioning is written to disk
 * (`<stationId>-chain.pem`) and was then never read back at connect time:
 * `opts.cert` came from the bare leaf file. The broker therefore had to
 * supply the intermediate from its own bundle for the handshake to build a
 * path, which means the whole simulator suite was blind to any defect in the
 * chain the station actually stores — CONS-115 included, where a replay after
 * a Station CA rotation leaves a station holding a leaf its stored chain
 * cannot verify. That station connects fine under test and bricks in the field.
 *
 * A station MUST present leaf + intermediate(s), leaf first (RFC 8446 §4.4.2).
 *
 * The two provisioning writers disagree on the chain file's format, so the
 * presented bundle is asserted against both:
 *   - `cli/index.ts` `provision`  → chain file holds the CA chain ONLY
 *   - `ProvisionStep` / `ProvisionStationPoolStep` → chain file holds leaf + CA chain
 */

const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

class FakeMqttClient extends EventEmitter {
  stream?: { getProtocol?: () => string | null };
  end = vi.fn((_force: boolean, _opts: object, cb?: () => void) => {
    cb?.();
  });
  subscribe = vi.fn();
  publish = vi.fn();
}

vi.mock('mqtt', () => ({
  connect: vi.fn((url: string, opts: Record<string, unknown>) => {
    connectCalls.push({ url, opts });
    return new FakeMqttClient();
  }),
}));

const { MqttConnection } = await import('../../mqtt/MqttConnection.js');

// PEM-shaped fixtures with distinguishable bodies. The fake mqtt client never
// parses them; what is under test is which blocks reach `opts.cert`, in what
// order. A future arc asserting that a leaf does NOT verify against its stored
// chain needs real certificates — this one only needs block identity.
const LEAF = `-----BEGIN CERTIFICATE-----\nTEEEEEAF\n-----END CERTIFICATE-----\n`;
const INTERMEDIATE = `-----BEGIN CERTIFICATE-----\nSTATIONCA\n-----END CERTIFICATE-----\n`;
const ROOT = `-----BEGIN CERTIFICATE-----\nROOTCA\n-----END CERTIFICATE-----\n`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ospp-chain-'));

function fixture(name: string, contents: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, contents);
  return p;
}

const keyPath = fixture('stn_chain-key.pem', '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n');
const leafPath = fixture('stn_chain.pem', LEAF);
/** `cli/index.ts:795` shape — `fs.writeFile(chainPath, data.stationCaChain)`. */
const chainCaOnlyPath = fixture('stn_chain-chain-caonly.pem', INTERMEDIATE + ROOT);
/** `ProvisionStep.ts:148-152` shape — `cert + data.stationCaChain`. */
const chainWithLeafPath = fixture('stn_chain-chain-withleaf.pem', LEAF + INTERMEDIATE + ROOT);

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function presentedCert(): string {
  return String(connectCalls[0].opts.cert);
}

function blockCount(pem: string, marker: string): number {
  return pem.split(marker).length - 1;
}

describe('MqttConnection — presents the certificate CHAIN, not the leaf alone (CONS-133)', () => {
  beforeEach(() => {
    connectCalls.length = 0;
  });

  it('presents leaf + intermediate when the chain file holds the CA chain only (cli `provision` format)', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: 'stn_chain',
      tls: { key: keyPath, cert: leafPath, chain: chainCaOnlyPath },
    });
    conn.connect();

    const presented = presentedCert();
    expect(presented).toContain('TEEEEEAF');
    expect(presented).toContain('STATIONCA');
    // Leaf first — a TLS peer reads the end-entity certificate from position 0.
    expect(presented.indexOf('TEEEEEAF')).toBeLessThan(presented.indexOf('STATIONCA'));
  });

  it('presents leaf + intermediate when the chain file already embeds the leaf (ProvisionStep format), without duplicating it', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: 'stn_chain',
      tls: { key: keyPath, cert: leafPath, chain: chainWithLeafPath },
    });
    conn.connect();

    const presented = presentedCert();
    expect(presented).toContain('TEEEEEAF');
    expect(presented).toContain('STATIONCA');
    expect(blockCount(presented, 'TEEEEEAF')).toBe(1);
    expect(blockCount(presented, '-----BEGIN CERTIFICATE-----')).toBe(3);
  });

  it('carries every certificate in the stored chain through to the wire (the bytes a chain defect would live in)', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: 'stn_chain',
      tls: { key: keyPath, cert: leafPath, chain: chainCaOnlyPath },
    });
    conn.connect();

    const presented = presentedCert();
    expect(blockCount(presented, '-----BEGIN CERTIFICATE-----')).toBe(3);
    expect(presented).toContain('ROOTCA');
  });

  it('UNCHANGED: with no chain configured, the leaf alone is still presented', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: 'stn_chain',
      tls: { key: keyPath, cert: leafPath },
    });
    conn.connect();

    const presented = presentedCert();
    expect(blockCount(presented, '-----BEGIN CERTIFICATE-----')).toBe(1);
    expect(presented).toContain('TEEEEEAF');
  });

  it('getTlsPaths() surfaces the chain path so a scenario can assert on what is presented', () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: 'stn_chain',
      tls: { key: keyPath, cert: leafPath, chain: chainCaOnlyPath },
    });
    expect(conn.getTlsPaths()?.chain).toBe(chainCaOnlyPath);
  });
});
