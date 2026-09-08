import { validateTransition } from "./lifecycle.js";
import type { LifecycleState, TransitionBlockedInfo } from "./lifecycle.js";
import type { TaskId, TaskRecord, WorkflowStateStore } from "../state/store.js";

/**
 * A concurrent writer already advanced the task past the (lifecycleState, version) this
 * caller observed before validating the transition — the loser of a race against another
 * legal transition from the same prior state (Issue #867), never a silent overwrite.
 */
export interface TransitionConflictInfo {
  taskId: TaskId;
  expectedLifecycle: LifecycleState;
  expectedVersion: number;
  requestedTransition: LifecycleState;
  /** The task row as it actually stands after losing the race. */
  current: TaskRecord;
}

export type TransitionTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; kind: "blocked"; blocked: TransitionBlockedInfo }
  | { ok: false; kind: "conflict"; conflict: TransitionConflictInfo };

/** Human-readable detail for any `transitionTask` failure, regardless of kind. */
export function transitionFailureDetail(failure: Extract<TransitionTaskResult, { ok: false }>): string {
  if (failure.kind === "blocked") return failure.blocked.blockingRule;
  const { conflict } = failure;
  return `task ${conflict.taskId} lifecycle changed concurrently: expected ${conflict.expectedLifecycle}@v${conflict.expectedVersion} -> ${conflict.requestedTransition}, but found ${conflict.current.lifecycleState}@v${conflict.current.version}`;
}

export interface TransitionTaskOptions {
  /**
   * Test-only synchronization seam invoked once the transition is validated as legal but
   * before the CAS write is issued. Production callers never pass this. It exists solely so
   * the two-OS-process concurrency test (task-lifecycle.concurrency.test.ts) can force both
   * processes to finish observing the identical prior (lifecycleState, version) before either
   * issues its guarded UPDATE, reproducing the exact race this Issue guards against instead of
   * depending on incidental process-scheduling timing.
   */
  beforeCasWrite?: () => void;
}

/**
 * Semantic task lifecycle transition; physical execution state is external.
 *
 * CAS-guarded (Issue #867): the legality check and the write both pin the exact prior
 * (lifecycleState, version) this call observed, via `updateTaskLifecycleStateIfCurrent`.
 * Two concurrent callers racing from the same prior state can no longer both silently
 * succeed — the loser gets a structured `kind: "conflict"` result instead of having its
 * transition discarded without any signal.
 */
export function transitionTask(
  store: WorkflowStateStore,
  taskId: TaskId,
  to: LifecycleState,
  options?: TransitionTaskOptions,
): TransitionTaskResult {
  const task = store.getTask(taskId);
  if (task === undefined) throw new Error(`task not found: ${taskId}`);
  const validation = validateTransition(task.lifecycleState, to);
  if (!validation.allowed) return { ok: false, kind: "blocked", blocked: validation.blocked };
  options?.beforeCasWrite?.();
  const updated = store.updateTaskLifecycleStateIfCurrent({
    taskId,
    expectedLifecycle: task.lifecycleState,
    expectedVersion: task.version,
    next: to,
  });
  if (!updated.ok) {
    return {
      ok: false,
      kind: "conflict",
      conflict: {
        taskId,
        expectedLifecycle: task.lifecycleState,
        expectedVersion: task.version,
        requestedTransition: to,
        current: updated.current,
      },
    };
  }
  return { ok: true, task: updated.task };
}
