import crypto from "node:crypto";
import { NawabariExecutionClient } from "../nawabari.js";
import type { TaskRecord, ManagerSessionRecord, WorkflowStateStore } from "../state/store.js";
import { ManagerError, ManagerSessionService, type NewManagerSessionInput } from "../../manager/service.js";

const MAX_ERROR_LENGTH = 512;

export interface ManagedTaskRunInput {
  workspaceRoot: string;
  store: WorkflowStateStore;
  nawabari: NawabariExecutionClient;
  manager: ManagerSessionService;
  taskSlug: string;
  issueRef: string;
  branchType: string;
  agentKind: string;
  provider?: string;
  model?: string;
  instruction: string;
  idempotencyKey?: string;
}

export interface TaskRunExecutionProjection {
  sessionId?: string;
  worktree?: string;
  branch?: string;
  state: string;
}

export interface TaskRunManagerProjection {
  idempotencyKey?: string;
  sessionId: string;
  taskId?: string;
  executionSessionId?: string;
  runtimeName: string;
  worktreePath: string;
  branchName?: string;
  agentKind: string;
  launchProfile: string;
  lifecycleState: string;
  runtimeState: string;
  semanticLifecycleState: string;
  attachable: boolean;
  reconciliationState: string;
  reconciliationMessage?: string;
  latestStatus?: string;
  restartCount: number;
  errorMessage?: string;
}

export interface ManagedTaskRunSuccess {
  ok: true;
  operation: "task-run";
  idempotencyKey: string;
  task?: TaskRecord;
  execution: TaskRunExecutionProjection;
  manager: TaskRunManagerProjection;
  currentState: string;
}

export interface ManagedTaskRunFailure {
  ok: false;
  operation: "task-run";
  idempotencyKey: string;
  error: { code: string; message: string };
  recoverable: boolean;
  task?: TaskRecord;
  execution?: TaskRunExecutionProjection;
  manager?: TaskRunManagerProjection;
  currentState?: string;
}

export type ManagedTaskRunResult = ManagedTaskRunSuccess | ManagedTaskRunFailure;

/** Stable default operation identity. An explicit key remains available for callers that need a custom retry scope. */
export function deriveTaskRunIdempotencyKey(input: {
  taskSlug: string;
  issueRef: string;
  branchType: string;
  agentKind: string;
  provider?: string;
  model?: string;
  instruction: string;
}): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        input.taskSlug,
        input.issueRef,
        input.branchType,
        input.agentKind,
        input.provider ?? null,
        input.model ?? null,
        input.instruction,
      ]),
    )
    .digest("hex");
  return `task-run:${digest}`;
}

export function defaultTaskRunInstruction(issueRef: string): string {
  return `Work on Issue #${issueRef} in the managed task worktree.`;
}

function managerProjection(session: ManagerSessionRecord): TaskRunManagerProjection {
  return {
    ...(session.idempotencyKey === undefined ? {} : { idempotencyKey: session.idempotencyKey }),
    sessionId: session.sessionId,
    ...(session.taskId === undefined ? {} : { taskId: session.taskId }),
    ...(session.executionSessionId === undefined ? {} : { executionSessionId: session.executionSessionId }),
    runtimeName: session.runtimeName,
    worktreePath: session.worktreePath,
    ...(session.branchName === undefined ? {} : { branchName: session.branchName }),
    agentKind: session.agentKind,
    launchProfile: session.launchProfile,
    lifecycleState: session.lifecycleState,
    runtimeState: session.runtimeState,
    semanticLifecycleState: session.semanticLifecycleState,
    attachable: session.attachable,
    reconciliationState: session.reconciliationState,
    ...(session.reconciliationMessage === undefined ? {} : { reconciliationMessage: session.reconciliationMessage }),
    ...(session.latestStatus === undefined ? {} : { latestStatus: session.latestStatus }),
    restartCount: session.restartCount,
    ...(session.errorMessage === undefined ? {} : { errorMessage: session.errorMessage }),
  };
}

function findManagerSession(store: WorkflowStateStore, workspaceRoot: string, idempotencyKey: string) {
  return store.listManagerSessions(workspaceRoot).find((session) => session.idempotencyKey === idempotencyKey);
}

