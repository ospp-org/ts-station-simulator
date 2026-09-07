/**
 * traversal-capture.ts — a live station that records every MQTT packet it sends
 * and receives, verbatim, in both directions.
 *
 * Written for the integrator-guide traversal: the guide must be written from what
 * actually crosses the wire, so this taps mqtt.js's `packetsend` / `packetreceive`
 * events, which fire on the RAW MQTT packet — CONNECT, CONNACK, SUBSCRIBE, SUBACK,
 * PUBLISH (both directions), PUBACK, PINGREQ/PINGRESP, DISCONNECT — including every
 * MQTT 5 property. Nothing here interprets or summarises; the JSON envelope is
 * recorded as parsed JSON only so the NDJSON stays one line per frame.
 *
 * Not a scenario runner. It registers the same 20 handlers `simulator connect`
 * does, so the server's requests get real answers, and it takes station-originated
 * sends from a control file so a second shell can drive the flow step by step.
 *
 * Usage:
 *   npx tsx scripts/traversal-capture.ts --station stn_xxx --target uat \
 *     --out docs/traversal-captures/wire/stn_xxx.ndjson --ctl /tmp/ctl
 *
 * Control file: one command per line, appended by the driver.
 *   note <text>                             -- marker record in the capture
 *   boot                                    -- publish BootNotification
 *   send <ACTION> <Request|Response|Event> <json> [correlationId]
 *   quit [--will|--clean]                   -- disconnect (default clean)
 */
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Station } from '../src/station/Station.js';
import { loadTarget } from '../src/cli/config.js';
import { deriveBays } from '../src/cli/connectBays.js';
import { loadBrokerArtifacts } from '../src/cli/artifacts.js';
import { OsppAction, MessageType } from '@ospp/protocol';
import type { Handler } from '../src/station/Station.js';
import { BootNotificationHandler } from '../src/handlers/BootNotificationHandler.js';
import { HeartbeatHandler } from '../src/handlers/HeartbeatHandler.js';
import { StartServiceHandler } from '../src/handlers/StartServiceHandler.js';
import { StopServiceHandler } from '../src/handlers/StopServiceHandler.js';
import { ReserveBayHandler } from '../src/handlers/ReserveBayHandler.js';
import { CancelReservationHandler } from '../src/handlers/CancelReservationHandler.js';
import { GetConfigurationHandler } from '../src/handlers/GetConfigurationHandler.js';
import { ChangeConfigurationHandler } from '../src/handlers/ChangeConfigurationHandler.js';
import { ResetHandler } from '../src/handlers/ResetHandler.js';
import { UpdateFirmwareHandler } from '../src/handlers/UpdateFirmwareHandler.js';
import { GetDiagnosticsHandler } from '../src/handlers/GetDiagnosticsHandler.js';
import { SetMaintenanceModeHandler } from '../src/handlers/SetMaintenanceModeHandler.js';
import { UpdateServiceCatalogHandler } from '../src/handlers/UpdateServiceCatalogHandler.js';
import { TriggerMessageHandler } from '../src/handlers/TriggerMessageHandler.js';
import { CertificateInstallHandler } from '../src/handlers/CertificateInstallHandler.js';
import { TriggerCertificateRenewalHandler } from '../src/handlers/TriggerCertificateRenewalHandler.js';
import { DataTransferHandler } from '../src/handlers/DataTransferHandler.js';
import { StatusNotificationHandler } from '../src/handlers/StatusNotificationHandler.js';
import { MeterValuesHandler } from '../src/handlers/MeterValuesHandler.js';
import { SecurityEventHandler } from '../src/handlers/SecurityEventHandler.js';

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (dflt !== undefined) return dflt;
  throw new Error(`missing --${name}`);
}

const stationId = arg('station');
const targetName = arg('target', 'uat');
const outPath = arg('out', `docs/traversal-captures/wire/${stationId}.ndjson`);
const ctlPath = arg('ctl', `/tmp/traversal-ctl-${stationId}`);
const bayCount = Number(arg('bays', '2'));

mkdirSync(dirname(outPath), { recursive: true });

let seq = 0;
async function rec(dir: string, kind: string, data: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ seq: ++seq, t: new Date().toISOString(), dir, kind, ...data });
  await appendFile(outPath, line + '\n');
}

/** Buffers are recorded as parsed JSON when they are JSON, else as base64. */
function decodePayload(p: unknown): unknown {
  if (p === undefined || p === null) return undefined;
  const buf = Buffer.isBuffer(p) ? p : Buffer.from(String(p));
  const s = buf.toString('utf8');
  try { return JSON.parse(s); } catch { return { _base64: buf.toString('base64') }; }
}

