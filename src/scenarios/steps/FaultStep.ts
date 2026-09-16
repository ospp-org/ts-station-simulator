import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

export class FaultStep implements Step {
  async execute(
    definition: StepDefinition,
    _context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const faultType = definition.type as string;
    if (!faultType) {
      throw new Error('FaultStep requires a "type" field');
    }

    switch (faultType) {
      case 'disconnect':
        station.destroyConnection();
        break;

      // A power cut, not a network blip. `disconnect` destroys the socket but
      // leaves the client to auto-reconnect in 5s, which is INSIDE the will's
      // 10s willDelayInterval and therefore cancels it — so no scenario using
      // `disconnect` can ever observe the broker publish the Last Will. `sever`
      // is the teardown that can: unclean (no DISCONNECT packet, so the will
      // stays armed) and final (no reconnect, so the delay elapses). Pair it
      // with a delay longer than willDelayInterval before asserting server
      // state. See MqttConnection.severConnection().
      case 'sever':
        station.severConnection();
        break;

      // THE ANNOUNCED DEPARTURE, and the third distinct teardown in this switch.
      // The other two say nothing on the wire on purpose:
      //
      //   disconnect  destroys the socket and lets the client reconnect in 5s, inside
      //               the will's 10s delay, so the broker CANCELS the will;
      //   sever       is unclean and final, so the BROKER publishes the will and the
      //               server hears `UnexpectedDisconnect`;
      //   planned_shutdown  is the station's own goodbye — ConnectionLost with
      //               `reason: "PlannedShutdown"` published FIRST, then an ORDINARY
      //               clean DISCONNECT, which suppresses the will (MQTT 5 §3.14.4).
      //
      // The three are mutually exclusive by construction. Announcing and then forcing
      // the will would put a PlannedShutdown and an UnexpectedDisconnect about the SAME
      // departure on the wire, and the server would keep whichever landed second.
      //
      // Ends OFFLINE, because that is what a deliberate shutdown is. A scenario asserts
      // afterwards over HTTP, or against the frame journal, which outlives the link.
      case 'planned_shutdown':
        await station.disconnect({ announceDeparture: true });
        break;

      case 'timeout': {
        const ms = (definition.ms as number) ?? 30_000;
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        break;
      }

      case 'error':
        throw new Error(
          (definition.message as string) ?? 'Simulated fault error',
        );

      default:
        throw new Error(
          `Unknown fault type: ${faultType}. Known: disconnect, sever, planned_shutdown, ` +
            'timeout, error.',
        );
    }
  }
}
