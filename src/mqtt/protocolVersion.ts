/**
 * The wire `protocolVersion` this station puts on EVERY published envelope.
 *
 * One resolver, deliberately, because there are two publishers and they diverged:
 * `MessageSender` honoured `OSPP_PROTOCOL_VERSION` while `MqttConnection`'s
 * Last-Will builder called `createEnvelope()` with no version at all and silently
 * inherited the SDK constant. Against a server whose supported set did not contain
 * that constant, every ConnectionLost was refused `1007 PROTOCOL_VERSION_MISMATCH`
 * and hard-failed to the DLQ — so the server never learned the station had
 * vanished, and ConnectionLost is the only trigger for orphaned-session recovery
 * (`spec/03-messages.md` §5.5, `06-security.md:831-835`). Measured on UAT:
 * 11 dead-lettered wills reading `Unsupported version: 0.2.1`.
 *
 * Returning `undefined` means "let the SDK supply its own default", which is the
 * pre-existing contract of `createEnvelope({ protocolVersion })` — so an unset env
 * behaves exactly as before for both callers.
 *
 * NOTE the SDK's own default (`OSPP_PROTOCOL_VERSION`, currently `0.2.1`) does not
 * match the value spec v0.11.1 mandates on the wire (`0.3.0`, 176 value sites).
 * Fixing that default needs an SDK release and is recorded, not worked around here:
 * every deployment must set `OSPP_PROTOCOL_VERSION` explicitly until it lands.
 */
export function resolveWireProtocolVersion(): string | undefined {
  return process.env.OSPP_PROTOCOL_VERSION || undefined;
}
