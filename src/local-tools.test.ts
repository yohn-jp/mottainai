import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { allLocalTools, callLocalTool, localTools, localToolsFor, parseIssueViewOutput, parseRgJson } from "./local-tools.js";
import type { ResolvedGatewayConfig } from "./config.js";
import { InMemoryArtifactStore } from "./retrieve.js";

async function workspace(): Promise<{ root: string; config: ResolvedGatewayConfig }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-local-tools-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "src", "sample.ts"), "export function useful() {\n  return 1;\n}\nexport const value = 2;\n");
  await fs.writeFile(path.join(root, "needle.txt"), "one\nneedle here\nthree\n");
  await fs.writeFile(path.join(root, "node_modules", "ignored.txt"), "needle ignored");
  return { root, config: { workspaceRoot: root, defaultTimeoutMs: 1_000, maxTimeoutMs: 2_000, maxOutputBytes: 1024, execTargetTokens: 1_000, resultTtlMs: 10_000, resultMaxEntries: 10, capabilityMap: {}, toolMetadata: {}, tokenBudgets: { tools: {}, capabilities: {}, profiles: {} }, workflowTasks: false } };
}

function structured(result: Awaited<ReturnType<typeof callLocalTool>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

test("local tool definitions expose schemas, output schemas, and annotations", () => {
  assert.deepEqual(localTools.map((tool) => tool.name), [
    "mottainai_exec", "mottainai_read", "mottainai_search", "mottainai_list", "mottainai_result_get", "mottainai_result_search",
    "mottainai_runtime_status", "mottainai_telemetry_summary",
  ]);
  for (const tool of localTools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema?.type, "object");
    assert.ok(tool.annotations);
  }
});

test("read supports line ranges and symbols while rejecting paths outside root", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "read" });
  const ranged = structured(await callLocalTool("mottainai_read", { path: "src/sample.ts", startLine: 2, endLine: 2 }, config, store));
  assert.equal(ranged.text, "  return 1;");
  const symbols = structured(await callLocalTool("mottainai_read", { path: "src/sample.ts", mode: "symbols" }, config, store));
  assert.match(symbols.text as string, /useful/);
  assert.match(symbols.text as string, /value/);
  await assert.rejects(() => callLocalTool("mottainai_read", { path: "../outside" }, config, store));
  await fs.rm(root, { recursive: true, force: true });
});

test("read stores only the requested range so result_get cannot reach lines outside it", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "read-ranged" });
  const ranged = structured(await callLocalTool("mottainai_read", { path: "src/sample.ts", startLine: 2, endLine: 2 }, config, store));
  const retrieved = structured(await callLocalTool("mottainai_result_get", { id: ranged.result_id }, config, store));
  assert.equal(retrieved.text, "  return 1;");
  assert.equal(retrieved.totalLines, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("search groups rg matches and list omits dependency directories", async (t) => {
  const { root, config } = await workspace();
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
  } catch {
    await fs.rm(root, { recursive: true, force: true });
    t.skip("rg is not installed");
    return;
  }
  const store = new InMemoryArtifactStore({ createId: () => crypto.randomUUID() });
  const search = structured(await callLocalTool("mottainai_search", { query: "needle", path: ".", mode: "literal" }, config, store));
  assert.equal((search.groups as Array<unknown>).length, 1);
  const listed = structured(await callLocalTool("mottainai_list", { path: ".", depth: 2 }, config, store));
  assert.ok((listed.entries as string[]).includes("src/"));
  assert.ok(!(listed.entries as string[]).some((entry) => entry.startsWith("node_modules")));
  await fs.rm(root, { recursive: true, force: true });
});

