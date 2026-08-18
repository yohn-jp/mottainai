import fs from "node:fs";
import path from "node:path";
import { startNawabariTask } from "./nawabari-task.js";
import type { LifecycleState } from "./lifecycle.js";
import { resolveEffectiveWorkflowPolicy } from "../policy/load.js";
import type { WorkflowStateStore, ManagerSessionReceipt, TaskId, WorktreeId } from "../state/store.js";
import { createSemanticExecutionPlan, type SemanticExecutionPlan } from "../../semantics/execution-plan.js";
import { NawabariExecutionClient } from "../nawabari.js";

/**
 * The Manager-facing execution contract.  It is deliberately a projection:
 * Manager receives an execution context and never owns the physical worktree,
 * branch, lock, lease, or cleanup operation represented by that context.
 *
 * The sole production adapter delegates session/worktree/branch ownership to
 * the standalone Nawabari contract.
 */
export interface ManagerExecutionContext {
  taskId: TaskId | undefined;
  executionSessionId: string | undefined;
  worktreeId: WorktreeId | undefined;
  worktreePath: string;
  branchName: string | undefined;
  taskSlug: string | undefined;
  issueRef: string | undefined;
  branchType: string | undefined;
  semanticLifecycleState: LifecycleState | "unbound";
}

export interface ManagerExecutionObservation {
  semanticLifecycleState: LifecycleState | "unbound";
  status: string | undefined;
  receipt: ManagerSessionReceipt | undefined;
}

export interface ManagerExecutionAuthority {
  start(input: {
    workspaceRoot: string;
    store: WorkflowStateStore;
    taskSlug: string | undefined;
    issueRef: string | undefined;
    branchType: string;
    idempotencyKey: string;
    semanticPlan?: SemanticExecutionPlan;
  }): Promise<{ context: ManagerExecutionContext; receipt?: ManagerSessionReceipt }>;
  validate(context: ManagerExecutionContext): Promise<{ ok: true } | { ok: false; detail: string }>;
  observe(context: ManagerExecutionContext): Promise<ManagerExecutionObservation>;
}

export const MANAGER_SCOPE_FALLBACK_WARNING =
  "no resource scope supplied; using an explicit repository-wide read fallback";

export function createManagerFallbackSemanticExecutionPlan(): SemanticExecutionPlan {
  return createSemanticExecutionPlan({
    fallbackClaims: [{ resource: "**", mode: "read" }],
    fallbackReason: "Manager scope was not supplied; preserve compatibility with a repository-wide read boundary",
    fallbackWarning: MANAGER_SCOPE_FALLBACK_WARNING,
    verification: { rationale: "Manager launch context is read-only until semantic scope is declared" },
  });
}

function receipt(code: string, message: string, source: ManagerSessionReceipt["source"]): ManagerSessionReceipt {
  return { code, message: message.slice(0, 512), source, recordedAt: Date.now() };
}

/** Compatibility name retained for embedders; it now uses Nawabari authority. */
export function createWorkflowManagerExecutionAuthority(
  initialStore?: WorkflowStateStore,
  initialWorkspaceRoot?: string,
  nawabari: NawabariExecutionClient = new NawabariExecutionClient(),
): ManagerExecutionAuthority {
  return createNawabariManagerExecutionAuthority(initialStore, initialWorkspaceRoot, nawabari);
}

/**
 * Nawabari-backed implementation. Manager launches only ever declare an
 * explicit repository-wide `read` claim: a later semantic/task operation must
 * replace it with concrete write claims before any mutation is authorized.
 * No Mottainai worktree reservation or Git worktree mutation occurs here —
 * Nawabari owns the physical session, worktree, and branch.
 */
