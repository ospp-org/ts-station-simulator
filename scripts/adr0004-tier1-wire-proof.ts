/**
 * ADR-0004 TIER 1 — the wire proof, against live UAT.
 *
 * Proves the invariant the durable ban broke (ADR-0004 §4.1):
 *
 *   a disabled station is KICKED off the broker, RECONNECTS on its own, and is
 *   STILL RENEWABLE — so it is never bricked at cert expiry.
 *
 * Hop by hop:
 *   H1  provision + connect + boot a fresh station on UAT          (baseline)
 *   H2  disable it via PATCH /active                               (ADR-0003 teeth, live on UAT)
 *   H3  kick it via the EMQX admin API                             (byte-identical to KickStationOffBrokerAction)
 *   H4  the sim OBSERVES the kick as broker-initiated              (Part 1 observability)
 *   H5  CONTROL: ban it, prove the reconnect is REFUSED, then unban
 *       (this is what the OLD TIER 1 did — the brick, demonstrated on the real broker.
 *        Without it, H6 succeeding proves nothing: a check that cannot fail is not a check.)
 *   H6  the sim RECONNECTS unaided                                 (no durable bar)
 *   H7  trigger a REAL cert-renewal on the still-disabled station and complete
 *       the full handshake: TriggerCertificateRenewal -> CSR -> CertificateInstall
 *       -> re-handshake presenting the renewed leaf
 *   H8  re-enable                                                  (reversible)
 *   H9  teardown to baseline
 *
 * WHAT THIS DOES NOT PROVE (stated up front, not discovered later): UAT runs
 * master, which has neither the is_active command gate nor the disable->kick
 * wiring. So H3 issues the kick that KickStationOffBrokerAction would issue,
 * rather than proving PATCH /active fires it; and the allow-list itself is
 * proven by the server-side feature tests, not here. What IS proven here is the
 * half no fixture can establish: that a kicked station comes BACK on the real
 * broker, and that renewal reaches it once it has.
 *
 * Run:
 *   set -a; source ~/.config/osp-e2e-secrets.env; set +a
 *   npx tsx scripts/adr0004-tier1-wire-proof.ts
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import axios from 'axios';
import { OsppAction } from '@ospp/protocol';
import {
  bootstrapPool,
  teardownPool,
  platformAdminCredsFromEnv,
  type PoolBootstrapHandle,
} from '../src/scenarios/bootstrap/PoolBootstrap.js';
import type { TargetConfig } from '../src/scenarios/ScenarioRunner.js';
import { Station, type Handler } from '../src/station/Station.js';
import { BootNotificationHandler } from '../src/handlers/BootNotificationHandler.js';
import { TriggerCertificateRenewalHandler } from '../src/handlers/TriggerCertificateRenewalHandler.js';
import { CertificateInstallHandler } from '../src/handlers/CertificateInstallHandler.js';
import { CONNACK_REASON_NOT_AUTHORIZED } from '../src/mqtt/MqttConnection.js';

const execFileAsync = promisify(execFile);

const UAT_SSH = '89.33.25.117';
const MQTT_URL = 'mqtts://mqtt-uat.onestoppay.ro:8883';
const API_BASE = 'https://api-uat.onestoppay.ro';

const target: TargetConfig = {
  mqttUrl: MQTT_URL,
  apiBaseUrl: API_BASE,
  tls: {
    keyPattern: 'certs/uat/{{stationId}}-key.pem',
    certPattern: 'certs/uat/{{stationId}}.pem',
    minVersion: 'TLSv1.2',
  },
};

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

const results: Array<{ hop: string; ok: boolean; detail: string }> = [];

function record(hop: string, ok: boolean, detail: string): void {
  results.push({ hop, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${hop} — ${detail}`);
}

function assert(hop: string, condition: boolean, detail: string): void {
  record(hop, condition, detail);
  if (!condition) {
    throw new Error(`${hop} FAILED: ${detail}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* UAT side-channels: the EMQX admin API and the DB, over SSH          */
/* ------------------------------------------------------------------ */

/**
 * Single-quote for POSIX sh. Load-bearing: the snippet passes through TWO
 * shells (the host login shell, then the container's sh). Double-quoting it
 * would let the HOST expand `$(...)` and `$VAR` — running curl on the host,
 * where `emqx:18083` does not resolve and EMQX_DASHBOARD_PASSWORD is unset.
 * Single quotes keep it literal until the inner sh, which is what must expand it.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run a shell snippet inside a UAT container. Read-only unless the snippet says otherwise. */