test("search caps total matches across files at maxResults and reports truncation", async (t) => {
  const { root, config } = await workspace();
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
  } catch {
    await fs.rm(root, { recursive: true, force: true });
    t.skip("rg is not installed");
    return;
  }
  const manyLines = Array.from({ length: 10 }, (_, index) => `needle ${index}`).join("\n");
  for (let file = 0; file < 5; file += 1) {
    await fs.writeFile(path.join(root, `many-${file}.txt`), `${manyLines}\n`);
  }
  const store = new InMemoryArtifactStore({ createId: () => crypto.randomUUID() });
  const search = structured(await callLocalTool("mottainai_search", { query: "needle", path: ".", mode: "literal", maxResults: 5 }, { ...config, maxOutputBytes: 64 * 1024 }, store));
  const groups = search.groups as Array<{ matches: Array<unknown> }>;
  const totalMatches = groups.reduce((count, group) => count + group.matches.length, 0);
  assert.ok(totalMatches <= 5);
  assert.equal(search.truncated, true);
  assert.ok(((search.metrics as Record<string, number>).omitted_matches) > 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("exec preserves stdout/stderr and result tools retrieve and search it", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "exec" });
  const command = "printf out; printf err >&2";
  const executed = structured(await callLocalTool("mottainai_exec", { command }, config, store));
  assert.equal(executed.status, "success");
  const id = executed.result_id as string;
  const stderr = structured(await callLocalTool("mottainai_result_get", { id, stream: "stderr" }, config, store));
  assert.equal(stderr.text, "err");
  const found = structured(await callLocalTool("mottainai_result_search", { query: "err" }, config, store));
  assert.equal((found.results as unknown[]).length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("exec returns structured failure for timeout and output limit", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "limit" });
  // output-limit ケースは maxOutputBytes を timeout より先に必ず超える必要がある。
  // CI ランナーの CPU 負荷でイベントループが遅延すると、50ms のような極端に短い
  // timeout では data イベント到達前に timeout が先着することがある（両方 true に
  // なるべきだが output 側が先に立たない flaky 挙動）ため、output-limit 専用の
  // config だけ timeout を十分長く取り、timeout ケースとは config を分ける。
  const outputLimitedConfig = { ...config, maxOutputBytes: 20, defaultTimeoutMs: 5_000, maxTimeoutMs: 5_000 };
  const limited = structured(await callLocalTool("mottainai_exec", { command: "yes x" }, outputLimitedConfig, store));
  assert.equal(limited.output_limited, true);

  const timeoutConfig = { ...config, maxOutputBytes: 20, defaultTimeoutMs: 50, maxTimeoutMs: 50 };
  const timed = structured(await callLocalTool("mottainai_exec", { command: "sleep 1" }, timeoutConfig, store));
  assert.equal(timed.timed_out, true);
  const stubborn = structured(await callLocalTool(
    "mottainai_exec",
    { command: `${process.execPath} -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'` },
    timeoutConfig,
    store,
  ));
  assert.equal(stubborn.timed_out, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("exec reports stdout-only and empty failures as diagnostics", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "failure" });
  const stdoutFailure = structured(await callLocalTool("mottainai_exec", { command: "printf failure; exit 1" }, config, store));
  assert.deepEqual(stdoutFailure.diagnostics, [{ severity: "error", message: "failure" }]);
  const emptyFailure = structured(await callLocalTool("mottainai_exec", { command: "false" }, config, store));
  assert.deepEqual(emptyFailure.diagnostics, [{ severity: "error", message: "command failed" }]);
  await fs.rm(root, { recursive: true, force: true });
});

test("exec classifies TypeScript failures and gives a result retrieval command", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "typescript" });
  const result = structured(await callLocalTool("mottainai_exec", { command: "printf 'src/a.ts(1,1): error TS2322: bad type\\n' >&2; exit 1" }, config, store));
  assert.equal(result.failure_classification, "typescript");
  assert.deepEqual(result.diagnostics, [{ severity: "error", message: "src/a.ts(1,1): error TS2322: bad type" }]);
  assert.equal(result.next_command, 'mottainai_result_get id=mx_typescript query="error TS"');
  await fs.rm(root, { recursive: true, force: true });
});

test("exec diagnoses missing dist artifacts from package build scripts", async () => {
  const { root, config } = await workspace();
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
  const store = new InMemoryArtifactStore({ createId: () => "dist" });
  const result = structured(await callLocalTool("mottainai_exec", { command: "printf \"Error: Cannot find module 'dist/index.js'\\n\" >&2; exit 1" }, config, store));
  assert.equal(result.failure_classification, "missing_build_artifact");
  assert.deepEqual(result.facts, [{ kind: "missing_build_artifacts", paths: ["dist/index.js"] }, { kind: "recovery_commands", commands: ["pnpm run build"] }]);
  assert.equal(result.next_command, "pnpm run build");
  await fs.rm(root, { recursive: true, force: true });
});