export function createNawabariManagerExecutionAuthority(
  initialStore?: WorkflowStateStore,
  initialWorkspaceRoot?: string,
  nawabari: NawabariExecutionClient = new NawabariExecutionClient(),
): ManagerExecutionAuthority {
  let boundStore: WorkflowStateStore | undefined = initialStore;
  let boundWorkspaceRoot: string | undefined = initialWorkspaceRoot;
  return {
    async start(input) {
      boundStore = input.store;
      boundWorkspaceRoot = input.workspaceRoot;
      if (input.taskSlug === undefined) {
        return {
          context: {
            taskId: undefined,
            executionSessionId: undefined,
            worktreeId: undefined,
            worktreePath: input.workspaceRoot,
            branchName: undefined,
            taskSlug: undefined,
            issueRef: undefined,
            branchType: undefined,
            semanticLifecycleState: "unbound",
          },
        };
      }

      const policyResult = resolveEffectiveWorkflowPolicy(input.workspaceRoot);
      if (!policyResult.ok) throw new Error(`workflow policy is invalid: ${policyResult.reason}`);
      const result = await startNawabariTask({
        workspaceRoot: input.workspaceRoot,
        store: input.store,
        policy: policyResult.document,
        taskSlug: input.taskSlug,
        branchType: input.branchType,
        issueRef: input.issueRef,
        idempotencyKey: input.idempotencyKey,
        nawabari,
        // Manager establishes an inspection-only execution boundary at launch.
        // A later semantic/task operation must replace it with concrete write
        // claims; this keeps concurrent control-plane sessions from claiming
        // unknown source scope while never granting mutation authority by
        // implication.
        semanticPlan: input.semanticPlan ?? createManagerFallbackSemanticExecutionPlan(),
      });
      if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
      return {
        context: {
          taskId: result.task.taskId,
          executionSessionId: result.execution.sessionId,
          worktreeId: undefined,
          worktreePath: result.execution.worktree,
          branchName: result.execution.branch,
          taskSlug: result.task.taskSlug,
          issueRef: result.task.issueRef,
          branchType: input.branchType,
          semanticLifecycleState: result.task.lifecycleState,
        },
        ...(result.warnings.length === 0
          ? {}
          : {
              receipt: receipt(
                "workflow_warning",
                result.warnings.map((warning) => warning.detail).join("; "),
                "workflow",
              ),
            }),
      };
    },

    async validate(context) {
      try {
        if (
          boundWorkspaceRoot !== undefined &&
          context.taskId === undefined &&
          path.resolve(context.worktreePath) !== path.resolve(boundWorkspaceRoot)
        ) {
          return {
            ok: false,
            detail: `unbound execution path is not the Manager workspace root: ${context.worktreePath}`,
          };
        }
        if (context.taskId !== undefined) {
          const task = boundStore?.getTask(context.taskId);
          if (task === undefined) return { ok: false, detail: `managed task record is missing: ${context.taskId}` };
          if (task.nawabariSessionId === undefined || task.nawabariSessionId !== context.executionSessionId) {
            return { ok: false, detail: `managed Nawabari session identity is unresolved for task: ${context.taskId}` };
          }
        }
        if (!(await fs.promises.stat(context.worktreePath)).isDirectory()) {
          return { ok: false, detail: `execution directory is not a directory: ${context.worktreePath}` };
        }
        return { ok: true };
      } catch {
        return { ok: false, detail: `execution directory is unavailable: ${context.worktreePath}` };
      }
    },

    async observe(context) {
      if (context.taskId === undefined) {
        return { semanticLifecycleState: "unbound", status: undefined, receipt: undefined };
      }
      const task = boundStore?.getTask(context.taskId);
      if (task === undefined) {
        return {
          semanticLifecycleState: "orphaned",
          status: "task record is unavailable; execution identity was not recreated",
          receipt: receipt(
            "task_unresolved",
            "task record is unavailable; execution identity was not recreated",
            "workflow",
          ),
        };
      }
      return {
        semanticLifecycleState: task.lifecycleState,
        status: `task lifecycle: ${task.lifecycleState}`,
        receipt: undefined,
      };
    },
  };
}
