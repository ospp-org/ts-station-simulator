import crypto from 'node:crypto';
import {
  OsppAction,
  MessageType,
  MessageSource,
  createEnvelope,
  toServerTopic,
  requiresMac,
  type MessageSigningMode,
  type OsppEnvelope,
} from '@ospp/protocol';
import { signMessage } from '@ospp/protocol/server';
import type { MqttConnection } from './MqttConnection.js';
import { resolveWireProtocolVersion } from './protocolVersion.js';

export class MessageSender {
  private readonly connection: MqttConnection;
  private readonly stationId: string;
  private readonly getSessionKey: () => string | null;
  private readonly signingMode: MessageSigningMode;
  private readonly protocolVersion: string | undefined;

  constructor(
    connection: MqttConnection,
    stationId: string,
    getSessionKey: () => string | null = () => null,
    // 'All' is the default and one of two remaining modes; 'Critical' is deleted
    // — with everything signed it selected nothing.
    signingMode: MessageSigningMode = 'All',
    // The wire protocolVersion for every outgoing envelope, from the one resolver both
    // publishers share (the LWT builder in MqttConnection is the other). Never hardcoded
    // here, so one build can be pointed at any server.
    //
    // The comment this replaces said the SDK default "negotiates fine (MAJOR-0 matches
    // dev/testing/prod-example)" and told the reader to set the env only for "a server
    // pinned to a different MAJOR (e.g. UAT 1.x)". Both claims are false: negotiation is
    // EXACT MATCH against a set (VERSIONING.md:25), the SDK's MAJOR gate
    // `isCompatibleWith()` was deleted in 0.12.0, and csms-server's VersionNegotiator
    // never called it — so a shared MAJOR has never made 0.2.1 acceptable to a server
    // configured for anything else.
    protocolVersion: string | undefined = resolveWireProtocolVersion(),
  ) {
    this.connection = connection;
    this.stationId = stationId;
    this.getSessionKey = getSessionKey;
    this.signingMode = signingMode;
    this.protocolVersion = protocolVersion;
  }

  async send<T>(
    action: OsppAction,
    messageType: MessageType,
    payload: T,
    correlationId?: string,
  ): Promise<OsppEnvelope<T>> {
    const envelope = createEnvelope<T>({
      messageId: correlationId ?? crypto.randomUUID(),
      messageType,
      action,
      source: MessageSource.STATION,
      payload,
      // undefined → the SDK default (OSPP_PROTOCOL_VERSION); an env/explicit override negotiates
      // against a server pinned to a different MAJOR.
      protocolVersion: this.protocolVersion,
    });

    // HMAC-sign the WHOLE envelope (not envelope.payload) when the message
    // requires it — this mirrors the server's MacSigner, which signs the full
    // envelope minus `mac`. signMessage adds the `mac` field.
    const sessionKey = this.getSessionKey();
    let outgoing: OsppEnvelope<T> = envelope;

    if (requiresMac(action, messageType, this.signingMode)) {
      // Fail CLOSED. 06-security.md:869-873 — "No session key held for the peer
      // -> Refuse to send. The sender MUST NOT publish the message unsigned."
      //
      // The condition used to be `sessionKey !== null && requiresMac(...)`, so a
      // message that REQUIRED a MAC but had no key fell through to the unsigned
      // branch and was published anyway. That is the send path failing OPEN
      // while MessageRouter::verified() (:113-154) already failed CLOSED on the
      // very same condition — the two halves of §5.7 disagreeing inside one
      // repo, which is the shape that has burned this programme before.
      //
      // Nothing in the suite trips this: every scenario waits for the
      // BootNotification RESPONSE (which CARRIES the key, and is one of the
      // three structural exemptions) before sending anything that needs one.
      // Throwing is therefore a real guard, not a behaviour change.
      if (sessionKey === null) {
        throw new Error(
          `MessageSender: refusing to publish ${action} ${messageType} unsigned — ` +
            'no session key held (06-security.md §5.7 requires the sender to fail ' +
            'closed). The key arrives on the BootNotification RESPONSE, so a station ' +
            'that has not completed a boot cannot sign this message.',
        );
      }
      outgoing = signMessage(
        sessionKey,
        envelope as unknown as Record<string, unknown>,
      ) as unknown as OsppEnvelope<T>;
    }

    await this.connection.publish(toServerTopic(this.stationId), JSON.stringify(outgoing), 1);

    return outgoing;
  }

  /**
   * Publish a pre-built envelope verbatim — no signing, no exemption check.
   *
   * CURRENTLY UNCALLED (verified across `src/`), and left in place rather than
   * deleted only because it is a published surface. Flagged because it is a
   * second unsigned-publish path: anything routed through here bypasses the
   * §5.7 fail-closed guard in `send()` above. A caller MUST therefore pass an
   * envelope that is already signed, or one of the three structural exemptions.
   * If this ever acquires a real caller, the guard belongs here too.
   */
  async sendEnvelope<T>(envelope: OsppEnvelope<T>): Promise<void> {
    await this.connection.publish(toServerTopic(this.stationId), JSON.stringify(envelope), 1);
  }
}
