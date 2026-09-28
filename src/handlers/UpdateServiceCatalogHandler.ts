import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  type OsppEnvelope,
  type UpdateServiceCatalogRequest,
  type UpdateServiceCatalogResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';
import { errorName } from './bayRefusal.js';

export class UpdateServiceCatalogHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as UpdateServiceCatalogRequest;

    console.log(
      '[UpdateServiceCatalog] Received catalog version %s with %d services',
      request.catalogVersion,
      request.services.length,
    );

    // CAPTURED BEFORE THE STATION ADOPTS THE NEW ONE, and the order is the whole
    // point: `previousCatalogVersion` is what this station HELD, so reading it after
    // the assignment below would report the incoming version as its own predecessor
    // and the field would be true of nothing.
    //
    // `''` is the conforming answer for a station that has never held a catalog —
    // update-service-catalog-response.schema.json at spec v0.25.0 says so, and made
    // the field required on the `Accepted` arm. Before that release this handler
    // answered a bare `{status: 'Accepted'}` and the SDK's type allowed it; the
    // widening is what surfaced that this station kept no catalog version at all.
    const previousCatalogVersion = station.currentCatalogVersion;

    // RULE 8, AND IT IS ALL-OR-NOTHING. A `bindings` entry naming a (bayNumber,
    // programNumber) pair this station "did not declare at provisioning or at its most
    // recent boot" obliges a Rejected/5024 and obliges the PREVIOUS catalog to stay in
    // force — "It MUST NOT apply the remaining entries and report success."
    //
    // The branch sits above the mutation loop on purpose: nothing below has run yet, so
    // "leave the previous catalog in force" needs no rollback, only an early return.
    //
    // The declared set is the same object `Station.declaredTopology()` serialises, so this
    // compares against what the server was actually told — not against a second copy that
    // could drift. `StartServiceHandler` already runs the identical predicate for one
    // ordinal; this is that predicate over the catalog's bindings.
    const declared = new Set(
      station.config.bays.flatMap(b => b.programs.map(p => `${b.bayNumber}:${p.programNumber}`)),
    );
    const unsupported = request.services.find(svc =>
      (svc.bindings ?? []).some(bd => !declared.has(`${bd.bayNumber}:${bd.programNumber}`)),
    );

    if (unsupported) {
      const rejected: UpdateServiceCatalogResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.UNSUPPORTED_SERVICE,
        errorText: errorName(OsppErrorCode.UNSUPPORTED_SERVICE),
      };
      await station.sender.send<UpdateServiceCatalogResponse>(
        OsppAction.UPDATE_SERVICE_CATALOG, MessageType.RESPONSE, rejected, envelope.messageId,
      );
      console.log(
        '[UpdateServiceCatalog] Rejected — service %s binds a (bay, program) pair this station never declared; keeping catalog %s',
        unsupported.serviceId,
        previousCatalogVersion === '' ? '(none)' : previousCatalogVersion,
      );
      return;
    }

    // Update local service config on each bay to reflect the new catalog
    const services = request.services.map(svc => ({
      serviceId: svc.serviceId,
      serviceName: svc.serviceName,
      available: svc.available,
    }));
    for (const bay of station.config.bays) {
      bay.services = services.map(svc => ({ ...svc }));
    }

    station.currentCatalogVersion = request.catalogVersion;

    // RULE 5: kept where the next process of this station finds it, BEFORE the Accepted goes out -
    // an Accepted is the server's licence never to push this catalog again (PublishFirstCatalogOnBoot
    // pushes only to a station that never held one).
    await station.persistCatalog?.(request.catalogVersion, services);

    const response: UpdateServiceCatalogResponse = {
      status: 'Accepted',
      previousCatalogVersion,
    };

    await station.sender.send<UpdateServiceCatalogResponse>(
      OsppAction.UPDATE_SERVICE_CATALOG,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[UpdateServiceCatalog] Accepted — catalog updated to version %s',
      request.catalogVersion,
    );
  }
}
