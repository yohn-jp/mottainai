import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedGatewayConfig } from "../../config.js";
import { DEFAULT_BURST_BUDGET_POLICY } from "../../context-runtime/burst-budget.js";
import { DEFAULT_AWAIT_POLICY } from "../../context-runtime/poll-policy.js";
import { callWorkflowCommandTool, workflowCommandTools, workflowCommandToolsFor } from "./mcp-tools.js";
import { bundledGovernedBranchTypes } from "../governance/branch.js";
import { resolveRepositoryIdentity } from "../domain/identity.js";
import { startTask, transitionTask } from "../domain/task.js";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { WorkflowSqliteStateStore } from "../state/sqlite-store.js";

function structured(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

async function gitWorkspace(t: TestContext): Promise<{ root: string; config: ResolvedGatewayConfig }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-workflow-mcp-tools-"));
  // アサーションが投げても掃除が漏れないよう、生成直後に t.after で登録する
  // （末尾の fs.rm 頼みだと、途中で作られた worktree ごと残る）。
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(path.join(root, "file.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });
  const config: ResolvedGatewayConfig = {
    workspaceRoot: root,
    defaultTimeoutMs: 1_000,
    maxTimeoutMs: 2_000,
    maxOutputBytes: 1024,
    execTargetTokens: 1_000,
    resultTtlMs: 10_000,
    resultMaxEntries: 10,
    capabilityMap: {},
    toolMetadata: {},
    tokenBudgets: { tools: {}, capabilities: {}, profiles: {} },
    workflowTasks: false,
    await: DEFAULT_AWAIT_POLICY,
    burstBudget: DEFAULT_BURST_BUDGET_POLICY,
  };
  return { root, config };
}

function enabled(config: ResolvedGatewayConfig): ResolvedGatewayConfig {
  return { ...config, workflowTasks: true };
}

function openWorkflowStore(): WorkflowSqliteStateStore {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  return store;
}

// --- gating: the whole family is hidden and rejected unless workflowTasks is set ---

test("workflowCommandToolsFor returns nothing unless workflowTasks is configured", async (t) => {
  const { config } = await gitWorkspace(t);
  assert.deepEqual(workflowCommandToolsFor(config), []);
  const names = workflowCommandToolsFor(enabled(config)).map((tool) => tool.name);
  assert.deepEqual(
    names.sort(),
    [
      "mottainai_workflow_policy_explain",
      "mottainai_workflow_task_start",
      "mottainai_workflow_task_status",
      "mottainai_workflow_task_list",
      "mottainai_workflow_doctor",
      "mottainai_workflow_task_commit",
      "mottainai_workflow_task_push",
      "mottainai_workflow_task_open_pr",
      "mottainai_workflow_task_finish",
      "mottainai_workflow_task_abandon",
      "mottainai_workflow_task_cleanup",
      "mottainai_workflow_task_migrate_legacy",
      "mottainai_workflow_check_run",
      "mottainai_workflow_validation_receipt",
    ].sort(),
  );
});

test("every tool in workflowCommandTools is reachable through workflowCommandToolsFor once enabled", async (t) => {
  const { config } = await gitWorkspace(t);
  const advertised = new Set(workflowCommandToolsFor(enabled(config)).map((tool) => tool.name));
  for (const tool of workflowCommandTools()) assert.ok(advertised.has(tool.name));
});

test("each workflow command tool throws when workflowTasks is not configured", async (t) => {
  const { config } = await gitWorkspace(t);
  await assert.rejects(
    () => callWorkflowCommandTool("mottainai_workflow_policy_explain", {}, config),
    /workflow command tools are not configured/,
  );
  await assert.rejects(
    () => callWorkflowCommandTool("mottainai_workflow_task_start", { taskSlug: "example" }, config),
    /workflow command tools are not configured/,
  );
  await assert.rejects(
    () => callWorkflowCommandTool("mottainai_workflow_task_status", {}, config),
    /workflow command tools are not configured/,
  );
  await assert.rejects(
    () => callWorkflowCommandTool("mottainai_workflow_task_list", {}, config),
    /workflow command tools are not configured/,
  );
  await assert.rejects(
    () => callWorkflowCommandTool("mottainai_workflow_doctor", {}, config),
    /workflow command tools are not configured/,
  );
  for (const name of [
    "mottainai_workflow_task_commit",
    "mottainai_workflow_task_push",
    "mottainai_workflow_task_open_pr",
    "mottainai_workflow_task_finish",
    "mottainai_workflow_task_abandon",
    "mottainai_workflow_task_cleanup",
    "mottainai_workflow_task_migrate_legacy",
  ]) {
    await assert.rejects(() => callWorkflowCommandTool(name, {}, config), /workflow command tools are not configured/);
  }
});

// --- mottainai_workflow_policy_explain ---

test("policy_explain reports the standard preset by default, with authority=preset on its rules", async (t) => {
  const { config } = await gitWorkspace(t);
  const result = structured(await callWorkflowCommandTool("mottainai_workflow_policy_explain", {}, enabled(config)));
  assert.equal(result.status, "success");
  assert.equal(result.preset, "standard");
  assert.equal(result.policySourceAuthority, "preset");
  const rules = result.rules as { protectedBranchRule: { directPush: { mode: string; authority: string } } };
  assert.equal(rules.protectedBranchRule.directPush.mode, "enforce");
  assert.equal(rules.protectedBranchRule.directPush.authority, "preset");
  const resolvedPolicy = result.resolvedPolicy as {
    pullRequest: { issue: { value: string; authority: string } };
  };
  // No preset declares `pullRequest` (see presets.ts) — its value here is a synthesized
  // default, not something the "standard" preset actually declared.
  assert.deepEqual(resolvedPolicy.pullRequest.issue, { value: "optional", authority: "default" });
});

test("policy_explain fails closed on a corrupted .mottainai/workflow.json", async (t) => {
  const { root, config } = await gitWorkspace(t);
  await fs.mkdir(path.join(root, ".mottainai"), { recursive: true });
  await fs.writeFile(path.join(root, ".mottainai", "workflow.json"), "{ not json");
  const result = structured(await callWorkflowCommandTool("mottainai_workflow_policy_explain", {}, enabled(config)));
  assert.equal(result.status, "failed");
});

// --- mottainai_workflow_task_start / mottainai_workflow_task_status ---

test("task_start rejects an invalid taskSlug at the MCP boundary", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  await assert.rejects(
    () =>
      callWorkflowCommandTool(
        "mottainai_workflow_task_start",
        { taskSlug: "Bad Slug", branchType: "fix", issueRef: "9" },
        enabled(config),
        store,
      ),
    /invalid task slug/,
  );
  store.close();
});

test("task_start rejects an invalid issueRef at the MCP boundary", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  await assert.rejects(
    () =>
      callWorkflowCommandTool(
        "mottainai_workflow_task_start",
        { taskSlug: "ok", branchType: "fix", issueRef: "../evil" },
        enabled(config),
        store,
      ),
    /invalid issue ref/,
  );
  store.close();
});

