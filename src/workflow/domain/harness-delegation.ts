import crypto from "node:crypto";
import path from "node:path";
import {
  ManagerError,
  ManagerSessionService,
  type ManagerResourceClaim,
  type ManagerResourceScope,
} from "../../manager/service.js";
import { NawabariExecutionClient } from "../nawabari.js";
import { transitionTask } from "./task-lifecycle.js";
import type { RepositoryInstanceId } from "./identity.js";
import {
  deriveTaskRunIdempotencyKey,
  runManagedTask,
  type ManagedTaskRunResult,
} from "./managed-task-run.js";
import type { LifecycleState } from "./lifecycle.js";
import type {
  ManagerRuntimeState,
  ManagerSessionRecord,
  ManagerSessionId,
  PullRequestRecord,
  TaskId,
  TaskRecord,
  WorkflowStateStore,
} from "../state/store.js";

export const HARNESS_DELEGATION_SCHEMA_VERSION = 1 as const;

export const HARNESS_DELEGATION_STATUSES = [
  "accepted",
  "running",
  "completed",
  "failed",
  "cancelled",
  "blocked",
  "missing",
] as const;
export type HarnessWorkStatus = (typeof HARNESS_DELEGATION_STATUSES)[number];

export const HARNESS_ERROR_CLASSES = [
  "invalid_input",
  "unavailable_capability",
  "lifecycle_conflict",
  "governed_refusal",
  "execution_failure",
  "internal_failure",
] as const;
export type HarnessErrorClass = (typeof HARNESS_ERROR_CLASSES)[number];

export interface HarnessRepositorySelector {
  path?: string;
  instanceId?: string;
}

export type HarnessSelectorValue = string | HarnessRepositorySelector;

export interface HarnessWorkConstraints {
  taskSlug?: string;
  issueRef?: string;
  branchType?: string;
  agentKind?: string;
  launchProfile?: string;
  provider?: string;
  model?: string;
  paths?: readonly string[];
  claims?: readonly ManagerResourceClaim[];
}

export interface DelegateWorkRequest {
  goal: string;
  workspace?: HarnessSelectorValue;
  repository?: HarnessSelectorValue;
  workspaceSelector?: HarnessSelectorValue;
  constraints?: HarnessWorkConstraints;
  idempotencyKey?: string;
}

export interface ContinueWorkRequest {
  workId: string;
  followUp: string;
}

export interface CancelWorkRequest {
  workId: string;
  reason?: string;
}

export interface HarnessError {
  class: HarnessErrorClass;
  code: string;
  message: string;
}

export interface HarnessLifecycleProjection {
  taskState: LifecycleState;
  managerState: ManagerSessionRecord["lifecycleState"] | null;
  runtimeState: ManagerRuntimeState | null;
  semanticState: LifecycleState | "unbound" | null;
  reconciliationState: ManagerSessionRecord["reconciliationState"] | null;
  allowedActions: readonly ("continue" | "cancel")[];
}

export interface HarnessEvidenceProjection {
  latestStatus?: string;
  receipts: readonly { code: string; source: string; message: string }[];
}

export interface HarnessArtifactProjection {
  kind: "pull_request";
  provider: string;
  repositoryId: string;
  number: number;
  url: string;
  state: string;
  headSha?: string;
  mergeRevision?: string;
}

/** Safe northbound projection. Paths, runtime names, argv, raw logs, and credentials are omitted. */
export interface HarnessWorkSnapshot {
  schemaVersion: typeof HARNESS_DELEGATION_SCHEMA_VERSION;
  workId: string;
  status: HarnessWorkStatus;
  lifecycle: HarnessLifecycleProjection;
  identity: {
    repositoryInstanceId: string;
    taskSlug: string;
    issueRef?: string;
    branchName?: string;
    agentKind?: string;
  };
  outcome: {
    semanticState: string;
    summary: string;
  };
  evidence: HarnessEvidenceProjection;
  artifacts: readonly HarnessArtifactProjection[];
  truncated: boolean;
}

