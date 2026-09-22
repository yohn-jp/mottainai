import type { CanonCheckpointRecord, ManagerSessionRecord, TaskRecord } from "../state/store.js";
import type { ManagerExecutionContext } from "./manager-execution.js";
import type { NawabariRepositoryEvidence } from "../nawabari.js";
import type { CanonIdentities } from "../../canon/identity.js";
import type {
  ClaimGenerationProvenance,
  ExecutionClaim,
  SemanticExecutionPlan,
  SemanticExecutionTarget,
  VerificationIntent,
} from "../../semantics/execution-plan.js";

/** The manifest is a projection contract; it does not own any execution authority. */
export const EXECUTION_MANIFEST_CONTRACT_ID = "mottainai.execution-manifest.v1" as const;
export const EXECUTION_MANIFEST_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_RESOURCE_LENGTH = 512;
const MAX_TARGETS = 128;
const MAX_TARGET_PATHS = 128;
const MAX_CLAIMS = 128;
const MAX_CHECKS = 128;
const MAX_WARNINGS = 128;
const MAX_DIAGNOSTICS = 32;
const MAX_REASON_LENGTH = 512;
const MAX_EVIDENCE_HASH_LENGTH = 512;

export type ExecutionManifestCompleteness = "complete" | "incomplete";
export type ExecutionManifestFreshness = "current" | "stale" | "unknown";
export type ExecutionManifestAttachmentStatus = "attached" | "missing" | "stale" | "ambiguous" | "invalid";

/** Bounded task facts copied from the task authority, not a replacement task record. */
export interface ExecutionManifestTaskFacts {
  taskId: TaskRecord["taskId"];
  instanceId: TaskRecord["instanceId"];
  taskSlug: string;
  issueRef: string | undefined;
  lifecycleState: TaskRecord["lifecycleState"];
  baseBranch: string;
  baseCommit: string;
}

/** Manager identity is retained as identity/provenance only; prompt text is excluded. */
export interface ExecutionManifestManagerIdentity {
  managerSessionId: ManagerSessionRecord["sessionId"] | undefined;
  runtimeId: ManagerSessionRecord["runtimeId"] | undefined;
  executionMode: ManagerSessionRecord["executionMode"] | undefined;
  executionSessionId: string | undefined;
  taskId: TaskRecord["taskId"] | undefined;
  semanticLifecycleState: ManagerExecutionContext["semanticLifecycleState"];
}

/** Canon identities remain references to the existing Canon boundary. */
export interface ExecutionManifestCanonIdentity {
  contractId: string | undefined;
  schemaVersion: number | undefined;
  checkpointId: CanonCheckpointRecord["checkpointId"] | undefined;
  parentCheckpointId: CanonCheckpointRecord["parentCheckpointId"] | undefined;
  lineageKind: CanonCheckpointRecord["lineageKind"] | undefined;
  state: CanonCheckpointRecord["state"] | undefined;
  prefix_id: string | undefined;
  execution_state_id: string | undefined;
}

export interface ExecutionManifestIntent {
  task: ExecutionManifestTaskFacts | undefined;
  manager: ExecutionManifestManagerIdentity | undefined;
  canon: ExecutionManifestCanonIdentity | undefined;
  semanticPlan: SemanticExecutionPlan;
}

/** Physical facts are admitted only through an explicitly identified Nawabari source. */
export interface ExecutionManifestPhysicalAttachment {
  sessionId: string;
  worktree: string;
  branch: string;
  branchId: string | undefined;
  sessionState: string;
}

export interface ExecutionManifestAttachment {
  authority: "nawabari" | "none";
  status: ExecutionManifestAttachmentStatus;
  completeness: ExecutionManifestCompleteness;
  freshness: ExecutionManifestFreshness;
  evidenceHash: string | undefined;
  physical: ExecutionManifestPhysicalAttachment | undefined;
  reasons: readonly string[];
}

export interface ExecutionManifestDiagnostics {
  completeness: ExecutionManifestCompleteness;
  freshness: ExecutionManifestFreshness;
  reasons: readonly string[];
}

