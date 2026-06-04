import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { OsppAction, MessageType, canonicalize } from '@ospp/protocol';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

const ACTION_MAP: ReadonlyMap<string, OsppAction> = new Map(
  Object.entries(OsppAction).map(([, value]) => [value, value]),
);

function mapToOsppAction(name: string): OsppAction {
  const action = ACTION_MAP.get(name);
  if (!action) {
    throw new Error(`Unknown OSPP action: ${name}`);
  }
  return action;
}

function mapToMessageType(name: string | undefined): MessageType {
  if (!name) return MessageType.REQUEST;
  const upper = name as MessageType;
  if (Object.values(MessageType).includes(upper)) {
    return upper;
  }
  throw new Error(`Unknown message type: ${name}`);
}

function substituteTemplateValue(
  value: string,
  context: ScenarioContext,
): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (_match, varName: string) => {
    const trimmed = varName.trim();
    if (trimmed.startsWith('captured.')) {
      const captureKey = trimmed.slice('captured.'.length);
      const captured = context.captured.get(captureKey);
      if (captured === undefined) {
        throw new Error(`Captured variable not found: ${captureKey}`);
      }
      return String(captured);
    }
    const variable = context.variables.get(trimmed);
    if (variable === undefined) {
      throw new Error(`Template variable not found: ${trimmed}`);
    }
    return variable;
  });
}

function substituteTemplates(
  value: unknown,
  context: ScenarioContext,
): unknown {
  if (typeof value === 'string') {
    return substituteTemplateValue(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteTemplates(item, context));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteTemplates(val, context);
    }
    return result;
  }
  return value;
}

/**
 * Sign the receipt on a TransactionEvent payload per spec §6.2.
 *
 * Pre-(α-bag) the simulator sent a placeholder `signature: "test_sig"` — the
 * server's ReceiptVerifier rejected as invalid_receipt_signature, FraudScorer
 * hit Critical, and the Reconciler persisted status='rejected'. That proves
 * the rejected branch end-to-end. For the Accepted branch we need a real
 * signature the verifier accepts.
 *
 * Algorithm (matches csms-server EcdsaService::verify behavior, which is
 * `openssl_verify($decodedCanonicalBytes, $sig, $pubKey, OPENSSL_ALGO_SHA256)`
 * — SHA-256 over the DECODED canonical JSON, then ECDSA verify):
 *
 *   receipt_fields = { offlineTxId, bayId, serviceId, startedAt, endedAt,
 *                      durationSeconds, creditsCharged, meterValues?,
 *                      txCounter }  (9 fields per spec §6.2 — meterValues
 *                                    omitted if not present on payload)
 *   canonical_bytes = OSPP_Canonical_Form(receipt_fields)  (UTF-8, sorted
 *                                                          keys, compact)
 *   signature       = ECDSA-P256-Sign(receipt_private_key, canonical_bytes)
 *                     (openssl_sign with SHA256 internally hashes then signs)
 *
 *   receipt.data               = base64(canonical_bytes)
 *   receipt.signature          = base64(DER-encoded ECDSA signature)
 *   receipt.signatureAlgorithm = "ECDSA-P256-SHA256"
 *
 * NOTE on spec inconsistency: §6.2 step 3 says "data_bytes = base64_encode
 * (receipt_data); digest = SHA-256(data_bytes)" — i.e. hash the base64.
 * But verification step 2 decodes from base64 and step 3 hashes the
 * decoded form. csms-server's verifier follows the verification side
 * (decoded form). We sign to match the verifier, not the literal signing
 * pseudocode. Worth flagging for a spec amendment.
 */
async function signTransactionEventReceipt(
  payload: Record<string, unknown>,
  station: Station,
  context: ScenarioContext,
): Promise<void> {
  const receipt = payload.receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return;
  }

  const poolEntry = context.pool.get(station.config.stationId);
  if (!poolEntry?.receiptKeyPath) {
    throw new Error(
      `SendStep: no receiptKeyPath registered for station ${station.config.stationId}. ` +
      'PoolBootstrap must persist <stationId>-receipt-key.pem (run with --bootstrap-pool).',
    );
  }

  // Build the 9 canonicalized fields per spec §6.2. meterValues is included
  // only if present on the payload (canonicalization sorts present keys; the
  // verifier re-canonicalizes the same byte sequence, so both sides agree
  // whether meterValues was a key in the signed input).
  const receiptFields: Record<string, unknown> = {
    offlineTxId: payload.offlineTxId,
    bayId: payload.bayId,
    serviceId: payload.serviceId,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    durationSeconds: payload.durationSeconds,
    creditsCharged: payload.creditsCharged,
    txCounter: payload.txCounter,
  };
  if (payload.meterValues !== undefined) {
    receiptFields.meterValues = payload.meterValues;
  }

  const canonicalJson = canonicalize(receiptFields);
  const canonicalBytes = Buffer.from(canonicalJson, 'utf-8');

  const receiptKeyPem = await fs.readFile(poolEntry.receiptKeyPath, 'utf-8');
  const privateKey = crypto.createPrivateKey(receiptKeyPem);

  // ECDSA-P256-SHA256: createSign('SHA256') + sign() does SHA-256 over the
  // input then ECDSA-signs the digest. Default signature encoding is DER —
  // matches what openssl_verify expects on the server side.
  const signer = crypto.createSign('SHA256');
  signer.update(canonicalBytes);
  const signatureDer = signer.sign(privateKey);

  const receiptRecord = receipt as Record<string, unknown>;
  receiptRecord.data = canonicalBytes.toString('base64');
  receiptRecord.signature = signatureDer.toString('base64');
  receiptRecord.signatureAlgorithm = 'ECDSA-P256-SHA256';

  if (process.env['SCENARIO_DEBUG'] === '1') {
    console.log(
      `[SendStep] signed TransactionEvent receipt for ${station.config.stationId} ` +
      `(canonicalBytes=${canonicalBytes.length}B, sigDer=${signatureDer.length}B)`,
    );
  }
}

