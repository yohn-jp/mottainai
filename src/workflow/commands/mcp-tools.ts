import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedGatewayConfig } from "../../config.js";
import { OUTPUT_SCHEMA, output } from "../../envelope.js";
import { getTaskStatusForWorkspace, startTask } from "../domain/task.js";
import { explainWorkflowPolicy } from "../policy/explain.js";
import { resolveEffectiveWorkflowPolicy } from "../policy/load.js";
import type { WorkflowStateStore } from "../state/store.js";
import { validateIssueRef, validateTaskSlug } from "./validate.js";

/**
 * Early dogfooding exposure of the Git workflow engine (Issue #34, Child Issue 9a-1's
 * thin precursor). `mottainai_workflow_policy_explain` / `mottainai_workflow_task_start` /
 * `mottainai_workflow_task_status` — following the same `Tool[]` + dispatch-function
 * pattern as `src/local-tools.ts`, but kept in their own module since this family has
 * its own gating (`config.workflowTasks`) and its own state dependency
 * (`WorkflowStateStore`) that the rest of `src/local-tools.ts` doesn't need.
 *
 * No enforcement is wired to these tools beyond what `src/workflow/domain/task.ts`
 * itself already does — this is observation/dogfooding only, per Issue #34's Non-goals
 * (no commit/push/PR/cleanup exposure, no protected-branch write-blocking here).
 */

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const policyExplainTool: Tool = {
  name: "mottainai_workflow_policy_explain",
  description: "Explain the effective Git workflow policy for this workspace: for each protected-branch/worktree/cleanup rule, the resolved mode, which authority (preset vs. repository) set it, and whether it can still be weakened. Side-effect free.",
  inputSchema: { type: "object", properties: {} },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
};

const taskStartTool: Tool = {
  name: "mottainai_workflow_task_start",
  description: "Start a Git workflow task: reserve it under Mottainai's task lifecycle, generate a governance-validated <type>/<issue>-<slug> branch, create it below the canonical repository .mottainai/worktrees root, and activate it.",
  inputSchema: { type: "object", properties: {
    taskSlug: { type: "string" }, branchType: { type: "string" }, issueRef: { type: "string" },
  }, required: ["taskSlug", "branchType", "issueRef"] },
  outputSchema: OUTPUT_SCHEMA,
  // openWorldHint: true — policy.worktree.bootstrapMode: "automatic" runs
  // `pnpm install --frozen-lockfile` in the new worktree, which can reach package registries.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const taskStatusTool: Tool = {
  name: "mottainai_workflow_task_status",
  description: "Report the active Git workflow task (if any) for the current worktree: task id, lifecycle state, repository/worktree identity, branch, and guardrail warnings. Side-effect free.",
  inputSchema: { type: "object", properties: {} },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
};

export const workflowCommandTools: Tool[] = [policyExplainTool, taskStartTool, taskStatusTool];

/** `config.workflowTasks` 未設定のワークスペースではこのファミリー全体を公開しない
 * （worktree 作成等の副作用を持つため既定非公開。`mottainai_worktree_new` と同じ姿勢）。 */
export function workflowCommandToolsFor(config: ResolvedGatewayConfig): Tool[] {
  return config.workflowTasks ? workflowCommandTools : [];
}

export function isWorkflowCommandTool(name: string): boolean {
  return workflowCommandTools.some((tool) => tool.name === name);
}

type Args = Record<string, unknown> | undefined;

function value(args: Args, key: string): unknown {
  return args?.[key];
}
function stringArg(args: Args, key: string, required = false): string | undefined {
  const candidate = value(args, key);
  if (candidate === undefined && !required) return undefined;
  if (typeof candidate !== "string" || (required && candidate.length === 0)) throw new Error(`${key} must be a non-empty string`);
  return candidate;
}

function requireWorkflowTasksConfigured(config: ResolvedGatewayConfig): void {
  if (!config.workflowTasks) throw new Error("workflow command tools are not configured for this workspace");
}

function policyExplainToolImpl(config: ResolvedGatewayConfig): CallToolResult {
  requireWorkflowTasksConfigured(config);
  const result = explainWorkflowPolicy(config.workspaceRoot);
  if (!result.ok) {
    const summary = `FAIL policy_explain: invalid workflow policy (${result.reason})`;
    return output("workflow_policy_explain", "failed", summary, "", { diagnostics: [{ severity: "error", message: result.reason }] }, true);
  }
  const summary = `OK preset=${result.explained.preset ?? "(none)"} authority=${result.explained.policySourceAuthority}`;
  return output("workflow_policy_explain", "success", summary, "", {
    policySourceAuthority: result.explained.policySourceAuthority,
    policyFilePath: result.explained.policyFilePath,
    preset: result.explained.preset,
    descriptive: result.explained.descriptive,
    rules: result.explained.rules,
  });
}

