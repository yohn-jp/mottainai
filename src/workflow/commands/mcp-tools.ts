import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedGatewayConfig } from "../../config.js";
import { GhInariClient } from "../../gh-inari.js";
import { OUTPUT_SCHEMA, output } from "../../envelope.js";
import { InMemoryArtifactStore, type ArtifactStore } from "../../retrieve.js";
import { collectWorkflowDoctorReport } from "./doctor.js";
import {
  getTaskStatus,
  getTaskStatusById,
  getTaskStatusForWorkspace,
  listTaskDiscoverySnapshot,
} from "../domain/task.js";
import { migrateLegacyWorkflowTask, type LegacyMigrationMode } from "../domain/legacy-migration.js";
import { startNawabariTask } from "../domain/nawabari-task.js";
import { NawabariExecutionClient } from "../nawabari.js";
import { createSemanticExecutionPlan, type CreateSemanticExecutionPlanInput } from "../../semantics/execution-plan.js";
import { getWorkflowValidationReceipt, runWorkflowCheck } from "./check.js";
import { DEFAULT_MANAGED_CHECKS } from "../validation/registry.js";
import {
  abandonWorkflowTask,
  cleanupWorkflowTask,
  commitWorkflowTask,
  finishWorkflowTask,
  openWorkflowTaskPullRequest,
  pushWorkflowTask,
} from "./write.js";
import type { CleanupPlan } from "../domain/cleanup-plan.js";
import type { StructuredCommitMessage } from "../git/commit.js";
import { bundledGovernedBranchTypes } from "../governance/branch.js";
import { explainWorkflowPolicy } from "../policy/explain.js";
import { resolveEffectiveWorkflowPolicy } from "../policy/load.js";
import type { TaskId, WorkflowStateStore } from "../state/store.js";
import { validateIssueRef, validateTaskSlug } from "./validate.js";

/**
 * Read-oriented exposure of the Git workflow engine (Issue #39, extending Issue #34).
 * `mottainai_workflow_policy_explain` / `mottainai_workflow_task_start` /
 * `mottainai_workflow_task_status` / `mottainai_workflow_doctor` — following the same
 * `Tool[]` + dispatch-function
 * pattern as `src/local-tools.ts`, but kept in their own module since this family has
 * its own gating (`config.workflowTasks`) and its own state dependency
 * (`WorkflowStateStore`) that the rest of `src/local-tools.ts` doesn't need.
 *
 * Write operations remain thin adapters: policy, repository identity, Git safety,
 * lifecycle transitions, provider state, and cleanup leases are owned by the
 * workflow domain services they call.
 */

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const taskCommitTool: Tool = {
  name: "mottainai_workflow_task_commit",
  description:
    "Commit the current managed workflow task after repository, worktree, branch, and protected-branch checks. Supports a side-effect-free dry run.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      message: { type: "object" },
      includePaths: { type: "array", items: { type: "string" } },
      dryRun: { type: "boolean" },
    },
    required: ["message"],
    additionalProperties: false,
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: destructive,
};

const taskPushTool: Tool = {
  name: "mottainai_workflow_task_push",
  description:
    "Push a committed managed workflow task after remote, worktree, branch, validation, and protected-branch checks. Supports a side-effect-free dry run.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      remote: { type: "string" },
      remoteBranch: { type: "string" },
      force: { type: "boolean" },
      createUpstream: { type: "boolean" },
      allowRemoteBehind: { type: "boolean" },
      allowDiverged: { type: "boolean" },
      dryRun: { type: "boolean" },
    },
    additionalProperties: false,
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: destructive,
};

const taskOpenPrTool: Tool = {
  name: "mottainai_workflow_task_open_pr",
  description:
    "Create or reuse the managed task pull request through the GitHub provider after repository, worktree, branch, and lifecycle checks. Supports a side-effect-free dry run.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      title: { type: "string", minLength: 1 },
      repository: { type: "string" },
      issueReference: { type: "string" },
      sections: { type: "object", additionalProperties: true },
      acceptanceCriteria: { type: "array", items: { type: "string" } },
      providerDraft: { type: "boolean" },
      dryRun: { type: "boolean" },
    },
    required: ["title"],
    additionalProperties: false,
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: { ...destructive, idempotentHint: true },
};

const taskFinishTool: Tool = {
  name: "mottainai_workflow_task_finish",
  description:
    "Finish a managed workflow task by applying the existing lifecycle transition to merged after identity, worktree, branch, and policy checks. Supports a dry run.",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string" }, dryRun: { type: "boolean" } },
    additionalProperties: false,
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: { ...destructive, idempotentHint: true },
};

const taskAbandonTool: Tool = {
  name: "mottainai_workflow_task_abandon",
  description:
    "Abandon a managed workflow task through the existing lifecycle transition after identity, worktree, branch, and policy checks. Supports a dry run.",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string" }, dryRun: { type: "boolean" } },
    additionalProperties: false,
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: { ...destructive, idempotentHint: true },
};

