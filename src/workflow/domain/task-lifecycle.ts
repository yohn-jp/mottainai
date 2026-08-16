import { validateTransition } from "./lifecycle.js";
import type { LifecycleState, TransitionBlockedInfo } from "./lifecycle.js";
import type { TaskId, TaskRecord, WorkflowStateStore } from "../state/store.js";

export type TransitionTaskResult = { ok: true; task: TaskRecord } | { ok: false; blocked: TransitionBlockedInfo };

/** Semantic task lifecycle transition; physical execution state is external. */
export function transitionTask(store: WorkflowStateStore, taskId: TaskId, to: LifecycleState): TransitionTaskResult {
  const task = store.getTask(taskId);
  if (task === undefined) throw new Error(`task not found: ${taskId}`);
  const validation = validateTransition(task.lifecycleState, to);
  if (!validation.allowed) return { ok: false, blocked: validation.blocked };
  return { ok: true, task: store.updateTaskLifecycleState(taskId, to) };
}
