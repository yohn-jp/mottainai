import type {
  ExecutionManifest,
  ExecutionManifestCanonInput,
  ExecutionManifestInput,
  ExecutionManifestManagerIdentity,
  ExecutionManifestTaskFacts,
  createExecutionManifest,
} from "../workflow/domain/execution-manifest.js";
import type { ManagerExecutionAuthority, ManagerExecutionContext } from "../workflow/domain/manager-execution.js";
import type { TaskStatusByIdSuccess } from "../workflow/domain/task.js";
import type { NawabariExecutionClient, NawabariRepositoryEvidence } from "../workflow/nawabari.js";
import type { ManagerSessionRecord, TaskId, TaskRecord, WorkflowStateStore } from "../workflow/state/store.js";
import type { SemanticExecutionPlan } from "../semantics/execution-plan.js";

/** The physical attachment returned to a provider-neutral runtime caller. */
export interface ExecutionRuntimeAttachment {
  readonly sessionId: string;
  readonly worktree: string;
  readonly branch: string;
  readonly branchId: string;
  readonly sessionState: string;
}

export interface ExecutionAdmissionTaskProjection {
  readonly task: TaskRecord;
  readonly worktreePath: string;
  readonly branch: string | undefined;
}

export type ExecutionManifestProjector = typeof createExecutionManifest;

/** Existing task-domain keyed producer, injected to preserve its cwd-independent lookup. */
export type ExecutionTaskStatusResolver = (
  store: WorkflowStateStore,
  taskId: TaskId,
  nawabari: NawabariExecutionClient,
) => Promise<TaskStatusByIdSuccess | { ok: false; reason: string }>;

/** The read-only Nawabari boundary needed by admission. */
export type ExecutionNawabariBoundary = Pick<NawabariExecutionClient, "repositoryEvidence">;

export type ExecutionAdmissionDiagnosticCode =
  | "missing-task"
  | "missing-manager"
  | "missing-task-identity"
  | "task-resolution-failed"
  | "task-identity-mismatch"
  | "manager-validation-failed"
  | "missing-physical-identity"
  | "nawabari-evidence-unavailable"
  | "nawabari-evidence-incomplete"
  | "session-mismatch"
  | "worktree-mismatch"
  | "branch-mismatch"
  | "base-revision-mismatch"
  | "manifest-invalid";

export interface ExecutionAdmissionDiagnostic {
  readonly code: ExecutionAdmissionDiagnosticCode;
  readonly message: string;
  readonly error?: unknown;
}

export interface ExecutionAdmissionInput {
  /** The task identity is keyed by taskId when a fresh producer projection is required. */
  readonly taskId?: TaskId;
  readonly task?: TaskRecord | ExecutionManifestTaskFacts;
  /** A fresh projection may be supplied by the existing task producer. */
  readonly taskProjection?: ExecutionAdmissionTaskProjection | TaskStatusByIdSuccess;
  readonly store?: WorkflowStateStore;
  readonly resolveTaskStatus?: ExecutionTaskStatusResolver;
  readonly manager?: ManagerSessionRecord | ManagerExecutionContext | ExecutionManifestManagerIdentity;
  readonly managerAuthority?: ManagerExecutionAuthority;
  readonly nawabari: ExecutionNawabariBoundary;
  /** The canonical #948 projector; admission never duplicates its normalizer. */
  readonly projectManifest: ExecutionManifestProjector;
  readonly canon?: ExecutionManifestCanonInput;
  readonly semanticPlan?: SemanticExecutionPlan;
  readonly scope?: SemanticExecutionPlan;
  /**
   * Optional prior projection. Only its governed intent is reused; its
   * physical attachment is deliberately ignored and re-observed below.
   */
  readonly manifest?: ExecutionManifest;
  /** Retained for API callers that carry a caller cwd; it is never used as an authority anchor. */
  readonly callerCwd?: string;
}

export interface ExecutionAdmissionSuccess {
  readonly ok: true;
  readonly admitted: true;
  readonly manifest: ExecutionManifest;
  readonly attachment: ExecutionRuntimeAttachment;
  readonly diagnostics: readonly ExecutionAdmissionDiagnostic[];
}

export interface ExecutionAdmissionFailure {
  readonly ok: false;
  readonly admitted: false;
  readonly manifest: ExecutionManifest;
  readonly attachment: undefined;
  readonly diagnostics: readonly ExecutionAdmissionDiagnostic[];
}

export type ExecutionAdmissionResult = ExecutionAdmissionSuccess | ExecutionAdmissionFailure;