const taskCleanupTool: Tool = {
  name: "mottainai_workflow_task_cleanup",
  description:
    "Plan and execute safe managed task cleanup using fresh identity, provider, activity, lease, and policy checks. Dry run returns the serializable plan without mutation; idempotencyKey can resume the same cleanup operation.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      dryRun: { type: "boolean" },
      idempotencyKey: { type: "string" },
      plan: { type: "object" },
    },
    additionalProperties: false,
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: { ...destructive, idempotentHint: true },
};

const taskLegacyMigrationTool: Tool = {
  name: "mottainai_workflow_task_migrate_legacy",
  description:
    "Complete or explicitly adopt one pre-cutover task. Complete can abandon an active task after independently observing absence of legacy physical state; terminal tasks continue to migrate to cleaned. Adopt requires an explicitly named Nawabari session whose repository, worktree, branch, active state, and ownership identity all match. Ambiguous state fails closed and no legacy physical row is mutated.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["complete", "adopt"] },
      sessionId: { type: "string", minLength: 1 },
      dryRun: { type: "boolean" },
    },
    required: ["taskId", "mode"],
    additionalProperties: false,
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: { ...destructive, idempotentHint: true },
};

const policyExplainTool: Tool = {
  name: "mottainai_workflow_policy_explain",
  description:
    "Explain the effective Git workflow policy for this workspace: for each protected-branch/worktree/cleanup rule, the resolved mode, which authority (preset vs. repository) set it, and whether it can still be weakened. Side-effect free.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
};

/** `branchType` の enum は Mottainai 自身の bundled governance-rules.json を読んで導出する
 * （`bundledGovernedBranchTypes`）ため、この tool 定義の構築自体を import 時ではなく初回
 * 参照時まで遅延させる（`architecture-check` の import-time-side-effect rule）。 */