async function taskStartToolImpl(args: Args, config: ResolvedGatewayConfig, store: WorkflowStateStore): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
  const taskSlug = stringArg(args, "taskSlug", true)!;
  validateTaskSlug(taskSlug);
  const branchType = stringArg(args, "branchType", true)!;
  const issueRef = stringArg(args, "issueRef", true)!;
  validateIssueRef(issueRef);

  const policyResult = resolveEffectiveWorkflowPolicy(config.workspaceRoot);
  if (!policyResult.ok) {
    const summary = `FAIL task_start: invalid workflow policy (${policyResult.reason})`;
    return output("workflow_task_start", "failed", summary, "", { reason: "invalid-policy", diagnostics: [{ severity: "error", message: policyResult.reason }] }, true);
  }

  // `skipWorktree` を渡さない — policy.worktree.required に関わらず常に専用 worktree/branch
  // を作らせる（task lifecycle の目的そのものが「今どの worktree/branch にいるか」の追跡であり、
  // 現在の branch（main を含む）をそのまま work branch にすることは決して起きない）。
  const result = await startTask({ workspaceRoot: config.workspaceRoot, store, policy: policyResult.document, taskSlug, branchType, issueRef });
  if (!result.ok) {
    const summary = `FAIL task_start (${result.reason}): ${result.detail}`;
    return output("workflow_task_start", "failed", summary, "", { reason: result.reason, diagnostics: [{ severity: "error", message: result.detail }] }, true);
  }

  const summary = `OK task=${result.task.taskId} state=${result.task.lifecycleState} branch=${result.worktree?.branchName ?? "(none)"}`;
  return output("workflow_task_start", "success", summary, "", {
    task: result.task,
    worktree: result.worktree,
    warnings: result.warnings,
  });
}

async function taskStatusToolImpl(config: ResolvedGatewayConfig, store: WorkflowStateStore): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
  const result = await getTaskStatusForWorkspace(config.workspaceRoot, store);
  if (!result.ok) {
    const summary = `FAIL task_status: ${result.reason}`;
    return output("workflow_task_status", "failed", summary, "", { diagnostics: [{ severity: "error", message: result.reason }] }, true);
  }

  const repository = { instanceId: result.instanceId, worktreePath: result.worktreePath, branch: result.branch, repoStateKind: result.repoStateKind };
  if (!result.active) {
    const summary = `OK no active task at ${result.worktreePath}`;
    return output("workflow_task_status", "success", summary, "", { active: false, repository, warnings: result.warnings });
  }

  const summary = `OK task=${result.status.task.taskId} state=${result.status.task.lifecycleState} branch=${result.branch ?? "(detached)"}`;
  return output("workflow_task_status", "success", summary, "", {
    active: true,
    repository,
    task: result.status.task,
    worktrees: result.status.worktrees,
    allowedNextTransitions: result.status.allowedNextTransitions,
    warnings: result.warnings,
  });
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

export async function callWorkflowCommandTool(
  name: string, args: Args, config: ResolvedGatewayConfig, workflowStore?: WorkflowStateStore,
): Promise<CallToolResult> {
  switch (name) {
    case "mottainai_workflow_policy_explain":
      return policyExplainToolImpl(config);
    case "mottainai_workflow_task_start":
      // config.workflowTasks のゲートは defaultWorkflowStore() より前に通す — さもないと
      // 無効化されたワークスペースでも既定の on-disk SQLite DB を開いてから拒否することになる
      // （taskStartToolImpl 内の requireWorkflowTasksConfigured は defense in depth として残す）。
      requireWorkflowTasksConfigured(config);
      return taskStartToolImpl(args, config, workflowStore ?? (await defaultWorkflowStore()));
    case "mottainai_workflow_task_status":
      requireWorkflowTasksConfigured(config);
      return taskStatusToolImpl(config, workflowStore ?? (await defaultWorkflowStore()));
    default:
      throw new Error(`Unknown workflow command tool: ${name}`);
  }
}
