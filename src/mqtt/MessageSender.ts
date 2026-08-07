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

/**
 * How to BREAK the MAC on one outgoing message, so a scenario can reach the
 * server's inbound-verification branches.
 *
 * csms-server verifies inbound MACs at
 * `app/Shared/Protocol/Middleware/VerifyIncomingMiddleware.php`, and nothing in
 * scenario mode could provoke a failure there: `send()` always signs correctly
 * with the real session key, and the only other publish path (`sendEnvelope`)
 * has no caller. So three server branches sat unreachable from YAML.
 *
 * The modes map to the branches, NOT to a taxonomy of attacks:
 *   - `omit`      -> `:51`  MAC_MISSING            (mac absent on a message that owes one)
 *   - `corrupt`   -> `:82`  MAC_VERIFICATION_FAILED
 *   - `wrong_key` -> `:82`  MAC_VERIFICATION_FAILED — the SAME branch as `corrupt`.
 *
 * `wrong_key` is kept as a distinct mode because it is a distinct *input* class
 * and the collapse is a finding rather than an assumption: `MacSigner::verify()`
 * ends in one `hash_equals`, so a mac computed with another key and a mac with
 * flipped bytes are indistinguishable to the server. Proved in
 * MessageSender.tamperMac.test.ts rather than asserted here.
 *
 * Every mode keeps the envelope SCHEMA-VALID. That is load-bearing, not tidiness:
 * csms-server validates the schema BEFORE it verifies the MAC
 * (MessageDispatcher.php:109 precedes :146 — csms-server docs/KNOWN-ISSUES.md
 * "Schema rejection preempts the HMAC gate", OPEN), and a schema rejection
 * answers a REQUEST with a Rejected RESPONSE on the wire, which the MAC path
 * never does. A malformed envelope would therefore prove the wrong gate while
 * looking like the right one. `mac` is optional in
 * common/mqtt-envelope.schema.json (`minLength: 1`), so `omit` is schema-valid
 * and `corrupt` stays a non-empty base64 string of the original length.
 */
export type MacTamperMode = 'corrupt' | 'wrong_key' | 'omit';

/**
 * A 32-byte key that is validly-shaped and is NOT the station's. Fixed rather
 * than random so a failing run reproduces byte-for-byte.
 */
const WRONG_SESSION_KEY = Buffer.alloc(32, 0x5a).toString('base64');

/**
 * Flip the low bit of the first signature byte, then re-encode.
 *
 * Length and alphabet are preserved so the result still satisfies the envelope
 * schema's `minLength`/`maxLength` and still base64-decodes — the ONLY thing
 * wrong with it is the MAC value, which is what makes the server's refusal
 * attributable to the MAC gate and nothing else.
 */
function corruptMac(mac: string): string {
  const raw = Buffer.from(mac, 'base64');
  if (raw.length === 0) {
    throw new Error('MessageSender: cannot corrupt an empty mac');
  }
  const flipped = Buffer.from(raw);
  flipped[0] = flipped[0] ^ 0x01;
  return flipped.toString('base64');
}

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
    // Break the MAC on THIS message only. Undefined on every ordinary send, so
    // the fail-closed guard below is untouched for everything that is not a
    // deliberate probe of the server's verification branches.
    tamperMac?: MacTamperMode,
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

      // The session key is checked FIRST even for a tampered send. `omit` must
      // mean "this station holds a key and withheld the mac anyway" — which is
      // the server branch we are aiming at (MAC_MISSING). If it were allowed to
      // stand in for the no-key case it would silently re-open the fail-OPEN
      // hole this guard was added to close, and a keyless station's omission is
      // a different server branch anyway (SESSION_KEY_UNAVAILABLE, :69, which is
      // reached by the server's own key expiry and not by anything a station
      // sends).
      if (tamperMac === 'omit') {
        console.warn(
          '[MessageSender] TAMPER: publishing %s %s with NO mac (server branch: MAC_MISSING)',
          action,
          messageType,
        );
      } else {
        const signingKey = tamperMac === 'wrong_key' ? WRONG_SESSION_KEY : sessionKey;
        outgoing = signMessage(
          signingKey,
          envelope as unknown as Record<string, unknown>,
        ) as unknown as OsppEnvelope<T>;

        if (tamperMac !== undefined) {
          const signed = outgoing as unknown as Record<string, unknown>;
          if (tamperMac === 'corrupt') {
            signed.mac = corruptMac(String(signed.mac));
          }
          console.warn(
            '[MessageSender] TAMPER: publishing %s %s with a %s mac (server branch: MAC_VERIFICATION_FAILED)',
            action,
            messageType,
            tamperMac,
          );
        }
      }
    } else if (tamperMac !== undefined) {
      // This message owes no mac, for one of two reasons, and NEITHER can reach a
      // verification branch — so a scenario built on it would assert nothing.
      // Refuse at authoring time rather than let it pass silently.
      //
      //  - structurally exempt (BootNotification Request/Response, ConnectionLost):
      //    csms-server returns skipped() at VerifyIncomingMiddleware.php:45 BEFORE
      //    it reads envelope.mac at :49, so an attached mac is never examined;
      //  - signingMode 'None' on THIS sender: nothing is signed at all.
      const why = this.signingMode === 'All'
        ? 'it is structurally exempt from signing (06-security.md §5.6), and the server ' +
          'skips verification for these before it reads the mac field'
        : `this sender runs signingMode '${this.signingMode}', which signs nothing`;
      throw new Error(
        `MessageSender: tamper_mac requested on ${action} ${messageType}, but ${why}. ` +
          'No verification branch can be reached from here.',
      );
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