test("task_start rejects an issueRef ending in .lock at the MCP boundary", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  await assert.rejects(
    () =>
      callWorkflowCommandTool(
        "mottainai_workflow_task_start",
        { taskSlug: "ok", branchType: "fix", issueRef: "9.lock" },
        enabled(config),
        store,
      ),
    /invalid issue ref/,
  );
  store.close();
});

test("task_start rejects an issueRef ending in . at the MCP boundary", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  await assert.rejects(
    () =>
      callWorkflowCommandTool(
        "mottainai_workflow_task_start",
        { taskSlug: "ok", branchType: "fix", issueRef: "issue." },
        enabled(config),
        store,
      ),
    /invalid issue ref/,
  );
  store.close();
});

test("task_start's branchType input schema declares an enum matching the bundled governed branch types (no duplicated/hand-written list)", () => {
  const taskStart = workflowCommandTools().find((tool) => tool.name === "mottainai_workflow_task_start");
  assert.ok(taskStart);
  const properties = taskStart.inputSchema.properties as {
    branchType?: { enum?: unknown };
    dryRun?: { type?: string };
  };
  assert.deepEqual(properties.branchType?.enum, bundledGovernedBranchTypes());
  assert.equal((properties.branchType?.enum as string[] | undefined)?.includes("research"), false);
  assert.equal(properties.dryRun?.type, "boolean");
});

