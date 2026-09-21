import {
  CANON_CONTRACT_ID,
  CANON_SCHEMA_VERSION,
  identitiesOf,
  parseCanonDocument,
  type CanonDocument,
  type CanonExecutionAttachment,
  type CanonPrefix,
} from "./identity.js";
import {
  NawabariExecutionError,
  type NawabariExecutionClient,
  type NawabariRepositoryEvidence,
} from "../workflow/nawabari.js";
import type { TaskId, TaskRecord, WorkflowStateStore } from "../workflow/state/store.js";

const MAX_DIAGNOSTIC_LENGTH = 512;

export type CanonResolutionFailureCode =
  | "task-not-found"
  | "task-unavailable"
  | "task-session-missing"
  | "repository-fact-missing"
  | "repository-path-unavailable"
  | "nawabari-incompatible"
  | "nawabari-evidence-unavailable"
  | "nawabari-evidence-invalid"
  | "nawabari-evidence-mismatch"
  | "nawabari-evidence-incomplete"
  | "base-revision-mismatch";

export interface CanonResolutionDiagnostics {
  readonly completeness: "complete" | "incomplete";
  readonly freshness: "current" | "unknown";
  readonly evidenceSource: "nawabari-repository-evidence" | "none";
  readonly evidenceHash?: string;
  readonly baseRevisionProven?: boolean;
  readonly generationSource?: "nawabari" | "initial-attachment";
}

export interface CanonResolutionSuccess {
  readonly ok: true;
  readonly taskId: TaskId;
  readonly contractId: typeof CANON_CONTRACT_ID;
  readonly schemaVersion: typeof CANON_SCHEMA_VERSION;
  readonly prefix: CanonPrefix;
  readonly prefix_id: string;
  readonly executionAttachment: CanonExecutionAttachment;
  readonly execution_state_id: string;
  readonly diagnostics: CanonResolutionDiagnostics;
  readonly canon: CanonDocument;
}

export interface CanonResolutionFailure {
  readonly ok: false;
  readonly taskId: TaskId;
  readonly code: CanonResolutionFailureCode;
  readonly reason: CanonResolutionFailureCode;
  readonly error: string;
  readonly diagnostics: CanonResolutionDiagnostics;
}

export type CanonResolutionResult = CanonResolutionSuccess | CanonResolutionFailure;

export interface ResolveCanonInput {
  readonly store: WorkflowStateStore;
  readonly taskId: TaskId;
  readonly nawabari: NawabariExecutionClient;
}

function boundedMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  const normalized = message.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized.length <= MAX_DIAGNOSTIC_LENGTH ? normalized : `${normalized.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function failure(
  taskId: TaskId,
  code: CanonResolutionFailureCode,
  error: unknown,
  diagnostics: Partial<CanonResolutionDiagnostics> = {},
): CanonResolutionFailure {
  const message = boundedMessage(error);
  return {
    ok: false,
    taskId,
    code,
    reason: code,
    error: message,
    diagnostics: {
      completeness: diagnostics.completeness ?? "incomplete",
      freshness: diagnostics.freshness ?? "unknown",
      evidenceSource: diagnostics.evidenceSource ?? "none",
      ...(diagnostics.evidenceHash === undefined ? {} : { evidenceHash: diagnostics.evidenceHash }),
      ...(diagnostics.baseRevisionProven === undefined ? {} : { baseRevisionProven: diagnostics.baseRevisionProven }),
      ...(diagnostics.generationSource === undefined ? {} : { generationSource: diagnostics.generationSource }),
    },
  };
}

function sameRepository(left: string, right: string): boolean {
  if (left === right) return true;
  return left.replace(/[\\/]+$/u, "") === right.replace(/[\\/]+$/u, "");
}

function generationFromEvidence(evidence: NawabariRepositoryEvidence): {
  value: number;
  source: "nawabari" | "initial-attachment";
} {
  const raw = evidence.raw as Record<string, unknown>;
  for (const field of ["generation", "physical_generation", "session_generation"] as const) {
    if (!(field in raw)) continue;
    const value = raw[field];
    if (!Number.isSafeInteger(value) || (value as number) < 1)
      throw new Error(`Nawabari repository evidence has invalid ${field}`);
    return { value: value as number, source: "nawabari" };
  }
  // Nawabari's repository-evidence.v1 identifies each observed physical
  // generation by evidence_hash. Canon v1 requires a positive numeric
  // attachment generation; the first resolver attachment is generation one,
  // while evidence_hash remains the bounded freshness proof.
  return { value: 1, source: "initial-attachment" };
}

function resolvePrefix(task: TaskRecord, source: { sourceId: string; rootCommitDigest: string }): CanonPrefix {
  return {
    c0: {
      runtimeContract: { contractId: "mottainai.runtime.v1", schemaVersion: 1 },
      projectContract: { contractId: "mottainai.project.v1", schemaVersion: 1 },
      runtimeInstructions: [],
    },
    c1: {
      repository: {
        repositoryId: source.sourceId,
        sourceRevision: source.rootCommitDigest,
        baseRevision: task.baseCommit,
      },
      packageFacts: {
        taskSlug: task.taskSlug,
        issueRef: task.issueRef ?? null,
      },
      workspaceFacts: {
        baseBranch: task.baseBranch,
      },
    },
    c2: [],
    c3: [],
  };
}

/** Resolve one explicit managed task into the read-only Canon v1 boundary. */
export async function resolveCanon(input: ResolveCanonInput): Promise<CanonResolutionResult> {
  const task = input.store.getTask(input.taskId);
  if (task === undefined) return failure(input.taskId, "task-not-found", "task was not found in workflow state");
  if (["cleaned", "abandoned", "merged"].includes(task.lifecycleState))
    return failure(input.taskId, "task-unavailable", `task is not available in lifecycle state ${task.lifecycleState}`);
  if (task.nawabariSessionId === undefined)
    return failure(input.taskId, "task-session-missing", "task has no supported Nawabari session reference");

  const paths = input.store.listRepositoryPaths(task.instanceId).filter((candidate) => candidate.isCurrent);
  if (paths.length !== 1)
    return failure(
      input.taskId,
      "repository-path-unavailable",
      paths.length === 0 ? "repository has no current authoritative path" : "repository has ambiguous current paths",
    );
  const instance = input.store.getRepositoryInstance(task.instanceId);
  if (instance === undefined) return failure(input.taskId, "repository-fact-missing", "repository instance is missing");
  const source = input.store.getRepositorySource(instance.sourceId);
  if (source === undefined) return failure(input.taskId, "repository-fact-missing", "repository source is missing");

  let evidence: NawabariRepositoryEvidence;
  try {
    evidence = await input.nawabari.repositoryEvidence({
      cwd: paths[0]!.canonicalPath,
      sessionId: task.nawabariSessionId,
    });
  } catch (error) {
    const code =
      error instanceof NawabariExecutionError && error.code === "nawabari-incompatible"
        ? "nawabari-incompatible"
        : error instanceof NawabariExecutionError && error.code === "nawabari-contract-invalid"
          ? "nawabari-evidence-invalid"
          : "nawabari-evidence-unavailable";
    return failure(input.taskId, code, boundedMessage(error));
  }

  const evidenceDiagnostics = {
    evidenceSource: "nawabari-repository-evidence" as const,
    evidenceHash: evidence.evidenceHash,
    baseRevisionProven: evidence.baseRevisionProven,
  };
  if (
    evidence.sessionId !== task.nawabariSessionId ||
    !sameRepository(evidence.repository, instance.gitCommonDir) ||
    evidence.sessionState !== "active" ||
    evidence.branch.length === 0 ||
    evidence.worktree.length === 0
  )
    return failure(
      input.taskId,
      "nawabari-evidence-mismatch",
      "Nawabari evidence does not match the task-owned session",
      evidenceDiagnostics,
    );
  if (!evidence.complete)
    return failure(
      input.taskId,
      "nawabari-evidence-incomplete",
      `Nawabari evidence is incomplete${evidence.incompleteReasons.length === 0 ? "" : `: ${evidence.incompleteReasons.join(", ")}`}`,
      evidenceDiagnostics,
    );
  if (!evidence.baseRevisionProven || evidence.baseRevision !== task.baseCommit)
    return failure(
      input.taskId,
      "base-revision-mismatch",
      "Nawabari physical base revision does not match the immutable task base revision",
      evidenceDiagnostics,
    );

  let generation: { value: number; source: "nawabari" | "initial-attachment" };
  try {
    generation = generationFromEvidence(evidence);
  } catch (error) {
    return failure(input.taskId, "nawabari-evidence-invalid", boundedMessage(error), evidenceDiagnostics);
  }
  const executionAttachment: CanonExecutionAttachment = {
    generation: generation.value,
    sessionId: evidence.sessionId,
    worktreeId: evidence.worktree,
    branchName: evidence.branch,
  };
  const prefix = resolvePrefix(task, source);
  try {
    const canon = parseCanonDocument({
      contractId: CANON_CONTRACT_ID,
      schemaVersion: CANON_SCHEMA_VERSION,
      prefix,
      executionAttachment,
    });
    const identities = identitiesOf(canon);
    return {
      ok: true,
      taskId: input.taskId,
      contractId: CANON_CONTRACT_ID,
      schemaVersion: CANON_SCHEMA_VERSION,
      prefix: canon.prefix,
      prefix_id: identities.prefix_id,
      executionAttachment: canon.executionAttachment,
      execution_state_id: identities.execution_state_id,
      diagnostics: {
        completeness: "complete",
        freshness: "current",
        ...evidenceDiagnostics,
        generationSource: generation.source,
      },
      canon,
    };
  } catch (error) {
    return failure(input.taskId, "nawabari-evidence-invalid", boundedMessage(error), evidenceDiagnostics);
  }
}
