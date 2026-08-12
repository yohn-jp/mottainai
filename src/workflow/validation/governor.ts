import crypto from "node:crypto";
import path from "node:path";
import type { ArtifactStore } from "../../retrieve.js";
import { runProgram } from "../../subprocess.js";
import { readGitStatus } from "../git/context.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import type { CheckRunProvenance, CheckRunRecord, WorkflowStateStore } from "../state/store.js";
import { computeStateFingerprint, type StateFingerprintResult } from "./fingerprint.js";
import { computeCommandDigest, computeConfigDigest, type ManagedCheckCommand } from "./identity.js";
import { boundedFailureDiagnostics, combinedOutputText, executionOutcomeSummary } from "./receipt.js";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, type ManagedCheckDefinition } from "./registry.js";

/**
 * Validation governor core (issue #184 Phase 1). The invariant this module exists to
 * enforce: a prior PASS is reused only when the check identity (command/config) and the
 * repository state fingerprint both match exactly, and any uncertainty about that state
 * falls back to real execution. See docs/validation-governor.md.
 */

export type CheckReceiptState = "executed-pass" | "executed-fail" | "reused-pass" | "stale" | "not-required";
export type CheckExecutionKind = "executed" | "reused" | "not-run";
export type CheckStatus = "passed" | "failed" | "unknown" | "not-required";

export interface CheckReceipt {
  check: string;
  label: string;
  required: boolean;
  status: CheckStatus;
  execution: CheckExecutionKind;
  state: CheckReceiptState;
  durationMs: number;
  fingerprint: string | undefined;
  runId: string | undefined;
  reusedFromRunId: string | undefined;
  summary: string;
  diagnostics: readonly string[] | undefined;
  artifactRef: string | undefined;
  provenance: CheckRunProvenance;
}

