import crypto from "node:crypto";
import path from "node:path";
import {
  ManagerError,
  ManagerSessionService,
  selectControllingManagerSession,
  type ManagerResourceClaim,
  type ManagerResourceScope,
} from "../../manager/service.js";
import { NawabariExecutionClient } from "../nawabari.js";
import { allowedNextTransitions, validateTransition } from "./lifecycle.js";
import type { LifecycleState } from "./lifecycle.js";
import { transitionTask } from "./task-lifecycle.js";
import type { RepositoryInstanceId } from "./identity.js";
import {
  deriveTaskRunIdempotencyKey,
  runManagedTask,
  type ManagedTaskRunResult,
} from "./managed-task-run.js";
import type {
  ManagerRuntimeState,
  ManagerSessionId,
  ManagerSessionRecord,
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

export interface HarnessWorkSnapshot {
  schemaVersion: typeof HARNESS_DELEGATION_SCHEMA_VERSION;
  workId: string;
  status: HarnessWorkStatus;
  summary: string;
  lifecycle: {
    taskState: LifecycleState;
    managerState: ManagerSessionRecord["lifecycleState"] | null;
    runtimeState: ManagerRuntimeState | null;
    allowedActions: readonly ("continue" | "cancel")[];
  };
  evidence: {
    latestStatus?: string;
    latestReceipt?: { code: string; source: string; message: string };
  };
  artifacts: readonly HarnessArtifact[];
  truncated: boolean;
}

export interface HarnessArtifact {
  kind: "pull_request";
  provider: string;
  repositoryId: string;
  number: number;
  url: string;
  state: string;
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
const MAX_WORK_ID_LENGTH = 128;
const MAX_SELECTOR_LENGTH = 2_048;
const MAX_STATUS_LENGTH = 512;
const MAX_SCOPE_ENTRIES = 128;
export const MAX_HARNESS_ARTIFACTS = 16;

class HarnessInputError extends Error {}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HarnessInputError(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength || value.includes("\u0000")) {
    throw new HarnessInputError(`${label} is invalid`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedString(value, label, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWorkId(value: unknown): string {
  return boundedString(value, "workId", MAX_WORK_ID_LENGTH);
}

function normalizeSelector(value: HarnessSelectorValue, label: string): HarnessRepositorySelector {
  if (typeof value === "string") return { path: boundedString(value, label, MAX_SELECTOR_LENGTH) };
  if (!isRecord(value)) throw new HarnessInputError(`${label} must be a string or selector object`);
  const selectedPath = optionalString(value.path, `${label}.path`, MAX_SELECTOR_LENGTH);
  const instanceId = optionalString(value.instanceId, `${label}.instanceId`, MAX_WORK_ID_LENGTH);
  if ((selectedPath === undefined) === (instanceId === undefined)) {
    throw new HarnessInputError(`${label} must contain exactly one of path or instanceId`);
  }
  return selectedPath === undefined ? { instanceId } : { path: selectedPath };
}

function normalizeScope(value: Record<string, unknown>): ManagerResourceScope | undefined {
  const paths = value.paths;
  const claims = value.claims;
  if (paths === undefined && claims === undefined) return undefined;
  if (paths !== undefined && (!Array.isArray(paths) || paths.length > MAX_SCOPE_ENTRIES)) {
    throw new HarnessInputError("constraints.paths is invalid");
  }
  if (claims !== undefined && (!Array.isArray(claims) || claims.length > MAX_SCOPE_ENTRIES)) {
    throw new HarnessInputError("constraints.claims is invalid");
  }
  const normalizedPaths = paths?.map((entry, index) =>
    boundedString(entry, `constraints.paths[${index}]`, 512),
  );
  const normalizedClaims = claims?.map((entry, index) => {
    if (!isRecord(entry)) throw new HarnessInputError(`constraints.claims[${index}] is invalid`);
    const resource = boundedString(entry.resource, `constraints.claims[${index}].resource`, 512);
    if (entry.mode !== "read" && entry.mode !== "write" && entry.mode !== "exclusive-write") {
      throw new HarnessInputError(`constraints.claims[${index}].mode is invalid`);
    }
    return { resource, mode: entry.mode } satisfies ManagerResourceClaim;
  });
  if ((normalizedPaths?.length ?? 0) === 0 && (normalizedClaims?.length ?? 0) === 0) {
    throw new HarnessInputError("constraints scope must not be empty");
  }
  return { paths: normalizedPaths, claims: normalizedClaims };
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
  const agentKind = optionalString(raw.agentKind, "constraints.agentKind", 32);
  const launchProfile = optionalString(raw.launchProfile, "constraints.launchProfile", 32);
  if (agentKind !== undefined && launchProfile !== undefined && agentKind !== launchProfile) {
    throw new HarnessInputError("constraints.agentKind and constraints.launchProfile conflict");
  }
  const taskSlug = optionalString(raw.taskSlug, "constraints.taskSlug", 96);
  const issueRef = optionalString(raw.issueRef, "constraints.issueRef", 96);
  const provider = optionalString(raw.provider, "constraints.provider", 128);
  const model = optionalString(raw.model, "constraints.model", 128);
  const scope = normalizeScope(raw);
  return {
    ...(taskSlug === undefined ? {} : { taskSlug }),
    ...(issueRef === undefined ? {} : { issueRef }),
    branchType: optionalString(raw.branchType, "constraints.branchType", 32) ?? "feat",
    agentKind: agentKind ?? launchProfile ?? "codex",
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(scope === undefined ? {} : { scope }),
  };
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  const key = optionalString(value, "idempotencyKey", 128);
  if (key !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key)) {
    throw new HarnessInputError("idempotencyKey is invalid");
  }
  return key;
}

function generatedTaskSlug(goal: string): string {
  return `mcp-${crypto.createHash("sha256").update(goal).digest("hex").slice(0, 24)}`;
}

function safeText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/(?:token|password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'`;,)\]}]*/gu, "[path]")
    .trim();
  return sanitized.slice(0, MAX_STATUS_LENGTH);
}

function safeCode(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 96) || "unknown";
}

function isActiveRuntime(state: ManagerRuntimeState): boolean {
  return state === "starting" || state === "running" || state === "detached";
}

function statusFor(task: TaskRecord, manager: ManagerSessionRecord | undefined): HarnessWorkStatus {
  if (task.lifecycleState === "abandoned") return "cancelled";
  if (task.lifecycleState === "merged" || task.lifecycleState === "cleaned") return "completed";
  if (task.lifecycleState === "orphaned") return "blocked";
  if (manager === undefined) return task.lifecycleState === "planned" ? "accepted" : "blocked";
  if (manager.runtimeState === "failed" || manager.lifecycleState === "failed") return "failed";
  if (isActiveRuntime(manager.runtimeState)) return manager.runtimeState === "starting" ? "accepted" : "running";
  return task.lifecycleState === "planned" ? "accepted" : "blocked";
}

function summaryFor(status: HarnessWorkStatus, manager: ManagerSessionRecord | undefined): string {
  if (status === "accepted") return "work accepted";
  if (status === "running") return "work running";
  if (status === "completed") return "work completed";
  if (status === "cancelled") return "work cancelled";
  if (status === "missing") return "work not found";
  return safeText(manager?.errorMessage ?? manager?.latestStatus) ?? `work ${status}`;
}

function allowedActionsFor(
  task: TaskRecord,
  manager: ManagerSessionRecord | undefined,
): readonly ("continue" | "cancel")[] {
  const actions: ("continue" | "cancel")[] = [];
  if (
    manager !== undefined &&
    manager.semanticLifecycleState !== "unbound" &&
    (manager.semanticLifecycleState === "planned" || manager.semanticLifecycleState === "active")
  ) {
    actions.push("continue");
  }
  if (manager !== undefined && allowedNextTransitions(task.lifecycleState).includes("abandoned")) {
    actions.push("cancel");
  }
  return actions;
}

function artifactFor(record: PullRequestRecord): HarnessArtifact | undefined {
  try {
    const parsed = new URL(record.url);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
      return undefined;
    }
    return {
      kind: "pull_request",
      provider: record.provider.slice(0, 96),
      repositoryId: record.repositoryId.slice(0, 256),
      number: record.prNumber,
      url: `${parsed.origin}${parsed.pathname}`.slice(0, 2_048),
      state: record.lifecycleState.slice(0, 96),
    };
  } catch {
    return undefined;
  }
}

function snapshotFor(
  store: WorkflowStateStore,
  task: TaskRecord,
  manager: ManagerSessionRecord | undefined,
  statusOverride?: HarnessWorkStatus,
): HarnessWorkSnapshot {
  const status = statusOverride ?? statusFor(task, manager);
  const records = store.listPullRequestRecordsForTask(task.taskId);
  const artifacts = records
    .slice()
    .sort((left, right) => left.recordId.localeCompare(right.recordId))
    .slice(0, MAX_HARNESS_ARTIFACTS)
    .flatMap((record) => {
      const artifact = artifactFor(record);
      return artifact === undefined ? [] : [artifact];
    });
  const latestStatus = safeText(manager?.latestStatus);
  const receipt = manager?.latestReceipt;
  return {
    schemaVersion: HARNESS_DELEGATION_SCHEMA_VERSION,
    workId: task.taskId,
    status,
    summary: summaryFor(status, manager),
    lifecycle: {
      taskState: task.lifecycleState,
      managerState: manager?.lifecycleState ?? null,
      runtimeState: manager?.runtimeState ?? null,
      allowedActions: allowedActionsFor(task, manager),
    },
    evidence: {
      ...(latestStatus === undefined ? {} : { latestStatus }),
      ...(receipt === undefined
        ? {}
        : {
            latestReceipt: {
              code: safeCode(receipt.code),
              source: receipt.source.slice(0, 96),
              message: safeText(receipt.message) ?? "",
            },
          }),
    },
    artifacts,
    truncated: records.length > MAX_HARNESS_ARTIFACTS,
  };
}

function errorProjection(errorClass: HarnessErrorClass, code: string, message: string): HarnessError {
  return { class: errorClass, code: safeCode(code), message: safeText(message) ?? "operation failed" };
}

function classifyError(error: unknown, fallbackCode: string): HarnessError {
  const code =
    error instanceof ManagerError
      ? error.code
      : isRecord(error) && typeof error.code === "string"
        ? error.code
        : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HarnessInputError || code === "invalid_request") {
    return errorProjection("invalid_input", code, message);
  }
  if (/unavailable|incompatible/u.test(code)) return errorProjection("unavailable_capability", code, message);
  if (/(?:policy|governance|protected|claim|forbidden|ownership)/iu.test(code)) {
    return errorProjection("governed_refusal", code, message);
  }
  if (
    /(?:session_not|restart_rejected|continue_rejected|idempotency_conflict|worktree_missing|execution_unresolved|work_not_found|manager_session|multiple_manager)/u.test(
      code,
    )
  ) {
    return errorProjection("lifecycle_conflict", code, message);
  }
  if (code === "runtime_error" || code === "task_start_failed" || /^nawabari-/u.test(code)) {
    return errorProjection("execution_failure", code, message);
  }
  return errorProjection("internal_failure", code, message);
}

function failure(
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
  | { kind: "missing" }
  | { kind: "invalid"; store: WorkflowStateStore; task: TaskRecord; manager?: ManagerSessionRecord; error: HarnessError };

export class HarnessDelegationService {
  private readonly operations = new Map<string, Promise<HarnessOperationResult>>();

  constructor(private readonly dependencies: HarnessDelegationDependencies) {}

  async delegate(request: DelegateWorkRequest): Promise<HarnessOperationResult> {
    let goal: string;
    let constraints: ReturnType<typeof normalizeConstraints>;
    let idempotencyKey: string | undefined;
    let store: WorkflowStateStore;
    let workspaceRoot: string;
    try {
      goal = boundedString(request.goal, "goal", MAX_GOAL_LENGTH);
      constraints = normalizeConstraints(request.constraints);
      idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      if (request.workspace !== undefined && request.workspaceSelector !== undefined) {
        throw new HarnessInputError("workspace and workspaceSelector conflict");
      }
      store = await this.dependencies.store();
      workspaceRoot = this.resolveWorkspace(store, request.workspace ?? request.workspaceSelector, request.repository);
    } catch (error) {
      return failure("failed", classifyError(error, "invalid_input"));
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
          return failure(
            work?.status ?? (run.error.code === "invalid_request" ? "failed" : "blocked"),
            classifyError({ code: run.error.code, message: run.error.message }, run.error.code),
            work,
          );
        }
        if (work === undefined) {
          return failure(
            "failed",
            errorProjection("internal_failure", "work_identity_missing", "managed task identity was not returned"),
          );
        }
        return { ok: true, status: work.status, work, ...(prior === undefined ? {} : { reused: true }) };
      } catch (error) {
        return failure("failed", classifyError(error, "delegate_failed"));
      }
    });
  }

  async inspect(workIdValue: string): Promise<HarnessOperationResult> {
    let workId: string;
    try {
      workId = normalizeWorkId(workIdValue);
    } catch (error) {
      return failure("failed", classifyError(error, "invalid_input"));
    }
    return this.withOperation(`inspect:${workId}`, async () => {
      const lookup = await this.lookup(workId);
      if (lookup.kind === "missing") {
        return failure("missing", errorProjection("lifecycle_conflict", "work_not_found", "work item was not found"));
      }
      if (lookup.kind === "invalid") {
        return failure("blocked", lookup.error, snapshotFor(lookup.store, lookup.task, lookup.manager));
      }
      try {
        const manager = await lookup.value.managerService.get(lookup.value.manager.sessionId);
        const task = lookup.value.store.getTask(lookup.value.task.taskId) ?? lookup.value.task;
        const work = snapshotFor(lookup.value.store, task, manager);
        return { ok: true, status: work.status, work };
      } catch (error) {
        return failure("blocked", classifyError(error, "inspect_failed"));
      }
    });
  }

  async continueWork(request: ContinueWorkRequest): Promise<HarnessOperationResult> {
    let workId: string;
    let followUp: string;
    try {
      workId = normalizeWorkId(request.workId);
      followUp = boundedString(request.followUp, "followUp", MAX_GOAL_LENGTH);
    } catch (error) {
      return failure("failed", classifyError(error, "invalid_input"));
    }
    return this.withOperation(`continue:${workId}`, async () => {
      const found = await this.requireWork(workId);
      if (found instanceof ErrorResult) return found.result;
      try {
        const manager = await found.managerService.continueWork(found.manager.sessionId, followUp);
        const task = found.store.getTask(found.task.taskId) ?? found.task;
        const work = snapshotFor(found.store, task, manager);
        return { ok: true, status: work.status, work };
      } catch (error) {
        const task = found.store.getTask(found.task.taskId) ?? found.task;
        const manager = found.store.getManagerSession(found.manager.sessionId) ?? found.manager;
        const work = snapshotFor(found.store, task, manager);
        return failure(work.status, classifyError(error, "continue_failed"), work);
      }
    });
  }

  async cancelWork(request: CancelWorkRequest): Promise<HarnessOperationResult> {
    let workId: string;
    try {
      workId = normalizeWorkId(request.workId);
      if (request.reason !== undefined) boundedString(request.reason, "reason", MAX_GOAL_LENGTH);
    } catch (error) {
      return failure("failed", classifyError(error, "invalid_input"));
    }
    return this.withOperation(`cancel:${workId}`, async () => {
      const found = await this.requireWork(workId);
      if (found instanceof ErrorResult) return found.result;
      const task = found.store.getTask(found.task.taskId) ?? found.task;
      if (task.lifecycleState === "abandoned") {
        return { ok: true, status: "cancelled", work: snapshotFor(found.store, task, found.manager) };
      }
      const validation = validateTransition(task.lifecycleState, "abandoned");
      if (!validation.allowed) {
        const work = snapshotFor(found.store, task, found.manager);
        return failure(
          work.status,
          errorProjection("lifecycle_conflict", "cancel_not_allowed", validation.blocked.blockingRule),
          work,
        );
      }
      try {
        const stopped = await found.managerService.stop(found.manager.sessionId);
        if (isActiveRuntime(stopped.runtimeState) || stopped.runtimeState === "stale") {
          const work = snapshotFor(found.store, task, stopped);
          return failure(
            "blocked",
            errorProjection(
              "lifecycle_conflict",
              "cancel_stop_unresolved",
              stopped.reconciliationMessage ?? "managed runtime stop could not be verified",
            ),
            work,
          );
        }
        const transitioned = transitionTask(found.store, task.taskId, "abandoned");
        if (!transitioned.ok) {
          const work = snapshotFor(found.store, task, stopped);
          return failure(
            work.status,
            errorProjection("lifecycle_conflict", "cancel_not_allowed", transitioned.blocked.blockingRule),
            work,
          );
        }
        const work = snapshotFor(found.store, transitioned.task, stopped, "cancelled");
        return { ok: true, status: "cancelled", work };
      } catch (error) {
        return failure("blocked", classifyError(error, "cancel_failed"));
      }
    });
  }

  private async requireWork(workId: string): Promise<FoundWork | ErrorResult> {
    try {
      const lookup = await this.lookup(workId);
      if (lookup.kind === "found") return lookup.value;
      if (lookup.kind === "missing") {
        return new ErrorResult(
          failure("missing", errorProjection("lifecycle_conflict", "work_not_found", "work item was not found")),
        );
      }
      return new ErrorResult(
        failure("blocked", lookup.error, snapshotFor(lookup.store, lookup.task, lookup.manager)),
      );
    } catch (error) {
      return new ErrorResult(failure("blocked", classifyError(error, "work_lookup_failed")));
    }
  }

  private async lookup(workId: string): Promise<WorkLookup> {
    const store = await this.dependencies.store();
    const task = store.getTask(workId as TaskId);
    if (task === undefined) return { kind: "missing" };
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
    const manager = selectControllingManagerSession(sessions);
    if (manager === undefined) {
      return {
        kind: "invalid",
        store,
        task,
        manager: sessions[0],
        error: errorProjection(
          "lifecycle_conflict",
          "multiple_manager_sessions",
          "multiple active Manager sessions claim this work item",
        ),
      };
    }
    return {
      kind: "found",
      value: {
        store,
        task,
        manager,
        managerService: await this.dependencies.managerForWorkspace(manager.workspaceRoot, store),
      },
    };
  }

  private managerRecord(store: WorkflowStateStore, run: ManagedTaskRunResult): ManagerSessionRecord | undefined {
    return run.manager === undefined ? undefined : store.getManagerSession(run.manager.sessionId as ManagerSessionId);
  }

  private resolveWorkspace(
    store: WorkflowStateStore,
    workspaceSelector: HarnessSelectorValue | undefined,
    repositorySelector: HarnessSelectorValue | undefined,
  ): string {
    if (workspaceSelector !== undefined && repositorySelector !== undefined) {
      throw new HarnessInputError("workspace and repository selectors conflict");
    }
    const selector = workspaceSelector ?? repositorySelector;
    if (selector === undefined) return path.resolve(this.dependencies.defaultWorkspaceRoot);

    if (repositorySelector !== undefined && typeof repositorySelector === "string") {
      const instance = store.getRepositoryInstance(repositorySelector as RepositoryInstanceId);
      if (instance !== undefined) return this.workspaceForInstance(store, instance.instanceId);
    }

    const normalized = normalizeSelector(selector, workspaceSelector === undefined ? "repository" : "workspace");
    if (normalized.instanceId !== undefined) {
      const instance = store.getRepositoryInstance(normalized.instanceId as RepositoryInstanceId);
      if (instance === undefined) throw new HarnessInputError("repository instance was not found");
      return this.workspaceForInstance(store, instance.instanceId);
    }
    return path.resolve(this.dependencies.defaultWorkspaceRoot, normalized.path!);
  }

  private workspaceForInstance(store: WorkflowStateStore, instanceId: RepositoryInstanceId): string {
    const currentPaths = store.listRepositoryPaths(instanceId).filter((candidate) => candidate.isCurrent);
    if (currentPaths.length !== 1) {
      throw new HarnessInputError("repository current path is unavailable or ambiguous");
    }
    return path.resolve(currentPaths[0]!.canonicalPath);
  }

  private withOperation(key: string, operation: () => Promise<HarnessOperationResult>): Promise<HarnessOperationResult> {
    const existing = this.operations.get(key);
    if (existing !== undefined) return existing;
    const current = operation().finally(() => {
      if (this.operations.get(key) === current) this.operations.delete(key);
    });
    this.operations.set(key, current);
    return current;
  }
}

class ErrorResult extends Error {
  constructor(readonly result: HarnessOperationResult) {
    super(result.error?.message ?? result.status);
  }
}
