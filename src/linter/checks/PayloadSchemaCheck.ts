import { OsppAction } from '@ospp/protocol';
import { SchemaValidator } from '@ospp/protocol/server';
import type { LintIssue, LintCheck, ParsedScenario } from '../types.js';

// Map YAML message names to schema keys
// Schema key format: "boot-notification-request", "start-service-response", "status-notification", "meter-values-event"
function toSchemaKey(message: string, messageType: string | undefined): string | null {
  // Convert PascalCase to kebab-case
  const kebab = message.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

  // Events without Request/Response suffix
  const eventOnlyMessages = new Set([
    'StatusNotification', 'ConnectionLost', 'SecurityEvent',
    'FirmwareStatusNotification', 'DiagnosticsNotification',
  ]);

  // Events with "-event" suffix
  const eventSuffixMessages = new Set(['MeterValues', 'SessionEnded']);

  if (eventOnlyMessages.has(message)) {
    return kebab;
  }
  if (eventSuffixMessages.has(message)) {
    return `${kebab}-event`;
  }

  // Request/Response messages
  const mt = (messageType ?? 'Request').toLowerCase();
  if (mt === 'event') return null; // No schema for events sent as events for req/res messages
  return `${kebab}-${mt}`;
}

// Replace template variables with dummy values for schema validation
function replaceTemplates(obj: unknown): unknown {
  if (typeof obj === 'string') {
    if (obj.includes('{{')) {
      // Determine dummy value based on content hints
      if (obj.includes('bayId') || obj.includes('bay_')) return 'bay_00000001';
      if (obj.includes('stationId') || obj.includes('stn_')) return 'stn_00000001';
      if (obj.includes('sessionId') || obj.includes('sess_')) return 'sess_00000001';
      if (obj.includes('serviceId') || obj.includes('svc_')) return 'svc_wash_basic';
      if (obj.includes('serialNumber')) return 'SN-12345678';
      if (obj.includes('reservationId') || obj.includes('rsv_')) return 'rsv_00000001';
      if (obj.includes('offlinePassId') || obj.includes('opass_')) return 'opass_00000001';
      if (obj.includes('offlineTxId') || obj.includes('otx_')) return 'otx_00000001';
      if (obj.includes('authId') || obj.includes('auth_')) return 'auth_00000001';
      if (obj.includes('userId') || obj.includes('sub_')) return 'sub_testuser01';
      if (obj.includes('deviceId') || obj.includes('dev_')) return 'dev_00000001';
      if (obj.includes('target_url')) return 'http://localhost:8080';
      if (obj.includes('firmwareVersion') || obj.includes('catalogVersion')) return '1.0.0';
      return 'test_dummy_value';
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => replaceTemplates(item));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = replaceTemplates(val);
    }
    return result;
  }
  return obj;
}

// A string whose ENTIRE value is a single {{ captured.X }} token. Mirrors
// ScenarioRunner.substituteTemplates: such a field is replaced at runtime with
// the captured value VERBATIM (object / array / number / ...), so its static
// type is unknown here and must not be schema-type-checked. Embedded templates
// ("opass_{{x}}") and pool/provisioning/variable tokens are NOT whole-value.
const WHOLE_CAPTURE_RE = /^\{\{\s*captured\.[^{}]+\s*\}\}$/;

// JSON Pointer escaping per RFC 6901 so paths line up with Ajv instancePaths.
function escapeJsonPointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

// Collect the instancePaths of every field whose entire value is a whole-value
// capture, walking nested objects/arrays so deep captures are covered too.
function collectDynamicCapturePaths(value: unknown, base = '', out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (WHOLE_CAPTURE_RE.test(value)) out.push(base);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectDynamicCapturePaths(item, `${base}/${i}`, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      collectDynamicCapturePaths(v, `${base}/${escapeJsonPointer(k)}`, out);
    }
  }
  return out;
}

function isUnderDynamicPath(instancePath: string, dynamicPaths: string[]): boolean {
  return dynamicPaths.some((p) => instancePath === p || instancePath.startsWith(`${p}/`));
}