function findTask(
  store: WorkflowStateStore,
  idempotencyKey: string,
  managerSession: ManagerSessionRecord | undefined,
): TaskRecord | undefined {
  if (managerSession?.taskId !== undefined) {
    const linked = store.getTask(managerSession.taskId);
    if (linked !== undefined) return linked;
  }
  return store.listTasks().find((task) => task.startIdempotencyKey === idempotencyKey);
}

async function executionProjection(
  input: ManagedTaskRunInput,
  task: TaskRecord | undefined,
  managerSession: ManagerSessionRecord | undefined,
): Promise<TaskRunExecutionProjection | undefined> {
  const sessionId = managerSession?.executionSessionId ?? task?.nawabariSessionId;
  let external: { sessionId: string; worktree: string; branch: string; state: string } | undefined;
  if (sessionId !== undefined && managerSession === undefined) {
    try {
      external = await input.nawabari.showSession({ cwd: input.workspaceRoot, sessionId });
    } catch {
      // The durable task/Manager records still provide the identities that are
      // safe to return when the external companion cannot be observed now.
    }
  }
  if (sessionId === undefined && managerSession === undefined && task === undefined) return undefined;
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(managerSession?.worktreePath === undefined && external === undefined
      ? {}
      : { worktree: managerSession?.worktreePath ?? external?.worktree }),
    ...(managerSession?.branchName === undefined && external === undefined
      ? {}
      : { branch: managerSession?.branchName ?? external?.branch }),
    state: external?.state ?? managerSession?.semanticLifecycleState ?? task?.lifecycleState ?? "unknown",
  };
}

async function projectionFor(
  input: ManagedTaskRunInput,
  idempotencyKey: string,
  managerSession?: ManagerSessionRecord,
): Promise<{
  task?: TaskRecord;
  manager?: TaskRunManagerProjection;
  execution?: TaskRunExecutionProjection;
  currentState?: string;
}> {
  const manager = managerSession ?? findManagerSession(input.store, input.workspaceRoot, idempotencyKey);
  const task = findTask(input.store, idempotencyKey, manager);
  const execution = await executionProjection(input, task, manager);
  return {
    ...(task === undefined ? {} : { task }),
    ...(manager === undefined ? {} : { manager: managerProjection(manager) }),
    ...(execution === undefined ? {} : { execution }),
    ...(manager === undefined && task === undefined
      ? {}
      : { currentState: manager?.semanticLifecycleState ?? task?.lifecycleState ?? "unknown" }),
  };
}

/** Compose the existing Manager task-bound launch with a bounded recovery projection. */
export async function runManagedTask(input: ManagedTaskRunInput): Promise<ManagedTaskRunResult> {
  const idempotencyKey =
    input.idempotencyKey ??
    deriveTaskRunIdempotencyKey({
      taskSlug: input.taskSlug,
      issueRef: input.issueRef,
      branchType: input.branchType,
      agentKind: input.agentKind,
      provider: input.provider,
      model: input.model,
      instruction: input.instruction,
    });
  const reportedIdempotencyKey = idempotencyKey.slice(0, 128);
  const managerInput: NewManagerSessionInput = {
    instruction: input.instruction,
    agentKind: input.agentKind,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    taskSlug: input.taskSlug,
    issueRef: input.issueRef,
    branchType: input.branchType,
    idempotencyKey,
  };
  try {
    const session = await input.manager.start(managerInput);
    const projection = await projectionFor(input, idempotencyKey, session);
    return {
      ok: true,
      operation: "task-run",
      idempotencyKey: reportedIdempotencyKey,
      execution: projection.execution ?? { state: session.semanticLifecycleState },
      manager: managerProjection(session),
      currentState: session.semanticLifecycleState,
      ...(projection.task === undefined ? {} : { task: projection.task }),
    };
  } catch (error) {
    const projection = await projectionFor(input, idempotencyKey);
    const code = error instanceof ManagerError ? error.code : "runtime_error";
    const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
    return {
      ok: false,
      operation: "task-run",
      idempotencyKey: reportedIdempotencyKey,
      error: { code, message },
      recoverable: projection.task !== undefined || projection.manager !== undefined,
      ...projection,
    };
  }
}