interface ResolvedTask {
  readonly task: TaskRecord | ExecutionManifestTaskFacts | undefined;
  readonly worktreePath: string | undefined;
  readonly branch: string | undefined;
}

interface ManagerIdentity {
  readonly context: ManagerExecutionContext | undefined;
  readonly taskId: string | undefined;
  readonly sessionId: string | undefined;
  readonly worktreePath: string | undefined;
  readonly branch: string | undefined;
}

function managerIdentity(
  manager: ManagerSessionRecord | ManagerExecutionContext | ExecutionManifestManagerIdentity | undefined,
): ManagerIdentity {
  if (manager === undefined || !("worktreePath" in manager)) {
    return {
      context: undefined,
      taskId:
        manager !== undefined && "taskId" in manager && typeof manager.taskId === "string" ? manager.taskId : undefined,
      sessionId:
        manager !== undefined && "executionSessionId" in manager && typeof manager.executionSessionId === "string"
          ? manager.executionSessionId
          : undefined,
      worktreePath: undefined,
      branch: undefined,
    };
  }

  const context: ManagerExecutionContext =
    "sessionId" in manager
      ? {
          taskId: manager.taskId,
          executionSessionId: manager.executionSessionId,
          worktreeId: manager.worktreeId,
          worktreePath: manager.worktreePath,
          branchName: manager.branchName,
          taskSlug: manager.taskSlug,
          issueRef: manager.issueRef,
          branchType: manager.branchType,
          semanticLifecycleState: manager.semanticLifecycleState,
        }
      : manager;
  return {
    context,
    taskId: context.taskId,
    sessionId: context.executionSessionId,
    worktreePath: context.worktreePath,
    branch: context.branchName,
  };
}

function projectionParts(projection: ExecutionAdmissionTaskProjection | TaskStatusByIdSuccess): ResolvedTask {
  return {
    task: projection.task,
    worktreePath: projection.worktreePath,
    branch: projection.branch,
  };
}

function taskIdentity(task: TaskRecord | ExecutionManifestTaskFacts | undefined): string | undefined {
  return task?.taskId;
}

function taskSessionId(task: TaskRecord | ExecutionManifestTaskFacts | undefined): string | undefined {
  return task !== undefined && "nawabariSessionId" in task && typeof task.nawabariSessionId === "string"
    ? task.nawabariSessionId
    : undefined;
}

