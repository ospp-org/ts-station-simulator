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
 * (`spec/03-messages.md` §5.5, `06-security.md:831-835`).
 *
 * THE FIRST FIX WAS INERT AND THIS IS WHY. It routed the will through this
 * resolver but left the resolver returning `undefined` when the env was unset,
 * documenting that "every deployment must set OSPP_PROTOCOL_VERSION explicitly".
 * `createEnvelope` reads `opts.protocolVersion ?? OSPP_PROTOCOL_VERSION`, so
 * `undefined` still resolved to the SDK's `0.2.1` — and nothing sets that env:
 * not the repo `.env`, not `~/.config/osp-e2e-secrets.env`, not `config/targets.yaml`.
 * A test even pinned the fallback as "unchanged prior behaviour", which locked the
 * defect in place. Re-proved on the wire against UAT on 2026-08-10 08:44Z with the
 * env unset: `lwt-stn_674b55ca`, `protocolVersion: 0.2.1`, dead-lettered
 * `Unsupported version: 0.2.1`.
 *
 * So the default is now the value the spec mandates on the wire, not the SDK's.
 * An unset env produces a CONFORMING envelope; the env remains an override for
 * talking to a server pinned elsewhere. There is no longer a silent path that puts
 * a non-conformant version on the wire — which is the only property that actually
 * closes this, since "remember to set the env" demonstrably does not.
 *
 * NB this constant must track the spec until the SDK's own default is corrected;
 * `@ospp/protocol`'s `OSPP_PROTOCOL_VERSION` is still `0.2.1` while spec v0.11.1
 * mandates `0.3.0` on the wire. Fixing that needs an SDK release. When it lands,
 * delete WIRE_PROTOCOL_VERSION and return the SDK constant directly.
 */

/** The wire version spec v0.11.1 mandates. NOT the SDK constant — see above. */
export const WIRE_PROTOCOL_VERSION = '0.3.0';

export function resolveWireProtocolVersion(): string {
  return process.env.OSPP_PROTOCOL_VERSION || WIRE_PROTOCOL_VERSION;
}
