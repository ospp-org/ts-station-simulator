import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type DataTransferRequest,
  type DataTransferResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class DataTransferHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const payload = envelope.payload as DataTransferRequest;

    if (envelope.messageType === MessageType.REQUEST) {
      // Server sent a DataTransfer request — respond with Accepted
      const response: DataTransferResponse = {
        status: 'Accepted',
        data: {},
      };

      await station.sender.send<DataTransferResponse>(
        OsppAction.DATA_TRANSFER,
        MessageType.RESPONSE,
        response,
        envelope.messageId,
      );

      console.log(
        '[DataTransfer] Request from server — vendor: %s, dataId: %s — responded Accepted',
        payload.vendorId,
        payload.dataId,
      );
    } else if (envelope.messageType === MessageType.RESPONSE) {
      // Response to a DataTransfer request we sent
      const response = envelope.payload as DataTransferResponse;

      console.log(
        '[DataTransfer] Response received — status: %s',
        response.status,
      );
    }
  }
}