async function uatExec(container: string, snippet: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'ssh',
    ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', UAT_SSH, `docker exec ${container} sh -c ${shQuote(snippet)} < /dev/null`],
    { env: { ...process.env, SSH_AUTH_SOCK: '' }, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout.trim();
}

/**
 * The EMQX admin calls, issued exactly as the server issues them:
 * login -> bearer -> the endpoint. `kick` mirrors KickStationOffBrokerAction;
 * `ban`/`unban` mirror the code TIER 1 REMOVED, used here only as the control
 * that gives the reconnect assertion a failure mode.
 */
async function emqxAdmin(method: 'kick' | 'ban' | 'unban', clientId: string): Promise<string> {
  const curl = {
    kick: `curl -s -o /dev/null -w "%{http_code}" -X DELETE "http://emqx:18083/api/v5/clients/${clientId}" -H "Authorization: Bearer $TOKEN"`,
    ban: `curl -s -o /dev/null -w "%{http_code}" -X POST "http://emqx:18083/api/v5/banned" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"as":"clientid","who":"${clientId}","by":"adr0004-wire-proof","reason":"control: prove the ban refuses"}'`,
    unban: `curl -s -o /dev/null -w "%{http_code}" -X DELETE "http://emqx:18083/api/v5/banned/clientid/${clientId}" -H "Authorization: Bearer $TOKEN"`,
  }[method];

  // The dashboard password is read from the container's OWN env — never hardcoded
  // here, so this script carries no credential and is safe to commit.
  return uatExec(
    'csms-app-uat',
    `TOKEN=$(curl -s -X POST http://emqx:18083/api/v5/login -H "Content-Type: application/json" ` +
      `-d "{\\"username\\":\\"admin\\",\\"password\\":\\"$EMQX_DASHBOARD_PASSWORD\\"}" ` +
      `| sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p'); ` +
      `[ -z "$TOKEN" ] && { echo "EMQX_LOGIN_FAILED"; exit 1; }; ${curl}`,
  );
}

async function uatSql(sql: string): Promise<string> {
  // psql's own -c argument is double-quoted INSIDE the single-quoted outer
  // snippet, so the SQL's own single quotes survive shQuote's escaping.
  return uatExec('csms-postgres-uat', `psql -U csms_uat -d csms_uat -t -A -F'|' -c ${JSON.stringify(sql)}`);
}

/* ------------------------------------------------------------------ */
/* CSMS admin API, as the platform admin (NULL team — no org header)   */
/* ------------------------------------------------------------------ */

async function platformAdminToken(): Promise<string> {
  const creds = platformAdminCredsFromEnv();
  const { data } = await axios.post(`${API_BASE}/api/v1/auth/login`, creds, { timeout: 30000 });
  const token = (data?.data?.access_token ?? data?.access_token) as string | undefined;
  if (!token) {
    throw new Error(`login returned no access_token: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return token;
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  let handle: PoolBootstrapHandle | undefined;
  let station: Station | undefined;

  try {
    /* ---- H1: provision + connect + boot ---------------------------- */
    console.log('\n=== H1: provision a fresh station on UAT, connect, boot ===');
    handle = await bootstrapPool(target, {
      poolSize: 1,
      bayCount: 2,
      enableOffline: false,
      identityPoolSize: 0,
    });

    const entry = handle.pool.first();
    if (!entry?.keyPath || !entry.certPath) {
      throw new Error('bootstrapPool returned no cert/key paths');
    }
    const stationId = entry.stationId;
    console.log(`    provisioned ${stationId}`);

    station = new Station(
      {
        stationId,
        firmwareVersion: '1.0.0',
        stationModel: 'WashPro X200',
        stationVendor: 'SimCorp',
        serialNumber: `SIM-ADR0004-${Date.now()}`,
        bayCount: 2,
        timezone: 'Europe/Bucharest',
        bays: entry.bayIds.map((bayId, i) => ({
          bayId,
          bayNumber: i + 1,
          services: [{ serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', available: true }],
        })),
        behavior: {
          acceptRate: 1.0,
          responseDelayMs: [0, 0],
          heartbeatIntervalSec: 60,
          meterValuesIntervalSec: 30,
          autoRetryBoot: true,
        },
      },
      {
        mqttUrl: MQTT_URL,
        stationId,
        tls: {
          key: entry.keyPath,
          cert: entry.certPath,
          // Only for a private CA; UAT's 8883 presents a public Let's Encrypt cert.
          serverCa: entry.brokerCaPath && existsSync(entry.brokerCaPath) ? entry.brokerCaPath : undefined,
          minVersion: 'TLSv1.2',
        },
        cleanSession: true,
      },
    );

    const reg = (a: OsppAction, h: unknown): void => station!.registerHandler(a, h as Handler);
    reg(OsppAction.BOOT_NOTIFICATION, new BootNotificationHandler());
    reg(OsppAction.TRIGGER_CERTIFICATE_RENEWAL, new TriggerCertificateRenewalHandler());
    reg(OsppAction.CERTIFICATE_INSTALL, new CertificateInstallHandler());

    await station.connect();
    await station.retryBoot();
    await sleep(2000);

    assert('H1 connect', station.bootAccepted, `booted; TLS=${station.getNegotiatedTlsProtocol()}`);
    const onlineRow = await uatSql(`SELECT is_online, is_active FROM stations WHERE station_id = '${stationId}'`);
    assert('H1 online', onlineRow.startsWith('t|t'), `DB is_online|is_active = ${onlineRow}`);

    /* ---- H2: disable ------------------------------------------------
     * PATCH /active is authorised by a TENANT-SCOPED policy
     * (StationPolicy::maintenance), and bootstrapPool mints its ephemeral
     * tenant_owner internally without exposing the token — a bare platform
     * admin is 403'd. So the flag is set directly in the DB.
     *
     * This is honest because is_active=false is the PRECONDITION here, not the
     * claim: what is under test is that a kicked station reconnects and stays
     * renewable WHILE disabled. Nothing downstream reads how the flag was set —
     * the renewal hop below still goes through the real HTTP + authz path. The
     * auto-stop the API would also fire is irrelevant: this station has no
     * sessions. That PATCH /active itself works is covered server-side.
     */
    console.log('\n=== H2: disable the station (DB precondition — see comment) ===');
    const token = await platformAdminToken();
    const authHeaders = { Authorization: `Bearer ${token}` };

    await uatSql(`UPDATE stations SET is_active = false WHERE station_id = '${stationId}'`);
    const disabledRow = await uatSql(`SELECT is_active FROM stations WHERE station_id = '${stationId}'`);
    assert('H2 disabled', disabledRow === 'f', `DB is_active = ${disabledRow}`);

    /* ---- H3+H4: kick, and OBSERVE it as broker-initiated ------------ */
    console.log('\n=== H3/H4: kick via the EMQX admin API; observe the sever ===');
    // Swallow the rejection at attach time: if the kick call itself fails we
    // want THAT error, not an unhandled watcher rejection racing it to the top.
    const kickWatcher = station.waitForKick(20000).catch((e: unknown) => {
      throw e instanceof Error ? e : new Error(String(e));
    });
    kickWatcher.catch(() => { /* re-awaited below; keeps node from crashing early */ });
    const kickCode = await emqxAdmin('kick', stationId);
    record('H3 kick', kickCode === '204' || kickCode === '200', `EMQX DELETE /api/v5/clients/${stationId} -> HTTP ${kickCode}`);

    const kickReason = await kickWatcher;
    const sev = station.getSeverance();
    assert(
      'H4 kicked',
      sev.kicked && sev.lastCloseCause === 'broker-kick',
      `sim observed BROKER-INITIATED disconnect (cause=${sev.lastCloseCause}, reasonCode=${kickReason ?? 'none'})`,
    );

    /* ---- H5: CONTROL — the ban refuses, so H6 means something ------- */
    console.log('\n=== H5: CONTROL — ban it and prove the reconnect is REFUSED (the old TIER 1 brick) ===');
    const banCode = await emqxAdmin('ban', stationId);
    record('H5 ban', banCode === '200' || banCode === '204', `EMQX POST /api/v5/banned -> HTTP ${banCode}`);
    await sleep(1000);

    const refused = await station.probeReconnect(15000);
    assert(
      'H5 refused',
      refused.outcome === 'refused',
      refused.outcome === 'refused'
        ? `reconnect REFUSED by the broker (reasonCode=${refused.reasonCode ?? 'none'}${
            refused.reasonCode === CONNACK_REASON_NOT_AUTHORIZED ? ' = NotAuthorized' : ''
          }) — this is what the durable ban did, and why a banned station could never be renewed`
        : 'expected the banned station to be refused',
    );

    const unbanCode = await emqxAdmin('unban', stationId);
    record('H5 unban', unbanCode === '204' || unbanCode === '200', `EMQX DELETE /api/v5/banned/clientid/${stationId} -> HTTP ${unbanCode}`);
    await sleep(1000);

    /* ---- H6: reconnect unaided — no durable bar --------------------- */
    console.log('\n=== H6: the station reconnects on its own (TIER 1 leaves nothing durable) ===');
    const accepted = await station.probeReconnect(15000);
    assert(
      'H6 probe',
      accepted.outcome === 'connected',
      'a reconnect attempt is now ACCEPTED by the broker — the same probe that just reported refused',
    );

    await station.connect();
    record('H6 reconnected', true, `MQTT/mTLS re-established unaided; TLS=${station.getNegotiatedTlsProtocol()}`);

    // From here the run is DIAGNOSTIC, not assertive: it records what the server
    // actually does with a reconnected-but-disabled station rather than pinning
    // what we hoped. Asserting the hoped-for state here is precisely the mistake
    // the original branch made in its fixture.
    await station.retryBoot();
    await sleep(4000);
    record(
      'H6 boot',
      station.bootAccepted,
      station.bootAccepted
        ? 'server ACCEPTED BootNotification from the disabled station'
        : 'server REJECTED BootNotification because the station is disabled '
          + '(BootNotificationHandler.php:96 returns before the is_online=true write at :134)',
    );

    const backOnline = await uatSql(`SELECT is_online, is_active FROM stations WHERE station_id = '${stationId}'`);
    record(
      'H6 db state',
      backOnline.startsWith('t|'),
      `DB is_online|is_active = ${backOnline}`
        + (backOnline.startsWith('f|')
          ? ' — NOT online: boot was rejected, so the renewal guard will refuse it'
          : ''),
    );

    /* ---- H7: renewal completes on the DISABLED station -------------- */
    console.log('\n=== H7: cert-renewal on the still-disabled station ===');
    const certBefore = await uatSql(
      `SELECT id, serial_number FROM certificates WHERE station_id = '${stationId}' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    );

    let installed = false;
    station.once('certificate-installed', () => {
      installed = true;
    });

    let triggerAccepted = false;
    try {
      await axios.post(
        `${API_BASE}/api/v1/admin/stations/${stationId}/trigger-cert-renewal`,
        { certificateType: 'MQTTClientCertificate' },
        { headers: authHeaders, timeout: 30000 },
      );
      triggerAccepted = true;
      record('H7 trigger', true, 'POST trigger-cert-renewal -> 202 on a DISABLED station');
    } catch (e: unknown) {
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      const body = axios.isAxiosError(e) ? JSON.stringify(e.response?.data).slice(0, 220) : String(e);
      record('H7 trigger', false, `POST trigger-cert-renewal REFUSED -> HTTP ${status ?? '?'} ${body}`);
    }

    if (!triggerAccepted) {
      record(
        'H7 verdict',
        false,
        'RENEWAL DOES NOT REACH A DISABLED STATION. Removing the ban was necessary but NOT '
          + 'sufficient: the station reconnects (H6) yet its boot is rejected while disabled, so '
          + 'is_online never becomes true and the renewal guard refuses it. ADR-0004 invariant 2 '
          + 'is still broken — by BootNotificationHandler.php:96, which is master behaviour, not TIER 1.',
      );
      throw new Error('H7: renewal refused for a disabled station — see verdict above');
    }

    // The handshake is autonomous from here: the station answers Accepted, mints a
    // CSR, the server signs it and pushes CertificateInstall, the station installs
    // the leaf and re-handshakes mTLS with it.
    for (let i = 0; i < 60 && !installed; i += 1) {
      await sleep(1000);
    }
    assert('H7 installed', installed, 'station installed the renewed leaf and re-handshook mTLS with it');

    await sleep(5000);
    const certAfter = await uatSql(
      `SELECT id, serial_number FROM certificates WHERE station_id = '${stationId}' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    );
    assert(
      'H7 new cert',
      certAfter !== '' && certAfter !== certBefore,
      `a NEW active cert is on record (before=${certBefore || 'none'} after=${certAfter})`,
    );

    const stillDisabled = await uatSql(`SELECT is_active, is_online FROM stations WHERE station_id = '${stationId}'`);
    assert(
      'H7 renewed while disabled',
      stillDisabled.startsWith('f|'),
      `DB is_active|is_online = ${stillDisabled} — renewed WITHOUT being re-enabled: ADR-0004 invariant 2 holds on the wire`,
    );

    /* ---- H8: re-enable --------------------------------------------- */
    console.log('\n=== H8: re-enable ===');
    await uatSql(`UPDATE stations SET is_active = true WHERE station_id = '${stationId}'`);
    const reenabled = await uatSql(`SELECT is_active, is_online FROM stations WHERE station_id = '${stationId}'`);
    assert('H8 re-enabled', reenabled.startsWith('t|'), `DB is_active|is_online = ${reenabled}`);
  } finally {
    /* ---- H9: teardown ---------------------------------------------- */
    console.log('\n=== H9: teardown ===');
    if (station) {
      try {
        await station.disconnect();
      } catch (e) {
        console.error('    station disconnect failed:', e);
      }
    }
    if (handle) {
      // Belt and braces: lift any control ban before tearing down, so a crash
      // mid-run can never leave a banned clientid behind on the shared broker.
      try {
        await emqxAdmin('unban', handle.stationIds[0]);
      } catch { /* already gone */ }
      try {
        await teardownPool(handle);
        console.log('    pool torn down');
      } catch (e) {
        console.error('    TEARDOWN FAILED — UAT may need manual cleanup:', e);
      }
    }

    console.log('\n================ SUMMARY ================');
    for (const r of results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.hop.padEnd(22)} ${r.detail}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} hops passed`);
  }
}

main().catch((e: unknown) => {
  console.error('\nWIRE PROOF ABORTED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