// A string whose ENTIRE value is a single {{ X }} token where X is NOT
// `captured.*` (that case is WHOLE_CAPTURE_RE above). ScenarioRunner resolves
// these from CLI `--var KEY=VALUE` flags at run time (e.g. `--var
// reason=TimerExpired`) — the linter has no way to know the operator-supplied
// value ahead of time, so the generic 'test_dummy_value' dummy substituted
// above cannot satisfy a downstream `enum` constraint on that field. Unlike
// WHOLE_CAPTURE_RE paths (whole error skipped — the runtime type is
// genuinely unknown there), we skip ONLY the `enum` keyword for these paths:
// a --var default substituted where the schema demands e.g. an object still
// fails as before, since that would be a real bug, not a missing enum member.
const WHOLE_VAR_RE = /^\{\{\s*(?!captured\.)[^{}]+\s*\}\}$/;

function collectDynamicVarPaths(value: unknown, base = '', out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (WHOLE_VAR_RE.test(value)) out.push(base);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectDynamicVarPaths(item, `${base}/${i}`, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      collectDynamicVarPaths(v, `${base}/${escapeJsonPointer(k)}`, out);
    }
  }
  return out;
}

export class PayloadSchemaCheck implements LintCheck {
  name = 'payload-schema';
  private validator: SchemaValidator;
  private availableKeys: Set<string>;

  constructor() {
    this.validator = new SchemaValidator();
    this.availableKeys = new Set(this.validator.allKeys);
  }

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      if (step.action !== 'send') continue;
      // A `send` step marked `expect_invalid: true` deliberately publishes a
      // malformed payload to probe server robustness (e.g. an omitted
      // required field, or a field violating a pattern/enum) — schema
      // validation on THIS step's payload is the whole point of the test, so
      // skip it here rather than have the scenario fight the linter. This is
      // an opt-out per-step, not a weakening of the check globally: every
      // other `send` step, including other steps in the same scenario, is
      // still fully validated.
      if (step.expect_invalid === true) continue;

      const message = step.message as string | undefined;
      const messageType = step.messageType as string | undefined;
      const payload = step.payload as Record<string, unknown> | undefined;

      if (!message || !payload) continue;

      const schemaKey = toSchemaKey(message, messageType);
      if (!schemaKey || !this.availableKeys.has(schemaKey)) continue;

      const resolved = replaceTemplates(payload) as Record<string, unknown>;
      // Mirror SendStep: `deviceId` is a receipt-only convention field that SendStep
      // signs into receipt.data and then strips before publishing a TransactionEvent
      // Request, so it never reaches the wire. Drop it here too before schema-
      // validating, else additionalProperties:false flags a field that is not sent.
      if (message === 'TransactionEvent') {
        delete resolved.deviceId;
      }
      // C-015: a field whose entire value is a single {{captured.X}} token is
      // populated at runtime with a value of statically-unknown type (the engine
      // forwards the captured value verbatim). The dummy-string substitution above
      // cannot represent that, so skip schema errors at those paths — the server
      // validates the real value at runtime. Embedded/non-capture templates stay
      // validated as before.
      const dynamicPaths = collectDynamicCapturePaths(payload);
      // Non-captured whole-value `--var` templates (e.g. `reason: "{{reason}}"`)
      // — see WHOLE_VAR_RE above. Only `enum` errors are suppressed at these
      // paths, not the whole error.
      const dynamicVarPaths = collectDynamicVarPaths(payload);

      try {
        const result = this.validator.validate(schemaKey, resolved);
        if (!result.valid && result.errors) {
          for (const err of result.errors) {
            if (isUnderDynamicPath(err.instancePath ?? '', dynamicPaths)) continue;
            if (err.keyword === 'enum' && isUnderDynamicPath(err.instancePath ?? '', dynamicVarPaths)) continue;
            issues.push({
              file: scenario.filePath,
              step: i,
              stepAction: 'send',
              message: `Schema validation error for ${schemaKey}: ${err.instancePath || '/'} ${err.message ?? 'unknown error'}`,
            });
          }
        }
      } catch {
        // Schema not found or validation error -- skip silently
      }
    }

    return issues;
  }
}