export interface ExecutionManifest {
  contractId: typeof EXECUTION_MANIFEST_CONTRACT_ID;
  schemaVersion: typeof EXECUTION_MANIFEST_SCHEMA_VERSION;
  intent: ExecutionManifestIntent;
  attachment: ExecutionManifestAttachment;
  diagnostics: ExecutionManifestDiagnostics;
}

/** The explicit Nawabari boundary required before physical fields are projected. */
export interface AuthoritativeNawabariAttachmentInput {
  authority: "nawabari";
  evidence?: NawabariRepositoryEvidence;
  status?: ExecutionManifestAttachmentStatus;
  reason?: string;
}

export type ExecutionManifestCanonInput =
  | CanonIdentities
  | CanonCheckpointRecord
  | {
      contractId?: string;
      schemaVersion?: number;
      checkpointId?: string;
      parentCheckpointId?: string;
      lineageKind?: CanonCheckpointRecord["lineageKind"];
      state?: CanonCheckpointRecord["state"];
      prefix_id?: string;
      execution_state_id?: string;
    };

export interface ExecutionManifestInput {
  task?: TaskRecord | ExecutionManifestTaskFacts;
  manager?: ManagerSessionRecord | ManagerExecutionContext | ExecutionManifestManagerIdentity;
  canon?: ExecutionManifestCanonInput;
  semanticPlan?: SemanticExecutionPlan;
  /** Alias for callers that name the semantic scope directly. */
  scope?: SemanticExecutionPlan;
  /** Only this explicitly authoritative Nawabari input may populate physical fields. */
  nawabari?: AuthoritativeNawabariAttachmentInput;
  /** Alias retained for the runtime attachment terminology. */
  attachment?: AuthoritativeNawabariAttachmentInput;
}

export interface ExecutionManifestValidation {
  valid: boolean;
  completeness: ExecutionManifestCompleteness;
  freshness: ExecutionManifestFreshness;
  errors: readonly string[];
  warnings: readonly string[];
}

export class ExecutionManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionManifestError";
  }
}

