import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type UpdateServiceCatalogRequest,
  type UpdateServiceCatalogResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

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

    // Update local service config on each bay to reflect the new catalog
    for (const bay of station.config.bays) {
      bay.services = request.services.map(svc => ({
        serviceId: svc.serviceId,
        serviceName: svc.serviceName,
        available: svc.available,
      }));
    }

    station.currentCatalogVersion = request.catalogVersion;

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
