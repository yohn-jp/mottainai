import crypto from "node:crypto";
import path from "node:path";
import {
  ManagerError,
  ManagerSessionService,
  selectControllingManagerSession,
  type ManagerResourceClaim,
  type ManagerResourceScope,
} from "../../manager/service.js";
import { allowedNextTransitions, isContinuableLifecycleState, validateTransition } from "./lifecycle.js";
import type { LifecycleState } from "./lifecycle.js";
import { transitionTask } from "./task-lifecycle.js";
import type { RepositoryInstanceId } from "./identity.js";
import type {
  ManagerRuntimeState,
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

export interface HarnessArtifact {
  kind: "pull_request";
  provider: string;
  repositoryId: string;
  number: number;
  url: string;
  state: string;
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
  managerForWorkspace: (
    workspaceRoot: string,
    store: WorkflowStateStore,
  ) => Promise<ManagerSessionService>;
}

export const MAX_HARNESS_ARTIFACTS = 16;
const MAX_PUBLIC_TEXT = 512;

class HarnessInputError extends Error {}

function generatedTaskSlug(goal: string): string {
  return `mcp-${crypto.createHash("sha256").update(goal).digest("hex").slice(0, 24)}`;
}

function canonicalScope(scope: ManagerResourceScope | undefined): unknown {
  if (scope === undefined) return null;
  return {
    paths: scope.paths === undefined ? [] : [...scope.paths].sort(),
    claims:
      scope.claims === undefined
        ? []
        : scope.claims
            .map((claim) => ({ resource: claim.resource, mode: claim.mode }))
            .sort((left, right) =>
              `${left.resource}\u0000${left.mode}`.localeCompare(`${right.resource}\u0000${right.mode}`),
            ),
  };
}

function deriveDelegationKey(
  goal: string,
  taskSlug: string,
  constraints: HarnessWorkConstraints,
  scope: ManagerResourceScope | undefined,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        goal,
        taskSlug,
        constraints.issueRef ?? null,
        constraints.branchType ?? "feat",
        constraints.agentKind ?? null,
        constraints.launchProfile ?? null,
        constraints.provider ?? null,
        constraints.model ?? null,
        canonicalScope(scope),
      ]),
    )
    .digest("hex");
  return `mcp-delegate:${digest}`;
}

