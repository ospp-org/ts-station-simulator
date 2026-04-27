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

      const message = step.message as string | undefined;
      const messageType = step.messageType as string | undefined;
      const payload = step.payload as Record<string, unknown> | undefined;

      if (!message || !payload) continue;

      const schemaKey = toSchemaKey(message, messageType);
      if (!schemaKey || !this.availableKeys.has(schemaKey)) continue;

      const resolved = replaceTemplates(payload) as Record<string, unknown>;

      try {
        const result = this.validator.validate(schemaKey, resolved);
        if (!result.valid && result.errors) {
          for (const err of result.errors) {
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