function boundedText(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ExecutionManifestError(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new ExecutionManifestError(`${field} must not be empty`);
  if (normalized.length > max) throw new ExecutionManifestError(`${field} exceeds the bounded manifest length`);
  if (/[\u0000-\u001f\u007f]/u.test(normalized))
    throw new ExecutionManifestError(`${field} contains control characters`);
  return normalized;
}

function optionalText(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string | undefined {
  return value === undefined || value === null ? undefined : boundedText(value, field, max);
}

function uniqueSorted(values: readonly string[], field: string, max = MAX_IDENTIFIER_LENGTH): string[] {
  return [
    ...new Set(
      values.map((value) => boundedText(value, field, max)).filter((value): value is string => value !== undefined),
    ),
  ].sort();
}

function boundedReasons(values: readonly string[], field: string): string[] {
  return uniqueSorted(values, field, MAX_REASON_LENGTH).slice(0, MAX_DIAGNOSTICS);
}

function normalizeTarget(target: SemanticExecutionTarget): SemanticExecutionTarget {
  if (target.kind !== "symbol" && target.kind !== "component" && target.kind !== "path")
    throw new ExecutionManifestError("semantic target kind is invalid");
  const id = boundedText(target.id, "semantic target id")!;
  const paths =
    target.paths === undefined
      ? undefined
      : uniqueSorted(target.paths, "semantic target path", MAX_RESOURCE_LENGTH).slice(0, MAX_TARGET_PATHS);
  return paths === undefined ? { kind: target.kind, id } : { kind: target.kind, id, paths };
}

function normalizeClaim(claim: ExecutionClaim): ExecutionClaim {
  if (claim.mode !== "read" && claim.mode !== "write" && claim.mode !== "exclusive-write")
    throw new ExecutionManifestError("semantic claim mode is invalid");
  return { resource: boundedText(claim.resource, "semantic claim resource", MAX_RESOURCE_LENGTH)!, mode: claim.mode };
}

function normalizeProvenance(provenance: ClaimGenerationProvenance): ClaimGenerationProvenance {
  if (
    provenance.strategy !== "declared" &&
    provenance.strategy !== "conservative-broad" &&
    provenance.strategy !== "blocked"
  )
    throw new ExecutionManifestError("claim generation strategy is invalid");
  if (
    provenance.source !== "repository-semantics" &&
    provenance.source !== "explicit-paths" &&
    provenance.source !== "explicit-claims" &&
    provenance.source !== "unknown-scope"
  )
    throw new ExecutionManifestError("claim generation source is invalid");
  return {
    strategy: provenance.strategy,
    reason: boundedText(provenance.reason, "claim generation reason", MAX_REASON_LENGTH)!,
    source: provenance.source,
    warnings: boundedReasons(provenance.warnings, "claim generation warning"),
  };
}

function normalizeVerification(verification: VerificationIntent): VerificationIntent {
  return {
    requiredChecks: uniqueSorted(verification.requiredChecks, "verification check", MAX_RESOURCE_LENGTH).slice(
      0,
      MAX_CHECKS,
    ),
    rationale: boundedText(verification.rationale, "verification rationale", MAX_REASON_LENGTH)!,
  };
}

function normalizeSemanticPlan(plan: SemanticExecutionPlan | undefined): SemanticExecutionPlan {
  if (plan === undefined) {
    return {
      schemaVersion: 1,
      semanticTargets: [],
      claims: [],
      claimGeneration: {
        strategy: "blocked",
        reason: "semantic execution plan was not supplied",
        source: "unknown-scope",
        warnings: ["semantic scope is incomplete; execution manifest remains fail-closed"],
      },
      verification: { requiredChecks: [], rationale: "verification plan was not supplied" },
    };
  }
  if (plan.schemaVersion !== 1) throw new ExecutionManifestError("semantic execution plan schema is unsupported");
  if (plan.semanticTargets.length > MAX_TARGETS)
    throw new ExecutionManifestError("semantic target count exceeds the bounded manifest limit");
  if (plan.claims.length > MAX_CLAIMS)
    throw new ExecutionManifestError("semantic claim count exceeds the bounded manifest limit");
  const targetById = new Map<string, SemanticExecutionTarget>();
  for (const target of plan.semanticTargets.map(normalizeTarget)) {
    const key = `${target.kind}\u0000${target.id}`;
    const previous = targetById.get(key);
    if (previous === undefined) {
      targetById.set(key, target);
    } else {
      const paths = uniqueSorted(
        [...(previous.paths ?? []), ...(target.paths ?? [])],
        "semantic target path",
        MAX_RESOURCE_LENGTH,
      ).slice(0, MAX_TARGET_PATHS);
      targetById.set(
        key,
        paths.length === 0 ? { kind: target.kind, id: target.id } : { kind: target.kind, id: target.id, paths },
      );
    }
  }
  const semanticTargets = [...targetById.values()].sort((left, right) =>
    `${left.kind}\u0000${left.id}`.localeCompare(`${right.kind}\u0000${right.id}`),
  );
  const claimById = new Map<string, ExecutionClaim>();
  for (const claim of plan.claims.map(normalizeClaim)) claimById.set(`${claim.resource}\u0000${claim.mode}`, claim);
  const claims = [...claimById.values()].sort((left, right) =>
    `${left.resource}\u0000${left.mode}`.localeCompare(`${right.resource}\u0000${right.mode}`),
  );
  const claimGeneration = normalizeProvenance(plan.claimGeneration);
  if (claimGeneration.warnings.length > MAX_WARNINGS)
    throw new ExecutionManifestError("claim warning count exceeds the bounded manifest limit");
  return {
    schemaVersion: 1,
    semanticTargets,
    claims,
    claimGeneration,
    verification: normalizeVerification(plan.verification),
  };
}

function normalizeTask(
  task: TaskRecord | ExecutionManifestTaskFacts | undefined,
): ExecutionManifestTaskFacts | undefined {
  if (task === undefined) return undefined;
  return {
    taskId: boundedText(task.taskId, "task id")! as TaskRecord["taskId"],
    instanceId: boundedText(task.instanceId, "repository instance id")! as TaskRecord["instanceId"],
    taskSlug: boundedText(task.taskSlug, "task slug")!,
    issueRef: optionalText(task.issueRef, "issue reference"),
    lifecycleState: task.lifecycleState,
    baseBranch: boundedText(task.baseBranch, "task base branch")!,
    baseCommit: boundedText(task.baseCommit, "task base commit")!,
  };
}

function isManagerSession(
  value: ManagerSessionRecord | ManagerExecutionContext | ExecutionManifestManagerIdentity,
): value is ManagerSessionRecord {
  return "sessionId" in value;
}

function normalizeManager(
  manager: ManagerSessionRecord | ManagerExecutionContext | ExecutionManifestManagerIdentity | undefined,
): ExecutionManifestManagerIdentity | undefined {
  if (manager === undefined) return undefined;
  if (isManagerSession(manager)) {
    return {
      managerSessionId: boundedText(manager.sessionId, "Manager session id")! as ManagerSessionRecord["sessionId"],
      runtimeId: optionalText(manager.runtimeId, "Manager runtime id") as ManagerSessionRecord["runtimeId"],
      executionMode: manager.executionMode,
      executionSessionId: optionalText(manager.executionSessionId, "execution session id"),
      taskId: optionalText(manager.taskId, "Manager task id") as TaskRecord["taskId"],
      semanticLifecycleState: manager.semanticLifecycleState,
    };
  }
  return {
    managerSessionId:
      "managerSessionId" in manager
        ? (optionalText(manager.managerSessionId, "Manager session id") as ManagerSessionRecord["sessionId"])
        : undefined,
    runtimeId:
      "runtimeId" in manager
        ? (optionalText(manager.runtimeId, "Manager runtime id") as ManagerSessionRecord["runtimeId"])
        : undefined,
    executionMode: "executionMode" in manager ? manager.executionMode : undefined,
    executionSessionId: optionalText(manager.executionSessionId, "execution session id"),
    taskId: optionalText(manager.taskId, "Manager task id") as TaskRecord["taskId"],
    semanticLifecycleState: manager.semanticLifecycleState,
  };
}

function isCheckpoint(value: ExecutionManifestCanonInput): value is CanonCheckpointRecord {
  return "checkpointId" in value && "prefix_id" in value;
}

function normalizeCanon(canon: ExecutionManifestCanonInput | undefined): ExecutionManifestCanonIdentity | undefined {
  if (canon === undefined) return undefined;
  if (isCheckpoint(canon)) {
    return {
      contractId: optionalText(canon.canonContractId, "Canon contract id"),
      schemaVersion: canon.canonSchemaVersion,
      checkpointId: optionalText(canon.checkpointId, "Canon checkpoint id") as CanonCheckpointRecord["checkpointId"],
      parentCheckpointId: optionalText(
        canon.parentCheckpointId,
        "Canon parent checkpoint id",
      ) as CanonCheckpointRecord["parentCheckpointId"],
      lineageKind: canon.lineageKind,
      state: canon.state,
      prefix_id: boundedText(canon.prefix_id, "Canon prefix id"),
      execution_state_id: optionalText(canon.execution_state_id, "Canon execution state id"),
    };
  }
  return {
    contractId: optionalText("contractId" in canon ? canon.contractId : undefined, "Canon contract id"),
    schemaVersion: "schemaVersion" in canon ? canon.schemaVersion : undefined,
    checkpointId: optionalText(
      "checkpointId" in canon ? canon.checkpointId : undefined,
      "Canon checkpoint id",
    ) as CanonCheckpointRecord["checkpointId"],
    parentCheckpointId: optionalText(
      "parentCheckpointId" in canon ? canon.parentCheckpointId : undefined,
      "Canon parent checkpoint id",
    ) as CanonCheckpointRecord["parentCheckpointId"],
    lineageKind: "lineageKind" in canon ? canon.lineageKind : undefined,
    state: "state" in canon ? canon.state : undefined,
    prefix_id: optionalText("prefix_id" in canon ? canon.prefix_id : undefined, "Canon prefix id"),
    execution_state_id: optionalText(
      "execution_state_id" in canon ? canon.execution_state_id : undefined,
      "Canon execution state id",
    ),
  };
}

function normalizeAttachment(input: AuthoritativeNawabariAttachmentInput | undefined): ExecutionManifestAttachment {
  if (input === undefined) {
    return {
      authority: "none",
      status: "missing",
      completeness: "incomplete",
      freshness: "unknown",
      evidenceHash: undefined,
      physical: undefined,
      reasons: ["authoritative Nawabari attachment evidence was not supplied"],
    };
  }
  if (input.authority !== "nawabari") throw new ExecutionManifestError("attachment authority is not supported");
  const explicitReason = optionalText(input.reason, "attachment reason", MAX_REASON_LENGTH);
  const evidence = input.evidence;
  if (evidence === undefined) {
    const status = input.status ?? "missing";
    if (status === "attached") throw new ExecutionManifestError("attached Nawabari evidence is missing");
    return {
      authority: "nawabari",
      status,
      completeness: "incomplete",
      freshness: status === "stale" ? "stale" : "unknown",
      evidenceHash: undefined,
      physical: undefined,
      reasons: boundedReasons([explicitReason ?? `Nawabari attachment evidence is ${status}`], "attachment reason"),
    };
  }
  const evidenceHash = boundedText(evidence.evidenceHash, "Nawabari evidence hash", MAX_EVIDENCE_HASH_LENGTH);
  const commonReasons = [...evidence.incompleteReasons, ...(explicitReason === undefined ? [] : [explicitReason])];
  const physicalValues = [evidence.sessionId, evidence.worktree, evidence.branch];
  const physicalValid = physicalValues.every((value) => typeof value === "string" && value.trim().length > 0);
  const branchId = optionalText(evidence.branchId, "Nawabari branch id");
  const status: ExecutionManifestAttachmentStatus =
    !physicalValid || evidence.complete !== true
      ? "invalid"
      : evidence.sessionState === "active"
        ? "attached"
        : "stale";
  const complete = status === "attached" && evidence.baseRevisionProven === true && evidenceHash !== undefined;
  const reasons = boundedReasons(
    [
      ...commonReasons,
      ...(evidence.complete !== true ? ["Nawabari evidence is incomplete"] : []),
      ...(physicalValid ? [] : ["Nawabari evidence is missing physical attachment identity"]),
      ...(evidence.sessionState === "active" ? [] : ["Nawabari session is not active"]),
      ...(evidence.baseRevisionProven === true ? [] : ["Nawabari base revision is not proven"]),
    ],
    "attachment reason",
  );
  return {
    authority: "nawabari",
    status,
    completeness: complete ? "complete" : "incomplete",
    freshness: status === "attached" && complete ? "current" : status === "stale" ? "stale" : "unknown",
    evidenceHash,
    physical: physicalValid
      ? {
          sessionId: evidence.sessionId,
          worktree: evidence.worktree,
          branch: evidence.branch,
          branchId,
          sessionState: evidence.sessionState,
        }
      : undefined,
    reasons,
  };
}

function overallDiagnostics(
  intent: ExecutionManifestIntent,
  attachment: ExecutionManifestAttachment,
): ExecutionManifestDiagnostics {
  const canonComplete =
    intent.canon !== undefined && intent.canon.prefix_id !== undefined && intent.canon.execution_state_id !== undefined;
  const reasons = [
    ...(intent.task === undefined ? ["task facts were not supplied"] : []),
    ...(intent.manager === undefined ? ["Manager execution identity was not supplied"] : []),
    ...(!canonComplete ? ["complete Canon identity was not supplied"] : []),
    ...(intent.semanticPlan.claimGeneration.strategy === "blocked" ? [intent.semanticPlan.claimGeneration.reason] : []),
    ...attachment.reasons,
  ];
  return {
    completeness:
      intent.task !== undefined &&
      intent.manager !== undefined &&
      canonComplete &&
      intent.semanticPlan.claimGeneration.strategy !== "blocked" &&
      attachment.completeness === "complete"
        ? "complete"
        : "incomplete",
    freshness: attachment.freshness,
    reasons: boundedReasons(reasons, "manifest diagnostic"),
  };
}

/** Create a deterministic, bounded projection from existing authority facts. */
export function createExecutionManifest(input: ExecutionManifestInput = {}): ExecutionManifest {
  if (input.semanticPlan !== undefined && input.scope !== undefined) {
    const left = serializeSemanticPlan(input.semanticPlan);
    const right = serializeSemanticPlan(input.scope);
    if (left !== right) throw new ExecutionManifestError("semanticPlan and scope disagree");
  }
  const intent: ExecutionManifestIntent = {
    task: normalizeTask(input.task),
    manager: normalizeManager(input.manager),
    canon: normalizeCanon(input.canon),
    semanticPlan: normalizeSemanticPlan(input.semanticPlan ?? input.scope),
  };
  if (input.nawabari !== undefined && input.attachment !== undefined) {
    const nawabari = normalizeAttachment(input.nawabari);
    const attachment = normalizeAttachment(input.attachment);
    if (JSON.stringify(nawabari) !== JSON.stringify(attachment))
      throw new ExecutionManifestError("nawabari and attachment evidence disagree");
  }
  const suppliedAttachment = input.nawabari ?? input.attachment;
  const attachment = normalizeAttachment(suppliedAttachment);
  return {
    contractId: EXECUTION_MANIFEST_CONTRACT_ID,
    schemaVersion: EXECUTION_MANIFEST_SCHEMA_VERSION,
    intent,
    attachment,
    diagnostics: overallDiagnostics(intent, attachment),
  };
}

export const normalizeExecutionManifest = createExecutionManifest;
export const projectExecutionManifest = createExecutionManifest;
export const normalizeSemanticExecutionPlan = normalizeSemanticPlan;

function serializeSemanticPlan(plan: SemanticExecutionPlan): string {
  return JSON.stringify(normalizeSemanticPlan(plan));
}

/** Serialize the normalized manifest with stable field and array ordering. */
export function serializeExecutionManifest(manifest: ExecutionManifest): string {
  const validation = validateExecutionManifest(manifest);
  if (!validation.valid) throw new ExecutionManifestError(validation.errors.join("; "));
  const intent: ExecutionManifestIntent = {
    task: manifest.intent.task,
    manager: manifest.intent.manager,
    canon: manifest.intent.canon,
    semanticPlan: normalizeSemanticPlan(manifest.intent.semanticPlan),
  };
  const attachment: ExecutionManifestAttachment = {
    authority: manifest.attachment.authority,
    status: manifest.attachment.status,
    completeness: manifest.attachment.completeness,
    freshness: manifest.attachment.freshness,
    evidenceHash: manifest.attachment.evidenceHash,
    physical:
      manifest.attachment.physical === undefined
        ? undefined
        : {
            sessionId: boundedText(manifest.attachment.physical.sessionId, "attachment session id")!,
            worktree: boundedText(manifest.attachment.physical.worktree, "attachment worktree")!,
            branch: boundedText(manifest.attachment.physical.branch, "attachment branch")!,
            branchId: boundedText(manifest.attachment.physical.branchId, "attachment branch id")!,
            sessionState: boundedText(manifest.attachment.physical.sessionState, "attachment session state")!,
          },
    reasons: boundedReasons(manifest.attachment.reasons, "attachment reason"),
  };
  const diagnostics: ExecutionManifestDiagnostics = {
    completeness: manifest.diagnostics.completeness,
    freshness: manifest.diagnostics.freshness,
    reasons: boundedReasons(manifest.diagnostics.reasons, "manifest diagnostic"),
  };
  return JSON.stringify({
    contractId: EXECUTION_MANIFEST_CONTRACT_ID,
    schemaVersion: EXECUTION_MANIFEST_SCHEMA_VERSION,
    intent,
    attachment,
    diagnostics,
  } satisfies ExecutionManifest);
}

export const canonicalExecutionManifestText = serializeExecutionManifest;

function validationErrors(manifest: ExecutionManifest): string[] {
  const errors: string[] = [];
  if (manifest.contractId !== EXECUTION_MANIFEST_CONTRACT_ID) errors.push("manifest contract id is unsupported");
  if (manifest.schemaVersion !== EXECUTION_MANIFEST_SCHEMA_VERSION)
    errors.push("manifest schema version is unsupported");
  if (typeof manifest.intent !== "object" || manifest.intent === null) {
    errors.push("manifest intent is missing");
    return errors;
  }
  if (typeof manifest.intent.semanticPlan !== "object" || manifest.intent.semanticPlan === null) {
    errors.push("manifest semantic plan is missing");
  } else if (manifest.intent.semanticPlan.schemaVersion !== 1) {
    errors.push("semantic plan schema version is unsupported");
  } else {
    try {
      normalizeSemanticPlan(manifest.intent.semanticPlan);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "semantic plan is invalid");
    }
  }
  if (typeof manifest.attachment !== "object" || manifest.attachment === null) {
    errors.push("manifest attachment is missing");
    return errors;
  }
  if (manifest.attachment.authority === "none" && manifest.attachment.physical !== undefined)
    errors.push("physical attachment exists without an authority");
  if (manifest.attachment.status === "attached" && manifest.attachment.physical === undefined)
    errors.push("attached manifest is missing physical attachment evidence");
  if (manifest.attachment.completeness === "complete" && manifest.attachment.freshness !== "current")
    errors.push("complete attachment is not current");
  if (manifest.attachment.physical !== undefined && manifest.attachment.authority !== "nawabari")
    errors.push("physical attachment is not Nawabari-authoritative");
  if (manifest.attachment.status === "missing" && manifest.attachment.physical !== undefined)
    errors.push("missing attachment cannot contain physical evidence");
  if (manifest.attachment.status === "ambiguous" && manifest.attachment.physical !== undefined)
    errors.push("ambiguous attachment cannot contain physical evidence");
  if (
    manifest.attachment.status !== "attached" &&
    manifest.attachment.status !== "missing" &&
    manifest.attachment.status !== "stale" &&
    manifest.attachment.status !== "ambiguous" &&
    manifest.attachment.status !== "invalid"
  )
    errors.push("attachment status is unsupported");
  if (manifest.attachment.authority !== "nawabari" && manifest.attachment.authority !== "none")
    errors.push("attachment authority is unsupported");
  if (manifest.attachment.completeness !== "complete" && manifest.attachment.completeness !== "incomplete")
    errors.push("attachment completeness is unsupported");
  if (
    manifest.attachment.freshness !== "current" &&
    manifest.attachment.freshness !== "stale" &&
    manifest.attachment.freshness !== "unknown"
  )
    errors.push("attachment freshness is unsupported");
  return errors;
}

/** Validate without consulting a provider or mutating any state. */
export function validateExecutionManifest(value: unknown): ExecutionManifestValidation {
  if (typeof value !== "object" || value === null) {
    return {
      valid: false,
      completeness: "incomplete",
      freshness: "unknown",
      errors: ["manifest must be an object"],
      warnings: [],
    };
  }
  const manifest = value as ExecutionManifest;
  const errors = validationErrors(manifest);
  const warnings = manifest.diagnostics?.reasons ?? [];
  return {
    valid: errors.length === 0,
    completeness: manifest.diagnostics?.completeness ?? "incomplete",
    freshness: manifest.diagnostics?.freshness ?? "unknown",
    errors,
    warnings,
  };
}

export function isExecutionManifestValid(value: unknown): boolean {
  return validateExecutionManifest(value).valid;
}

export function parseExecutionManifest(value: unknown): ExecutionManifest {
  const validation = validateExecutionManifest(value);
  if (!validation.valid) throw new ExecutionManifestError(validation.errors.join("; "));
  return value as ExecutionManifest;
}