export interface HarnessOperationResult {
  ok: boolean;
  status: HarnessWorkStatus;
  work?: HarnessWorkSnapshot;
  error?: HarnessError;
  reused?: boolean;
}

export interface HarnessDelegationDependencies {
  defaultWorkspaceRoot: string;
  store: () => Promise<WorkflowStateStore>;
  nawabari: NawabariExecutionClient;
  managerForWorkspace: (
    workspaceRoot: string,
    store: WorkflowStateStore,
  ) => Promise<ManagerSessionService>;
}

const MAX_GOAL_LENGTH = 64 * 1024;
const MAX_FOLLOW_UP_LENGTH = 64 * 1024;
const MAX_WORK_ID_LENGTH = 128;
const MAX_SELECTOR_LENGTH = 2_048;
const MAX_CONSTRAINT_TEXT_LENGTH = 128;
const MAX_STATUS_LENGTH = 512;
const MAX_RECEIPTS = 4;
const MAX_ARTIFACTS = 16;
const MAX_SCOPE_ENTRIES = 128;
const ACTIVE_RUNTIME_STATES: readonly ManagerRuntimeState[] = ["starting", "running", "detached"];
const TERMINAL_TASK_STATES: ReadonlySet<LifecycleState> = new Set([
  "merged",
  "abandoned",
  "cleaned",
]);
const CONTINUE_INELIGIBLE_TASK_STATES: ReadonlySet<LifecycleState> = new Set([
  "committed",
  "pushed",
  "pull-request-open",
  "merged",
  "abandoned",
  "orphaned",
  "cleaned",
]);

class HarnessInputError extends Error {
  readonly code = "invalid_input";
}

function boundedText(value: string, maxLength: number, label: string): string {
  if (value.length === 0 || value.trim().length === 0) throw new HarnessInputError(`${label} must be non-empty`);
  if (value.length > maxLength) throw new HarnessInputError(`${label} must be at most ${maxLength} characters`);
  if (value.includes("\u0000")) throw new HarnessInputError(`${label} contains an unsupported NUL character`);
  return value;
}

function optionalText(value: unknown, label: string, maxLength = MAX_CONSTRAINT_TEXT_LENGTH): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HarnessInputError(`${label} must be a string`);
  if (value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value))
    throw new HarnessInputError(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWorkId(value: unknown): string {
  if (typeof value !== "string") throw new HarnessInputError("workId must be a string");
  return boundedText(value, MAX_WORK_ID_LENGTH, "workId");
}

function selectorObject(value: HarnessSelectorValue, label: string): HarnessRepositorySelector {
  if (typeof value === "string") return { path: boundedText(value, MAX_SELECTOR_LENGTH, label) };
  if (!isRecord(value)) throw new HarnessInputError(`${label} must be a string or selector object`);
  const selectedPath = optionalText(value.path, `${label}.path`, MAX_SELECTOR_LENGTH);
  const instanceId = optionalText(value.instanceId, `${label}.instanceId`, MAX_WORK_ID_LENGTH);
  if (selectedPath === undefined && instanceId === undefined)
    throw new HarnessInputError(`${label} must contain path or instanceId`);
  if (selectedPath !== undefined && instanceId !== undefined)
    throw new HarnessInputError(`${label} must not contain both path and instanceId`);
  return {
    ...(selectedPath === undefined ? {} : { path: selectedPath }),
    ...(instanceId === undefined ? {} : { instanceId }),
  };
}

function scopeClaims(value: unknown): ManagerResourceClaim[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HarnessInputError("constraints.claims must be an array");
  if (value.length > MAX_SCOPE_ENTRIES) throw new HarnessInputError("constraints.claims is too large");
  return value.map((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.resource !== "string")
      throw new HarnessInputError(`constraints.claims[${index}] is invalid`);
    if (candidate.mode !== "read" && candidate.mode !== "write" && candidate.mode !== "exclusive-write")
      throw new HarnessInputError(`constraints.claims[${index}].mode is invalid`);
    return { resource: candidate.resource, mode: candidate.mode };
  });
}

function scopePaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HarnessInputError("constraints.paths must be an array");
  if (value.length > MAX_SCOPE_ENTRIES || value.some((candidate) => typeof candidate !== "string"))
    throw new HarnessInputError("constraints.paths is invalid");
  return value.map((candidate) => candidate as string);
}

function normalizeConstraints(value: HarnessWorkConstraints | undefined): {
  taskSlug?: string;
  issueRef?: string;
  branchType: string;
  agentKind: string;
  provider?: string;
  model?: string;
  scope?: ManagerResourceScope;
} {
  if (value !== undefined && !isRecord(value)) throw new HarnessInputError("constraints must be an object");
  const raw = (value ?? {}) as Record<string, unknown>;
  const taskSlug = optionalText(raw.taskSlug, "constraints.taskSlug", 96);
  const issueRef = optionalText(raw.issueRef, "constraints.issueRef", 96);
  const branchType = optionalText(raw.branchType, "constraints.branchType", 32) ?? "feat";
  const agentKind = optionalText(raw.agentKind, "constraints.agentKind", 32);
  const launchProfile = optionalText(raw.launchProfile, "constraints.launchProfile", 32);
  if (agentKind !== undefined && launchProfile !== undefined && agentKind !== launchProfile)
    throw new HarnessInputError("constraints.agentKind and constraints.launchProfile conflict");
  const paths = scopePaths(raw.paths);
  const claims = scopeClaims(raw.claims);
  const scope = paths === undefined && claims === undefined ? undefined : { paths, claims };
  if (scope !== undefined && paths?.length === 0 && claims?.length === 0)
    throw new HarnessInputError("constraints scope must not be empty");
  return {
    ...(taskSlug === undefined ? {} : { taskSlug }),
    ...(issueRef === undefined ? {} : { issueRef }),
    branchType,
    agentKind: agentKind ?? launchProfile ?? "codex",
    ...(optionalText(raw.provider, "constraints.provider") === undefined
      ? {}
      : { provider: optionalText(raw.provider, "constraints.provider") }),
    ...(optionalText(raw.model, "constraints.model") === undefined
      ? {}
      : { model: optionalText(raw.model, "constraints.model") }),
    ...(scope === undefined ? {} : { scope }),
  };
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  const key = optionalText(value, "idempotencyKey", 128);
  if (key !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key))
    throw new HarnessInputError("idempotencyKey is invalid");
  return key;
}

function generatedTaskSlug(goal: string): string {
  return `mcp-${crypto.createHash("sha256").update(goal).digest("hex").slice(0, 24)}`;
}

function safeText(value: string | undefined, maxLength = MAX_STATUS_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  const redacted = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/(?:token|password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'`;,)\]}]*/gu, "[path]")
    .trim();
  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
}

function safeCode(value: string): string {
  const code = value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 96);
  return code.length === 0 ? "unknown" : code;
}

function safeUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password)
      return undefined;
    const safe = `${parsed.origin}${parsed.pathname}`;
    return safe.length > 2_048 ? safe.slice(0, 2_048) : safe;
  } catch {
    return undefined;
  }
}

function safeSha(value: string | undefined): string | undefined {
  return value !== undefined && /^[0-9a-f]{7,128}$/iu.test(value) ? value : undefined;
}

function terminalStatus(task: TaskRecord): HarnessWorkStatus | undefined {
  if (task.lifecycleState === "abandoned") return "cancelled";
  if (task.lifecycleState === "merged" || task.lifecycleState === "cleaned") return "completed";
  if (task.lifecycleState === "orphaned") return "blocked";
  return undefined;
}

function statusFor(task: TaskRecord, manager: ManagerSessionRecord | undefined): HarnessWorkStatus {
  const terminal = terminalStatus(task);
  if (terminal !== undefined) return terminal;
  if (manager === undefined) return task.lifecycleState === "planned" ? "accepted" : "blocked";
  if (manager.runtimeState === "failed" || manager.lifecycleState === "failed") return "failed";
  if (ACTIVE_RUNTIME_STATES.includes(manager.runtimeState)) {
    return manager.runtimeState === "starting" ? "accepted" : "running";
  }
  if (task.lifecycleState === "planned") return "accepted";
  return "blocked";
}