export interface ManagedCheckContext {
  workspaceRoot: string;
  store: WorkflowStateStore;
  artifactStore: ArtifactStore;
  instanceId: RepositoryInstanceId;
  /** managed worktree が無い呼び出しは省略する（内部で `""` として分離される）。 */
  worktreeId?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface RunManagedCheckOptions {
  /** reuse を無視して必ず実行する。実行自体は依然として fingerprint/config digest を記録する。 */
  force?: boolean;
}

function worktreeKey(worktreeId: string | undefined): string {
  return worktreeId ?? "";
}

interface ResolvedCheckIdentity {
  command: ManagedCheckCommand;
  commandDigest: string;
  fingerprintResult: StateFingerprintResult;
  configDigest: string | undefined;
}

async function resolveIdentity(context: ManagedCheckContext, check: ManagedCheckDefinition): Promise<ResolvedCheckIdentity> {
  const cwd = check.cwd !== undefined ? path.join(context.workspaceRoot, check.cwd) : context.workspaceRoot;
  const command: ManagedCheckCommand = { command: check.command, args: [...check.args], cwd };
  const commandDigest = computeCommandDigest(command);
  const fingerprintResult = await computeStateFingerprint({
    workspaceRoot: context.workspaceRoot,
    scope: check.scope,
    configPaths: check.configPaths,
  });
  if (!fingerprintResult.ok) return { command, commandDigest, fingerprintResult, configDigest: undefined };

  // `process.env` is never read directly here (architecture env boundary); a check that
  // declares `relevantEnv` only sees values the caller explicitly injected via `context.env`.
  const relevantEnvSource = context.env ?? {};
  const relevantEnv = Object.fromEntries((check.relevantEnv ?? []).map((name) => [name, relevantEnvSource[name]]));
  const configDigest = computeConfigDigest({
    checkId: check.id,
    command,
    configFileDigests: fingerprintResult.snapshot.configFileDigests,
    relevantEnv,
  });
  return { command, commandDigest, fingerprintResult, configDigest };
}

function reusedReceipt(check: ManagedCheckDefinition, identity: ResolvedCheckIdentity, match: CheckRunRecord): CheckReceipt {
  return {
    check: check.id,
    label: check.label,
    required: check.required,
    status: "passed",
    execution: "reused",
    state: "reused-pass",
    durationMs: match.durationMs,
    fingerprint: identity.fingerprintResult.ok ? identity.fingerprintResult.fingerprint : undefined,
    runId: match.runId,
    reusedFromRunId: match.runId,
    summary: `${check.id} reused a prior passing execution (run ${match.runId}); no process was started`,
    diagnostics: undefined,
    artifactRef: match.artifactRef,
    provenance: {
      reasonCode: "matching-prior-success",
      explanation:
        `Repository state fingerprint and configuration digest matched the successful execution recorded as ${match.runId} ` +
        `(recorded ${new Date(match.recordedAt).toISOString()}); the check was not re-executed.`,
    },
  };
}

function staleReceipt(check: ManagedCheckDefinition, identity: ResolvedCheckIdentity, reasonCode: string, explanation: string): CheckReceipt {
  return {
    check: check.id,
    label: check.label,
    required: check.required,
    status: "unknown",
    execution: "not-run",
    state: "stale",
    durationMs: 0,
    fingerprint: identity.fingerprintResult.ok ? identity.fingerprintResult.fingerprint : undefined,
    runId: undefined,
    reusedFromRunId: undefined,
    summary: `${check.id} has no current evidence and must run`,
    diagnostics: undefined,
    artifactRef: undefined,
    provenance: { reasonCode, explanation },
  };
}

function notRequiredReceipt(check: ManagedCheckDefinition, identity: ResolvedCheckIdentity): CheckReceipt {
  return {
    check: check.id,
    label: check.label,
    required: check.required,
    status: "not-required",
    execution: "not-run",
    state: "not-required",
    durationMs: 0,
    fingerprint: identity.fingerprintResult.ok ? identity.fingerprintResult.fingerprint : undefined,
    runId: undefined,
    reusedFromRunId: undefined,
    summary: `${check.id} is not required by repository policy and has no current evidence`,
    diagnostics: undefined,
    artifactRef: undefined,
    provenance: {
      reasonCode: "not-required",
      explanation: `${check.id} is declared optional (required: false) and no matching evidence exists.`,
    },
  };
}

/**
 * Read-only status query: never spawns the check's process. Mirrors
 * `src/semantics/verification/planner.ts`'s "know whether checks are satisfied without
 * rerunning them" but scoped to the governor's own state-fingerprint evidence rather than
 * semantic impact analysis.
 */
export async function assessManagedCheck(context: ManagedCheckContext, check: ManagedCheckDefinition): Promise<CheckReceipt> {
  const identity = await resolveIdentity(context, check);
  if (!identity.fingerprintResult.ok) {
    return staleReceipt(
      check,
      identity,
      "fingerprint-unavailable",
      `Repository state fingerprint could not be established (${identity.fingerprintResult.reason}: ${identity.fingerprintResult.detail}); uncertainty requires execution.`,
    );
  }
  const match = context.store.findReusableCheckRun(
    context.instanceId,
    worktreeKey(context.worktreeId),
    check.id,
    identity.fingerprintResult.fingerprint,
    identity.configDigest!,
  );
  if (match !== undefined) return reusedReceipt(check, identity, match);
  if (!check.required) return notRequiredReceipt(check, identity);
  return staleReceipt(
    check,
    identity,
    "no-matching-evidence",
    "No prior successful execution matches the current repository state and configuration digest.",
  );
}

function evidenceBridgeStatus(passed: boolean): "passed" | "failed" {
  return passed ? "passed" : "failed";
}

/**
 * `identity.fingerprintResult.snapshot.overallClean` is measured before the check's process
 * starts. A check that mutates tracked files as a side effect (a formatter, codegen, a build
 * step that writes into a tracked path) can leave the worktree dirty by the time it finishes,
 * even though it started clean. Bridging evidence into `validation_evidence` must not trust
 * that stale, pre-execution snapshot — re-read Git status right before the write so the bridge
 * only ever fires when the worktree is still clean at `headCommit` after the check ran.
 */
async function isWorkspaceCleanNow(workspaceRoot: string): Promise<boolean> {
  const status = await readGitStatus(workspaceRoot);
  return status.ok && status.status.entries.length === 0;
}

/**
 * Execute-or-reuse a managed check. A matching prior PASS (same instance/worktree/check/
 * fingerprint/config digest) is returned without starting a process (issue #184
 * "duplicate-success execution suppression"). A matching prior FAILURE is never reused
 * silently as a pass — it always falls through to real execution.
 */
export async function runManagedCheck(
  context: ManagedCheckContext,
  check: ManagedCheckDefinition,
  options: RunManagedCheckOptions = {},
): Promise<CheckReceipt> {
  const now = context.now ?? Date.now;
  const identity = await resolveIdentity(context, check);

  if (identity.fingerprintResult.ok && options.force !== true) {
    const match = context.store.findReusableCheckRun(
      context.instanceId,
      worktreeKey(context.worktreeId),
      check.id,
      identity.fingerprintResult.fingerprint,
      identity.configDigest!,
    );
    if (match !== undefined) return reusedReceipt(check, identity, match);
  }

  const startedAt = now();
  const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await runProgram(
    identity.command.command,
    [...identity.command.args],
    identity.command.cwd,
    timeoutMs,
    DEFAULT_MAX_OUTPUT_BYTES,
    context.env,
  );
  const durationMs = now() - startedAt;
  const passed = result.spawnError === undefined && !result.timedOut && !result.outputLimit && result.exitCode === 0;
  const summary = executionOutcomeSummary(check, passed, result, durationMs);

  const artifactRef = context.artifactStore.putArtifact({
    text: combinedOutputText(result),
    stdout: result.stdout,
    stderr: result.stderr,
    metadata: {
      operation: "managed-check",
      command: `${identity.command.command} ${identity.command.args.join(" ")}`,
      cwd: identity.command.cwd,
      summary,
    },
  });
  const diagnostics = passed ? undefined : boundedFailureDiagnostics(result);

  const reasonCode = !identity.fingerprintResult.ok
    ? "fingerprint-unavailable"
    : options.force === true
      ? "force-requested"
      : "no-matching-prior-success";
  const explanation = !identity.fingerprintResult.ok
    ? `Repository state fingerprint could not be established (${identity.fingerprintResult.reason}: ${identity.fingerprintResult.detail}); the check executed rather than reusing evidence.`
    : options.force === true
      ? "Execution was explicitly forced; reuse was not considered."
      : "No prior successful execution matched the current repository state and configuration digest.";
  const provenance: CheckRunProvenance = { reasonCode, explanation };

  // Fingerprint unavailable: recording a keyed run would create evidence that can never be
  // matched again (and could misleadingly resemble reusable evidence). Report the execution
  // without persisting reuse evidence in that case.
  const persistedRunId = identity.fingerprintResult.ok ? `cr_${crypto.randomUUID()}` : undefined;
  if (identity.fingerprintResult.ok && persistedRunId !== undefined) {
    context.store.recordCheckRun({
      runId: persistedRunId,
      instanceId: context.instanceId,
      worktreeId: worktreeKey(context.worktreeId),
      checkId: check.id,
      commandDigest: identity.commandDigest,
      stateFingerprint: identity.fingerprintResult.fingerprint,
      configDigest: identity.configDigest!,
      status: evidenceBridgeStatus(passed),
      execution: "executed",
      startedAt,
      durationMs,
      summary,
      artifactRef,
      provenance,
    });
    if (check.evidenceName !== undefined && (await isWorkspaceCleanNow(context.workspaceRoot))) {
      context.store.recordValidationEvidence({
        instanceId: context.instanceId,
        headCommit: identity.fingerprintResult.headCommit,
        name: check.evidenceName,
        status: evidenceBridgeStatus(passed),
      });
    }
  }

  return {
    check: check.id,
    label: check.label,
    required: check.required,
    status: passed ? "passed" : "failed",
    execution: "executed",
    state: passed ? "executed-pass" : "executed-fail",
    durationMs,
    fingerprint: identity.fingerprintResult.ok ? identity.fingerprintResult.fingerprint : undefined,
    runId: persistedRunId,
    reusedFromRunId: undefined,
    summary,
    diagnostics,
    artifactRef,
    provenance,
  };
}

export interface ValidationReceipt {
  apiVersion: "v1";
  satisfied: boolean;
  checks: readonly CheckReceipt[];
  requiredPending: readonly string[];
}

export function buildValidationReceipt(checks: readonly CheckReceipt[]): ValidationReceipt {
  const requiredPending = checks
    .filter((receipt) => receipt.required && receipt.state !== "reused-pass" && receipt.state !== "executed-pass")
    .map((receipt) => receipt.check);
  return {
    apiVersion: "v1",
    satisfied: requiredPending.length === 0,
    checks,
    requiredPending,
  };
}

export async function assessManagedChecks(
  context: ManagedCheckContext,
  checks: readonly ManagedCheckDefinition[],
): Promise<ValidationReceipt> {
  const receipts: CheckReceipt[] = [];
  for (const check of checks) receipts.push(await assessManagedCheck(context, check));
  return buildValidationReceipt(receipts);
}
