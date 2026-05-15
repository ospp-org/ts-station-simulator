import type { OsppEnvelope } from '@ospp/protocol';

export interface ScenarioContext {
  /** Template variables: stationId, serialNumber, bayId_1, etc. */
  variables: Map<string, string>;
  /** Values captured by WaitFor steps */
  captured: Map<string, unknown>;
  /** All messages sent during the scenario */
  sentMessages: OsppEnvelope[];
  /**
   * Sent Request messageIds already claimed by a WaitForStep awaiting the
   * correlated Response. Used for Drift 7-E FIFO auto-correlation so that
   * back-to-back Requests of the same action each match their own Response
   * even when Responses arrive out of order.
   */
  consumedSentMessageIds: Set<string>;
  /** All messages received during the scenario */
  receivedMessages: OsppEnvelope[];
  /** Step results for reporting */
  stepResults: StepResult[];
  /** Start time of the scenario */
  startTime: number;
  /** Cached JWT token for API calls */
  authToken?: string;
  /** API base URL for auth login */
  apiBaseUrl?: string;
  /** API credentials for JWT login */
  apiCredentials?: { email: string; password: string };
  /**
   * Organization UUID for multi-tenant routing. Auto-injected as
   * `X-Organization-Id` header on /api/v1/admin/* calls by ApiCallStep.
   *
   * Resolution order: CLI `--org-id` flag → auto-discovery via GET
   * /api/v1/organizations (only when exactly one org is returned).
   * Auto-discovery is lazy on first admin api_call.
   */
  orgId?: string;
}

export interface StepResult {
  stepIndex: number;
  action: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

export function createContext(): ScenarioContext {
  return {
    variables: new Map(),
    captured: new Map(),
    sentMessages: [],
    consumedSentMessageIds: new Set(),
    receivedMessages: [],
    stepResults: [],
    startTime: Date.now(),
  };
}