/**
 * v0.4.0 ordering-field auto-injection.
 *
 * - MeterValues Event: stamp seqNo from session counter (if YAML omits), then advance counter.
 * - SessionEnded Event: stamp seqNo + finalSeqNo from session counter (if YAML omits).
 * - StopService Accepted Response: stamp finalSeqNo from session counter (if YAML omits).
 *
 * Explicit YAML values always win — needed for negative tests that emit late
 * MeterValues with seqNo > finalSeqNo.
 */
function injectSeqNoFields(
  action: OsppAction,
  msgType: MessageType,
  payload: Record<string, unknown>,
  station: Station,
): void {
  const sessionId = payload.sessionId;
  if (typeof sessionId !== 'string') return;
  const session = station.sessions.get(sessionId);
  if (!session) return;

  if (action === OsppAction.METER_VALUES && msgType === MessageType.EVENT) {
    if (payload.seqNo === undefined) payload.seqNo = session.seqNo;
    const used = payload.seqNo as number;
    session.seqNo = used + 1;
    return;
  }
  if (action === OsppAction.SESSION_ENDED && msgType === MessageType.EVENT) {
    if (payload.seqNo === undefined) payload.seqNo = session.seqNo;
    if (payload.finalSeqNo === undefined) payload.finalSeqNo = session.seqNo;
    return;
  }
  if (action === OsppAction.STOP_SERVICE && msgType === MessageType.RESPONSE) {
    if (payload.status === 'Accepted' && payload.finalSeqNo === undefined) {
      payload.finalSeqNo = session.seqNo;
    }
  }
}

/**
 * Pick the outbound messageId for a SendStep. Mirror of
 * WaitForStep::pickExpectedMessageId for the inverse direction.
 *
 * OSPP correlates a Response to its Request by messageId equality (the
 * envelope has no separate correlationId field; see
 * vendor/ospp/protocol/src/Envelope/MessageBuilder.php::correlatedTo).
 *
 * Order of precedence:
 *  1. Explicit `correlationId` on the YAML step → use as-is.
 *  2. `messageType === Response` → reverse-scan `context.receivedMessages`
 *     for the most recent Request of the same action whose messageId hasn't
 *     been claimed by an earlier SendStep response.
 *  3. Otherwise generate a fresh UUID (Requests + Events, plus
 *     Responses with no paired inbound Request — preserves backward-compat
 *     for tests that build Responses standalone).
 *
 * Result type tags whether the id was matched or freshly generated, so the
 * debug log can label the source clearly.
 */
type CorrelationSource = 'explicit' | 'auto-correlated' | 'generated';

function resolveSendCorrelation(
  definition: StepDefinition,
  messageType: MessageType,
  action: OsppAction,
  context: ScenarioContext,
): { id: string; source: CorrelationSource } {
  const explicit = definition.correlationId as string | undefined;
  if (typeof explicit === 'string') {
    return { id: explicit, source: 'explicit' };
  }

  if (messageType === MessageType.RESPONSE) {
    for (let i = context.receivedMessages.length - 1; i >= 0; i--) {
      const env = context.receivedMessages[i];
      if (
        env.action === action &&
        env.messageType === MessageType.REQUEST &&
        !context.consumedReceivedMessageIds.has(env.messageId)
      ) {
        context.consumedReceivedMessageIds.add(env.messageId);
        return { id: env.messageId, source: 'auto-correlated' };
      }
    }
  }

  return { id: crypto.randomUUID(), source: 'generated' };
}

export class SendStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const messageName = definition.message as string;
    if (!messageName) {
      throw new Error('SendStep requires a "message" field');
    }

    const action = mapToOsppAction(messageName);
    const messageType = mapToMessageType(definition.messageType as string | undefined);
    const rawPayload = (definition.payload as Record<string, unknown>) ?? {};
    const payload = substituteTemplates(rawPayload, context) as Record<string, unknown>;

    injectSeqNoFields(action, messageType, payload, station);

    if (action === OsppAction.TRANSACTION_EVENT && messageType === MessageType.REQUEST) {
      await signTransactionEventReceipt(payload, station, context);
    }

    const { id: correlationId, source } = resolveSendCorrelation(
      definition,
      messageType,
      action,
      context,
    );
    if (process.env['SCENARIO_DEBUG'] === '1') {
      console.log(
        `[SendStep] action=${action} type=${messageType} messageId=${correlationId} (${source})`,
      );
    }
    const envelope = await station.sender.send(
      action,
      messageType,
      payload,
      correlationId,
    );

    context.sentMessages.push(envelope);
  }
}