function summaryFor(status: HarnessWorkStatus, task: TaskRecord, manager: ManagerSessionRecord | undefined): string {
  if (status === "accepted") return "work accepted; managed runtime is starting or awaiting launch";
  if (status === "running") return "managed work is running in the existing harness execution context";
  if (status === "completed") return `work completed with lifecycle state ${task.lifecycleState}`;
  if (status === "cancelled") return "work cancellation was recorded through the task lifecycle";
  if (status === "missing") return "work item was not found";
  if (status === "failed") return safeText(manager?.errorMessage ?? manager?.latestStatus) ?? "managed execution failed";
  return safeText(manager?.reconciliationMessage ?? manager?.latestStatus) ?? "work requires governed reconciliation";
}

function allowedActionsFor(
  task: TaskRecord,
  manager: ManagerSessionRecord | undefined,
  status: HarnessWorkStatus,
): readonly ("continue" | "cancel")[] {
  if (manager === undefined || TERMINAL_TASK_STATES.has(task.lifecycleState) || task.lifecycleState === "orphaned") return [];
  const actions: ("continue" | "cancel")[] = [];
  if (!CONTINUE_INELIGIBLE_TASK_STATES.has(task.lifecycleState)) actions.push("continue");
  if (status !== "completed" && status !== "cancelled") actions.push("cancel");
  return actions;
}

function artifactsFor(records: readonly PullRequestRecord[]): { items: HarnessArtifactProjection[]; truncated: boolean } {
  const items = [...records]
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.repositoryId.localeCompare(right.repositoryId) ||
        left.prNumber - right.prNumber ||
        left.recordId.localeCompare(right.recordId),
    )
    .slice(0, MAX_ARTIFACTS)
    .flatMap((record) => {
      const url = safeUrl(record.url);
      if (url === undefined) return [];
      return [{
        kind: "pull_request" as const,
        provider: safeText(record.provider, 96) ?? "unknown",
        repositoryId: safeText(record.repositoryId, 256) ?? "unknown",
        number: record.prNumber,
        url,
        state: safeText(record.lifecycleState, 96) ?? "unknown",
        ...(safeSha(record.headSha) === undefined ? {} : { headSha: safeSha(record.headSha) }),
        ...(safeSha(record.mergeRevision) === undefined ? {} : { mergeRevision: safeSha(record.mergeRevision) }),
      }];
    });
  return { items, truncated: records.length > MAX_ARTIFACTS };
}

function snapshotFor(
  store: WorkflowStateStore,
  task: TaskRecord,
  manager: ManagerSessionRecord | undefined,
  statusOverride?: HarnessWorkStatus,
): HarnessWorkSnapshot {
  const status = statusOverride ?? statusFor(task, manager);
  const reconciliation = manager?.latestReceipt === undefined
    ? []
    : [{
        code: safeCode(manager.latestReceipt.code),
        source: manager.latestReceipt.source,
        message: safeText(manager.latestReceipt.message) ?? "",
      }];
  const branchName =
    manager?.branchName ?? store.getTaskStartReconciliation(task.taskId)?.branchName;
  const artifactProjection = artifactsFor(store.listPullRequestRecordsForTask(task.taskId));
  return {
    schemaVersion: HARNESS_DELEGATION_SCHEMA_VERSION,
    workId: task.taskId,
    status,
    lifecycle: {
      taskState: task.lifecycleState,
      managerState: manager?.lifecycleState ?? null,
      runtimeState: manager?.runtimeState ?? null,
      semanticState: manager?.semanticLifecycleState ?? null,
      reconciliationState: manager?.reconciliationState ?? null,
      allowedActions: allowedActionsFor(task, manager, status),
    },
    identity: {
      repositoryInstanceId: task.instanceId,
      taskSlug: task.taskSlug,
      ...(task.issueRef === undefined ? {} : { issueRef: task.issueRef }),
      ...(branchName === undefined ? {} : { branchName }),
      ...(manager?.agentKind === undefined ? {} : { agentKind: manager.agentKind }),
    },
    outcome: {
      semanticState: manager?.semanticLifecycleState ?? task.lifecycleState,
      summary: summaryFor(status, task, manager),
    },
    evidence: {
      ...(safeText(manager?.latestStatus) === undefined ? {} : { latestStatus: safeText(manager?.latestStatus) }),
      receipts: reconciliation,
    },
    artifacts: artifactProjection.items,
    truncated: artifactProjection.truncated,
  };
}