test("exec preserves Git conflict output without compression", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "conflict" });
  const command = "printf 'CONFLICT (content): Merge conflict in src/a.ts\\n<<<<<<< HEAD\\nleft\\n=======\\nright\\n>>>>>>> branch\\n' >&2; exit 1";
  const result = structured(await callLocalTool("mottainai_exec", { command, targetTokens: 128 }, config, store));
  assert.equal(result.failure_classification, "git_conflict");
  assert.match(result.output as string, /<<<<<<< HEAD/);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.facts, [
    { kind: "unresolved_paths", paths: ["src/a.ts"] },
    { kind: "conflict_markers", count: 3 },
    { kind: "raw_artifact", retention: "full until output limit or artifact expiry" },
  ]);
  await fs.rm(root, { recursive: true, force: true });
});

test("exec captures npm output through its file redirect adapter", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "npm" });
  const result = structured(await callLocalTool("mottainai_exec", { command: "npm --version" }, config, store));
  assert.match(result.output as string, /\d+\.\d+\.\d+/);
  await fs.rm(root, { recursive: true, force: true });
});

test("exec captures every command in a package-manager command chain", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "npm-chain" });
  const result = structured(await callLocalTool("mottainai_exec", { command: "npm --version && printf chained >&2" }, config, store));
  assert.equal(result.status, "success");
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.output as string, /\d+\.\d+\.\d+/);
  assert.match(result.output as string, /chained/);
  await fs.rm(root, { recursive: true, force: true });
});

test("exec bounds generic output to its target token budget", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "budget" });
  const result = structured(await callLocalTool("mottainai_exec", { command: "yes repeated | head -n 1000", targetTokens: 300 }, config, store));
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1_300);
  await fs.rm(root, { recursive: true, force: true });
});

