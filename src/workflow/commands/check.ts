import type { ArtifactStore } from "../../retrieve.js";
import {
  assessManagedChecks,
  runManagedCheck,
  type CheckReceipt,
  type ManagedCheckContext,
  type ValidationReceipt,
} from "../validation/governor.js";
import { DEFAULT_MANAGED_CHECKS, findManagedCheck, type ManagedCheckDefinition } from "../validation/registry.js";
import {
  resolveWorkflowTask,
  type WorkflowTaskSelector,
  type WorkflowWriteFailure,
  type WorkflowWriteResult,
} from "./write.js";

export interface WorkflowCheckDependencies {
  artifactStore: ArtifactStore;
  /** Repository-specific overrides of the managed check registry. Defaults to `DEFAULT_MANAGED_CHECKS`. */
  checks?: readonly ManagedCheckDefinition[];
}

function failure(reason: string, detail: string): WorkflowWriteFailure {
  return { ok: false, reason, detail };
}

async function resolveContext(
  input: WorkflowTaskSelector,
  dependencies: WorkflowCheckDependencies,
): Promise<WorkflowWriteResult<{ context: ManagedCheckContext }>> {
  const selected = await resolveWorkflowTask(input);
  if (!selected.ok) return selected;
  return {
    ok: true,
    context: {
      workspaceRoot: input.workspaceRoot,
      store: input.store,
      artifactStore: dependencies.artifactStore,
      instanceId: selected.instanceId,
      worktreeId: selected.worktreeId,
    },
  };
}

function resolveChecks(dependencies: WorkflowCheckDependencies): readonly ManagedCheckDefinition[] {
  return dependencies.checks ?? DEFAULT_MANAGED_CHECKS;
}

export interface RunWorkflowCheckInput extends WorkflowTaskSelector {
  checkId: string;
  force?: boolean;
}

/** Execute-or-reuse a single managed check for the current (or explicit) workflow task. */
export async function runWorkflowCheck(
  input: RunWorkflowCheckInput,
  dependencies: WorkflowCheckDependencies,
): Promise<WorkflowWriteResult<{ receipt: CheckReceipt }>> {
  const check = findManagedCheck(resolveChecks(dependencies), input.checkId);
  if (check === undefined) return failure("unknown-check", `no managed check is registered with id ${input.checkId}`);
  const resolved = await resolveContext(input, dependencies);
  if (!resolved.ok) return resolved;
  const receipt = await runManagedCheck(resolved.context, check, { force: input.force });
  return { ok: true, receipt };
}

export interface WorkflowValidationReceiptInput extends WorkflowTaskSelector {
  checkIds?: readonly string[];
}

/** Read-only aggregate status across managed checks; never spawns a process. */
export async function getWorkflowValidationReceipt(
  input: WorkflowValidationReceiptInput,
  dependencies: WorkflowCheckDependencies,
): Promise<WorkflowWriteResult<{ receipt: ValidationReceipt }>> {
  const registry = resolveChecks(dependencies);
  const checks =
    input.checkIds === undefined
      ? registry
      : input.checkIds.map((checkId) => findManagedCheck(registry, checkId)).filter((check): check is ManagedCheckDefinition => check !== undefined);
  if (input.checkIds !== undefined && checks.length !== input.checkIds.length) {
    const known = new Set(checks.map((check) => check.id));
    const unknown = input.checkIds.filter((checkId) => !known.has(checkId));
    return failure("unknown-check", `no managed check is registered with id: ${unknown.join(", ")}`);
  }
  const resolved = await resolveContext(input, dependencies);
  if (!resolved.ok) return resolved;
  const receipt = await assessManagedChecks(resolved.context, checks);
  return { ok: true, receipt };
}