function errorProjection(errorClass: HarnessErrorClass, code: string, message: string): HarnessError {
  return {
    class: errorClass,
    code: safeCode(code),
    message: safeText(message) ?? "operation failed",
  };
}

function classifyError(error: unknown, fallbackCode: string): HarnessError {
  const code =
    error instanceof ManagerError
      ? error.code
      : isRecord(error) && typeof error.code === "string"
        ? error.code
        : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "invalid_request" || code === "invalid-input") return errorProjection("invalid_input", code, message);
  if (code === "zellij_unavailable" || code === "zellij_incompatible" || /^nawabari-(?:unavailable|incompatible)$/u.test(code))
    return errorProjection("unavailable_capability", code, message);
  if (
    code === "forbidden" ||
    code === "claim_conflict" ||
    code === "claim_preflight_stale" ||
    code === "policy-denied" ||
    /(?:policy|governance|protected|claim|issue-required|ownership)/iu.test(code)
  )
    return errorProjection("governed_refusal", code, message);
  if (
    code === "session_not_found" ||
    code === "session_not_running" ||
    code === "session_not_attachable" ||
    code === "session_restart_rejected" ||
    code === "session_continue_rejected" ||
    code === "idempotency_conflict" ||
    code === "worktree_missing" ||
    code === "execution_unresolved" ||
    code === "work_not_found" ||
    code === "manager_session_missing" ||
    code === "multiple_manager_sessions"
  )
    return errorProjection("lifecycle_conflict", code, message);
  if (
    code === "runtime_error" ||
    code === "task_start_failed" ||
    /^nawabari-/u.test(code) ||
    code === "nawabari-command-failed" ||
    code === "execution_failure"
  )
    return errorProjection("execution_failure", code, message);
  return errorProjection("internal_failure", code, message);
}

function resultFailure(
  status: HarnessWorkStatus,
  error: HarnessError,
  work?: HarnessWorkSnapshot,
): HarnessOperationResult {
  return { ok: false, status, ...(work === undefined ? {} : { work }), error };
}

interface FoundWork {
  store: WorkflowStateStore;
  task: TaskRecord;
  manager: ManagerSessionRecord;
  managerService: ManagerSessionService;
}

type WorkLookup =
  | { kind: "found"; value: FoundWork }
  | { kind: "missing"; store: WorkflowStateStore }
  | { kind: "invalid"; store: WorkflowStateStore; error: HarnessError; task?: TaskRecord; manager?: ManagerSessionRecord };

export class HarnessDelegationService {
  private readonly dependencies: HarnessDelegationDependencies;
  private readonly operations = new Map<string, Promise<HarnessOperationResult>>();

  constructor(dependencies: HarnessDelegationDependencies) {
    this.dependencies = dependencies;
  }

