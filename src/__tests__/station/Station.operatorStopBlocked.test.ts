import { describe, it, expect } from 'vitest';
import { SessionEndReason } from '@ospp/protocol';

// ---------------------------------------------------------------------------
// A KNOWN-WRONG value, pinned deliberately, with the reason it cannot yet be
// corrected — so nobody "fixes" it into something worse.
//
// settleSessionAsOperatorStop() reports `Deauthorized`. That is wrong: spec
// v0.11.0 03-messages.md §5.4 gives `Deauthorized` the rule "Session MUST be
// billed at zero", while reset-request.schema.json's `force` requires that the
// customer "is billed for what they received". A forced reset therefore delivers
// a wash and charges nothing for it.
//
// The correct value is `OperatorStopped`, added to the spec for exactly this.
// It CANNOT be emitted yet: @ospp/protocol has not been regenerated, so the
// member does not exist here, and the reference server's installed schema
// rejects the string outright — measured:
//
//     REJECTED — /reason: The data should match one item from enum
//
// A rejected SessionEnded is not a smaller fault than a mis-billed one. It is a
// larger one: SessionEnded is the sole billing source when no StopService was
// issued, so the message is dropped and the session is never billed at all,
// rather than billed at zero. Zero at least records that the session ended.
//
// This test fails the moment the SDK ships the member, which is the signal to
// make the change. Do not delete it to make it pass.
// ---------------------------------------------------------------------------

describe('operator-stop reason — blocked on an SDK release', () => {
  it('the SDK still lacks OperatorStopped, so the fix cannot land', () => {
    expect(Object.keys(SessionEndReason)).not.toContain('OPERATOR_STOPPED');
  });

  it('names exactly what to change when it does ship', () => {
    // Station.settleSessionAsOperatorStop():
    //   reason: SessionEndReason.DEAUTHORIZED  ->  SessionEndReason.OPERATOR_STOPPED
    // and delete the comment that calls Deauthorized "the closest correct value".
    // The server side must move first or in the same release: a station emitting
    // the new value against an old server has its SessionEnded rejected.
    expect(SessionEndReason.DEAUTHORIZED).toBe('Deauthorized');
  });
});
