import fs from "node:fs";
import path from "node:path";
import type { RepositoryInstanceId } from "./identity.js";
import { transitionTask } from "./task-lifecycle.js";
import { createPullRequestObserver, type PullRequestObserver } from "../providers/reconciliation.js";
import type {
  NawabariCloseReconciliationRecord,
  NawabariSessionId,
  PullRequestRecord,
  TaskRecord,
  WorkflowStateStore,
} from "../state/store.js";
import { type NawabariExecutionClient, type NawabariSession } from "../nawabari.js";

const MAX_RECONCILIATION_TASKS = 32;

export type NawabariCloseResult =
  | {
      ok: true;
      task: TaskRecord;
      session: NawabariSession;
      reconciliation: NawabariCloseReconciliationRecord;
      alreadyClosed: boolean;
    }
  | {
      ok: false;
      reason: "cleanup-blocked" | "task-identity-ambiguous" | "close-fetch-authority-missing";
      detail: string;
      task: TaskRecord;
      reconciliation?: NawabariCloseReconciliationRecord;
    };

function canonicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function repositoryMatches(session: NawabariSession, store: WorkflowStateStore, task: TaskRecord): boolean {
  const repository = store.getRepositoryInstance(task.instanceId);
  if (repository === undefined) return false;
  return (
    samePath(session.repository, repository.gitCommonDir) ||
    (repository.gitCommonDir.endsWith(`${path.sep}.git`) &&
      samePath(session.repository, path.dirname(repository.gitCommonDir)))
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Identity-bound handoff from a merged provider record to Nawabari.
 * Nawabari's inspect result is the only physical observation used before the
 * normal close request; Mottainai never edits claims or registry state.
 */
export async function closeNawabariExecution(input: {
  workspaceRoot: string;
  store: WorkflowStateStore;
  client: NawabariExecutionClient;
  task: TaskRecord;
  providerRecord: PullRequestRecord;
  expectedBranch?: string;
  /**
   * Only the successful finish/merged close path may set this. When true,
   * the remote is derived from the task's persisted push receipt and the
   * branch from `task.baseBranch`; missing or ambiguous authority fails
   * closed rather than guessing `origin`/`main`.
   */
  requestFetch?: boolean;
}): Promise<NawabariCloseResult> {
  const { task, providerRecord, store, client } = input;
  if (task.lifecycleState !== "merged")
    return {
      ok: false,
      reason: "task-identity-ambiguous",
      detail: `task ${task.taskId} is ${task.lifecycleState}, not merged; refusing Nawabari close`,
      task,
    };
  if (task.nawabariSessionId === undefined)
    return {
      ok: false,
      reason: "task-identity-ambiguous",
      detail: `task ${task.taskId} has no durable Nawabari session identity`,
      task,
    };
  if (providerRecord.taskId !== task.taskId || providerRecord.lifecycleState !== "merged")
    return {
      ok: false,
      reason: "task-identity-ambiguous",
      detail: `provider record is not the merged record owned by task ${task.taskId}`,
      task,
    };
  if (providerRecord.instanceId !== undefined && providerRecord.instanceId !== task.instanceId)
    return {
      ok: false,
      reason: "task-identity-ambiguous",
      detail: `provider record belongs to a different repository instance than task ${task.taskId}`,
      task,
    };

  let reconciliation: NawabariCloseReconciliationRecord;
  try {
    reconciliation = store.beginNawabariCloseReconciliation({
      taskId: task.taskId,
      instanceId: task.instanceId,
      nawabariSessionId: task.nawabariSessionId,
      providerRecordId: providerRecord.recordId,
      ...(providerRecord.mergeRevision === undefined ? {} : { integratedRevision: providerRecord.mergeRevision }),
    });
  } catch (error) {
    return { ok: false, reason: "task-identity-ambiguous", detail: errorDetail(error), task };
  }
  if (reconciliation.state === "closed") {
    // A durable closed result is the idempotency boundary. The session was
    // already handed to Nawabari successfully in a prior invocation.
    return {
      ok: true,
      task,
      session: {
        sessionId: task.nawabariSessionId,
        repository: "",
        worktree: "",
        branch: "",
        state: "closed",
        raw: { ok: true, command: "session close", state: "closed" },
      },
      reconciliation,
      alreadyClosed: true,
    };
  }

  // Fetch is only ever meaningful alongside a non-ancestry integration proof
  // (Nawabari requires --integrated-revision together with the fetch flags).
  // An ordinary ancestry-based merge has no mergeRevision and needs no fetch;
  // only a task that actually carries a merge revision must resolve fetch
  // authority, and only then does missing/ambiguous authority fail closed.
  let fetchAuthority: { fetchRemote: string; fetchBranch: string } | undefined;
  if (input.requestFetch === true && providerRecord.mergeRevision !== undefined) {
    const pushReceipt = store.getPushReconciliation(task.taskId);
    const fetchRemote = pushReceipt?.remote;
    const fetchBranch = task.baseBranch;
    if (fetchRemote === undefined || fetchRemote.length === 0 || fetchBranch.length === 0)
      return {
        ok: false,
        reason: "close-fetch-authority-missing",
        detail: `task ${task.taskId} has no authoritative persisted remote/base branch for Nawabari close-fetch`,
        task,
        reconciliation,
      };
    fetchAuthority = { fetchRemote, fetchBranch };
  }

  let inspected: NawabariSession;
  try {
    inspected = await client.inspectSession({ cwd: input.workspaceRoot, sessionId: task.nawabariSessionId });
  } catch (error) {
    const detail = `Nawabari session inspect blocked close for task ${task.taskId}: ${errorDetail(error)}`;
    try {
      reconciliation = store.markNawabariCloseReconciliation(task.taskId, "blocked", detail);
    } catch {
      // Preserve the physical blocker even if the secondary diagnostic write fails.
    }
    return { ok: false, reason: "cleanup-blocked", detail, task, reconciliation };
  }
  const expectedSessionId = task.nawabariSessionId as NawabariSessionId;
  if (
    inspected.sessionId !== expectedSessionId ||
    !repositoryMatches(inspected, store, task) ||
    (input.expectedBranch !== undefined && inspected.branch !== input.expectedBranch)
  ) {
    const detail = `Nawabari session ${expectedSessionId} failed task identity verification before close`;
    try {
      reconciliation = store.markNawabariCloseReconciliation(task.taskId, "blocked", detail);
    } catch {
      // Preserve the identity failure as the returned bounded diagnostic.
    }
    return { ok: false, reason: "cleanup-blocked", detail, task, reconciliation };
  }

  if (inspected.state === "closed") {
    try {
      reconciliation = store.markNawabariCloseReconciliation(task.taskId, "closed");
    } catch (error) {
      return { ok: false, reason: "cleanup-blocked", detail: errorDetail(error), task, reconciliation };
    }
    return { ok: true, task, session: inspected, reconciliation, alreadyClosed: true };
  }
  if (inspected.state !== "active") {
    // Nawabari also reports "closing"/"stale"/"new": physical claim release is not
    // proven, so only "closed" is durable and every other state must stay retryable.
    const detail = `Nawabari session ${expectedSessionId} is ${inspected.state}, not closed; close request deferred (close_readiness=${JSON.stringify(inspected.raw.close_readiness ?? null)}, blockers=${JSON.stringify(inspected.raw.blockers ?? null)})`;
    try {
      reconciliation = store.markNawabariCloseReconciliation(task.taskId, "blocked", detail);
    } catch {
      // Preserve the physical readiness blocker even if the secondary diagnostic write fails.
    }
    return { ok: false, reason: "cleanup-blocked", detail, task, reconciliation };
  }

  try {
    await client.closeSession({
      cwd: inspected.worktree,
      sessionId: expectedSessionId,
      ...(providerRecord.mergeRevision === undefined ? {} : { integratedRevision: providerRecord.mergeRevision }),
      ...(fetchAuthority === undefined ? {} : fetchAuthority),
    });
    reconciliation = store.markNawabariCloseReconciliation(task.taskId, "closed");
    return { ok: true, task, session: inspected, reconciliation, alreadyClosed: false };
  } catch (error) {
    const detail = `Nawabari session close blocked for task ${task.taskId}: ${errorDetail(error)}`;
    try {
      reconciliation = store.markNawabariCloseReconciliation(task.taskId, "blocked", detail);
    } catch {
      // Preserve the original close blocker in the result.
    }
    return { ok: false, reason: "cleanup-blocked", detail, task, reconciliation };
  }
}

export type NawabariClosureTaskResultReason =
  | "already-closed"
  | "closed"
  | "provider-identity-ambiguous"
  | "provider-observation-unavailable"
  | "provider-not-integrated"
  | "provider-head-mismatch"
  | "lifecycle-transition-blocked"
  | "integrated-task-persistence-failed"
  | "provider-identity-changed"
  | "task-not-merged"
  | "close-blocked"
  | "reconciliation-budget-exhausted";

export interface NawabariClosureTaskResult {
  taskId: string;
  status: "reconciled" | "not-reconciled";
  reason: NawabariClosureTaskResultReason;
  detail: string;
}

export interface ReconcileNawabariClosuresResult {
  attempted: number;
  closed: number;
  promoted: number;
  blocked: Array<{ taskId: string; detail: string }>;
  /** Non-blocking observations (e.g. a task that never reached a close attempt); these never stop a new task start. */
  diagnostics: Array<{ taskId: string; detail: string }>;
  /** Bounded per-task outcome, including tasks skipped because a durable result already exists. */
  tasks: NawabariClosureTaskResult[];
}

/**
 * Retry durable, task-owned integrated executions only. `maxTasks` is an
 * external-work budget, not a positional slice: up to that many provider
 * observations and up to that many physical close attempts may run while a
 * bounded local scan skips already-closed/diagnostic-only history. This keeps
 * interactive `maxTasks: 1` latency bounded without letting an older harmless
 * task starve the execution that is actually retaining claims.
 */
export async function reconcileNawabariClosures(input: {
  workspaceRoot: string;
  store: WorkflowStateStore;
  client: NawabariExecutionClient;
  instanceId?: RepositoryInstanceId;
  maxTasks?: number;
  /** Optional seam; production defaults to the same owning GitHub observer used by workflow reconciliation. */
  providerObserver?: PullRequestObserver;
}): Promise<ReconcileNawabariClosuresResult> {
  const limit = Math.max(0, Math.min(input.maxTasks ?? MAX_RECONCILIATION_TASKS, MAX_RECONCILIATION_TASKS));
  const result: ReconcileNawabariClosuresResult = {
    attempted: 0,
    closed: 0,
    promoted: 0,
    blocked: [],
    diagnostics: [],
    tasks: [],
  };
  if (limit === 0) return result;

  const recordTask = (
    taskId: string,
    status: "reconciled" | "not-reconciled",
    reason: NawabariClosureTaskResultReason,
    detail: string,
  ): void => {
    if (result.tasks.some((task) => task.taskId === taskId)) return;
    result.tasks.push({ taskId, status, reason, detail });
  };

  const providerObserver = input.providerObserver ?? createPullRequestObserver(input.workspaceRoot);
  const tasks = input.store
    .listTasks(input.instanceId)
    .filter(
      (task) => ["pull-request-open", "merged"].includes(task.lifecycleState) && task.nawabariSessionId !== undefined,
    )
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.taskId.localeCompare(left.taskId),
    )
    .slice(0, MAX_RECONCILIATION_TASKS);
  let providerObservations = 0;

  for (const originalTask of tasks) {
    // Durable closure is a local idempotency fact. Skip it before consuming
    // either the provider-observation or physical-close budget.
    if (input.store.getNawabariCloseReconciliation(originalTask.taskId)?.state === "closed") {
      recordTask(
        originalTask.taskId,
        "reconciled",
        "already-closed",
        "Nawabari close reconciliation is already durably closed",
      );
      continue;
    }

    let task = originalTask;
    let records = input.store.listPullRequestRecordsForTask(task.taskId);
    if (records.length !== 1) {
      // No close attempt has happened yet at this point in the loop: a task with
      // zero or several provider records here (often a pull-request-open task
      // that never merged, or a detached record from pr_records.task_id's
      // ON DELETE SET NULL) is provider-identity ambiguity, not a close failure.
      // Never let it block every other task's start in this repository instance.
      const detail = `task ${task.taskId} has ${records.length} provider records; close identity is ambiguous`;
      result.diagnostics.push({
        taskId: task.taskId,
        detail,
      });
      recordTask(task.taskId, "not-reconciled", "provider-identity-ambiguous", detail);
      continue;
    }
    let providerRecord = records[0]!;
    if (task.lifecycleState !== "merged") {
      let integrated = providerRecord.lifecycleState === "merged";
      let observedMergeRevision: string | undefined;
      let providerReason: NawabariClosureTaskResultReason = "provider-not-integrated";
      let providerObservationPerformed = false;
      if (!integrated && providerObservations < limit) {
        providerObservations += 1;
        providerObservationPerformed = true;
        let observed;
        try {
          observed = await providerObserver(providerRecord);
        } catch (error) {
          const detail = `provider reconciliation unavailable for task ${task.taskId}: ${errorDetail(error)}`;
          result.diagnostics.push({ taskId: task.taskId, detail });
          recordTask(task.taskId, "not-reconciled", "provider-observation-unavailable", detail);
          continue;
        }
        if (!observed.ok) {
          const detail =
            observed.detail ??
            `provider reconciliation unavailable for ${providerRecord.provider}/${providerRecord.repositoryId}#${providerRecord.prNumber}`;
          result.diagnostics.push({ taskId: task.taskId, detail });
          recordTask(task.taskId, "not-reconciled", "provider-observation-unavailable", detail);
          continue;
        }
        integrated = observed.lifecycleState === "merged" && observed.headSha === providerRecord.headSha;
        if (integrated) observedMergeRevision = observed.mergeRevision;
        else if (observed.lifecycleState === "merged") {
          providerReason = "provider-head-mismatch";
          result.diagnostics.push({
            taskId: task.taskId,
            detail: `task ${task.taskId} provider merge head does not match the persisted task-owned head`,
          });
        }
      }
      if (!integrated) {
        const reason = providerObservationPerformed ? providerReason : "reconciliation-budget-exhausted";
        recordTask(
          task.taskId,
          "not-reconciled",
          reason,
          reason === "provider-head-mismatch"
            ? `task ${task.taskId} provider merge head does not match the persisted task-owned head`
            : reason === "reconciliation-budget-exhausted"
              ? `task ${task.taskId} was not provider-observed because the reconciliation budget was exhausted`
              : `task ${task.taskId} provider state does not prove an integrated task-owned merge`,
        );
        continue;
      }
      try {
        if (observedMergeRevision !== undefined)
          providerRecord = input.store.recordPullRequestMergeRevision(providerRecord.recordId, observedMergeRevision);
        if (providerRecord.lifecycleState !== "merged")
          providerRecord = input.store.updatePullRequestLifecycleState(providerRecord.recordId, "merged");
        const transitioned = transitionTask(input.store, task.taskId, "merged");
        if (!transitioned.ok) {
          const detail = transitioned.blocked.blockingRule;
          result.blocked.push({ taskId: task.taskId, detail });
          recordTask(task.taskId, "not-reconciled", "lifecycle-transition-blocked", detail);
          continue;
        }
        task = transitioned.task;
        result.promoted += 1;
      } catch (error) {
        const detail = `integrated task persistence failed: ${errorDetail(error)}`;
        result.blocked.push({
          taskId: task.taskId,
          detail,
        });
        recordTask(task.taskId, "not-reconciled", "integrated-task-persistence-failed", detail);
        continue;
      }
    }
    records = input.store.listPullRequestRecordsForTask(task.taskId);
    if (records.length !== 1) {
      const detail = `task ${task.taskId} provider identity changed during reconciliation`;
      result.blocked.push({
        taskId: task.taskId,
        detail,
      });
      recordTask(task.taskId, "not-reconciled", "provider-identity-changed", detail);
      continue;
    }
    providerRecord = records[0]!;
    if (task.lifecycleState !== "merged" || providerRecord.lifecycleState !== "merged") {
      const detail = `task ${task.taskId} is not in a merged task/provider state after reconciliation`;
      recordTask(task.taskId, "not-reconciled", "task-not-merged", detail);
      continue;
    }
    if (result.attempted >= limit) {
      const detail = `task ${task.taskId} was not close-reconciled because the reconciliation budget was exhausted`;
      recordTask(task.taskId, "not-reconciled", "reconciliation-budget-exhausted", detail);
      const currentIndex = tasks.findIndex((candidate) => candidate.taskId === originalTask.taskId);
      for (const remaining of tasks.slice(currentIndex + 1)) {
        if (input.store.getNawabariCloseReconciliation(remaining.taskId)?.state === "closed")
          recordTask(
            remaining.taskId,
            "reconciled",
            "already-closed",
            "Nawabari close reconciliation is already durably closed",
          );
        else
          recordTask(
            remaining.taskId,
            "not-reconciled",
            "reconciliation-budget-exhausted",
            `task ${remaining.taskId} was not close-reconciled because the reconciliation budget was exhausted`,
          );
      }
      break;
    }

    result.attempted += 1;
    const closed = await closeNawabariExecution({
      workspaceRoot: input.workspaceRoot,
      store: input.store,
      client: input.client,
      task,
      providerRecord,
    });
    if (closed.ok) {
      result.closed += 1;
      recordTask(
        task.taskId,
        "reconciled",
        "closed",
        `Nawabari close reconciliation completed for task ${task.taskId}`,
      );
    } else {
      result.blocked.push({ taskId: task.taskId, detail: closed.detail });
      recordTask(task.taskId, "not-reconciled", "close-blocked", closed.detail);
    }
  }
  return result;
}