  async delegate(request: DelegateWorkRequest): Promise<HarnessOperationResult> {
    let goal: string;
    let constraints: ReturnType<typeof normalizeConstraints>;
    let idempotencyKey: string | undefined;
    try {
      goal = boundedText(request.goal, MAX_GOAL_LENGTH, "goal");
      constraints = normalizeConstraints(request.constraints);
      idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      if (request.workspace !== undefined && request.workspaceSelector !== undefined)
        throw new HarnessInputError("workspace and workspaceSelector must not both be supplied");
    } catch (error) {
      return resultFailure("failed", classifyError(error, "invalid_input"));
    }

    let store: WorkflowStateStore;
    let workspaceRoot: string;
    try {
      store = await this.dependencies.store();
      workspaceRoot = this.resolveWorkspace(
        store,
        request.workspace ?? request.workspaceSelector,
        request.repository,
      );
    } catch (error) {
      return resultFailure("failed", classifyError(error, "workspace_unavailable"));
    }

    const taskSlug = constraints.taskSlug ?? generatedTaskSlug(goal);
    const effectiveKey =
      idempotencyKey ??
      deriveTaskRunIdempotencyKey({
        taskSlug,
        issueRef: constraints.issueRef,
        branchType: constraints.branchType,
        agentKind: constraints.agentKind,
        provider: constraints.provider,
        model: constraints.model,
        instruction: goal,
        scope: constraints.scope,
      });
    return this.withOperation(`delegate:${workspaceRoot}:${effectiveKey}`, async () => {
      try {
        const manager = await this.dependencies.managerForWorkspace(workspaceRoot, store);
        const prior = store
          .listManagerSessions(workspaceRoot)
          .find((candidate) => candidate.idempotencyKey === effectiveKey);
        const run = await runManagedTask({
          workspaceRoot,
          store,
          nawabari: this.dependencies.nawabari,
          manager,
          taskSlug,
          issueRef: constraints.issueRef,
          branchType: constraints.branchType,
          agentKind: constraints.agentKind,
          ...(constraints.provider === undefined ? {} : { provider: constraints.provider }),
          ...(constraints.model === undefined ? {} : { model: constraints.model }),
          instruction: goal,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          ...(constraints.scope === undefined ? {} : { scope: constraints.scope }),
        });
        const task = run.task;
        const managerRecord = this.managerRecord(store, run);
        const work = task === undefined ? undefined : snapshotFor(store, task, managerRecord);
        if (!run.ok) {
          return resultFailure(
            work?.status ?? (run.error.code === "invalid_request" ? "failed" : "blocked"),
            classifyError({ code: run.error.code, message: run.error.message }, run.error.code),
            work,
          );
        }
        if (work === undefined)
          return resultFailure("failed", errorProjection("internal_failure", "work_identity_missing", "managed task identity was not returned"));
        return {
          ok: true,
          status: work.status,
          work,
          ...(prior === undefined ? {} : { reused: true }),
        };
      } catch (error) {
        return resultFailure("failed", classifyError(error, "delegate_failed"));
      }
    });
  }

  async inspect(workIdValue: string): Promise<HarnessOperationResult> {
    let workId: string;
    try {
      workId = normalizeWorkId(workIdValue);
    } catch (error) {
      return resultFailure("failed", classifyError(error, "invalid_input"));
    }
    return this.withOperation(`inspect:${workId}`, async () => {
      let lookup: WorkLookup;
      try {
        lookup = await this.lookup(workId);
      } catch (error) {
        return resultFailure("blocked", classifyError(error, "inspect_failed"));
      }
      if (lookup.kind === "missing")
        return resultFailure("missing", errorProjection("lifecycle_conflict", "work_not_found", "work item was not found"));
      if (lookup.kind === "invalid") {
        const work = lookup.task === undefined ? undefined : snapshotFor(lookup.store, lookup.task, lookup.manager);
        return resultFailure("blocked", lookup.error, work);
      }
      try {
        const observed = await lookup.value.managerService.get(lookup.value.manager.sessionId);
        const task = lookup.value.store.getTask(lookup.value.task.taskId) ?? lookup.value.task;
        const work = snapshotFor(lookup.value.store, task, observed);
        return { ok: true, status: work.status, work };
      } catch (error) {
        const task = lookup.value.store.getTask(lookup.value.task.taskId) ?? lookup.value.task;
        const work = snapshotFor(lookup.value.store, task, lookup.value.manager);
        return resultFailure(work.status === "failed" ? "failed" : "blocked", classifyError(error, "inspect_failed"), work);
      }
    });
  }