test("task_start dry-run returns a plan without creating a task or worktree", async (t) => {
  const { root, config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  try {
    const before = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
    const result = structured(
      await callWorkflowCommandTool(
        "mottainai_workflow_task_start",
        { taskSlug: "preview", branchType: "fix", issueRef: "480", dryRun: true },
        enabled(config),
        store,
      ),
    );
    assert.equal(result.status, "success");
    assert.equal(result.dryRun, true);
    assert.equal("task" in result, false);
    const plan = result.plan as {
      branch: string;
      claimAcquisition: { previewed: boolean; reason: string };
    };
    assert.equal(plan.branch, "fix/480-preview");
    assert.equal(plan.claimAcquisition.previewed, false);
    assert.match(plan.claimAcquisition.reason, /external mutation/u);
    assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }), before);
    assert.deepEqual(store.listTasks(), []);
    assert.equal(
      await fs.access(path.join(root, ".git", "mottainai-instance-id")).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    store.close();
  }
});

test("task_start dry-run with the default store leaves persistent state untouched", async (t) => {
  const { root, config } = await gitWorkspace(t);
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-workflow-default-state-"));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const statePath = path.join(stateDirectory, "state.sqlite3");
  const seeded = new WorkflowSqliteStateStore({ dbPath: statePath });
  seeded.init();
  seeded.close();
  const before = await fs.readFile(statePath);
  const previousStateDirectory = process.env.MOTTAINAI_STATE_DIR;
  process.env.MOTTAINAI_STATE_DIR = stateDirectory;
  try {
    const result = structured(
      await callWorkflowCommandTool(
        "mottainai_workflow_task_start",
        { taskSlug: "default-preview", branchType: "fix", issueRef: "480", dryRun: true },
        enabled(config),
      ),
    );
    assert.equal(result.status, "success");
    assert.equal(result.dryRun, true);
    assert.deepEqual(await fs.readFile(statePath), before);
  } finally {
    if (previousStateDirectory === undefined) delete process.env.MOTTAINAI_STATE_DIR;
    else process.env.MOTTAINAI_STATE_DIR = previousStateDirectory;
  }
});

test("task_start dry-run with the default store reads an active local blocker without writing state", async (t) => {
  const { root, config } = await gitWorkspace(t);
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-workflow-default-state-"));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const statePath = path.join(stateDirectory, "state.sqlite3");
  const seeded = new WorkflowSqliteStateStore({ dbPath: statePath });
  seeded.init();
  const previousStateDirectory = process.env.MOTTAINAI_STATE_DIR;
  process.env.MOTTAINAI_STATE_DIR = stateDirectory;
  try {
    const started = await startTask({
      workspaceRoot: root,
      store: seeded,
      policy: BUILTIN_PRESETS.standard,
      taskSlug: "existing",
      branchType: "fix",
      issueRef: "533",
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    if (!started.ok || started.worktree === undefined) throw new Error("active task fixture setup failed");
    const before = await fs.readFile(statePath);
    const result = structured(
      await callWorkflowCommandTool(
        "mottainai_workflow_task_start",
        { taskSlug: "preview", branchType: "fix", issueRef: "534", dryRun: true },
        enabled({ ...config, workspaceRoot: started.worktree.canonicalPath }),
      ),
    );
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "active-task-in-workspace");
    assert.deepEqual(await fs.readFile(statePath), before);
  } finally {
    seeded.close();
    if (previousStateDirectory === undefined) delete process.env.MOTTAINAI_STATE_DIR;
    else process.env.MOTTAINAI_STATE_DIR = previousStateDirectory;
  }
});

test('task_start rejects an ungoverned branchType (e.g. "research") before any worktree/Git mutation', async (t) => {
  const { root, config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  const result = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "example", branchType: "research", issueRef: "9" },
      enabled(config),
      store,
    ),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "invalid-branch-name");
  const worktreesDir = path.join(root, ".mottainai", "worktrees");
  await assert.rejects(() => fs.access(worktreesDir));
  store.close();
});

