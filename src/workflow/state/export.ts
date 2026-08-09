import os from "node:os";
import path from "node:path";
import type {
  AuditMetadata,
  CleanupLeaseRecord,
  GuardrailAuditRecord,
  RepositoryInstanceRecord,
  RepositoryPathRecord,
  RepositorySourceRecord,
  TaskRecord,
  WorkflowStateStore,
  WorktreeRecord,
} from "./store.js";
import { aggregateGuardrailMetrics, sanitizeAuditMetadata, type GuardrailMetrics } from "../domain/audit.js";

export const WORKFLOW_STATE_EXPORT_SCHEMA_VERSION = 1;
export const WORKFLOW_STATE_EXPORT_FORMAT = "mottainai.workflow-state";

export interface WorkflowStateExport {
  format: typeof WORKFLOW_STATE_EXPORT_FORMAT;
  schemaVersion: typeof WORKFLOW_STATE_EXPORT_SCHEMA_VERSION;
  exportedAt: number;
  repositories: {
    sources: ReadonlyArray<Pick<RepositorySourceRecord, "sourceId" | "rootCommitDigest" | "createdAt">>;
    instances: ReadonlyArray<
      Pick<RepositoryInstanceRecord, "instanceId" | "sourceId" | "gitCommonDir" | "createdAt" | "lastSeenAt">
    >;
    paths: ReadonlyArray<Pick<RepositoryPathRecord, "instanceId" | "canonicalPath" | "isCurrent" | "observedAt">>;
  };
  tasks: ReadonlyArray<Omit<TaskRecord, "baseCommit"> & { baseCommit: string }>;
  worktrees: ReadonlyArray<Omit<WorktreeRecord, "canonicalPath"> & { canonicalPath: string }>;
  pullRequests: ReadonlyArray<{
    recordId: string;
    taskId?: string;
    instanceId?: string;
    provider: string;
    repositoryId: string;
    prNumber: number;
    url: string;
    headSha: string;
    lifecycleState: string;
    createdAt: number;
    updatedAt: number;
  }>;
  cleanupLeases: ReadonlyArray<{
    operationId: string;
    planDigest: string;
    instanceId: string;
    taskId: string;
    worktreeId?: string;
    state: string;
    acquiredAt: number;
    expiresAt: number;
    updatedAt: number;
    completedActionIds: readonly string[];
  }>;
  audit: ReadonlyArray<GuardrailAuditRecord>;
  auditMetrics: GuardrailMetrics;
}

export interface CreateWorkflowStateExportInput {
  store: WorkflowStateStore;
  workspaceRoot?: string;
  now?: () => number;
}

function redactPath(value: string, workspaceRoot: string): string {
  const absolute = path.resolve(value);
  const root = path.resolve(workspaceRoot);
  if (absolute === root || absolute.startsWith(`${root}${path.sep}`)) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    return relative.length === 0 ? "<workspace>" : `<workspace>/${relative}`;
  }
  const home = path.resolve(os.homedir());
  if (absolute === home || absolute.startsWith(`${home}${path.sep}`)) {
    const relative = path.relative(home, absolute).split(path.sep).join("/");
    return relative.length === 0 ? "~" : `~/${relative}`;
  }
  return "<external-path>";
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<redacted-url>";
  }
}

function redactAudit(record: GuardrailAuditRecord): GuardrailAuditRecord {
  return { ...record, metadata: sanitizeAuditMetadata(record.metadata) as AuditMetadata };
}

export function createWorkflowStateExport(input: CreateWorkflowStateExportInput): WorkflowStateExport {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const sources = input.store.listRepositorySources();
  const instances = input.store.listRepositoryInstances();
  const paths = instances.flatMap((instance) => input.store.listRepositoryPaths(instance.instanceId));
  const tasks = input.store.listTasks();
  const worktrees = input.store.listWorktrees();
  const pullRequests = input.store.listPullRequestRecords();
  const cleanupLeases = input.store.listCleanupLeases();
  const audit = input.store.listGuardrailAuditRecords().map(redactAudit);
  return {
    format: WORKFLOW_STATE_EXPORT_FORMAT,
    schemaVersion: WORKFLOW_STATE_EXPORT_SCHEMA_VERSION,
    exportedAt: input.now?.() ?? Date.now(),
    repositories: {
      sources: sources.map(({ sourceId, rootCommitDigest, createdAt }) => ({ sourceId, rootCommitDigest, createdAt })),
      instances: instances.map((instance) => ({
        ...instance,
        gitCommonDir: redactPath(instance.gitCommonDir, workspaceRoot),
      })),
      paths: paths.map((record) => ({ ...record, canonicalPath: redactPath(record.canonicalPath, workspaceRoot) })),
    },
    tasks: tasks.map((task) => ({ ...task })),
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      canonicalPath: redactPath(worktree.canonicalPath, workspaceRoot),
    })),
    pullRequests: pullRequests.map((record) => ({
      recordId: record.recordId,
      ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
      ...(record.instanceId === undefined ? {} : { instanceId: record.instanceId }),
      provider: record.provider,
      repositoryId: record.repositoryId,
      prNumber: record.prNumber,
      url: redactUrl(record.url),
      headSha: record.headSha,
      lifecycleState: record.lifecycleState,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })),
    cleanupLeases: cleanupLeases.map((lease: CleanupLeaseRecord) => ({
      operationId: lease.operationId,
      planDigest: lease.planDigest,
      instanceId: lease.instanceId,
      taskId: lease.taskId,
      ...(lease.worktreeId === undefined ? {} : { worktreeId: lease.worktreeId }),
      state: lease.state,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      updatedAt: lease.updatedAt,
      completedActionIds: [...lease.completedActionIds],
    })),
    audit,
    auditMetrics: aggregateGuardrailMetrics(audit),
  };
}

export const exportWorkflowState = createWorkflowStateExport;

export function serializeWorkflowStateExport(snapshot: WorkflowStateExport): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function backupWorkflowState(input: CreateWorkflowStateExportInput): string {
  return serializeWorkflowStateExport(createWorkflowStateExport(input));
}