test("exec validates targetTokens before running the command: invalid values never invoke the command runner", async () => {
  const { root, config } = await workspace();
  const invalidValues = [-1, 0, 1, 127, 10_001, 100_000, NaN, Infinity, -Infinity, 128.5];
  for (const [index, targetTokens] of invalidValues.entries()) {
    const store = new InMemoryArtifactStore();
    const marker = path.join(root, `invalid-${index}.txt`);
    await assert.rejects(
      () => callLocalTool("mottainai_exec", { command: `touch "${marker}"`, targetTokens }, config, store),
      `targetTokens=${targetTokens} should be rejected`,
    );
    const exists = await fs.access(marker).then(() => true, () => false);
    assert.equal(exists, false, `command must not run for targetTokens=${targetTokens}`);
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("exec runs the command normally for boundary-valid targetTokens", async () => {
  const { root, config } = await workspace();
  for (const targetTokens of [128, 10_000]) {
    const store = new InMemoryArtifactStore();
    const marker = path.join(root, `valid-${targetTokens}.txt`);
    await callLocalTool("mottainai_exec", { command: `touch "${marker}"`, targetTokens }, config, store);
    assert.equal(await fs.access(marker).then(() => true, () => false), true);
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("exec keeps TAP counts and failure diagnostics structured when output is omitted (#54)", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "tap" });
  const command = [
    "printf 'TAP version 13\\nnot ok 1 - preserves failure diagnostics\\n  ---\\n  error: assertion failed\\n  ...\\n'",
    "yes '# detail' | head -n 400",
    "printf '1..1\\n# tests 1\\n# pass 0\\n# fail 1\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n'",
    "exit 1",
  ].join("; ");
  const failed = structured(await callLocalTool("mottainai_exec", { command, targetTokens: 128 }, { ...config, maxOutputBytes: 32 * 1024 }, store));
  const tests = failed.test_results as Record<string, unknown>;
  assert.equal(failed.status, "failed");
  assert.equal(failed.exit_code, 1);
  assert.equal(failed.truncated, true);
  assert.deepEqual(tests, {
    format: "tap",
    total: 1,
    pass: 0,
    fail: 1,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    failures: [{ name: "preserves failure diagnostics", diagnostic: "assertion failed" }],
    output_omitted: true,
    result_id: "mx_tap",
  });

  const success = structured(await callLocalTool(
    "mottainai_exec",
    { command: "printf 'TAP version 13\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n'" },
    config,
    new InMemoryArtifactStore({ createId: () => "tap-success" }),
  ));
  assert.equal(success.status, "success");
  assert.equal(success.exit_code, 0);
  assert.deepEqual(success.test_results, {
    format: "tap",
    total: 1,
    pass: 1,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    failures: [],
    output_omitted: false,
    result_id: "mx_tap-success",
  });
  await fs.rm(root, { recursive: true, force: true });
});

test("tapTestResults does not let a later failure's diagnostic leak into an earlier failure with none (regression)", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore({ createId: () => "tap-two-failures" });
  const command = [
    "printf 'TAP version 13\\nnot ok 1 - first failure has no diagnostic\\nnot ok 2 - second failure has a diagnostic\\n  ---\\n  error: only the second should show this\\n  ...\\nok 3 - passing test\\n'",
    "printf '1..3\\n# tests 3\\n# pass 1\\n# fail 2\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n'",
    "exit 1",
  ].join("; ");
  const failed = structured(await callLocalTool("mottainai_exec", { command }, config, store));
  const tests = failed.test_results as Record<string, unknown>;
  assert.deepEqual(tests.failures, [
    { name: "first failure has no diagnostic", diagnostic: "test failed" },
    { name: "second failure has a diagnostic", diagnostic: "only the second should show this" },
  ]);
  await fs.rm(root, { recursive: true, force: true });
});

test("runtime status reports provider health and diagnoses unhealthy upstreams", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore();
  const runtime = {
    status: () => [
      { name: "ready", state: "ready" as const, enabled: true, priority: 0, capabilities: ["code.search"], toolCount: 3, failureCount: 0 },
      { name: "off", state: "disabled" as const, enabled: false, priority: 0, capabilities: [], failureCount: 0 },
      { name: "broken", state: "unhealthy" as const, enabled: true, priority: 0, capabilities: [], failureCount: 2, lastError: "spawn missing ENOENT", lastErrorAt: "2026-07-31T00:00:00.000Z" },
    ],
  };
  const result = structured(await callLocalTool("mottainai_runtime_status", {}, config, store, runtime));
  assert.equal(result.status, "partial");
  assert.deepEqual(result.metrics, { providers: 3, ready: 1, unhealthy: 1, disabled: 1 });
  assert.deepEqual(result.diagnostics, [{ severity: "error", message: "broken unhealthy: spawn missing ENOENT" }]);
  assert.equal(result.result_id, "");

  const single = structured(await callLocalTool("mottainai_runtime_status", { provider: "ready" }, config, store, runtime));
  assert.equal(single.status, "success");
  assert.deepEqual(single.diagnostics, []);
  assert.equal((single.facts as unknown[]).length, 1);

  await assert.rejects(
    () => callLocalTool("mottainai_runtime_status", { provider: "absent" }, config, store, runtime),
    /unknown upstream: absent/,
  );
  await fs.rm(root, { recursive: true, force: true });
});

async function gitWorkspace(): Promise<{ root: string; config: ResolvedGatewayConfig }> {
  const { root, config } = await workspace();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });
  return {
    root,
    config: { ...config, worktree: { allowedBranchPrefixes: ["docs", "runtime"], baseBranch: "main", worktreeDir: ".worktrees" } },
  };
}

test("worktree_new tool is only listed when a worktree config is present", () => {
  const bareConfig: ResolvedGatewayConfig = {
    workspaceRoot: "/tmp", defaultTimeoutMs: 1_000, maxTimeoutMs: 2_000, maxOutputBytes: 1024, execTargetTokens: 1_000,
    resultTtlMs: 10_000, resultMaxEntries: 10, capabilityMap: {}, toolMetadata: {}, tokenBudgets: { tools: {}, capabilities: {}, profiles: {} },
    workflowTasks: false,
  };
  assert.equal(localToolsFor(bareConfig).some((tool) => tool.name === "mottainai_worktree_new"), false);

  const withWorktree: ResolvedGatewayConfig = { ...bareConfig, worktree: { allowedBranchPrefixes: ["docs"], baseBranch: "main", worktreeDir: ".worktrees" } };
  const tools = localToolsFor(withWorktree);
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("mottainai_worktree_new"));
  assert.ok(names.includes("mottainai_issue_view"));
});

