import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { callLocalTool, localTools, localToolsFor } from "./local-tools.js";
import type { ResolvedGatewayConfig } from "./config.js";
import { InMemoryArtifactStore } from "./retrieve.js";

async function workspace(): Promise<{ root: string; config: ResolvedGatewayConfig }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-local-tools-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "src", "sample.ts"), "export function useful() {\n  return 1;\n}\nexport const value = 2;\n");
  await fs.writeFile(path.join(root, "needle.txt"), "one\nneedle here\nthree\n");
  await fs.writeFile(path.join(root, "node_modules", "ignored.txt"), "needle ignored");
  return { root, config: { workspaceRoot: root, defaultTimeoutMs: 1_000, maxTimeoutMs: 2_000, maxOutputBytes: 1024, execTargetTokens: 1_000, resultTtlMs: 10_000, resultMaxEntries: 10, capabilityMap: {}, toolMetadata: {}, tokenBudgets: { tools: {}, capabilities: {}, profiles: {} } } };
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

test("search groups rg matches and list omits dependency directories", async () => {
  const { root, config } = await workspace();
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
  } catch {
    await fs.rm(root, { recursive: true, force: true });
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

test("search caps total matches across files at maxResults and reports truncation", async () => {
  const { root, config } = await workspace();
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
  } catch {
    await fs.rm(root, { recursive: true, force: true });
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
  const limitedConfig = { ...config, maxOutputBytes: 20, defaultTimeoutMs: 50, maxTimeoutMs: 50 };
  const limited = structured(await callLocalTool("mottainai_exec", { command: "yes x" }, limitedConfig, store));
  assert.equal(limited.output_limited, true);
  const timed = structured(await callLocalTool("mottainai_exec", { command: "sleep 1" }, limitedConfig, store));
  assert.equal(timed.timed_out, true);
  const stubborn = structured(await callLocalTool(
    "mottainai_exec",
    { command: `${process.execPath} -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'` },
    limitedConfig,
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
  };
  assert.equal(localToolsFor(bareConfig).some((tool) => tool.name === "mottainai_worktree_new"), false);

  const withWorktree: ResolvedGatewayConfig = { ...bareConfig, worktree: { allowedBranchPrefixes: ["docs"], baseBranch: "main", worktreeDir: ".worktrees" } };
  const names = localToolsFor(withWorktree).map((tool) => tool.name);
  assert.ok(names.includes("mottainai_worktree_new"));
  assert.ok(names.includes("mottainai_issue_view"));
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