  async continueWork(request: ContinueWorkRequest): Promise<HarnessOperationResult> {
    let workId: string;
    let followUp: string;
    try {
      workId = normalizeWorkId(request.workId);
      followUp = boundedText(request.followUp, MAX_FOLLOW_UP_LENGTH, "followUp");
    } catch (error) {
      return resultFailure("failed", classifyError(error, "invalid_input"));
    }
    return this.withOperation(`continue:${workId}`, async () => {
      const lookup = await this.lookupOrFailure(workId, "continue_failed");
      if (lookup.result !== undefined) return lookup.result;
      const found = lookup.value;
      const task = found.store.getTask(found.task.taskId) ?? found.task;
      const existing = snapshotFor(found.store, task, found.manager);
      if (CONTINUE_INELIGIBLE_TASK_STATES.has(task.lifecycleState)) {
        return resultFailure(
          existing.status,
          errorProjection(
            "lifecycle_conflict",
            "continue_not_allowed",
            `continue is not allowed for task lifecycle ${task.lifecycleState}`,
          ),
          existing,
        );
      }
      try {
        const continued = await found.managerService.continueWork(found.manager.sessionId, followUp);
        const refreshedTask = found.store.getTask(task.taskId) ?? task;
        const work = snapshotFor(found.store, refreshedTask, continued);
        return { ok: true, status: work.status, work };
      } catch (error) {
        const refreshedTask = found.store.getTask(task.taskId) ?? task;
        const refreshedManager = found.store.getManagerSession(found.manager.sessionId) ?? found.manager;
        const work = snapshotFor(found.store, refreshedTask, refreshedManager);
        return resultFailure(work.status, classifyError(error, "continue_failed"), work);
      }
    });
  }

  async cancelWork(request: CancelWorkRequest): Promise<HarnessOperationResult> {
    let workId: string;
    try {
      workId = normalizeWorkId(request.workId);
      if (request.reason !== undefined) boundedText(request.reason, MAX_FOLLOW_UP_LENGTH, "reason");
    } catch (error) {
      return resultFailure("failed", classifyError(error, "invalid_input"));
    }
    return this.withOperation(`cancel:${workId}`, async () => {
      const lookup = await this.lookupOrFailure(workId, "cancel_failed");
      if (lookup.result !== undefined) return lookup.result;
      const found = lookup.value;
      const task = found.store.getTask(found.task.taskId) ?? found.task;
      const existing = snapshotFor(found.store, task, found.manager);
      if (task.lifecycleState === "abandoned") return { ok: true, status: "cancelled", work: existing };
      if (TERMINAL_TASK_STATES.has(task.lifecycleState) || task.lifecycleState === "orphaned") {
        return resultFailure(
          existing.status,
          errorProjection("lifecycle_conflict", "cancel_not_allowed", `cancel is not allowed for task lifecycle ${task.lifecycleState}`),
          existing,
        );
      }
      const transition = transitionTask(found.store, task.taskId, "abandoned");
      if (!transition.ok) {
        const refreshedTask = found.store.getTask(task.taskId) ?? task;
        const work = snapshotFor(found.store, refreshedTask, found.manager);
        return resultFailure(work.status, errorProjection("lifecycle_conflict", "cancel_not_allowed", transition.blocked.blockingRule), work);
      }
      try {
        const stopped = await found.managerService.stop(found.manager.sessionId);
        const refreshedTask = found.store.getTask(task.taskId) ?? transition.task;
        const work = snapshotFor(found.store, refreshedTask, stopped, "cancelled");
        return { ok: true, status: "cancelled", work };
      } catch (error) {
        const refreshedTask = found.store.getTask(task.taskId) ?? transition.task;
        const refreshedManager = found.store.getManagerSession(found.manager.sessionId) ?? found.manager;
        const work = snapshotFor(found.store, refreshedTask, refreshedManager, "cancelled");
        return resultFailure("cancelled", classifyError(error, "cancel_failed"), work);
      }
    });
  }

