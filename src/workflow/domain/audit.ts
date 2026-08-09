import type {
  AuditMetadata,
  AuditMetadataValue,
  GuardrailAuditRecord,
  RecordGuardrailDecisionInput,
  WorkflowStateStore,
} from "../state/store.js";

export const GUARDRAIL_AUDIT_SCHEMA_VERSION = 1;
export type { AuditMetadata, AuditMetadataValue, GuardrailAuditRecord } from "../state/store.js";

const MAX_FIELD_LENGTH = 128;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_STRING_LENGTH = 256;
const FORBIDDEN_METADATA_KEY =
  /secret|token|password|credential|diff|content|stdout|stderr|environment|env|header|argument|command|raw|output/iu;

function bounded(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be empty`);
  if (normalized.length > MAX_FIELD_LENGTH) throw new Error(`${field} exceeds the bounded audit length`);
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(`${field} contains control characters`);
  return normalized;
}

export function sanitizeAuditMetadata(input: unknown): AuditMetadata {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("audit metadata must be an object");
  const result: Record<string, AuditMetadataValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(result).length >= MAX_METADATA_ENTRIES) break;
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(key) || FORBIDDEN_METADATA_KEY.test(key)) continue;
    if (typeof value === "string") {
      const normalized = value.slice(0, MAX_METADATA_STRING_LENGTH);
      if (!/[\u0000-\u001f\u007f]/u.test(normalized)) result[key] = normalized;
    } else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean" || value === null) result[key] = value;
  }
  return result;
}

export function recordGuardrailDecision(
  store: WorkflowStateStore,
  input: Omit<RecordGuardrailDecisionInput, "metadata"> & { metadata?: unknown },
): GuardrailAuditRecord {
  return store.recordGuardrailDecision({
    ...input,
    operation: bounded(input.operation, "operation"),
    ruleId: bounded(input.ruleId, "ruleId"),
    reasonCode: bounded(input.reasonCode, "reasonCode"),
    policyProvenance:
      input.policyProvenance === undefined ? undefined : bounded(input.policyProvenance, "policyProvenance"),
    metadata: sanitizeAuditMetadata(input.metadata),
  });
}

export const recordAuditDecision = recordGuardrailDecision;

function denied(record: GuardrailAuditRecord): boolean {
  return record.decision === "deny";
}

function matches(record: GuardrailAuditRecord, pattern: RegExp): boolean {
  const searchable = `${record.operation} ${record.ruleId} ${record.reasonCode}`.replace(
    /([a-z])([A-Z])/gu,
    "$1-$2",
  );
  return pattern.test(searchable);
}

export interface GuardrailMetrics {
  schemaVersion: typeof GUARDRAIL_AUDIT_SCHEMA_VERSION;
  totalDecisions: number;
  allowedDecisions: number;
  deniedDecisions: number;
  observedDecisions: number;
  deniedProtectedBranchOperations: number;
  invalidCommitAttempts: number;
  duplicateTaskWorktreeAttempts: number;
  cleanupBlockers: number;
  bypassDetections: number;
  byOperation: Readonly<Record<string, number>>;
  byRuleId: Readonly<Record<string, number>>;
  byReasonCode: Readonly<Record<string, number>>;
  policyProvenance: Readonly<Record<string, number>>;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

export function aggregateGuardrailMetrics(records: readonly GuardrailAuditRecord[]): GuardrailMetrics {
  const byOperation: Record<string, number> = {};
  const byRuleId: Record<string, number> = {};
  const byReasonCode: Record<string, number> = {};
  const policyProvenance: Record<string, number> = {};
  let deniedProtectedBranchOperations = 0;
  let invalidCommitAttempts = 0;
  let duplicateTaskWorktreeAttempts = 0;
  let cleanupBlockers = 0;
  let bypassDetections = 0;
  for (const record of records) {
    increment(byOperation, record.operation);
    increment(byRuleId, record.ruleId);
    increment(byReasonCode, record.reasonCode);
    if (record.policyProvenance !== undefined) increment(policyProvenance, record.policyProvenance);
    if (!denied(record)) continue;
    if (matches(record, /protected[-_ ]?branch/iu)) deniedProtectedBranchOperations += 1;
    if (matches(record, /invalid[-_ ]?commit|commit[-_ ]?invalid/iu)) invalidCommitAttempts += 1;
    if (matches(record, /duplicate|already[-_ ]claimed|collision|multiple|existing/iu))
      duplicateTaskWorktreeAttempts += 1;
    if (matches(record, /cleanup|lease[-_ ]blocker/iu)) cleanupBlockers += 1;
    if (matches(record, /bypass|direct[-_ ]git|hook[-_ ]bypass/iu)) bypassDetections += 1;
  }
  return {
    schemaVersion: GUARDRAIL_AUDIT_SCHEMA_VERSION,
    totalDecisions: records.length,
    allowedDecisions: records.filter((record) => record.decision === "allow").length,
    deniedDecisions: records.filter((record) => record.decision === "deny").length,
    observedDecisions: records.filter((record) => record.decision === "observe").length,
    deniedProtectedBranchOperations,
    invalidCommitAttempts,
    duplicateTaskWorktreeAttempts,
    cleanupBlockers,
    bypassDetections,
    byOperation,
    byRuleId,
    byReasonCode,
    policyProvenance,
  };
}

export function collectGuardrailMetrics(store: WorkflowStateStore): GuardrailMetrics {
  return aggregateGuardrailMetrics(store.listGuardrailAuditRecords());
}

export const computeGuardrailMetrics = aggregateGuardrailMetrics;
