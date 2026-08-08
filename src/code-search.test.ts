import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildCapabilityIndex } from "./adaptive/capabilities.js";
import { callCodeSearchTool, dispatchCodeSearchTool } from "./code-search.js";
import type { CodeSearchContext } from "./code-search.js";
import { buildCatalog } from "./catalog.js";
import type { ResolvedGatewayConfig } from "./config.js";
import { DEFAULT_BURST_BUDGET_POLICY } from "./context-runtime/burst-budget.js";
import { DEFAULT_AWAIT_POLICY } from "./context-runtime/poll-policy.js";
import { InMemoryArtifactStore } from "./retrieve.js";
import { UpstreamRegistry } from "./upstream.js";
import type { UpstreamHandle } from "./upstream.js";

function gatewayConfig(root: string): ResolvedGatewayConfig {
  return {
    workspaceRoot: root, defaultTimeoutMs: 5_000, maxTimeoutMs: 5_000, maxOutputBytes: 1024 * 1024,
    execTargetTokens: 1_000, resultTtlMs: 10_000, resultMaxEntries: 10,
    capabilityMap: {}, toolMetadata: {}, tokenBudgets: { tools: {}, capabilities: {}, profiles: {} }, workflowTasks: false,
    await: DEFAULT_AWAIT_POLICY, burstBudget: DEFAULT_BURST_BUDGET_POLICY,
  };
}

async function workspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mottainai-code-search-"));
}

function fakeHandle(name: string, callTool: UpstreamHandle["client"]["callTool"]): UpstreamHandle {
  return { config: { name, command: "noop" }, client: { callTool } as unknown as UpstreamHandle["client"], tools: [] };
}

function registryFromHandles(handles: UpstreamHandle[]): UpstreamRegistry {
  const byName = new Map(handles.map((handle) => [handle.config.name, handle]));
  return new UpstreamRegistry(handles.map((handle) => handle.config), async (config) => {
    const handle = byName.get(config.name);
    if (!handle) throw new Error(`missing fake upstream: ${config.name}`);
    return handle;
  });
}