  private async lookupOrFailure(
    workId: string,
    fallbackCode: string,
  ): Promise<{ value: FoundWork; result?: undefined } | { value?: undefined; result: HarnessOperationResult }> {
    try {
      const lookup = await this.lookup(workId);
      if (lookup.kind === "missing")
        return {
          result: resultFailure("missing", errorProjection("lifecycle_conflict", "work_not_found", "work item was not found")),
        };
      if (lookup.kind === "invalid") {
        const work = lookup.task === undefined ? undefined : snapshotFor(lookup.store, lookup.task, lookup.manager);
        return { result: resultFailure("blocked", lookup.error, work) };
      }
      return { value: lookup.value };
    } catch (error) {
      return { result: resultFailure("blocked", classifyError(error, fallbackCode)) };
    }
  }

  private async lookup(workId: string): Promise<WorkLookup> {
    const store = await this.dependencies.store();
    const task = store.getTask(workId as TaskId);
    if (task === undefined) return { kind: "missing", store };
    const sessions = store
      .listManagerSessions(undefined, { limit: 1_000 })
      .filter((candidate) => candidate.taskId === task.taskId);
    if (sessions.length === 0) {
      return {
        kind: "invalid",
        store,
        task,
        error: errorProjection(
          "lifecycle_conflict",
          "manager_session_missing",
          "managed Manager session identity is unavailable for this work item",
        ),
      };
    }
    if (sessions.length !== 1) {
      return {
        kind: "invalid",
        store,
        task,
        manager: sessions[0],
        error: errorProjection(
          "lifecycle_conflict",
          "multiple_manager_sessions",
          "multiple Manager sessions claim this work item; refusing ambiguous control",
        ),
      };
    }
    const manager = sessions[0]!;
    const managerService = await this.dependencies.managerForWorkspace(manager.workspaceRoot, store);
    return { kind: "found", value: { store, task, manager, managerService } };
  }

  private managerRecord(store: WorkflowStateStore, run: ManagedTaskRunResult): ManagerSessionRecord | undefined {
    if (run.ok) return store.getManagerSession(run.manager.sessionId as ManagerSessionId);
    return run.manager === undefined ? undefined : store.getManagerSession(run.manager.sessionId as ManagerSessionId);
  }

  private resolveWorkspace(
    store: WorkflowStateStore,
    workspaceSelector: HarnessSelectorValue | undefined,
    repositorySelector: HarnessSelectorValue | undefined,
  ): string {
    if (workspaceSelector !== undefined && repositorySelector !== undefined)
      throw new HarnessInputError("workspace and repository selectors conflict");
    const selector = workspaceSelector ?? repositorySelector;
    if (selector === undefined) return path.resolve(this.dependencies.defaultWorkspaceRoot);
    const normalized = selectorObject(selector, workspaceSelector === undefined ? "repository" : "workspace");
    const knownRepositoryInstance =
      repositorySelector !== undefined &&
      typeof repositorySelector === "string"
        ? store.getRepositoryInstance(repositorySelector as RepositoryInstanceId)
        : undefined;
    const instance = normalized.instanceId === undefined ? knownRepositoryInstance : store.getRepositoryInstance(normalized.instanceId as RepositoryInstanceId);
    if (normalized.path !== undefined && instance === undefined)
      return path.resolve(this.dependencies.defaultWorkspaceRoot, normalized.path);
    if (instance === undefined) throw new HarnessInputError("repository instance was not found");
    const currentPaths = store.listRepositoryPaths(instance.instanceId).filter((candidate) => candidate.isCurrent);
    if (currentPaths.length !== 1) throw new HarnessInputError("repository current path is unavailable or ambiguous");
    return path.resolve(currentPaths[0]!.canonicalPath);
  }

  private withOperation(key: string, operation: () => Promise<HarnessOperationResult>): Promise<HarnessOperationResult> {
    const previous = this.operations.get(key);
    if (previous !== undefined) return previous;
    const current = operation().finally(() => {
      if (this.operations.get(key) === current) this.operations.delete(key);
    });
    this.operations.set(key, current);
    return current;
  }
}