function safeText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/((?:token|password|secret|authorization|api[_-]?key))\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'`;,)\]}]*/gu, "[path]")
    .trim()
    .slice(0, MAX_PUBLIC_TEXT);
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
  if (manager === undefined) return [];
  const actions: ("continue" | "cancel")[] = [];
  if (
    manager.semanticLifecycleState !== "unbound" &&
    isContinuableLifecycleState(manager.semanticLifecycleState)
  ) {
    actions.push("continue");
  }
  if (allowedNextTransitions(task.lifecycleState).includes("abandoned")) actions.push("cancel");
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
  const latestReceipt = manager?.latestReceipt;
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
      ...(latestReceipt === undefined
        ? {}
        : {
            latestReceipt: {
              code: safeCode(latestReceipt.code),
              source: latestReceipt.source.slice(0, 96),
              message: safeText(latestReceipt.message) ?? "",
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
      : typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
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
  | {
      kind: "invalid";
      store: WorkflowStateStore;
      task: TaskRecord;
      manager?: ManagerSessionRecord;
      error: HarnessError;
    };

export class HarnessDelegationService {
  constructor(private readonly dependencies: HarnessDelegationDependencies) {}

  async delegate(request: DelegateWorkRequest): Promise<HarnessOperationResult> {
    let store: WorkflowStateStore;
    let workspaceRoot: string;
    try {
      store = await this.dependencies.store();
      workspaceRoot = this.resolveWorkspace(store, request.workspace, request.repository);
    } catch (error) {
      return failure("failed", classifyError(error, "invalid_input"));
    }

    const constraints = request.constraints ?? {};
    const taskSlug = constraints.taskSlug ?? generatedTaskSlug(request.goal);
    const scope: ManagerResourceScope | undefined =
      constraints.paths === undefined && constraints.claims === undefined
        ? undefined
        : { paths: constraints.paths, claims: constraints.claims };
    const effectiveKey = request.idempotencyKey ?? deriveDelegationKey(request.goal, taskSlug, constraints, scope);

    try {
      const manager = await this.dependencies.managerForWorkspace(workspaceRoot, store);
      const prior = store
        .listManagerSessions(workspaceRoot)
        .find((candidate) => candidate.idempotencyKey === effectiveKey);
      const session = await manager.start({
        instruction: request.goal,
        ...(constraints.agentKind === undefined ? {} : { agentKind: constraints.agentKind }),
        ...(constraints.launchProfile === undefined ? {} : { launchProfile: constraints.launchProfile }),
        ...(constraints.provider === undefined ? {} : { provider: constraints.provider }),
        ...(constraints.model === undefined ? {} : { model: constraints.model }),
        taskSlug,
        ...(constraints.issueRef === undefined ? {} : { issueRef: constraints.issueRef }),
        branchType: constraints.branchType ?? "feat",
        idempotencyKey: effectiveKey,
        ...(scope === undefined ? {} : { scope }),
      });
      const task = session.taskId === undefined ? undefined : store.getTask(session.taskId);
      if (task === undefined) {
        return failure(
          "failed",
          errorProjection("internal_failure", "work_identity_missing", "managed task identity was not returned"),
        );
      }
      const work = snapshotFor(store, task, session);
      return { ok: true, status: work.status, work, ...(prior === undefined ? {} : { reused: true }) };
    } catch (error) {
      return failure("failed", classifyError(error, "delegate_failed"));
    }
  }

  async inspect(workId: string): Promise<HarnessOperationResult> {
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
  }

  async continueWork(request: ContinueWorkRequest): Promise<HarnessOperationResult> {
    const resolved = await this.requireWork(request.workId);
    if (resolved.result !== undefined) return resolved.result;
    const found = resolved.value;
    try {
      const manager = await found.managerService.continueWork(found.manager.sessionId, request.followUp);
      const task = found.store.getTask(found.task.taskId) ?? found.task;
      const work = snapshotFor(found.store, task, manager);
      return { ok: true, status: work.status, work };
    } catch (error) {
      const task = found.store.getTask(found.task.taskId) ?? found.task;
      const manager = found.store.getManagerSession(found.manager.sessionId) ?? found.manager;
      const work = snapshotFor(found.store, task, manager);
      return failure(work.status, classifyError(error, "continue_failed"), work);
    }
  }

  async cancelWork(request: CancelWorkRequest): Promise<HarnessOperationResult> {
    const resolved = await this.requireWork(request.workId);
    if (resolved.result !== undefined) return resolved.result;
    const found = resolved.value;
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
  }

  private async requireWork(
    workId: string,
  ): Promise<{ value: FoundWork; result?: undefined } | { value?: undefined; result: HarnessOperationResult }> {
    try {
      const lookup = await this.lookup(workId);
      if (lookup.kind === "found") return { value: lookup.value };
      if (lookup.kind === "missing") {
        return {
          result: failure(
            "missing",
            errorProjection("lifecycle_conflict", "work_not_found", "work item was not found"),
          ),
        };
      }
      return {
        result: failure("blocked", lookup.error, snapshotFor(lookup.store, lookup.task, lookup.manager)),
      };
    } catch (error) {
      return { result: failure("blocked", classifyError(error, "work_lookup_failed")) };
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

  private resolveWorkspace(
    store: WorkflowStateStore,
    workspaceSelector: HarnessSelectorValue | undefined,
    repositorySelector: HarnessSelectorValue | undefined,
  ): string {
    if (workspaceSelector !== undefined && repositorySelector !== undefined) {
      throw new HarnessInputError("workspace and repository selectors conflict");
    }
    if (repositorySelector !== undefined) {
      if (typeof repositorySelector === "string") {
        const instance = store.getRepositoryInstance(repositorySelector as RepositoryInstanceId);
        if (instance === undefined) throw new HarnessInputError("repository instance was not found");
        return this.workspaceForInstance(store, instance.instanceId);
      }
      if (repositorySelector.instanceId !== undefined) {
        const instance = store.getRepositoryInstance(repositorySelector.instanceId as RepositoryInstanceId);
        if (instance === undefined) throw new HarnessInputError("repository instance was not found");
        return this.workspaceForInstance(store, instance.instanceId);
      }
      if (repositorySelector.path === undefined) throw new HarnessInputError("repository selector is empty");
      return path.resolve(this.dependencies.defaultWorkspaceRoot, repositorySelector.path);
    }
    if (workspaceSelector === undefined) return path.resolve(this.dependencies.defaultWorkspaceRoot);
    if (typeof workspaceSelector === "string") {
      return path.resolve(this.dependencies.defaultWorkspaceRoot, workspaceSelector);
    }
    if (workspaceSelector.instanceId !== undefined) {
      const instance = store.getRepositoryInstance(workspaceSelector.instanceId as RepositoryInstanceId);
      if (instance === undefined) throw new HarnessInputError("repository instance was not found");
      return this.workspaceForInstance(store, instance.instanceId);
    }
    if (workspaceSelector.path === undefined) throw new HarnessInputError("workspace selector is empty");
    return path.resolve(this.dependencies.defaultWorkspaceRoot, workspaceSelector.path);
  }

  private workspaceForInstance(store: WorkflowStateStore, instanceId: RepositoryInstanceId): string {
    const currentPaths = store.listRepositoryPaths(instanceId).filter((candidate) => candidate.isCurrent);
    if (currentPaths.length !== 1) {
      throw new HarnessInputError("repository current path is unavailable or ambiguous");
    }
    return path.resolve(currentPaths[0]!.canonicalPath);
  }
}