function structured(result: Awaited<ReturnType<typeof callCodeSearchTool>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

async function context(root: string, handles: UpstreamHandle[] = [], capabilityMapEntries: Record<string, string[]> = {}): Promise<CodeSearchContext> {
  const upstreams = registryFromHandles(handles);
  const config = gatewayConfig(root);
  return {
    upstreams,
    logger: { async log() {} },
    artifactStore: new InMemoryArtifactStore({ createId: () => "cs" }),
    catalog: async () => buildCatalog(
      await Promise.all(handles.map(async (handle) => ({ ...handle, tools: (await upstreams.start(handle.config.name)).tools }))),
      upstreams.configs(),
      capabilityMapEntries,
    ),
    capabilityIndex: buildCapabilityIndex(upstreams.configs(), capabilityMapEntries),
    gatewayConfig: config,
  };
}

test("mottainai_code_search finds a literal match with rg when no other backend is configured", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "needle.txt"), "one\nneedle here\nthree\n");
  const ctx = await context(root);
  const result = structured(await callCodeSearchTool("mottainai_code_search", { pattern: "needle" }, ctx));
  assert.equal(result.backend, "rg");
  assert.equal(result.routing_reason, "text_matches_rank_1");
  assert.deepEqual(result.fallback_history, []);
  assert.equal((result.facts as unknown[]).length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("mottainai_code_search with scope=tracked uses git grep and ignores untracked files", async () => {
  const root = await workspace();
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "a@b.c"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  await fs.writeFile(path.join(root, "tracked.txt"), "needle in tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  await fs.writeFile(path.join(root, "untracked.txt"), "needle in untracked\n");

  const ctx = await context(root);
  const result = structured(await callCodeSearchTool("mottainai_code_search", { pattern: "needle", scope: "tracked" }, ctx));
  assert.equal(result.backend, "git_grep");
  assert.equal(result.routing_reason, "scope_tracked");
  const facts = result.facts as Array<{ path: string }>;
  assert.deepEqual(facts.map((f) => f.path), ["tracked.txt"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("mottainai_code_search reports ast-grep failure without a lossy rg fallback", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "sample.txt"), "function useState() {}\n");
  const ctx = await context(root);
  const result = structured(await callCodeSearchTool(
    "mottainai_code_search", { pattern: "useState", kind: "ast" }, ctx,
  ));
  assert.equal(result.status, "failed");
  assert.equal(result.backend, undefined);
  const history = result.fallback_history as Array<{ provider: string; tool: string; error: string }>;
  assert.equal(history.length, 1);
  assert.equal(history[0].provider, "ast_grep");
  await fs.rm(root, { recursive: true, force: true });
});

test("mottainai_code_symbol falls back to rg text search of the symbol name when no relation provider is configured", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "sample.ts"), "export function useful() { return 1; }\n");
  const ctx = await context(root);
  const result = structured(await callCodeSearchTool("mottainai_code_symbol", { symbol: "useful" }, ctx));
  assert.equal(result.backend, "rg");
  assert.equal(result.routing_reason, "symbol_backend_unavailable_fallback_to_text_search");
  assert.equal((result.facts as unknown[]).length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("mottainai_code_symbol routes to the configured capability provider and preserves the raw upstream result", async () => {
  const root = await workspace();
  const handle = fakeHandle("codegraph", async (request) => ({
    content: [{ type: "text", text: JSON.stringify({ callers: [{ file: "src/a.ts", line: 3 }] }) }],
    _meta: { requestedTool: request.name, requestedArgs: request.arguments },
  }));
  const ctx = await context(root, [handle], { codegraph__find_callers: ["callers"] });
  const result = structured(await callCodeSearchTool("mottainai_code_symbol", { symbol: "useful", relation: "callers" }, ctx));
  assert.equal(result.backend, "codegraph");
  assert.equal(result.routing_reason, "callers_rank_1");
  assert.ok(result.raw);
  await fs.rm(root, { recursive: true, force: true });
});

test("dispatchCodeSearchTool reports the actual selected provider/tool, not the gateway tool name (issue #47/#48)", async () => {
  const root = await workspace();
  const handle = fakeHandle("codegraph", async (request) => ({
    content: [{ type: "text", text: JSON.stringify({ callers: [{ file: "src/a.ts", line: 3 }] }) }],
    _meta: { requestedTool: request.name, requestedArgs: request.arguments },
  }));
  const ctx = await context(root, [handle], { codegraph__find_callers: ["callers"] });
  const outcome = await dispatchCodeSearchTool("mottainai_code_symbol", { symbol: "useful", relation: "callers" }, ctx);
  assert.deepEqual(outcome.routing, { provider: "codegraph", tool: "codegraph__find_callers", backend: "codegraph" });
  await fs.rm(root, { recursive: true, force: true });
});

test("mottainai_code_symbol falls back to rg when the configured provider connection fails", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "sample.ts"), "export function useful() { return 1; }\n");
  const upstreams = new UpstreamRegistry(
    [{ name: "codegraph", command: "noop", capabilities: [] }],
    async () => { throw new Error("spawn failed: ENOENT"); },
  );
  const config = gatewayConfig(root);
  const ctx: CodeSearchContext = {
    upstreams,
    logger: { async log() {} },
    artifactStore: new InMemoryArtifactStore({ createId: () => "cs" }),
    catalog: async () => buildCatalog([], upstreams.configs(), { codegraph__find_callers: ["callers"] }),
    capabilityIndex: buildCapabilityIndex(upstreams.configs(), { codegraph__find_callers: ["callers"] }),
    gatewayConfig: config,
  };
  const result = structured(await callCodeSearchTool("mottainai_code_symbol", { symbol: "useful", relation: "callers" }, ctx));
  assert.equal(result.backend, "rg");
  const history = result.fallback_history as Array<{ provider: string; error: string }>;
  assert.equal(history.length, 1);
  assert.equal(history[0].provider, "codegraph");
  assert.match(history[0].error, /spawn failed/);
  await fs.rm(root, { recursive: true, force: true });
});
