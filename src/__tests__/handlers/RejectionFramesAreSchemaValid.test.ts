import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  OsppAction,
  MessageType,
  BayStatus,
  type OsppEnvelope,
} from '@ospp/protocol';
import { ReserveBayHandler } from '../../handlers/ReserveBayHandler.js';
import { StartServiceHandler } from '../../handlers/StartServiceHandler.js';
import { StopServiceHandler } from '../../handlers/StopServiceHandler.js';
import { CancelReservationHandler } from '../../handlers/CancelReservationHandler.js';
import { CertificateInstallHandler } from '../../handlers/CertificateInstallHandler.js';
import type { Handler, StationContext } from '../../handlers/Handler.js';

/**
 * A station answers `Rejected` on the wire, and the wire is narrow: `errorText` is
 * `^[A-Z][A-Z0-9_]+$` on the eighteen schemas that carry the pattern — a machine-readable
 * name, not a sentence. The simulator emitted prose into it from eight sites, so those
 * frames were schema-invalid and a server validating on ingest drops them. The scenarios
 * built on those branches were therefore testing something other than what they claimed.
 *
 * This asserts on the FRAME: the payload each handler hands to the sender is validated
 * against the SAME schema the SDK ships and the server validates with. A string-shaped
 * assertion would have to restate the pattern, and would then agree with itself forever.
 *
 * It also checks `errorCode` against the per-message roster of `07-errors.md` §4.2. That
 * belongs here rather than in a separate test because the two fields are one claim: a
 * frame naming `TLS_HANDSHAKE_FAILED` for a bay in the wrong state is not made honest by
 * spelling the text correctly — it is made *schema-valid*, which is worse, because the
 * defect stops being visible.
 */

const require_ = createRequire(import.meta.url);
const SCHEMA_ROOT = path.join(path.dirname(require_.resolve('@ospp/protocol')), 'schemas');
const SCHEMA_DIR = path.join(SCHEMA_ROOT, 'mqtt');

const ajv = new Ajv2020({ strict: false, allErrors: true });

// The response schemas $ref siblings under common/ (stop-service-response reaches
// credit-amount). Register every schema the package ships so a $ref is resolved
// rather than silently turning a validity check into a harness error.
for (const dir of ['common', 'mqtt', 'ble']) {
  const abs = path.join(SCHEMA_ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs).filter(x => x.endsWith('.schema.json'))) {
    const schema = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf-8'));
    if (typeof schema.$id === 'string' && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
    // Refs are written relative ('../common/x.schema.json'), so register that key too.
    const rel = `../${dir}/${f}`;
    if (!ajv.getSchema(rel)) ajv.addSchema(schema, rel);
  }
}
const compiled = new Map<string, (payload: unknown) => string[]>();

function validatorFor(schemaFile: string): (payload: unknown) => string[] {
  const hit = compiled.get(schemaFile);
  if (hit) return hit;
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, schemaFile), 'utf-8'));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const fn = (payload: unknown): string[] =>
    validate(payload) ? [] : (validate.errors ?? []).map(e => `${e.instancePath} ${e.message}`);
  compiled.set(schemaFile, fn);
  return fn;
}

/** `07-errors.md` §4.2 — the codes each Server→Station action may answer with. */
const PERMITTED_CODES: Record<string, number[]> = {
  ReserveBay: [3001, 3002, 3005, 3011, 3012, 3013, 3014],
  StartService: [3001, 3002, 3003, 3004, 3005, 3006, 3008, 3009, 3010, 3011, 3012, 3013, 3014, 3017, 5103, 5111],
  StopService: [3005, 3006, 3007, 3011],
  CancelReservation: [3005, 3012, 3013],
  CertificateInstall: [4011, 4012, 5103, 5107],
};

interface Captured {
  action: OsppAction;
  payload: unknown;
}

function makeStation(overrides: Partial<Record<string, unknown>>): {
  station: StationContext;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const station = {
    config: {
      stationId: 'stn_a1b2c3d4',
      bays: [{ bayId: 'bay_c1d2e3f4a5b6', bayNumber: 1, programs: [], services: [] }],
      // acceptRate 0 forces the random-refusal arm; 1 forces the state arm.
      behavior: { acceptRate: 0 },
    },
    sessions: new Map(),
    reservations: new Map(),
    getBayState: () => BayStatus.AVAILABLE,
    setBayState: () => undefined,
    pendingRenewalKeyPem: null,
    sender: {
      async send(action: OsppAction, _t: MessageType, payload: unknown): Promise<void> {
        captured.push({ action, payload });
      },
    },
    ...overrides,
  } as unknown as StationContext;
  return { station, captured };
}

function envelope(action: OsppAction, payload: unknown): OsppEnvelope {
  return {
    messageId: 'cmd_550e8400-e29b-41d4-a716-446655440000',
    messageType: MessageType.REQUEST,
    action,
    timestamp: new Date().toISOString(),
    source: 'Server',
    protocolVersion: '0.3.0',
    payload,
  } as unknown as OsppEnvelope;
}

interface Case {
  name: string;
  message: keyof typeof PERMITTED_CODES;
  schema: string;
  run: () => Promise<Captured[]>;
}