test("worktree_new is annotated as deprecated in favor of mottainai_workflow_task_start (Issue #34), without changing its behavior", () => {
  const withWorktree: ResolvedGatewayConfig = {
    workspaceRoot: "/tmp", defaultTimeoutMs: 1_000, maxTimeoutMs: 2_000, maxOutputBytes: 1024, execTargetTokens: 1_000,
    resultTtlMs: 10_000, resultMaxEntries: 10, capabilityMap: {}, toolMetadata: {}, tokenBudgets: { tools: {}, capabilities: {}, profiles: {} },
    workflowTasks: false, worktree: { allowedBranchPrefixes: ["docs"], baseBranch: "main", worktreeDir: ".worktrees" },
  };
  const tool = localToolsFor(withWorktree).find((candidate) => candidate.name === "mottainai_worktree_new");
  assert.ok(tool !== undefined);
  assert.match(tool!.description ?? "", /Deprecated/);
  assert.match(tool!.description ?? "", /mottainai_workflow_task_start/);
  // behavior/schema unchanged: still a required prefix+task worktree-creation tool.
  assert.deepEqual(tool!.inputSchema.required, ["prefix", "task"]);
  assert.equal(tool!.annotations?.destructiveHint, false);
});

test("worktree_new creates a branch and worktree under the configured directory", async () => {
  const { root, config } = await gitWorkspace();
  const store = new InMemoryArtifactStore();
  const result = structured(await callLocalTool("mottainai_worktree_new", { prefix: "docs", task: "example-task" }, config, store));
  assert.equal(result.status, "success");
  assert.equal(result.branch, "docs/example-task");
  assert.equal(result.worktree_dir, path.join(".worktrees", "docs-example-task"));
  const branch = execFileSync("git", ["-C", path.join(root, ".worktrees", "docs-example-task"), "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(branch, "docs/example-task");
  await fs.rm(root, { recursive: true, force: true });
});

test("worktree_new rejects a branch prefix outside the configured allow-list", async () => {
  const { root, config } = await gitWorkspace();
  const store = new InMemoryArtifactStore();
  await assert.rejects(
    () => callLocalTool("mottainai_worktree_new", { prefix: "danger", task: "example" }, config, store),
    /prefix must be one of: docs, runtime/,
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("worktree_new rejects an invalid task slug", async () => {
  const { root, config } = await gitWorkspace();
  const store = new InMemoryArtifactStore();
  await assert.rejects(
    () => callLocalTool("mottainai_worktree_new", { prefix: "docs", task: "Bad Task" }, config, store),
    /invalid task slug/,
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("worktree_new throws when the workspace has no worktree config", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore();
  await assert.rejects(
    () => callLocalTool("mottainai_worktree_new", { prefix: "docs", task: "example" }, config, store),
    /worktree tool is not configured/,
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("issue_view reports a structured failure when gh fails", async () => {
  const { root, config } = await gitWorkspace();
  const store = new InMemoryArtifactStore();
  const result = structured(await callLocalTool("mottainai_issue_view", { number: 999999999 }, config, store));
  assert.equal(result.status, "failed");
  await fs.rm(root, { recursive: true, force: true });
});

test("issue_view throws when the workspace has no worktree config, matching worktree_new's guard", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore();
  await assert.rejects(
    () => callLocalTool("mottainai_issue_view", { number: 1 }, config, store),
    /issue tool is not configured/,
  );
  await fs.rm(root, { recursive: true, force: true });
});

// --- F: advertised tool surface == executable tool surface, table-driven over both configurations ---

test("the advertised tool surface matches the executable tool surface for worktree-dependent tools", async () => {
  const { root, config: bareConfig } = await workspace();
  const withWorktree: ResolvedGatewayConfig = {
    ...bareConfig,
    worktree: { allowedBranchPrefixes: ["docs"], baseBranch: "main", worktreeDir: ".worktrees" },
  };
  const store = new InMemoryArtifactStore();
  const guardedTools: Array<{ name: string; args: Record<string, unknown>; enabled: (config: ResolvedGatewayConfig) => boolean }> = [
    { name: "mottainai_worktree_new", args: { prefix: "docs", task: "example" }, enabled: (config) => config.worktree !== undefined },
    { name: "mottainai_issue_view", args: { number: 1 }, enabled: (config) => config.worktree !== undefined },
  ];
  const configs = [bareConfig, withWorktree];

  for (const config of configs) {
    const advertisedNames = new Set(localToolsFor(config).map((tool) => tool.name));
    for (const tool of guardedTools) {
      const isAdvertised = advertisedNames.has(tool.name);
      assert.equal(isAdvertised, tool.enabled(config), `${tool.name} advertised state must track its gating config field`);
      if (!isAdvertised) {
        // hidden from localToolsFor: calling it directly by name must still be rejected by the
        // same runtime guard, so the advertised and executable surfaces stay in lockstep.
        await assert.rejects(
          () => callLocalTool(tool.name, tool.args, config, store),
          /not configured/,
        );
      }
    }
  }
  // every tool in allLocalTools is reachable through localToolsFor under some configuration.
  const everAdvertised = new Set(configs.flatMap((config) => localToolsFor(config).map((tool) => tool.name)));
  for (const tool of allLocalTools) assert.ok(everAdvertised.has(tool.name), `${tool.name} must be advertised under some configuration`);
  await fs.rm(root, { recursive: true, force: true });
});

// --- H: contextLines / maxResults validation and parseRgJson context association ---

test("search rejects out-of-range contextLines and maxResults without relying solely on JSON schema", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore();
  for (const contextLines of [-1, 21, 2.5, NaN, Infinity, -Infinity]) {
    await assert.rejects(() => callLocalTool("mottainai_search", { query: "needle", contextLines }, config, store));
  }
  for (const maxResults of [0, -1, 101, 2.5, NaN, Infinity, -Infinity]) {
    await assert.rejects(() => callLocalTool("mottainai_search", { query: "needle", maxResults }, config, store));
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("search accepts boundary-valid contextLines and maxResults", async (t) => {
  const { root, config } = await workspace();
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
  } catch {
    await fs.rm(root, { recursive: true, force: true });
    t.skip("rg is not installed");
    return;
  }
  const store = new InMemoryArtifactStore();
  for (const contextLines of [0, 20]) {
    const result = structured(await callLocalTool("mottainai_search", { query: "needle", contextLines }, config, store));
    assert.notEqual(result.status, undefined);
  }
  for (const maxResults of [1, 100]) {
    const result = structured(await callLocalTool("mottainai_search", { query: "needle", maxResults }, config, store));
    assert.notEqual(result.status, undefined);
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("search contextLines has an observable effect on the returned match context", async (t) => {
  const { root, config } = await workspace();
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
  } catch {
    await fs.rm(root, { recursive: true, force: true });
    t.skip("rg is not installed");
    return;
  }
  await fs.writeFile(path.join(root, "context.txt"), "line1\nline2\nneedle\nline4\nline5\n");
  const store = new InMemoryArtifactStore();
  const withoutContext = structured(await callLocalTool("mottainai_search", { query: "needle", path: "context.txt" }, config, store));
  const noContextGroups = withoutContext.groups as Array<{ matches: Array<{ context?: unknown }> }>;
  assert.equal(noContextGroups[0].matches[0].context, undefined);

  const withContext = structured(await callLocalTool("mottainai_search", { query: "needle", path: "context.txt", contextLines: 1 }, config, store));
  const contextGroups = withContext.groups as Array<{ matches: Array<{ context?: Array<{ line: number; text: string }> }> }>;
  const contextTexts = (contextGroups[0].matches[0].context ?? []).map((entry) => entry.text);
  assert.deepEqual(contextTexts, ["line2", "line4"]);
  await fs.rm(root, { recursive: true, force: true });
});

function rgEvent(type: "match" | "context", filePath: string, line: number, text: string): string {
  return JSON.stringify({ type, data: { path: { text: filePath }, line_number: line, lines: { text } } });
}

test("parseRgJson: zero context lines yields matches with no context field", () => {
  const raw = [rgEvent("match", "/root/file.txt", 5, "needle here")].join("\n");
  const groups = parseRgJson(raw, "/root", 0);
  assert.deepEqual(groups, [{ path: "file.txt", matches: [{ line: 5, text: "needle here" }] }]);
});

test("parseRgJson: before and after context lines attach to the correct match", () => {
  const raw = [
    rgEvent("context", "/root/file.txt", 3, "before-2"),
    rgEvent("context", "/root/file.txt", 4, "before-1"),
    rgEvent("match", "/root/file.txt", 5, "needle here"),
    rgEvent("context", "/root/file.txt", 6, "after-1"),
    rgEvent("context", "/root/file.txt", 7, "after-2"),
  ].join("\n");
  const groups = parseRgJson(raw, "/root", 2);
  assert.deepEqual(groups, [{
    path: "file.txt",
    matches: [{
      line: 5,
      text: "needle here",
      context: [
        { line: 3, text: "before-2" },
        { line: 4, text: "before-1" },
        { line: 6, text: "after-1" },
        { line: 7, text: "after-2" },
      ],
    }],
  }]);
});

test("parseRgJson: multiple distant match groups in the same file keep their own context separate", () => {
  const raw = [
    rgEvent("context", "/root/file.txt", 8, "before-match-1"),
    rgEvent("match", "/root/file.txt", 10, "first needle"),
    rgEvent("context", "/root/file.txt", 12, "after-match-1"),
    rgEvent("context", "/root/file.txt", 48, "before-match-2"),
    rgEvent("match", "/root/file.txt", 50, "second needle"),
    rgEvent("context", "/root/file.txt", 52, "after-match-2"),
  ].join("\n");
  const groups = parseRgJson(raw, "/root", 2);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].matches, [
    { line: 10, text: "first needle", context: [{ line: 8, text: "before-match-1" }, { line: 12, text: "after-match-1" }] },
    { line: 50, text: "second needle", context: [{ line: 48, text: "before-match-2" }, { line: 52, text: "after-match-2" }] },
  ]);
});

// --- I: malformed / incomplete gh JSON output must not escape as an unstructured exception ---

test("parseIssueViewOutput returns a structured failure for malformed JSON", () => {
  const result = parseIssueViewOutput("not json at all {");
  assert.deepEqual(result, { ok: false, reason: "unparsable JSON output" });
});

test("parseIssueViewOutput returns a structured failure and defaults labels safely for missing fields", () => {
  const missingRequired = parseIssueViewOutput(JSON.stringify({ number: 1, title: "x" }));
  assert.equal(missingRequired.ok, false);

  const missingLabels = parseIssueViewOutput(JSON.stringify({
    number: 42, title: "no labels field", state: "OPEN", url: "https://example.test/1", body: "body text",
  }));
  assert.deepEqual(missingLabels, {
    ok: true,
    issue: { number: 42, title: "no labels field", state: "OPEN", labels: [], url: "https://example.test/1", body: "body text" },
  });
});

test("parseIssueViewOutput parses valid gh output including labels", () => {
  const result = parseIssueViewOutput(JSON.stringify({
    number: 7, title: "valid issue", state: "OPEN", url: "https://example.test/7", body: "body",
    labels: [{ name: "bug" }, { name: "P1" }],
  }));
  assert.deepEqual(result, {
    ok: true,
    issue: { number: 7, title: "valid issue", state: "OPEN", labels: ["bug", "P1"], url: "https://example.test/7", body: "body" },
  });
});

// --- J: output byte accounting must use byte length, not JS string length, for multibyte content ---

test("exec keeps combined stdout+stderr within maxOutputBytes for multibyte content", async () => {
  const { root, config } = await workspace();
  const store = new InMemoryArtifactStore();
  // 日本語 characters are >1 byte in UTF-8 but 1 UTF-16 code unit each; this exercises the
  // package-manager (file-redirect) path in runShell, whose budgeting used to be string-length based.
  const stdoutText = "あ".repeat(500);
  const stderrText = "い".repeat(500);
  const limitedConfig = { ...config, maxOutputBytes: 800 };
  const result = structured(await callLocalTool(
    "mottainai_exec",
    { command: `npm --version >/dev/null; printf '${stdoutText}'; printf '${stderrText}' >&2`, targetTokens: 10_000, compression: false },
    limitedConfig,
    store,
  ));
  const stdoutBytes = (result.metrics as Record<string, number>).stdout_bytes;
  const stderrBytes = (result.metrics as Record<string, number>).stderr_bytes;
  assert.ok(stdoutBytes + stderrBytes <= limitedConfig.maxOutputBytes, `stdout(${stdoutBytes})+stderr(${stderrBytes}) must stay within maxOutputBytes(${limitedConfig.maxOutputBytes})`);
  await fs.rm(root, { recursive: true, force: true });
});