function buildTaskStartTool(): Tool {
  return {
    name: "mottainai_workflow_task_start",
    description:
      "Start a semantic/task orchestration record and delegate the local session, worktree, branch, and claims to the installed Nawabari standalone-execution.v1 companion.",
    inputSchema: {
      type: "object",
      properties: {
        taskSlug: { type: "string", minLength: 1, pattern: "^[a-z0-9][a-z0-9-]*$" },
        // 対象 repository が `.mottainai/governance-rules.json` で独自の type 集合を宣言する場合は、
        // この enum より広い/狭い可能性がある — 実際の許可判定は `startTask` 内の
        // `validateBranchNameAgainstGovernance` が repository 固有の override を尊重して行う
        // 唯一の authority であり続ける。
        branchType: { type: "string", enum: [...bundledGovernedBranchTypes()] },
        issueRef: {
          type: "string",
          minLength: 1,
          pattern: "^[A-Za-z0-9](?!.*\\.\\.)(?!.*\\.lock$)(?!.*\\.$)[A-Za-z0-9._-]*$",
        },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
        dryRun: { type: "boolean" },
        semanticPlan: {
          type: "object",
          properties: {
            semanticTargets: { type: "array", items: { type: "object" } },
            explicitPaths: { type: "array", items: { type: "string" } },
            claims: { type: "array", items: { type: "object" } },
            verification: { type: "object" },
            strict: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["taskSlug", "branchType", "issueRef"],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    // openWorldHint: true — policy.worktree.bootstrapMode: "automatic" runs
    // `pnpm install --frozen-lockfile` in the new worktree, which can reach package registries.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  };
}

const taskStatusTool: Tool = {
  name: "mottainai_workflow_task_status",
  description:
    "Report a Git workflow task: task id, lifecycle state, repository/worktree identity, branch, and guardrail warnings. Side-effect free. With no arguments, reports the active task (if any) for the current worktree (cwd-scoped, unchanged). With taskId, this is the AUTHORITATIVE fresh availability + worktree resolve step: it re-verifies the task right now and fails deterministically — never falling back to another task or to the current worktree — if the task is missing, terminal, or its execution session/worktree has drifted since it was last seen in mottainai_workflow_task_list. Callers MUST call this with taskId immediately before acting on any task id obtained from mottainai_workflow_task_list; that list is a discovery snapshot, not proof the task is still available.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        minLength: 1,
        description:
          "Resolve this task id instead of the current worktree's task. Always call this immediately before acting on a task id returned by mottainai_workflow_task_list — that tool's output can be stale by the time you act on it.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
};

const taskListTool: Tool = {
  name: "mottainai_workflow_task_list",
  description:
    "Enumerate candidate managed tasks across every repository this Mottainai install currently tracks in local state, not scoped to the caller's cwd (Issue #539). This is a discovery snapshot, not a live availability guarantee: each entry's lifecycleState is the last state persisted to Mottainai's store as of generatedAt, not a confirmation that the task is selectable or executable right now. A task can close, get abandoned, or lose its session/worktree between this call and any later action — that is a normal race, never a consistency failure. Before acting on any taskId from this list (starting work in it, resolving its worktree, etc.), callers MUST call mottainai_workflow_task_status with that taskId, which is the authoritative fresh resolve step and fails closed (no fallback to another task) if the task is no longer available. Side-effect free, bounded, deterministic, with an explicit schemaVersion. Excludes terminal/ownership-unresolved tasks (merged, abandoned, orphaned, cleaned) from the default view — exclusion narrows the candidate set but does not make the remainder authoritative. Never includes an absolute repository/worktree path, credential, or raw process/registry state; repository identity is the opaque, stable repository instance id.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
};

/** `DEFAULT_MANAGED_CHECKS` から enum を導出するため、`buildTaskStartTool` と同様に
 * import 時ではなく初回参照時まで構築を遅らせる（architecture-check の import-time-side-effect rule）。 */
function buildCheckRunTool(): Tool {
  return {
    name: "mottainai_workflow_check_run",
    description:
      "Execute a managed validation check (issue #184 governor) for the current task, or reuse a prior passing execution when the repository state and check configuration match exactly. Returns a compact receipt; successful stdout/stderr is not streamed by default (see result_id). force=true bypasses reuse.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        checkId: { type: "string", minLength: 1, enum: DEFAULT_MANAGED_CHECKS.map((check) => check.id) },
        force: { type: "boolean" },
      },
      required: ["checkId"],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

const validationReceiptTool: Tool = {
  name: "mottainai_workflow_validation_receipt",
  description:
    "Read-only aggregate validation status for the current task's managed checks: never spawns a process. Reports each check as reused-pass/stale/not-required against currently persisted governor evidence, so an agent can know whether required checks are already satisfied before rerunning them.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      checkIds: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
};

const workflowDoctorTool: Tool = {
  name: "mottainai_workflow_doctor",
  description:
    'Run the workflow reconciliation doctor and return the same structured report used by the workflow doctor CLI. By default this is strictly read-only: no task/provider state mutation, no filesystem deletion, and no Nawabari session close is performed. Pass reconcileClosures: true to additionally request Nawabari\'s normal safe-close for the caller\'s own prior merged executions; the report includes bounded per-task closure results with reasons for unreconciled tasks (report.mode becomes "reconcile" instead of "read-only"). Mottainai never edits Nawabari registry/claim state directly.',
  inputSchema: {
    type: "object",
    properties: {
      reconcileClosures: {
        type: "boolean",
        description:
          "Explicit opt-in. When true, also performs bounded Nawabari close reconciliation instead of pure read-only observation.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: OUTPUT_SCHEMA,
  // Not `readOnly`: `reconcileClosures: true` is a real, if idempotent and
  // non-destructive, mutating path (task/provider state, Nawabari session close).
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

let cachedWorkflowCommandTools: Tool[] | undefined;

/** 初回呼び出し時に一度だけ構築し、以降はキャッシュを返す（`buildTaskStartTool` 参照）。 */
export function workflowCommandTools(): Tool[] {
  cachedWorkflowCommandTools ??= [
    policyExplainTool,
    buildTaskStartTool(),
    taskStatusTool,
    taskListTool,
    workflowDoctorTool,
    taskCommitTool,
    taskPushTool,
    taskOpenPrTool,
    taskFinishTool,
    taskAbandonTool,
    taskCleanupTool,
    taskLegacyMigrationTool,
    buildCheckRunTool(),
    validationReceiptTool,
  ];
  return cachedWorkflowCommandTools;
}

function legacyMigrationResult(result: Awaited<ReturnType<typeof migrateLegacyWorkflowTask>>): CallToolResult {
  if (result.ok)
    return output(
      "workflow_task_migrate_legacy",
      "success",
      `OK workflow_task_migrate_legacy mode=${result.mode}${result.dryRun === true ? " (dry-run)" : ""}`,
      "",
      result,
    );
  return output(
    "workflow_task_migrate_legacy",
    "failed",
    `FAIL workflow_task_migrate_legacy (${result.reason}): ${result.detail}`,
    "",
    { ...result, diagnostics: [{ severity: "error", message: result.detail }] },
    true,
  );
}

async function legacyMigrationToolImpl(
  args: Args,
  config: ResolvedGatewayConfig,
  store: WorkflowStateStore,
): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
  const mode = stringArg(args, "mode", true);
  if (mode !== "complete" && mode !== "adopt") throw new Error("mode must be complete or adopt");
  return legacyMigrationResult(
    await migrateLegacyWorkflowTask({
      workspaceRoot: config.workspaceRoot,
      store,
      taskId: stringArg(args, "taskId", true)! as never,
      mode: mode as LegacyMigrationMode,
      sessionId: stringArg(args, "sessionId"),
      nawabari: new NawabariExecutionClient(),
      dryRun: boolArg(args, "dryRun"),
    }),
  );
}

/** `config.workflowTasks` 未設定のワークスペースではこのファミリー全体を公開しない
 * （worktree 作成等の副作用を持つため既定非公開）。 */
export function workflowCommandToolsFor(config: ResolvedGatewayConfig): Tool[] {
  return config.workflowTasks ? workflowCommandTools() : [];
}

export function isWorkflowCommandTool(name: string): boolean {
  return workflowCommandTools().some((tool) => tool.name === name);
}

type Args = Record<string, unknown> | undefined;

function value(args: Args, key: string): unknown {
  return args?.[key];
}
function stringArg(args: Args, key: string, required = false): string | undefined {
  const candidate = value(args, key);
  if (candidate === undefined && !required) return undefined;
  if (typeof candidate !== "string" || (required && candidate.length === 0))
    throw new Error(`${key} must be a non-empty string`);
  return candidate;
}

function boolArg(args: Args, key: string): boolean | undefined {
  const candidate = value(args, key);
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "boolean") throw new Error(`${key} must be a boolean`);
  return candidate;
}

function stringArrayArg(args: Args, key: string): string[] | undefined {
  const candidate = value(args, key);
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string"))
    throw new Error(`${key} must be an array of strings`);
  return [...candidate] as string[];
}

function semanticPlanArg(args: Args): CreateSemanticExecutionPlanInput | undefined {
  const raw = value(args, "semanticPlan");
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("semanticPlan must be an object");
  const plan = raw as Record<string, unknown>;
  const strings = (candidate: unknown, field: string): string[] | undefined => {
    if (candidate === undefined) return undefined;
    if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string"))
      throw new Error(`${field} must be an array of strings`);
    return candidate;
  };
  const claims = plan.claims;
  if (
    claims !== undefined &&
    (!Array.isArray(claims) ||
      claims.some((claim) => {
        if (typeof claim !== "object" || claim === null || Array.isArray(claim)) return true;
        const item = claim as Record<string, unknown>;
        return typeof item.resource !== "string" || !["read", "write", "exclusive-write"].includes(String(item.mode));
      }))
  )
    throw new Error("semanticPlan.claims must contain resource/mode declarations");
  const semanticTargets = plan.semanticTargets;
  if (
    semanticTargets !== undefined &&
    (!Array.isArray(semanticTargets) ||
      semanticTargets.some((target) => {
        if (typeof target !== "object" || target === null || Array.isArray(target)) return true;
        const item = target as Record<string, unknown>;
        return (
          !["symbol", "component", "path"].includes(String(item.kind)) ||
          typeof item.id !== "string" ||
          (item.paths !== undefined &&
            (!Array.isArray(item.paths) || item.paths.some((path) => typeof path !== "string")))
        );
      }))
  )
    throw new Error("semanticPlan.semanticTargets is invalid");
  const verification = plan.verification;
  if (
    verification !== undefined &&
    (typeof verification !== "object" || verification === null || Array.isArray(verification))
  )
    throw new Error("semanticPlan.verification must be an object");
  const verificationObject = verification as Record<string, unknown> | undefined;
  if (verificationObject?.rationale !== undefined && typeof verificationObject.rationale !== "string")
    throw new Error("semanticPlan.verification.rationale must be a string");
  if (plan.strict !== undefined && typeof plan.strict !== "boolean")
    throw new Error("semanticPlan.strict must be a boolean");
  return {
    semanticTargets: semanticTargets as CreateSemanticExecutionPlanInput["semanticTargets"],
    explicitPaths: strings(plan.explicitPaths, "semanticPlan.explicitPaths"),
    claims: claims as CreateSemanticExecutionPlanInput["claims"],
    verification:
      verificationObject === undefined
        ? undefined
        : {
            requiredChecks: strings(verificationObject.requiredChecks, "semanticPlan.verification.requiredChecks"),
            rationale: verificationObject.rationale as string | undefined,
          },
    strict: plan.strict as boolean | undefined,
  };
}

function requireWorkflowTasksConfigured(config: ResolvedGatewayConfig): void {
  if (!config.workflowTasks) throw new Error("workflow command tools are not configured for this workspace");
}

function policyExplainToolImpl(config: ResolvedGatewayConfig): CallToolResult {
  requireWorkflowTasksConfigured(config);
  const result = explainWorkflowPolicy(config.workspaceRoot);
  if (!result.ok) {
    const summary = `FAIL policy_explain: invalid workflow policy (${result.reason})`;
    return output(
      "workflow_policy_explain",
      "failed",
      summary,
      "",
      { diagnostics: [{ severity: "error", message: result.reason }] },
      true,
    );
  }
  const summary = `OK preset=${result.explained.preset ?? "(none)"} authority=${result.explained.policySourceAuthority}`;
  return output("workflow_policy_explain", "success", summary, "", {
    policySourceAuthority: result.explained.policySourceAuthority,
    policyFilePath: result.explained.policyFilePath,
    preset: result.explained.preset,
    descriptive: result.explained.descriptive,
    rules: result.explained.rules,
    resolvedPolicy: result.explained.resolvedPolicy,
    effectivePolicy: result.explained.effectivePolicy,
  });
}

async function taskStartToolImpl(
  args: Args,
  config: ResolvedGatewayConfig,
  store: WorkflowStateStore,
): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
  const taskSlug = stringArg(args, "taskSlug", true)!;
  validateTaskSlug(taskSlug);
  const branchType = stringArg(args, "branchType", true)!;
  const issueRef = stringArg(args, "issueRef", true)!;
  validateIssueRef(issueRef);

  const policyResult = resolveEffectiveWorkflowPolicy(config.workspaceRoot);
  if (!policyResult.ok) {
    const summary = `FAIL task_start: invalid workflow policy (${policyResult.reason})`;
    return output(
      "workflow_task_start",
      "failed",
      summary,
      "",
      { reason: "invalid-policy", diagnostics: [{ severity: "error", message: policyResult.reason }] },
      true,
    );
  }

  const result = await startNawabariTask({
    workspaceRoot: config.workspaceRoot,
    store,
    policy: policyResult.document,
    taskSlug,
    branchType,
    issueRef,
    idempotencyKey: stringArg(args, "idempotencyKey"),
    dryRun: boolArg(args, "dryRun") === true,
    semanticPlan: (() => {
      const input = semanticPlanArg(args);
      return input === undefined ? undefined : createSemanticExecutionPlan(input);
    })(),
    nawabari: new NawabariExecutionClient(),
  });
  if (!result.ok) {
    const summary = `FAIL task_start (${result.reason}): ${result.detail}`;
    return output(
      "workflow_task_start",
      "failed",
      summary,
      "",
      { reason: result.reason, diagnostics: [{ severity: "error", message: result.detail }] },
      true,
    );
  }

  if (result.dryRun === true)
    return output("workflow_task_start", "success", "OK workflow_task_start (dry-run)", "", {
      dryRun: true,
      plan: result.plan,
      semanticExecutionPlan: result.semanticPlan,
      warnings: result.warnings,
    });

  const summary = `OK task=${result.task.taskId} state=${result.task.lifecycleState} branch=${result.execution.branch} session=${result.execution.sessionId}`;
  const status = getTaskStatus(store, result.task.taskId);
  return output("workflow_task_start", "success", summary, "", {
    task: result.task,
    execution: result.execution,
    // Compatibility projection for clients that only need a launch directory.
    // It is not persisted ownership state; Nawabari remains authoritative.
    worktree: { canonicalPath: result.execution.worktree, branchName: result.execution.branch },
    semanticExecutionPlan: result.semanticPlan,
    warnings: result.warnings,
    pullRequests: status?.pullRequests ?? [],
    currentState: status?.currentState ?? result.task.lifecycleState,
    allowedNextTransitions: status?.allowedNextTransitions ?? [],
    invalidTransitions: status?.invalidTransitions ?? [],
  });
}

function taskStatusByIdResult(result: Awaited<ReturnType<typeof getTaskStatusById>>): CallToolResult {
  if (!result.ok) {
    return output(
      "workflow_task_status",
      "failed",
      `FAIL task_status: ${result.reason}`,
      "",
      { diagnostics: [{ severity: "error", message: result.reason }] },
      true,
    );
  }
  const summary = `OK task=${result.task.taskId} state=${result.task.lifecycleState} branch=${result.branch ?? "(detached)"}`;
  return output("workflow_task_status", "success", summary, "", {
    active: true,
    task: result.task,
    worktreePath: result.worktreePath,
    branch: result.branch,
    pullRequests: result.pullRequests,
    currentState: result.currentState,
    allowedNextTransitions: result.allowedNextTransitions,
    invalidTransitions: result.invalidTransitions,
  });
}

async function taskStatusToolImpl(
  args: Args,
  config: ResolvedGatewayConfig,
  store: WorkflowStateStore,
): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
  const explicitTaskId = stringArg(args, "taskId");
  if (explicitTaskId !== undefined) {
    // taskId だけを鍵にした cwd 非依存の fresh 解決（Issue #539）。以下の cwd スコープ
    // 経路（引数なし呼び出し）とは独立し、その挙動には一切触れない。
    return taskStatusByIdResult(
      await getTaskStatusById(store, explicitTaskId as TaskId, new NawabariExecutionClient()),
    );
  }
  const nawabari = new NawabariExecutionClient();
  let sessionId: string | undefined;
  try {
    sessionId = await nawabari.currentSessionId(config.workspaceRoot);
  } catch {
    // A primary checkout or a legacy worktree has no current Nawabari session;
    // retain the read-only Mottainai projection below.
  }
  if (sessionId !== undefined) {
    const task = store.listTasks().find((candidate) => candidate.nawabariSessionId === sessionId);
    if (task !== undefined) {
      try {
        const session = await nawabari.showSession({ cwd: config.workspaceRoot, sessionId });
        const status = getTaskStatus(store, task.taskId);
        return output(
          "workflow_task_status",
          "success",
          `OK task=${task.taskId} state=${task.lifecycleState} branch=${session.branch}`,
          "",
          {
            active: true,
            repository: {
              instanceId: task.instanceId,
              worktreePath: session.worktree,
              branch: session.branch,
              repoStateKind: "nawabari-managed",
            },
            task,
            execution: {
              sessionId: session.sessionId,
              worktree: session.worktree,
              branch: session.branch,
              state: session.state,
            },
            pullRequests: status?.pullRequests ?? [],
            currentState: status?.currentState ?? task.lifecycleState,
            allowedNextTransitions: status?.allowedNextTransitions ?? [],
            invalidTransitions: status?.invalidTransitions ?? [],
            warnings: [],
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return output(
          "workflow_task_status",
          "failed",
          `FAIL task_status: ${message}`,
          "",
          { diagnostics: [{ severity: "error", message }] },
          true,
        );
      }
    }
  }
  const result = await getTaskStatusForWorkspace(config.workspaceRoot, store);
  if (!result.ok) {
    const summary = `FAIL task_status: ${result.reason}`;
    return output(
      "workflow_task_status",
      "failed",
      summary,
      "",
      { diagnostics: [{ severity: "error", message: result.reason }] },
      true,
    );
  }

  const repository = {
    instanceId: result.instanceId,
    worktreePath: result.worktreePath,
    branch: result.branch,
    repoStateKind: result.repoStateKind,
  };
  if (!result.active) {
    const summary = `OK no active task at ${result.worktreePath}`;
    return output("workflow_task_status", "success", summary, "", {
      active: false,
      repository,
      warnings: result.warnings,
    });
  }

  const summary = `OK task=${result.status.task.taskId} state=${result.status.task.lifecycleState} branch=${result.branch ?? "(detached)"}`;
  return output("workflow_task_status", "success", summary, "", {
    active: true,
    repository,
    task: result.status.task,
    worktrees: result.status.worktrees,
    pullRequests: result.status.pullRequests,
    currentState: result.status.currentState,
    allowedNextTransitions: result.status.allowedNextTransitions,
    invalidTransitions: result.status.invalidTransitions,
    warnings: result.warnings,
  });
}

function taskListToolImpl(config: ResolvedGatewayConfig, store: WorkflowStateStore): CallToolResult {
  requireWorkflowTasksConfigured(config);
  const result = listTaskDiscoverySnapshot(store);
  // "candidates", not "tasks": this summary must not read as a confirmed-available
  // count — see mottainai_workflow_task_list's description for the freshness contract.
  const summary = `OK task_list candidates=${result.tasks.length} (discovery snapshot; re-resolve each with task_status before acting)`;
  return output("workflow_task_list", "success", summary, "", { ...result });
}

async function workflowDoctorToolImpl(
  args: Args,
  config: ResolvedGatewayConfig,
  store: WorkflowStateStore,
): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
  const report = await collectWorkflowDoctorReport({
    workspaceRoot: config.workspaceRoot,
    store,
    reconcileClosures: boolArg(args, "reconcileClosures") === true,
  });
  const summary = report.ok
    ? `OK workflow doctor checks=${report.checked} warnings=${report.warnings}`
    : `FAIL workflow doctor errors=${report.errors} warnings=${report.warnings}`;
  return output(
    "workflow_doctor",
    report.ok ? "success" : "failed",
    summary,
    "",
    {
      ...report,
      diagnostics: report.problems,
    },
    !report.ok,
  );
}

function checkReceiptResult(operation: string, result: Awaited<ReturnType<typeof runWorkflowCheck>>): CallToolResult {
  if (!result.ok) {
    return output(
      operation,
      "failed",
      `FAIL ${operation} (${result.reason}): ${result.detail}`,
      "",
      { ...result, diagnostics: [{ severity: "error", message: result.detail }] },
      true,
    );
  }
  const { receipt } = result;
  const summary = `${receipt.status.toUpperCase()} ${receipt.check} (${receipt.execution}, ${receipt.durationMs}ms)`;
  return output(
    operation,
    receipt.status === "failed" ? "failed" : "success",
    summary,
    receipt.artifactRef ?? "",
    { receipt },
    receipt.status === "failed",
  );
}

function validationReceiptResult(
  operation: string,
  result: Awaited<ReturnType<typeof getWorkflowValidationReceipt>>,
): CallToolResult {
  if (!result.ok) {
    return output(
      operation,
      "failed",
      `FAIL ${operation} (${result.reason}): ${result.detail}`,
      "",
      { ...result, diagnostics: [{ severity: "error", message: result.detail }] },
      true,
    );
  }
  const { receipt } = result;
  const summary = receipt.satisfied
    ? `OK all required checks satisfied (${receipt.checks.length} checks assessed)`
    : `PENDING required checks not satisfied: ${receipt.requiredPending.join(", ")}`;
  return output(operation, "success", summary, "", { receipt });
}

async function checkRunToolImpl(
  args: Args,
  config: ResolvedGatewayConfig,
  store: WorkflowStateStore,
  artifactStore: ArtifactStore,
): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
  const taskId = stringArg(args, "taskId");
  const result = await runWorkflowCheck(
    {
      workspaceRoot: config.workspaceRoot,
      store,
      ...(taskId === undefined ? {} : { taskId }),
      checkId: stringArg(args, "checkId", true)!,
      force: boolArg(args, "force"),
    },
    { artifactStore },
  );
  return checkReceiptResult("workflow_check_run", result);
}

async function validationReceiptToolImpl(
  args: Args,
  config: ResolvedGatewayConfig,
  store: WorkflowStateStore,
  artifactStore: ArtifactStore,
): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
  const taskId = stringArg(args, "taskId");
  const result = await getWorkflowValidationReceipt(
    {
      workspaceRoot: config.workspaceRoot,
      store,
      ...(taskId === undefined ? {} : { taskId }),
      checkIds: stringArrayArg(args, "checkIds"),
    },
    { artifactStore },
  );
  return validationReceiptResult("workflow_validation_receipt", result);
}

function writeResult(operation: string, result: Awaited<ReturnType<typeof commitWorkflowTask>>): CallToolResult {
  if (result.ok)
    return output(operation, "success", `OK ${operation}${result.dryRun === true ? " (dry-run)" : ""}`, "", result);
  return output(
    operation,
    "failed",
    `FAIL ${operation} (${result.reason}): ${result.detail}`,
    "",
    {
      ...result,
      diagnostics: [{ severity: "error", message: result.detail }],
    },
    true,
  );
}

async function workflowWriteToolImpl(
  name: string,
  args: Args,
  config: ResolvedGatewayConfig,
  store: WorkflowStateStore,
): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
  const taskId = stringArg(args, "taskId");
  const dryRun = boolArg(args, "dryRun") === true;
  const policyResult = resolveEffectiveWorkflowPolicy(config.workspaceRoot);
  if (!policyResult.ok) {
    return output(
      name.replace("mottainai_", ""),
      "failed",
      `FAIL ${name}: invalid workflow policy (${policyResult.reason})`,
      "",
      {
        reason: "invalid-policy",
        diagnostics: [{ severity: "error", message: policyResult.reason }],
      },
      true,
    );
  }
  const selector = {
    workspaceRoot: config.workspaceRoot,
    store,
    nawabari: new NawabariExecutionClient(),
    ...(taskId === undefined ? {} : { taskId }),
  };
  if (name === "mottainai_workflow_task_commit") {
    const message = value(args, "message");
    if (message === null || typeof message !== "object" || Array.isArray(message))
      throw new Error("message must be an object");
    return writeResult(
      "workflow_task_commit",
      await commitWorkflowTask({
        ...selector,
        policy: policyResult.document,
        message: message as StructuredCommitMessage,
        includePaths: stringArrayArg(args, "includePaths"),
        dryRun,
      }),
    );
  }
  if (name === "mottainai_workflow_task_push") {
    return writeResult(
      "workflow_task_push",
      await pushWorkflowTask({
        ...selector,
        policy: policyResult.document,
        remote: stringArg(args, "remote"),
        remoteBranch: stringArg(args, "remoteBranch"),
        force: boolArg(args, "force"),
        createUpstream: boolArg(args, "createUpstream"),
        allowRemoteBehind: boolArg(args, "allowRemoteBehind"),
        allowDiverged: boolArg(args, "allowDiverged"),
        dryRun,
      }),
    );
  }
  if (name === "mottainai_workflow_task_open_pr") {
    return writeResult(
      "workflow_task_open_pr",
      await openWorkflowTaskPullRequest(
        {
          ...selector,
          policy: policyResult.document,
          title: stringArg(args, "title", true)!,
          repository: stringArg(args, "repository"),
          issueReference: stringArg(args, "issueReference"),
          sections: value(args, "sections") as Record<string, string | readonly string[]> | undefined,
          acceptanceCriteria: stringArrayArg(args, "acceptanceCriteria"),
          providerDraft: boolArg(args, "providerDraft"),
          dryRun,
        },
        {
          ghInariClient: new GhInariClient({
            cwd: config.workspaceRoot,
            ...(config.ghInari ?? {}),
          }),
        },
      ),
    );
  }
  if (name === "mottainai_workflow_task_finish")
    return writeResult(
      "workflow_task_finish",
      await finishWorkflowTask({ ...selector, policy: policyResult.document, dryRun }),
    );
  if (name === "mottainai_workflow_task_abandon")
    return writeResult(
      "workflow_task_abandon",
      await abandonWorkflowTask({ ...selector, policy: policyResult.document, dryRun }),
    );
  if (name === "mottainai_workflow_task_cleanup")
    return writeResult(
      "workflow_task_cleanup",
      await cleanupWorkflowTask({
        ...selector,
        policy: policyResult.document,
        dryRun,
        idempotencyKey: stringArg(args, "idempotencyKey"),
        plan: value(args, "plan") as CleanupPlan | undefined,
      }),
    );
  throw new Error(`Unknown workflow write tool: ${name}`);
}

/**
 * 既定の `WorkflowStateStore`。プロセス内で一度だけ生成する module-level singleton
 * （lazy — 呼ばれるまで DB ファイルを開かない）。`src/state/*` の SqliteStateStore と
 * 同じ DB ファイル・パス解決を共有する（`src/workflow/state/sqlite-store.ts` 参照）。
 * テストは `callWorkflowCommandTool` の `workflowStore` 引数に独自インスタンス
 * （`:memory:` 等）を渡すことでこの singleton を迂回できる。
 *
 * `node:sqlite` の import は Node が `ExperimentalWarning` を stderr に一度だけ出す副作用を
 * 持つため、`workflowTasks` を使わない起動（CLI init 等、stdout/stderr の厳密な契約がある
 * 経路を含む）にまで static import で持ち込まない — 実際にこのツールが呼ばれたときだけ
 * dynamic import する。
 */
let defaultWorkflowStorePromise: Promise<WorkflowStateStore> | undefined;
export function defaultWorkflowStore(): Promise<WorkflowStateStore> {
  // 生成済みインスタンスではなく生成中の promise を保持する — await の間に同時呼び出しが
  // 入ると store が二重に init() され、先に作った SQLite handle が close されないまま漏れる。
  defaultWorkflowStorePromise ??= (async () => {
    const { WorkflowSqliteStateStore } = await import("../state/sqlite-store.js");
    const created = new WorkflowSqliteStateStore();
    created.init();
    return created;
  })().catch((error: unknown) => {
    defaultWorkflowStorePromise = undefined;
    throw error;
  });
  return defaultWorkflowStorePromise;
}

/**
 * 既定の `ArtifactStore`。managed check の raw stdout/stderr は既定でこのプロセス内
 * インスタンスへ bounded 保存する — `src/proxy.ts` の gateway 経路は connection ごとの
 * `resolvedArtifactStore` を明示的に渡すため、この既定値は CLI 等スタンドアロン呼び出しの
 * fallback としてのみ使われる。
 */
let defaultArtifactStore: ArtifactStore | undefined;
function defaultCheckArtifactStore(config: ResolvedGatewayConfig): ArtifactStore {
  defaultArtifactStore ??= new InMemoryArtifactStore({
    ttlMs: config.resultTtlMs,
    maxEntries: config.resultMaxEntries,
    aggregateByteBudget: config.resultMaxBytes,
  });
  return defaultArtifactStore;
}

export async function callWorkflowCommandTool(
  name: string,
  args: Args,
  config: ResolvedGatewayConfig,
  workflowStore?: WorkflowStateStore,
  artifactStore?: ArtifactStore,
): Promise<CallToolResult> {
  switch (name) {
    case "mottainai_workflow_policy_explain":
      return policyExplainToolImpl(config);
    case "mottainai_workflow_task_start":
      // config.workflowTasks のゲートは defaultWorkflowStore() より前に通す — さもないと
      // 無効化されたワークスペースでも既定の on-disk SQLite DB を開いてから拒否することになる
      // （taskStartToolImpl 内の requireWorkflowTasksConfigured は defense in depth として残す）。
      requireWorkflowTasksConfigured(config);
      if (workflowStore === undefined && boolArg(args, "dryRun") === true) {
        // A preview must not initialize the process-wide persistent store. Use a
        // short-lived in-memory store for the domain seam and close it before
        // returning; callers that inject a store retain ownership of it.
        const { WorkflowSqliteStateStore } = await import("../state/sqlite-store.js");
        const ephemeral = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
        ephemeral.init();
        try {
          return await taskStartToolImpl(args, config, ephemeral);
        } finally {
          ephemeral.close();
        }
      }
      return taskStartToolImpl(args, config, workflowStore ?? (await defaultWorkflowStore()));
    case "mottainai_workflow_task_status":
      requireWorkflowTasksConfigured(config);
      return taskStatusToolImpl(args, config, workflowStore ?? (await defaultWorkflowStore()));
    case "mottainai_workflow_task_list":
      requireWorkflowTasksConfigured(config);
      return taskListToolImpl(config, workflowStore ?? (await defaultWorkflowStore()));
    case "mottainai_workflow_doctor":
      requireWorkflowTasksConfigured(config);
      return workflowDoctorToolImpl(args, config, workflowStore ?? (await defaultWorkflowStore()));
    case "mottainai_workflow_task_migrate_legacy":
      requireWorkflowTasksConfigured(config);
      return legacyMigrationToolImpl(args, config, workflowStore ?? (await defaultWorkflowStore()));
    case "mottainai_workflow_check_run":
      requireWorkflowTasksConfigured(config);
      return checkRunToolImpl(
        args,
        config,
        workflowStore ?? (await defaultWorkflowStore()),
        artifactStore ?? defaultCheckArtifactStore(config),
      );
    case "mottainai_workflow_validation_receipt":
      requireWorkflowTasksConfigured(config);
      return validationReceiptToolImpl(
        args,
        config,
        workflowStore ?? (await defaultWorkflowStore()),
        artifactStore ?? defaultCheckArtifactStore(config),
      );
    case "mottainai_workflow_task_commit":
    case "mottainai_workflow_task_push":
    case "mottainai_workflow_task_open_pr":
    case "mottainai_workflow_task_finish":
    case "mottainai_workflow_task_abandon":
    case "mottainai_workflow_task_cleanup":
      requireWorkflowTasksConfigured(config);
      return workflowWriteToolImpl(name, args, config, workflowStore ?? (await defaultWorkflowStore()));
    default:
      throw new Error(`Unknown workflow command tool: ${name}`);
  }
}
