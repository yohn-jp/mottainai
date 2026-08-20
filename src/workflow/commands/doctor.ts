import {
  reconcileWorkflow,
  type ReconcileWorkflowInput,
  type ReconciliationDependencies,
  type ReconciliationReport,
} from "./reconcile.js";
import type { WorkflowStateStore } from "../state/store.js";
import { resolveRepositoryIdentity } from "../domain/identity.js";
import { reconcileNawabariClosures, type ReconcileNawabariClosuresResult } from "../domain/nawabari-close.js";
import { NawabariExecutionClient, NawabariExecutionError, type NawabariCommandResult } from "../nawabari.js";

export const WORKFLOW_DOCTOR_SCHEMA_VERSION = 1;

export type WorkflowDoctorCheckStatus = "pass" | "warning" | "error";

export interface WorkflowDoctorCheck {
  name: string;
  status: WorkflowDoctorCheckStatus;
  message: string;
}

export interface WorkflowDoctorProblem {
  severity: "warning" | "error";
  code: string;
  message: string;
}

export interface WorkflowDoctorReport {
  schemaVersion: typeof WORKFLOW_DOCTOR_SCHEMA_VERSION;
  mode: "read-only";
  ok: boolean;
  errors: number;
  warnings: number;
  checked: number;
  checks: readonly WorkflowDoctorCheck[];
  problems: readonly WorkflowDoctorProblem[];
  reconciliation: ReconciliationReport;
}

export interface WorkflowDoctorDependencies {
  reconcile: (input: ReconcileWorkflowInput) => Promise<ReconciliationReport>;
  inspectNawabari: (workspaceRoot: string) => Promise<NawabariCommandResult>;
  reconcileClosures: (input: {
    workspaceRoot: string;
    store: WorkflowStateStore;
    instanceId?: ReconcileWorkflowInput["repositoryInstanceId"];
    providerObserver?: ReconciliationDependencies["pullRequestObserver"];
  }) => Promise<ReconcileNawabariClosuresResult>;
}

export interface CollectWorkflowDoctorReportOptions {
  workspaceRoot: string;
  store: WorkflowStateStore;
  repositoryInstanceId?: ReconcileWorkflowInput["repositoryInstanceId"];
  dependencies?: Partial<WorkflowDoctorDependencies>;
  reconciliation?: ReconciliationDependencies;
}

function defaultDependencies(): WorkflowDoctorDependencies {
  const nawabari = new NawabariExecutionClient();
  return {
    reconcile: reconcileWorkflow,
    inspectNawabari: (workspaceRoot) => nawabari.doctor(workspaceRoot),
    reconcileClosures: (input) => reconcileNawabariClosures({ ...input, client: nawabari }),
  };
}

