import {
  reconcileWorkflow,
  type ReconcileWorkflowInput,
  type ReconciliationDependencies,
  type ReconciliationReport,
} from "./reconcile.js";
import type { WorkflowStateStore } from "../state/store.js";

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
}

export interface CollectWorkflowDoctorReportOptions {
  workspaceRoot: string;
  store: WorkflowStateStore;
  repositoryInstanceId?: ReconcileWorkflowInput["repositoryInstanceId"];
  dependencies?: Partial<WorkflowDoctorDependencies>;
  reconciliation?: ReconciliationDependencies;
}

function defaultDependencies(): WorkflowDoctorDependencies {
  return { reconcile: reconcileWorkflow };
}

export async function collectWorkflowDoctorReport(
  options: CollectWorkflowDoctorReportOptions,
): Promise<WorkflowDoctorReport> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  const reconciliation = await dependencies.reconcile({
    workspaceRoot: options.workspaceRoot,
    store: options.store,
    repositoryInstanceId: options.repositoryInstanceId,
    dependencies: options.reconciliation,
  });
  const checks: WorkflowDoctorCheck[] = [
    {
      name: "reconciliation",
      status: reconciliation.divergences.length === 0 ? "pass" : "error",
      message:
        reconciliation.divergences.length === 0
          ? "workflow state matches observed Git/provider state"
          : `${reconciliation.divergences.length} workflow divergence(s) detected`,
    },
    {
      name: "repair-mode",
      status: "pass",
      message: `read-only by default; ${reconciliation.repairPlan.length} explicit repair action(s) proposed`,
    },
    {
      name: "provider-observation",
      status: reconciliation.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "pass",
      message:
        reconciliation.diagnostics.length === 0
          ? "bounded provider/Git observations completed"
          : `${reconciliation.diagnostics.length} observation diagnostic(s) reported`,
    },
  ];
  const problems: WorkflowDoctorProblem[] = [
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
  if (report.reconciliation.repairPlan.length > 0)
    lines.push("Repairs require explicit confirmation; no filesystem deletion is performed by reconciliation.");
  return lines.join("\n");
}

export const formatDoctorHuman = formatWorkflowDoctorHuman;
