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

    // Update local service config on each bay to reflect the new catalog
    for (const bay of station.config.bays) {
      bay.services = request.services.map(svc => ({
        serviceId: svc.serviceId,
        serviceName: svc.serviceName,
        available: svc.available,
      }));
    }

    const response: UpdateServiceCatalogResponse = {
      status: 'Accepted',
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