export async function collectWorkflowDoctorReport(
  options: CollectWorkflowDoctorReportOptions,
): Promise<WorkflowDoctorReport> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  let reconciliation = await dependencies.reconcile({
    workspaceRoot: options.workspaceRoot,
    store: options.store,
    repositoryInstanceId: options.repositoryInstanceId,
    dependencies: options.reconciliation,
  });
  const resolvedIdentity = resolveRepositoryIdentity(options.workspaceRoot);
  const closeReconciliation = resolvedIdentity.ok
    ? await dependencies.reconcileClosures({
        workspaceRoot: options.workspaceRoot,
        store: options.store,
        instanceId: options.repositoryInstanceId ?? resolvedIdentity.identity.instanceId,
        providerObserver: options.reconciliation?.pullRequestObserver,
      })
    : undefined;
  if (closeReconciliation !== undefined && closeReconciliation.attempted > 0)
    reconciliation = await dependencies.reconcile({
      workspaceRoot: options.workspaceRoot,
      store: options.store,
      repositoryInstanceId: options.repositoryInstanceId,
      dependencies: options.reconciliation,
    });
  let nawabariCheck: WorkflowDoctorCheck;
  let nawabariProblem: WorkflowDoctorProblem | undefined;
  try {
    const observed = await dependencies.inspectNawabari(options.workspaceRoot);
    if (observed.ok) {
      nawabariCheck = {
        name: "nawabari-execution-authority",
        status: "pass",
        message: "compatible Nawabari execution authority reports a clean local boundary",
      };
    } else {
      const code = typeof observed.code === "string" ? observed.code : "DOCTOR_FAILED";
      const message = typeof observed.message === "string" ? observed.message : "Nawabari doctor reported a problem";
      nawabariCheck = { name: "nawabari-execution-authority", status: "error", message: `${code}: ${message}` };
      nawabariProblem = { severity: "error", code: `nawabari:${code}`, message };
    }
  } catch (error) {
    const code = error instanceof NawabariExecutionError ? error.code : "nawabari-command-failed";
    const message = error instanceof Error ? error.message : String(error);
    nawabariCheck = { name: "nawabari-execution-authority", status: "error", message };
    nawabariProblem = { severity: "error", code, message };
  }
  const providerObservationStatus: WorkflowDoctorCheckStatus = reconciliation.diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  )
    ? "error"
    : reconciliation.diagnostics.length > 0
      ? "warning"
      : "pass";
  const unresolvedLegacyTasks = options.store
    .listTasks(options.repositoryInstanceId)
    .filter((task) => task.nawabariSessionId === undefined && task.lifecycleState !== "cleaned");
  const legacyCheck: WorkflowDoctorCheck =
    unresolvedLegacyTasks.length === 0
      ? {
          name: "legacy-execution-state",
          status: "pass",
          message: "no unresolved task relies on Mottainai's retired local execution authority",
        }
      : {
          name: "legacy-execution-state",
          status: "error",
          message: `${unresolvedLegacyTasks.length} pre-cutover task(s) require explicit resolution before managed mutation`,
        };
  const checks: WorkflowDoctorCheck[] = [
    nawabariCheck,
    legacyCheck,
    {
      name: "reconciliation",
      status: reconciliation.ok ? "pass" : "error",
      message: reconciliation.ok
        ? "workflow state matches observed Git/provider state"
        : reconciliation.divergences.length > 0
          ? `${reconciliation.divergences.length} workflow divergence(s) detected`
          : "workflow reconciliation failed during observation",
    },
    {
      name: "repair-mode",
      status: "pass",
      message: `read-only; ${reconciliation.repairPlan.length} informational proposal(s), but physical repair is retired and delegated to Nawabari`,
    },
    {
      name: "provider-observation",
      status: providerObservationStatus,
      message:
        reconciliation.diagnostics.length === 0
          ? "bounded provider/Git observations completed"
          : `${reconciliation.diagnostics.length} observation diagnostic(s) reported`,
    },
  ];
  const problems: WorkflowDoctorProblem[] = [
    ...(nawabariProblem === undefined ? [] : [nawabariProblem]),
    ...unresolvedLegacyTasks.map((task) => ({
      severity: "error" as const,
      code: "legacy-task-resolution-required",
      message: `task ${task.taskId} (${task.lifecycleState}) has no Nawabari session reference`,
    })),
    ...reconciliation.divergences.map((divergence) => ({
      severity: divergence.severity,
      code: divergence.kind,
      message: divergence.detail,
    })),
    ...reconciliation.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.detail,
    })),
    ...(closeReconciliation === undefined
      ? []
      : closeReconciliation.blocked.map((blocked) => ({
          severity: "error" as const,
          code: "nawabari-cleanup-blocked",
          message: blocked.detail,
        }))),
  ];
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.length - errors;
  return {
    schemaVersion: WORKFLOW_DOCTOR_SCHEMA_VERSION,
    mode: "read-only",
    ok: errors === 0,
    errors,
    warnings,
    checked: checks.length,
    checks,
    problems,
    reconciliation,
  };
}

/** workflow domain専用doctor。`src/commands/doctor.ts` のDoctorReportは変更しない。 */
export const collectDoctorReport = collectWorkflowDoctorReport;

export function formatWorkflowDoctorHuman(report: WorkflowDoctorReport): string {
  const symbol: Record<WorkflowDoctorCheckStatus, string> = { pass: "✓", warning: "⚠", error: "✗" };
  const lines = [
    `Workflow doctor: ${report.ok ? "ok" : "problems detected"}`,
    `Mode: ${report.mode}`,
    ...report.checks.map((check) => `${symbol[check.status]} ${check.name}: ${check.message}`),
  ];
  lines.push(
    "Physical worktree, lease, and cleanup repair is delegated to Nawabari; reconciliation performs no repairs.",
  );
  return lines.join("\n");
}

export const formatDoctorHuman = formatWorkflowDoctorHuman;