function taskBaseCommit(task: TaskRecord | ExecutionManifestTaskFacts | undefined): string | undefined {
  return task?.baseCommit;
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function manifestIntent(
  input: ExecutionAdmissionInput,
  resolvedTask: ResolvedTask,
  manager: ManagerIdentity,
): ExecutionManifestInput {
  const previous = input.manifest?.intent;
  return {
    task: resolvedTask.task ?? input.task ?? previous?.task,
    manager: input.manager ?? previous?.manager,
    canon: input.canon ?? previous?.canon,
    semanticPlan: input.semanticPlan ?? input.scope ?? previous?.semanticPlan,
    // Never copy input.manifest.attachment, input.nawabari, or input.attachment.
    ...(manager.context === undefined ? {} : { manager: input.manager ?? manager.context }),
  };
}

function safeManifest(
  projectManifest: ExecutionManifestProjector,
  input: ExecutionManifestInput,
  attachment:
    | { authority: "nawabari"; evidence: NawabariRepositoryEvidence }
    | { authority: "nawabari"; status: "missing" | "ambiguous" | "invalid" | "stale"; reason: string },
): ExecutionManifest {
  const boundedAttachment =
    "evidence" in attachment
      ? attachment
      : { ...attachment, reason: attachment.reason.slice(0, 512) || "execution admission failed" };
  try {
    return projectManifest({ ...input, nawabari: boundedAttachment });
  } catch {
    return projectManifest({ nawabari: boundedAttachment });
  }
}

function failure(
  projectManifest: ExecutionManifestProjector,
  manifestInput: ExecutionManifestInput,
  diagnostics: readonly ExecutionAdmissionDiagnostic[],
  attachment: { authority: "nawabari"; status: "missing" | "ambiguous" | "invalid" | "stale"; reason: string },
): ExecutionAdmissionFailure {
  return {
    ok: false,
    admitted: false,
    manifest: safeManifest(projectManifest, manifestInput, attachment),
    attachment: undefined,
    diagnostics,
  };
}

function compareEvidence(
  evidence: NawabariRepositoryEvidence,
  expected: { sessionId: string; worktreePath: string; branch: string; baseCommit: string | undefined },
): ExecutionAdmissionDiagnostic[] {
  const diagnostics: ExecutionAdmissionDiagnostic[] = [];
  if (evidence.sessionId !== expected.sessionId)
    diagnostics.push({
      code: "session-mismatch",
      message: `Nawabari session identity does not match the explicit execution identity: expected ${expected.sessionId}, got ${evidence.sessionId}`,
    });
  if (evidence.worktree !== expected.worktreePath)
    diagnostics.push({
      code: "worktree-mismatch",
      message: `Nawabari worktree does not match the authoritative task/Manager worktree: expected ${expected.worktreePath}, got ${evidence.worktree}`,
    });
  if (evidence.branch !== expected.branch)
    diagnostics.push({
      code: "branch-mismatch",
      message: `Nawabari branch does not match the authoritative task/Manager branch: expected ${expected.branch}, got ${evidence.branch}`,
    });
  if (expected.baseCommit !== undefined && evidence.baseRevision !== expected.baseCommit)
    diagnostics.push({
      code: "base-revision-mismatch",
      message: `Nawabari base revision does not match the governed task base commit: expected ${expected.baseCommit}, got ${evidence.baseRevision ?? "(missing)"}`,
    });
  return diagnostics;
}

/**
 * Admit one governed Manager execution after projecting intent and freshly
 * revalidating the physical attachment through Nawabari.
 *
 * The caller cwd is intentionally absent from every authority lookup. When a
 * task id is supplied, getTaskStatusById performs the existing keyed,
 * cwd-independent producer resolution; the resulting worktree is the only
 * Nawabari command anchor used here.
 */
export async function admitExecution(input: ExecutionAdmissionInput): Promise<ExecutionAdmissionResult> {
  const diagnostics: ExecutionAdmissionDiagnostic[] = [];
  const manager = managerIdentity(input.manager ?? input.manifest?.intent.manager);
  let resolvedTask: ResolvedTask = {
    task: input.task ?? input.manifest?.intent.task,
    worktreePath: undefined,
    branch: undefined,
  };

  if (input.taskProjection !== undefined) resolvedTask = projectionParts(input.taskProjection);
  if (input.taskId !== undefined) {
    if (input.store === undefined || input.resolveTaskStatus === undefined) {
      diagnostics.push({
        code: "task-resolution-failed",
        message: "an explicit taskId requires the existing keyed task resolver and workflow state store",
      });
    } else {
      try {
        const projection = await input.resolveTaskStatus(
          input.store,
          input.taskId,
          input.nawabari as NawabariExecutionClient,
        );
        if (!projection.ok) {
          diagnostics.push({
            code: "task-resolution-failed",
            message: `task identity could not be freshly resolved: ${projection.reason}`,
          });
        } else {
          if (resolvedTask.task !== undefined && taskIdentity(resolvedTask.task) !== projection.task.taskId)
            diagnostics.push({
              code: "task-identity-mismatch",
              message: `supplied task facts do not match explicit taskId ${input.taskId}`,
            });
          resolvedTask = projectionParts(projection);
        }
      } catch (error) {
        diagnostics.push({
          code: "task-resolution-failed",
          message: `task identity resolution failed: ${reason(error)}`,
          error,
        });
      }
    }
  }

  if (resolvedTask.task === undefined)
    diagnostics.push({ code: "missing-task", message: "governed task facts were not supplied" });
  if (manager.context === undefined)
    diagnostics.push({ code: "missing-manager", message: "Manager execution identity was not supplied" });

  const taskId = taskIdentity(resolvedTask.task);
  if (input.taskId !== undefined && taskId !== undefined && taskId !== input.taskId)
    diagnostics.push({
      code: "task-identity-mismatch",
      message: `resolved task does not match explicit taskId ${input.taskId}`,
    });
  if (manager.taskId !== undefined && taskId !== undefined && manager.taskId !== taskId)
    diagnostics.push({
      code: "task-identity-mismatch",
      message: `Manager task identity does not match task ${taskId}`,
    });

  const sessionIds = [taskSessionId(resolvedTask.task), manager.sessionId].filter(
    (value): value is string => value !== undefined,
  );
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (uniqueSessionIds.length === 0)
    diagnostics.push({ code: "missing-task-identity", message: "no explicit Nawabari session identity was supplied" });
  if (uniqueSessionIds.length > 1)
    diagnostics.push({
      code: "session-mismatch",
      message: "task and Manager execution identities name different Nawabari sessions",
    });

  const worktreePath = resolvedTask.worktreePath ?? manager.worktreePath;
  const branch = resolvedTask.branch ?? manager.branch;
  if (worktreePath === undefined || branch === undefined)
    diagnostics.push({
      code: "missing-physical-identity",
      message: "authoritative worktree and branch identity is incomplete",
    });
  if (
    resolvedTask.worktreePath !== undefined &&
    manager.worktreePath !== undefined &&
    resolvedTask.worktreePath !== manager.worktreePath
  )
    diagnostics.push({ code: "worktree-mismatch", message: "task and Manager projections name different worktrees" });
  if (resolvedTask.branch !== undefined && manager.branch !== undefined && resolvedTask.branch !== manager.branch)
    diagnostics.push({ code: "branch-mismatch", message: "task and Manager projections name different branches" });

  if (input.managerAuthority !== undefined && manager.context !== undefined) {
    try {
      const validation = await input.managerAuthority.validate(manager.context);
      if (!validation.ok) diagnostics.push({ code: "manager-validation-failed", message: validation.detail });
    } catch (error) {
      diagnostics.push({
        code: "manager-validation-failed",
        message: `Manager authority validation failed: ${reason(error)}`,
        error,
      });
    }
  }

  const baseInput = manifestIntent(input, resolvedTask, manager);
  if (diagnostics.length > 0)
    return failure(input.projectManifest, baseInput, diagnostics, {
      authority: "nawabari",
      status: "ambiguous",
      reason: diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    });

  const sessionId = uniqueSessionIds[0]!;
  let evidence: NawabariRepositoryEvidence;
  try {
    // worktreePath comes only from the keyed task/Manager projection. The
    // callerCwd field is deliberately not consulted.
    evidence = await input.nawabari.repositoryEvidence({ cwd: worktreePath!, sessionId });
  } catch (error) {
    diagnostics.push({
      code: "nawabari-evidence-unavailable",
      message: `Nawabari evidence could not be read: ${reason(error)}`,
      error,
    });
    return failure(input.projectManifest, baseInput, diagnostics, {
      authority: "nawabari",
      status: "missing",
      reason: diagnostics[diagnostics.length - 1]!.message,
    });
  }

  if (
    !evidence.complete ||
    evidence.sessionState !== "active" ||
    !evidence.baseRevisionProven ||
    evidence.evidenceHash.length === 0
  ) {
    diagnostics.push({
      code: "nawabari-evidence-incomplete",
      message: `Nawabari evidence is not current and complete: ${evidence.incompleteReasons.join("; ") || "required freshness proof is missing"}`,
    });
  }
  diagnostics.push(
    ...compareEvidence(evidence, {
      sessionId,
      worktreePath: worktreePath!,
      branch: branch!,
      baseCommit: taskBaseCommit(resolvedTask.task),
    }),
  );
  if (diagnostics.length > 0)
    return failure(input.projectManifest, baseInput, diagnostics, {
      authority: "nawabari",
      status: diagnostics.some((diagnostic) => diagnostic.code.endsWith("mismatch")) ? "ambiguous" : "stale",
      reason: diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    });

  const manifestInput = manifestIntent(input, resolvedTask, manager);
  let manifest: ExecutionManifest;
  try {
    manifest = input.projectManifest({ ...manifestInput, nawabari: { authority: "nawabari", evidence } });
  } catch (error) {
    diagnostics.push({
      code: "manifest-invalid",
      message: `ExecutionManifest projection failed: ${reason(error)}`,
      error,
    });
    return failure(input.projectManifest, manifestInput, diagnostics, {
      authority: "nawabari",
      status: "invalid",
      reason: diagnostics[diagnostics.length - 1]!.message,
    });
  }

  if (manifest.diagnostics.completeness !== "complete" || manifest.attachment.status !== "attached") {
    diagnostics.push({
      code: "manifest-invalid",
      message: "ExecutionManifest is incomplete and cannot be runtime-attached",
    });
    return {
      ok: false,
      admitted: false,
      manifest,
      attachment: undefined,
      diagnostics,
    };
  }

  const physical = manifest.attachment.physical!;
  return {
    ok: true,
    admitted: true,
    manifest,
    attachment: {
      sessionId: physical.sessionId,
      worktree: physical.worktree,
      branch: physical.branch,
      branchId: physical.branchId!,
      sessionState: physical.sessionState,
    },
    diagnostics,
  };
}

export const admitManagedExecution = admitExecution;
export const admitExecutionManifest = admitExecution;
