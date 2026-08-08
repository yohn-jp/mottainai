import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedGatewayConfig } from "../../config.js";
import { DEFAULT_AWAIT_POLICY } from "../../context-runtime/poll-policy.js";
import { callWorkflowCommandTool, workflowCommandTools, workflowCommandToolsFor } from "./mcp-tools.js";
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
    workspaceRoot: root, defaultTimeoutMs: 1_000, maxTimeoutMs: 2_000, maxOutputBytes: 1024, execTargetTokens: 1_000,
    resultTtlMs: 10_000, resultMaxEntries: 10, capabilityMap: {}, toolMetadata: {}, tokenBudgets: { tools: {}, capabilities: {}, profiles: {} },
    workflowTasks: false, await: DEFAULT_AWAIT_POLICY,
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
  assert.deepEqual(names.sort(), [
    "mottainai_workflow_policy_explain",
    "mottainai_workflow_task_start",
    "mottainai_workflow_task_status",
  ].sort());
});

test("every tool in workflowCommandTools is reachable through workflowCommandToolsFor once enabled", async (t) => {
  const { config } = await gitWorkspace(t);
  const advertised = new Set(workflowCommandToolsFor(enabled(config)).map((tool) => tool.name));
  for (const tool of workflowCommandTools) assert.ok(advertised.has(tool.name));
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
    () => callWorkflowCommandTool("mottainai_workflow_task_start", { taskSlug: "Bad Slug" }, enabled(config), store),
    /invalid task slug/,
  );
  store.close();
});

test("task_start rejects an invalid issueRef at the MCP boundary", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  await assert.rejects(
    () => callWorkflowCommandTool("mottainai_workflow_task_start", { taskSlug: "ok", issueRef: "../evil" }, enabled(config), store),
    /invalid issue ref/,
  );
  store.close();
});

test("task_start rejects an issueRef ending in .lock at the MCP boundary", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  await assert.rejects(
    () => callWorkflowCommandTool("mottainai_workflow_task_start", { taskSlug: "ok", issueRef: "9.lock" }, enabled(config), store),
    /invalid issue ref/,
  );
  store.close();
});

test("task_start rejects an issueRef ending in . at the MCP boundary", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  await assert.rejects(
    () => callWorkflowCommandTool("mottainai_workflow_task_start", { taskSlug: "ok", issueRef: "issue." }, enabled(config), store),
    /invalid issue ref/,
  );
  store.close();
});

test("task_start always creates a dedicated worktree/branch (never main itself), and task_status reports it only from inside that worktree", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();

  const started = structured(await callWorkflowCommandTool(
    "mottainai_workflow_task_start", { taskSlug: "example", issueRef: "9" }, enabled(config), store,
  ));
  assert.equal(started.status, "success");
  const worktree = started.worktree as { branchName: string; canonicalPath: string };
  assert.equal(worktree.branchName, "issue-9/example");
  assert.notEqual(worktree.branchName, "main");

  const statusFromMainCheckout = structured(await callWorkflowCommandTool(
    "mottainai_workflow_task_status", {}, enabled(config), store,
  ));
  assert.equal(statusFromMainCheckout.status, "success");
  assert.equal(statusFromMainCheckout.active, false);

  const statusFromWorktree = structured(await callWorkflowCommandTool(
    "mottainai_workflow_task_status", {}, enabled({ ...config, workspaceRoot: worktree.canonicalPath }), store,
  ));
  assert.equal(statusFromWorktree.active, true);
  assert.equal((statusFromWorktree.task as { taskId: string }).taskId, (started.task as { taskId: string }).taskId);

  store.close();
});

test("task_status reports no active task as a normal, structured outcome (not an error)", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  const status = structured(await callWorkflowCommandTool("mottainai_workflow_task_status", {}, enabled(config), store));
  assert.equal(status.status, "success");
  assert.equal(status.active, false);
  assert.deepEqual(status.warnings, []);
  store.close();
});

test("task_start rejects starting a second task from inside its own already-active worktree (fail-closed guardrail)", async (t) => {
  const { config } = await gitWorkspace(t);
  const store = openWorkflowStore();
  const started = structured(await callWorkflowCommandTool(
    "mottainai_workflow_task_start", { taskSlug: "outer" }, enabled(config), store,
  ));
  assert.equal(started.status, "success");
  const worktree = started.worktree as { canonicalPath: string };

  const second = structured(await callWorkflowCommandTool(
    "mottainai_workflow_task_start", { taskSlug: "inner" }, enabled({ ...config, workspaceRoot: worktree.canonicalPath }), store,
  ));
  assert.equal(second.status, "failed");
  assert.equal(second.reason, "active-task-in-workspace");

  store.close();
});

test("task_start fails closed on a corrupted .mottainai/workflow.json instead of silently falling back to a preset", async (t) => {
  const { root, config } = await gitWorkspace(t);
  await fs.mkdir(path.join(root, ".mottainai"), { recursive: true });
  await fs.writeFile(path.join(root, ".mottainai", "workflow.json"), "{ not json");
  const store = openWorkflowStore();
  const result = structured(await callWorkflowCommandTool(
    "mottainai_workflow_task_start", { taskSlug: "example" }, enabled(config), store,
  ));
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "invalid-policy");
  store.close();
});

test("unknown tool name throws", async (t) => {
  const { config } = await gitWorkspace(t);
  await assert.rejects(() => callWorkflowCommandTool("mottainai_workflow_nonexistent", {}, enabled(config)));
});
