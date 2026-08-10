import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedGatewayConfig } from "../../config.js";
import { OUTPUT_SCHEMA, output } from "../../envelope.js";
import { collectWorkflowDoctorReport } from "./doctor.js";
import { getTaskStatus, getTaskStatusForWorkspace, startTask } from "../domain/task.js";
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
import type { WorkflowStateStore } from "../state/store.js";
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
      "Start a Git workflow task: reserve it under Mottainai's task lifecycle, generate a governance-validated <type>/<issue>-<slug> branch, create it below the canonical repository .mottainai/worktrees root, and activate it.",
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
    "Report the active Git workflow task (if any) for the current worktree: task id, lifecycle state, repository/worktree identity, branch, and guardrail warnings. Side-effect free.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
};

const workflowDoctorTool: Tool = {
  name: "mottainai_workflow_doctor",
  description:
    "Run the workflow reconciliation doctor in read-only mode and return the same structured report used by the workflow doctor CLI. No repair or filesystem deletion is performed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
};

let cachedWorkflowCommandTools: Tool[] | undefined;

/** 初回呼び出し時に一度だけ構築し、以降はキャッシュを返す（`buildTaskStartTool` 参照）。 */
export function workflowCommandTools(): Tool[] {
  cachedWorkflowCommandTools ??= [
    policyExplainTool,
    buildTaskStartTool(),
    taskStatusTool,
    workflowDoctorTool,
    taskCommitTool,
    taskPushTool,
    taskOpenPrTool,
    taskFinishTool,
    taskAbandonTool,
    taskCleanupTool,
  ];
  return cachedWorkflowCommandTools;
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

  // `skipWorktree` を渡さない — policy.worktree.required に関わらず常に専用 worktree/branch
  // を作らせる（task lifecycle の目的そのものが「今どの worktree/branch にいるか」の追跡であり、
  // 現在の branch（main を含む）をそのまま work branch にすることは決して起きない）。
  const result = await startTask({
    workspaceRoot: config.workspaceRoot,
    store,
    policy: policyResult.document,
    taskSlug,
    branchType,
    issueRef,
    idempotencyKey: stringArg(args, "idempotencyKey"),
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

  const summary = `OK task=${result.task.taskId} state=${result.task.lifecycleState} branch=${result.worktree?.branchName ?? "(none)"}`;
  const status = getTaskStatus(store, result.task.taskId);
  return output("workflow_task_start", "success", summary, "", {
    task: result.task,
    worktree: result.worktree,
    warnings: result.warnings,
    pullRequests: status?.pullRequests ?? [],
    currentState: status?.currentState ?? result.task.lifecycleState,
    allowedNextTransitions: status?.allowedNextTransitions ?? [],
    invalidTransitions: status?.invalidTransitions ?? [],
  });
}

async function taskStatusToolImpl(config: ResolvedGatewayConfig, store: WorkflowStateStore): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
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

async function workflowDoctorToolImpl(
  config: ResolvedGatewayConfig,
  store: WorkflowStateStore,
): Promise<CallToolResult> {
  requireWorkflowTasksConfigured(config);
  const report = await collectWorkflowDoctorReport({ workspaceRoot: config.workspaceRoot, store });
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
  const selector = { workspaceRoot: config.workspaceRoot, store, ...(taskId === undefined ? {} : { taskId }) };
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
      await openWorkflowTaskPullRequest({
        ...selector,
        policy: policyResult.document,
        title: stringArg(args, "title", true)!,
        repository: stringArg(args, "repository"),
        issueReference: stringArg(args, "issueReference"),
        sections: value(args, "sections") as Record<string, string | readonly string[]> | undefined,
        acceptanceCriteria: stringArrayArg(args, "acceptanceCriteria"),
        providerDraft: boolArg(args, "providerDraft"),
        dryRun,
      }),
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

export async function callWorkflowCommandTool(
  name: string,
  args: Args,
  config: ResolvedGatewayConfig,
  workflowStore?: WorkflowStateStore,
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
    case "mottainai_workflow_doctor":
      requireWorkflowTasksConfigured(config);
      return workflowDoctorToolImpl(config, workflowStore ?? (await defaultWorkflowStore()));
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
