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
 * THAT is why this function still exists, and it is the part that does not expire:
 * both publishers must reach the wire through ONE place, or they drift again. The
 * first fix routed the will through here and was still inert, because the resolver
 * returned `undefined` when the env was unset and `createEnvelope` reads
 * `opts.protocolVersion ?? OSPP_PROTOCOL_VERSION` — so `undefined` fell through to
 * the SDK's `0.2.1`, and nothing set that env: not the repo `.env`, not
 * `~/.config/osp-e2e-secrets.env`, not `config/targets.yaml`. Re-proved on the wire
 * against UAT on 2026-08-10 08:44Z: `lwt-stn_674b55ca`, `protocolVersion: 0.2.1`,
 * dead-lettered `Unsupported version: 0.2.1`. A test had even pinned that fallback
 * as "unchanged prior behaviour", which locked the defect in place.
 *
 * WHAT EXPIRED, AND DID: this module used to export a local
 * `WIRE_PROTOCOL_VERSION = '0.3.0'` constant, because `@ospp/protocol`'s own
 * `OSPP_PROTOCOL_VERSION` was `0.2.1` while the spec mandated `0.3.0`, and the
 * docblock said "when the SDK's own default is corrected, delete this and return
 * the SDK constant directly". `@ospp/protocol` 0.15.0 corrected it — in lockstep
 * with `ospp/protocol` (PHP) 0.15.0, both now `0.3.0`, both now gated in CI against
 * spec Chapter 08 — so the constant is deleted and this returns the SDK's value.
 *
 * The property that closed the original defect is unchanged and is the only one
 * worth restating: an unset env still produces a CONFORMING envelope. It is now
 * conforming because the SDK is right rather than because this file compensated for
 * the SDK being wrong, which is the same guarantee with one fewer place to maintain
 * it. The env remains an override for talking to a server pinned elsewhere.
 */

import { OSPP_PROTOCOL_VERSION } from '@ospp/protocol';

export function resolveWireProtocolVersion(): string {
  return process.env.OSPP_PROTOCOL_VERSION || OSPP_PROTOCOL_VERSION;
}
