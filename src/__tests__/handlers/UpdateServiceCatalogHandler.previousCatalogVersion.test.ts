import { describe, it, expect } from 'vitest';
import { SchemaValidator } from '@ospp/protocol/server';
import {
  OsppAction,
  MessageType,
  MessageSource,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
  type UpdateServiceCatalogResponse,
} from '@ospp/protocol';
import { UpdateServiceCatalogHandler } from '../../handlers/UpdateServiceCatalogHandler.js';
import type { StationContext } from '../../handlers/Handler.js';

/**
 * `previousCatalogVersion` on the `Accepted` arm — spec v0.25.0.
 *
 * update-service-catalog-response.schema.json gained an `Accepted` branch requiring
 * the field, and the SDK's `UpdateServiceCatalogResponse` moved it from optional to
 * REQUIRED with it. Before that, this handler answered a bare `{status: 'Accepted'}`
 * and nothing objected — which is how it came to light that this station kept **no
 * catalog version at all**. The field is not a formality: it is the station's
 * statement of what it was replacing, and there was nothing here to state.
 *
 * `''` is a VALUE, not "unknown". The schema's own words: "the empty string is the
 * legitimate value for a station that has never held a catalog". Absent and `''` are
 * two different statements on the wire and only one of them is allowed on `Accepted`.
 */

interface CapturedSend {
  action: OsppAction;
  messageType: MessageType;
  payload: unknown;
}

function makeMockStation(initialCatalogVersion = ''): {
  station: StationContext;
  captured: CapturedSend[];
} {
  const captured: CapturedSend[] = [];

  const station = {
    config: { bays: [{ bayId: 'bay_00000001', bayNumber: 1, programs: [], services: [] }] },
    sessions: new Map(),
    reservations: new Map(),
    currentRevocationEpoch: 0,
    currentCatalogVersion: initialCatalogVersion,
    sender: {
      async send(
        action: OsppAction,
        messageType: MessageType,
        payload: unknown,
      ): Promise<void> {
        captured.push({ action, messageType, payload });
      },
    },
  } as unknown as StationContext;

  return { station, captured };
}

function makeEnvelope(catalogVersion: string): OsppEnvelope {
  return {
    messageId: 'msg-catalog-test',
    messageType: MessageType.REQUEST,
    action: OsppAction.UPDATE_SERVICE_CATALOG,
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    timestamp: new Date().toISOString(),
    payload: {
      catalogVersion,
      services: [
        {
          serviceId: 'svc_wash_basic',
          serviceName: 'Basic Wash',
          available: true,
        },
      ],
    },
  } as unknown as OsppEnvelope;
}

function responseOf(captured: CapturedSend[]): UpdateServiceCatalogResponse {
  const sent = captured.find(
    c => c.action === OsppAction.UPDATE_SERVICE_CATALOG && c.messageType === MessageType.RESPONSE,
  );
  expect(sent, 'the handler sent no UpdateServiceCatalog Response').toBeDefined();
  return sent!.payload as UpdateServiceCatalogResponse;
}

describe('UpdateServiceCatalogHandler — previousCatalogVersion', () => {
  it('reports the empty string when the station has never held a catalog', async () => {
    const { station, captured } = makeMockStation();

    await new UpdateServiceCatalogHandler().handle(makeEnvelope('2'), station);

    const response = responseOf(captured);
    expect(response.status).toBe('Accepted');
    expect(response).toHaveProperty('previousCatalogVersion');
    expect((response as { previousCatalogVersion: string }).previousCatalogVersion).toBe('');
  });

  // THE CONTROL THAT MATTERS. The case above is satisfied by a handler that hardcodes
  // `''` and remembers nothing, which is indistinguishable from the real thing on a
  // fresh station — and a fresh station is every scenario in this corpus. Only a
  // SECOND push separates them: the field must be the version this station actually
  // held, and here that is not the empty string.
  it('reports the version it actually held, on a second push', async () => {
    const { station, captured } = makeMockStation();
    const handler = new UpdateServiceCatalogHandler();

    await handler.handle(makeEnvelope('1'), station);
    await handler.handle(makeEnvelope('2'), station);

    const second = captured.filter(c => c.messageType === MessageType.RESPONSE)[1];
    expect((second.payload as { previousCatalogVersion: string }).previousCatalogVersion).toBe('1');
  });

  it('advances the station to the pushed version', async () => {
    const { station } = makeMockStation();

    await new UpdateServiceCatalogHandler().handle(makeEnvelope('7'), station);

    expect(station.currentCatalogVersion).toBe('7');
  });

  // THE CONFORMANT CONTROL, against the SAME instrument the scenario linter uses.
  // Every assertion above is about a field NAME and a value this file chose; none of
  // them would notice a payload the schema refuses for some other reason. A refusal
  // proof needs a shape that still passes, and this is it: the response the handler
  // actually builds, validated by the SDK's Ajv against the vendored v0.25.0 schema.
  it('builds a response the v0.25.0 schema accepts', async () => {
    const { station, captured } = makeMockStation();

    await new UpdateServiceCatalogHandler().handle(makeEnvelope('2'), station);

    const result = new SchemaValidator().validate(
      'update-service-catalog-response',
      responseOf(captured),
    );

    expect(result.errors ?? [], JSON.stringify(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