async function drive(
  handler: Handler,
  action: OsppAction,
  payload: unknown,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<Captured[]> {
  const { station, captured } = makeStation(overrides);
  await handler.handle(envelope(action, payload), station);
  return captured;
}

const RESERVE_PAYLOAD = {
  bayId: 'bay_c1d2e3f4a5b6',
  reservationId: 'rsv_11111111',
  expirationTime: new Date(Date.now() + 60_000).toISOString(),
};

const START_PAYLOAD = {
  sessionId: 'sess_a1b2c3d4',
  bayId: 'bay_c1d2e3f4a5b6',
  serviceId: 'svc_eco',
  programNumber: 1,
  durationSeconds: 300,
  sessionSource: 'MobileApp',
};

const cases: Case[] = [
  {
    name: 'ReserveBay — bay is not Available',
    message: 'ReserveBay',
    schema: 'reserve-bay-response.schema.json',
    run: () =>
      drive(new ReserveBayHandler(), OsppAction.RESERVE_BAY, RESERVE_PAYLOAD, {
        getBayState: () => BayStatus.OCCUPIED,
      }),
  },
  {
    name: 'ReserveBay — bay Available, refused by acceptRate',
    message: 'ReserveBay',
    schema: 'reserve-bay-response.schema.json',
    run: () => drive(new ReserveBayHandler(), OsppAction.RESERVE_BAY, RESERVE_PAYLOAD),
  },
  {
    name: 'StartService — bay is not Available',
    message: 'StartService',
    schema: 'start-service-response.schema.json',
    run: () =>
      drive(new StartServiceHandler(), OsppAction.START_SERVICE, START_PAYLOAD, {
        getBayState: () => BayStatus.FAULTED,
        config: {
          stationId: 'stn_a1b2c3d4',
          bays: [
            {
              bayId: 'bay_c1d2e3f4a5b6',
              bayNumber: 1,
              programs: [{ programNumber: 1, name: 'Eco' }],
              services: [{ serviceId: 'svc_eco', programNumber: 1 }],
            },
          ],
          behavior: { acceptRate: 1 },
        },
      }),
  },
  {
    name: 'StartService — reservation held under a different id',
    message: 'StartService',
    schema: 'start-service-response.schema.json',
    run: () =>
      drive(
        new StartServiceHandler(),
        OsppAction.START_SERVICE,
        { ...START_PAYLOAD, reservationId: 'rsv_22222222' },
        {
          getBayState: () => BayStatus.RESERVED,
          reservations: new Map([
            ['bay_c1d2e3f4a5b6', { reservationId: 'rsv_11111111', bayId: 'bay_c1d2e3f4a5b6' }],
          ]),
          config: {
            stationId: 'stn_a1b2c3d4',
            bays: [
              {
                bayId: 'bay_c1d2e3f4a5b6',
                bayNumber: 1,
                programs: [{ programNumber: 1, name: 'Eco' }],
              services: [{ serviceId: 'svc_eco', programNumber: 1 }],
              },
            ],
            behavior: { acceptRate: 1 },
          },
        },
      ),
  },
  {
    name: 'StopService — no such session',
    message: 'StopService',
    schema: 'stop-service-response.schema.json',
    run: () =>
      drive(new StopServiceHandler(), OsppAction.STOP_SERVICE, { sessionId: 'sess_missing1' }),
  },
  {
    name: 'CancelReservation — bay Reserved, no reservation tracked',
    message: 'CancelReservation',
    schema: 'cancel-reservation-response.schema.json',
    run: () =>
      drive(
        new CancelReservationHandler(),
        OsppAction.CANCEL_RESERVATION,
        { bayId: 'bay_c1d2e3f4a5b6', reservationId: 'rsv_11111111' },
        { getBayState: () => BayStatus.RESERVED, reservations: new Map() },
      ),
  },
  {
    name: 'CertificateInstall — no renewal in flight',
    message: 'CertificateInstall',
    schema: 'certificate-install-response.schema.json',
    run: () =>
      drive(new CertificateInstallHandler(), OsppAction.CERTIFICATE_INSTALL, {
        certificatePem: '-----BEGIN CERTIFICATE-----\nMIIx==\n-----END CERTIFICATE-----',
      }),
  },
];

describe('every Rejected frame the simulator emits is valid against the schema it is sent under', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const captured = await c.run();
      const rejections = captured.filter(
        x => (x.payload as { status?: string }).status === 'Rejected',
      );

      // Anti-vacuum: a case that stopped reaching its rejection arm would otherwise
      // pass by asserting over an empty list.
      expect(rejections.length, 'the case did not reach a Rejected frame').toBeGreaterThan(0);

      const validate = validatorFor(c.schema);
      for (const r of rejections) {
        expect(validate(r.payload), `schema-invalid frame: ${JSON.stringify(r.payload)}`).toEqual(
          [],
        );

        const code = (r.payload as { errorCode?: number }).errorCode;
        expect(code, `no errorCode on a Rejected ${c.message}`).toBeDefined();
        expect(
          PERMITTED_CODES[c.message],
          `${code} is not a code 07-errors.md §4.2 permits for ${c.message}`,
        ).toContain(code);
      }
    });
  }
});