test("task_start always creates a dedicated worktree/branch (never main itself), and task_status reports it only from inside that worktree", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();

  const started = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "example", branchType: "fix", issueRef: "9" },
      enabled(config),
      store,
    ),
  );
  assert.equal(started.status, "success");
  const worktree = started.worktree as { branchName: string; canonicalPath: string };
  assert.equal(worktree.branchName, "fix/9-example");
  assert.notEqual(worktree.branchName, "main");

  const statusFromMainCheckout = structured(
    await callWorkflowCommandTool("mottainai_workflow_task_status", {}, enabled(config), store),
  );
  assert.equal(statusFromMainCheckout.status, "success");
  assert.equal(statusFromMainCheckout.active, false);

  const statusFromWorktree = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_status",
      {},
      enabled({ ...config, workspaceRoot: worktree.canonicalPath }),
      store,
    ),
  );
  assert.equal(statusFromWorktree.active, true);
  assert.equal((statusFromWorktree.task as { taskId: string }).taskId, (started.task as { taskId: string }).taskId);

  store.close();
});

test("task_status reports no active task as a normal, structured outcome (not an error)", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  const status = structured(
    await callWorkflowCommandTool("mottainai_workflow_task_status", {}, enabled(config), store),
  );
  assert.equal(status.status, "success");
  assert.equal(status.active, false);
  assert.deepEqual(status.warnings, []);
  store.close();
});

test("task_status reports complete lifecycle transition blockers and provider PR state", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  const started = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "provider-state", branchType: "fix", issueRef: "39" },
      enabled(config),
      store,
    ),
  );
  assert.equal(started.status, "success");
  const task = started.task as { taskId: string; instanceId: string };
  store.recordPullRequest({
    taskId: task.taskId as never,
    instanceId: task.instanceId as never,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 39,
    url: "https://github.com/org/repository/pull/39",
    headSha: "head-sha",
    lifecycleState: "open",
  });

  const worktree = started.worktree as { canonicalPath: string };
  const status = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_status",
      {},
      enabled({ ...config, workspaceRoot: worktree.canonicalPath }),
      store,
    ),
  );
  assert.equal(status.active, true);
  assert.deepEqual(status.pullRequests, [
    {
      recordId: (status.pullRequests as Array<{ recordId: string }>)[0]?.recordId,
      taskId: task.taskId,
      instanceId: task.instanceId,
      provider: "github",
      repositoryId: "org/repository",
      prNumber: 39,
      url: "https://github.com/org/repository/pull/39",
      headSha: "head-sha",
      mergeRevision: undefined,
      lifecycleState: "open",
      createdAt: (status.pullRequests as Array<{ createdAt: number }>)[0]?.createdAt,
      updatedAt: (status.pullRequests as Array<{ updatedAt: number }>)[0]?.updatedAt,
    },
  ]);
  assert.ok((status.allowedNextTransitions as string[]).includes("committed"));
  const invalid = status.invalidTransitions as Array<{ requestedTransition: string; blockingRule: string }>;
  assert.match(
    invalid.find((item) => item.requestedTransition === "merged")?.blockingRule ?? "",
    /no direct transition/,
  );
  store.close();
});

// --- mottainai_workflow_task_list / mottainai_workflow_task_status(taskId) (Issue #539) ---