/** mqtt.js packet → a plain object with every field that matters on the wire. */
function packetShape(pkt: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { cmd: pkt['cmd'] };
  for (const k of ['messageId', 'qos', 'retain', 'dup', 'topic', 'returnCode', 'reasonCode',
    'sessionPresent', 'granted', 'clientId', 'protocolVersion', 'protocolId', 'clean',
    'keepalive', 'username']) {
    if (pkt[k] !== undefined) out[k] = pkt[k];
  }
  if (pkt['password'] !== undefined) out['password'] = '<redacted>';
  if (pkt['properties'] !== undefined) {
    const props = { ...(pkt['properties'] as Record<string, unknown>) };
    if (props['authenticationData']) props['authenticationData'] = '<redacted>';
    out['properties'] = props;
  }
  if (pkt['will'] !== undefined) {
    const w = { ...(pkt['will'] as Record<string, unknown>) };
    w['payload'] = decodePayload(w['payload']);
    out['will'] = w;
  }
  if (pkt['payload'] !== undefined) out['payload'] = decodePayload(pkt['payload']);
  if (Array.isArray(pkt['subscriptions'])) out['subscriptions'] = pkt['subscriptions'];
  return out;
}

async function main(): Promise<void> {
  const target = await loadTarget(targetName);
  const resolveP = (s: string | undefined) => s?.replace('{{stationId}}', stationId);
  const tls = target.certs ? {
    key: resolveP(target.certs.keyPattern) ?? resolveP(target.certs.key),
    cert: resolveP(target.certs.certPattern) ?? resolveP(target.certs.cert),
    chain: resolveP(target.certs.stationCaChain),
    serverCa: resolveP(target.certs.serverCa),
  } : undefined;

  const persisted = await loadBrokerArtifacts(stationId, target.certs);
  const effectiveMqttUrl = persisted.brokerUri ?? target.mqttUrl;
  if (tls && persisted.brokerRootCaPath) tls.serverCa = persisted.brokerRootCaPath;

  // Bay ids are ASSIGNED BY THE SERVER in the provisioning response and are opaque
  // (`bay_` + 32 hex). deriveBays() computes `bay_<stationHex><NN>` locally instead,
  // which is a different string — so the persisted response wins whenever it exists.
  // Recorded rather than worked around silently: this is the provisioning→boot seam.
  const derived = deriveBays(stationId, bayCount, new Map()).bays;
  let bays = derived;
  let bayIdSource = 'deriveBays(local)';
  const baysFile = (target.certs?.key ?? target.certs?.keyPattern ?? '')
    .replace('{{stationId}}', stationId)
    .replace(/-key\.pem$/, '-bays.json');
  if (baysFile !== '' && existsSync(baysFile)) {
    const persistedBays = JSON.parse(await readFile(baysFile, 'utf8')) as
      { bays: { bayId: string; bayNumber: number }[] };
    bays = persistedBays.bays.map((b) => ({
      ...derived.find((d) => d.bayNumber === b.bayNumber)!,
      bayId: b.bayId,
      bayNumber: b.bayNumber,
    }));
    bayIdSource = baysFile;
  }
  await rec('meta', 'bay-ids', {
    source: bayIdSource,
    derivedLocally: derived.map((b) => b.bayId),
    used: bays.map((b) => b.bayId),
    match: JSON.stringify(derived.map((b) => b.bayId)) === JSON.stringify(bays.map((b) => b.bayId)),
  });

  await rec('meta', 'start', {
    stationId, target: targetName, mqttUrl: effectiveMqttUrl,
    persistedBrokerUri: persisted.brokerUri ?? null,
    wireProtocolVersion: process.env['OSPP_PROTOCOL_VERSION'] ?? '(sdk default)',
    tlsFiles: tls,
  });

  const station = new Station(
    {
      stationId,
      firmwareVersion: '1.0.0',
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      serialNumber: `SIM-${Date.now()}`,
      bayCount,
      timezone: 'Europe/Bucharest',
      bays,
      behavior: {
        acceptRate: 1.0,
        responseDelayMs: [0, 0] as [number, number],
        heartbeatIntervalSec: 60,
        meterValuesIntervalSec: 30,
        autoRetryBoot: false,
      },
    },
    { mqttUrl: effectiveMqttUrl, stationId, tls },
  );

  const reg = (a: OsppAction, h: unknown) => station.registerHandler(a, h as Handler);
  reg(OsppAction.BOOT_NOTIFICATION, new BootNotificationHandler());
  reg(OsppAction.HEARTBEAT, new HeartbeatHandler());
  reg(OsppAction.START_SERVICE, new StartServiceHandler());
  reg(OsppAction.STOP_SERVICE, new StopServiceHandler());
  reg(OsppAction.RESERVE_BAY, new ReserveBayHandler());
  reg(OsppAction.CANCEL_RESERVATION, new CancelReservationHandler());
  reg(OsppAction.GET_CONFIGURATION, new GetConfigurationHandler());
  reg(OsppAction.CHANGE_CONFIGURATION, new ChangeConfigurationHandler());
  reg(OsppAction.RESET, new ResetHandler());
  reg(OsppAction.UPDATE_FIRMWARE, new UpdateFirmwareHandler());
  reg(OsppAction.GET_DIAGNOSTICS, new GetDiagnosticsHandler());
  reg(OsppAction.SET_MAINTENANCE_MODE, new SetMaintenanceModeHandler());
  reg(OsppAction.UPDATE_SERVICE_CATALOG, new UpdateServiceCatalogHandler());
  reg(OsppAction.TRIGGER_MESSAGE, new TriggerMessageHandler());
  reg(OsppAction.CERTIFICATE_INSTALL, new CertificateInstallHandler());
  reg(OsppAction.TRIGGER_CERTIFICATE_RENEWAL, new TriggerCertificateRenewalHandler());
  reg(OsppAction.DATA_TRANSFER, new DataTransferHandler());
  reg(OsppAction.STATUS_NOTIFICATION, new StatusNotificationHandler());
  reg(OsppAction.METER_VALUES, new MeterValuesHandler());
  reg(OsppAction.SECURITY_EVENT, new SecurityEventHandler());

  // Tap the raw client the moment it exists. `connect()` assigns it synchronously
  // before the socket resolves, so a short poll is enough and costs one tick.
  const tapWhenReady = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const client = (station as unknown as { connection: { client: unknown } })
        .connection.client as { on(ev: string, cb: (p: unknown) => void): void } | null;
      if (client) {
        client.on('packetsend', (p) => { void rec('out', 'mqtt', packetShape(p as Record<string, unknown>)); });
        client.on('packetreceive', (p) => { void rec('in', 'mqtt', packetShape(p as Record<string, unknown>)); });
        await rec('meta', 'tap-attached', {});
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    await rec('meta', 'tap-FAILED', { note: 'client handle never appeared; capture is BLIND' });
  };

  const connectPromise = station.connect();
  await tapWhenReady();
  await connectPromise;
  await rec('meta', 'connected', { lifecycle: station.lifecycle });

  // ---- control loop -------------------------------------------------------
  if (!existsSync(ctlPath)) await writeFile(ctlPath, '');
  let consumed = 0;
  let quit = false;
  const ackPath = `${ctlPath}.ack`;

  while (!quit) {
    const lines = (await readFile(ctlPath, 'utf8')).split('\n').filter((l) => l.trim() !== '');
    while (consumed < lines.length) {
      const line = lines[consumed++]!.trim();
      const [cmd, ...rest] = line.split(/\s+/);
      try {
        if (cmd === 'note') {
          await rec('meta', 'note', { text: rest.join(' ') });
        } else if (cmd === 'boot') {
          await station.retryBoot();
        } else if (cmd === 'quit') {
          quit = true;
          await station.disconnect();
        } else if (cmd === 'send') {
          const action = rest[0] as OsppAction;
          const mType = rest[1] as MessageType;
          const jsonStart = line.indexOf('{');
          const jsonEnd = line.lastIndexOf('}');
          const payload = jsonStart >= 0 ? JSON.parse(line.slice(jsonStart, jsonEnd + 1)) : {};
          const tail = line.slice(jsonEnd + 1).trim();
          const corr = tail !== '' ? tail : undefined;
          await station.sender.send(action, mType, payload, corr);
        } else {
          await rec('meta', 'ctl-unknown', { line });
        }
        await appendFile(ackPath, `OK ${line}\n`);
      } catch (err) {
        await rec('meta', 'ctl-error', { line, error: String(err) });
        await appendFile(ackPath, `ERR ${line} :: ${String(err)}\n`);
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  await rec('meta', 'stopped', {});
  process.exit(0);
}

main().catch(async (err) => {
  await rec('meta', 'fatal', { error: String(err), stack: (err as Error)?.stack });
  console.error(err);
  process.exit(1);
});