test("task_list enumerates active tasks across repositories with an explicit schemaVersion and no absolute path fields", async (t) => {
  const { config: configA } = await gitWorkspace(t);
  const { config: configB } = await gitWorkspace(t);
  const store = openWorkflowStore();

  const startedA = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "cross-a", branchType: "fix", issueRef: "539" },
      enabled(configA),
      store,
    ),
  );
  const startedB = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "cross-b", branchType: "fix", issueRef: "540" },
      enabled(configB),
      store,
    ),
  );
  assert.equal(startedA.status, "success");
  assert.equal(startedB.status, "success");
  const taskA = startedA.task as { taskId: string; instanceId: string };
  const taskB = startedB.task as { taskId: string; instanceId: string };

  // A single call, gated on neither config's workspaceRoot, sees both.
  const listed = structured(await callWorkflowCommandTool("mottainai_workflow_task_list", {}, enabled(configA), store));
  assert.equal(listed.status, "success");
  assert.equal(listed.schemaVersion, 1);
  assert.equal(typeof listed.generatedAt, "number");
  const tasks = listed.tasks as Array<{ taskId: string; repository: { instanceId: string } }>;
  const entryA = tasks.find((task) => task.taskId === taskA.taskId);
  const entryB = tasks.find((task) => task.taskId === taskB.taskId);
  assert.ok(entryA);
  assert.ok(entryB);
  assert.equal(entryA!.repository.instanceId, taskA.instanceId);
  assert.notEqual(entryA!.repository.instanceId, entryB!.repository.instanceId);
  assert.deepEqual(Object.keys(entryA!.repository), ["instanceId"]);

  const serialized = JSON.stringify(listed);
  assert.doesNotMatch(serialized, /worktreePath/);
  store.close();
});

test("task_list removes an abandoned task from the default view while unrelated tasks remain listed", async (t) => {
  const { config: configA } = await gitWorkspace(t);
  const { config: configB } = await gitWorkspace(t);
  const store = openWorkflowStore();

  // Two different repositories, not two tasks in one repository: an unscoped
  // Nawabari task claims its whole repository exclusive-write, so a second
  // concurrent task in the *same* repository would conflict for real here.
  const stays = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "stays-listed", branchType: "fix", issueRef: "541" },
      enabled(configA),
      store,
    ),
  );
  const goes = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "gets-abandoned", branchType: "fix", issueRef: "542" },
      enabled(configB),
      store,
    ),
  );
  assert.equal(stays.status, "success");
  assert.equal(goes.status, "success");
  const staysTask = stays.task as { taskId: string };
  const goesTask = goes.task as { taskId: string };

  transitionTask(store, goesTask.taskId as never, "abandoned");

  const listed = structured(await callWorkflowCommandTool("mottainai_workflow_task_list", {}, enabled(configA), store));
  const ids = (listed.tasks as Array<{ taskId: string }>).map((task) => task.taskId);
  assert.ok(ids.includes(staysTask.taskId));
  assert.ok(!ids.includes(goesTask.taskId));
  store.close();
});

test("task_status(taskId) resolves the current worktree path fresh, independent of the caller's config.workspaceRoot", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  const started = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "keyed-resolve", branchType: "fix", issueRef: "543" },
      enabled(config),
      store,
    ),
  );
  assert.equal(started.status, "success");
  const task = started.task as { taskId: string };
  const worktree = started.worktree as { canonicalPath: string; branchName: string };

  // config.workspaceRoot points at an unrelated location (not even the task's own
  // repository or worktree) — the keyed resolve must not depend on it.
  const unrelated = await gitWorkspace(t);
  const status = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_status",
      { taskId: task.taskId },
      enabled(unrelated.config),
      store,
    ),
  );
  assert.equal(status.status, "success");
  assert.equal(status.active, true);
  assert.equal((status.task as { taskId: string }).taskId, task.taskId);
  assert.equal(status.worktreePath, worktree.canonicalPath);
  assert.equal(status.branch, worktree.branchName);
  store.close();
});

test("task_status(taskId) fails closed for an unknown or closed task, never falling back to another task", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();

  const unknown = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_status",
      { taskId: "not-a-real-task-id" },
      enabled(config),
      store,
    ),
  );
  assert.equal(unknown.status, "failed");

  const started = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "keyed-fails-closed", branchType: "fix", issueRef: "544" },
      enabled(config),
      store,
    ),
  );
  assert.equal(started.status, "success");
  const task = started.task as { taskId: string };
  transitionTask(store, task.taskId as never, "abandoned");

  const closed = structured(
    await callWorkflowCommandTool("mottainai_workflow_task_status", { taskId: task.taskId }, enabled(config), store),
  );
  assert.equal(closed.status, "failed");
  store.close();
});

test("workflow doctor is exposed as a read-only structured MCP report", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  const result = structured(await callWorkflowCommandTool("mottainai_workflow_doctor", {}, enabled(config), store));
  assert.equal(result.operation, "workflow_doctor");
  assert.equal(result.status, "failed");
  assert.equal(result.mode, "read-only");
  assert.equal(result.ok, false);
  assert.equal((result.problems as Array<{ code: string }>)[0]?.code, "repository-instance-not-found");
  assert.equal((result.reconciliation as { mode: string }).mode, "read-only");
  store.close();
});

test("legacy migration is exposed as an explicit task command", async (t) => {
  const { root, config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  const identity = resolveRepositoryIdentity(root);
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  store.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });
  const task = store.reserveTask({
    instanceId: identity.identity.instanceId,
    taskSlug: "legacy-command",
    issueRef: "203",
    baseBranch: "main",
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  assert.equal(transitionTask(store, task.task.taskId, "active").ok, true);
  assert.equal(transitionTask(store, task.task.taskId, "abandoned").ok, true);
  const result = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_migrate_legacy",
      { taskId: task.task.taskId, mode: "complete" },
      enabled(config),
      store,
    ),
  );
  assert.equal(result.status, "success");
  assert.equal((result.task as { lifecycleState: string }).lifecycleState, "cleaned");
  store.close();
});

test("MCP legacy migration releases 102 orphaned active tasks without direct state intervention", async (t) => {
  const { root, config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  t.after(() => store.close());
  const identity = resolveRepositoryIdentity(root);
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  store.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const taskIds: string[] = [];
  for (let index = 0; index < 102; index += 1) {
    const reserved = store.reserveTask({
      instanceId: identity.identity.instanceId,
      taskSlug: `orphaned-${index}`,
      issueRef: `551-${index}`,
      baseBranch: "main",
      baseCommit,
      allowMultipleActiveTasksPerIssue: true,
    });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;
    assert.equal(transitionTask(store, reserved.task.taskId, "active").ok, true);
    taskIds.push(reserved.task.taskId);
  }

  for (const taskId of taskIds) {
    const result = structured(
      await callWorkflowCommandTool(
        "mottainai_workflow_task_migrate_legacy",
        { taskId, mode: "complete" },
        enabled(config),
        store,
      ),
    );
    assert.equal(result.status, "success");
    assert.equal((result.task as { lifecycleState: string }).lifecycleState, "abandoned");
  }
  assert.equal(
    store.listTasks(identity.identity.instanceId).every((task) => task.lifecycleState === "abandoned"),
    true,
  );
});

test("task_start rejects starting a second task from inside its own already-active worktree (fail-closed guardrail)", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  const started = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "outer", branchType: "fix", issueRef: "10" },
      enabled(config),
      store,
    ),
  );
  assert.equal(started.status, "success");
  const worktree = started.worktree as { canonicalPath: string };

  const second = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "inner", branchType: "fix", issueRef: "11" },
      enabled({ ...config, workspaceRoot: worktree.canonicalPath }),
      store,
    ),
  );
  assert.equal(second.status, "failed");
  assert.equal(second.reason, "active-task-in-workspace");

  store.close();
});

test("task_start fails closed on a corrupted .mottainai/workflow.json instead of silently falling back to a preset", async (t) => {
  const { root, config } = await gitWorkspace(t);
  await fs.mkdir(path.join(root, ".mottainai"), { recursive: true });
  await fs.writeFile(path.join(root, ".mottainai", "workflow.json"), "{ not json");
  const store = openWorkflowStore();
  const result = structured(
    await callWorkflowCommandTool(
      "mottainai_workflow_task_start",
      { taskSlug: "example", branchType: "fix", issueRef: "12" },
      enabled(config),
      store,
    ),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "invalid-policy");
  store.close();
});

test("unknown tool name throws", async (t) => {
  const { config } = await gitWorkspace(t);
  await assert.rejects(() => callWorkflowCommandTool("mottainai_workflow_nonexistent", {}, enabled(config)));
});
