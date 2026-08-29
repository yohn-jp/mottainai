import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ArtifactStore, RetrievedArtifact, RetrieveOptions, StoredArtifactInput, ArtifactSearchResult } from "./retrieve.js";
import { InMemoryArtifactStore } from "./retrieve.js";
import { resolveGatewayConfig } from "./config.js";
import { allLocalTools, callLocalTool } from "./local-tools.js";
import { applyExecutionBudget, fitsResultBudget, normalizeExecutionOutcome, providerErrorOutcome } from "./execution.js";

test("normalizeExecutionOutcome classifies successful and empty results from one evidence rule", () => {
  const success = normalizeExecutionOutcome({
    result: { content: [{ type: "text", text: "hit" }] },
    selectedProvider: "codegraph",
    selectedTool: "explore",
    capability: "definitions",
    risk: "read_only",
  });
  const empty = normalizeExecutionOutcome({
    result: { content: [] },
    selectedProvider: "codegraph",
    selectedTool: "explore",
    capability: "definitions",
    risk: "read_only",
  });

  assert.equal(success.status, "success");
  assert.equal(empty.status, "empty");
  assert.deepEqual(success.attempts, []);
});

test("normalizeExecutionOutcome preserves tool errors and fallback attempts", () => {
  const outcome = normalizeExecutionOutcome({
    result: { content: [{ type: "text", text: "bad arguments" }], isError: true },
    selectedProvider: "codegraph",
    selectedTool: "explore",
    capability: "definitions",
    risk: "unknown",
    attempts: [{ provider: "broken", tool: "explore", error: "connection reset" }],
  });

  assert.equal(outcome.status, "tool_error");
  assert.deepEqual(outcome.attempts, [{ provider: "broken", tool: "explore", error: "connection reset" }]);
});

test("providerErrorOutcome keeps provider failure distinct from tool errors", () => {
  const outcome = providerErrorOutcome({
    selectedProvider: "codegraph",
    selectedTool: "explore",
    capability: "definitions",
    risk: "read_only",
    error: "connection reset",
  });

  assert.equal(outcome.status, "provider_error");
  assert.equal(outcome.result.isError, true);
  assert.deepEqual(outcome.attempts, [{ provider: "codegraph", tool: "explore", error: "connection reset" }]);
});

test("result budgeting removes oversized metadata after preserving the full artifact", () => {
  const outcome = normalizeExecutionOutcome({
    result: { content: [{ type: "text", text: "small" }], _meta: { diagnostic: "x".repeat(8_000) } },
    selectedProvider: "codegraph",
    selectedTool: "explore",
    capability: "definitions",
    risk: "read_only",
  });
  const artifactStore = new InMemoryArtifactStore({ createId: () => "budgeted-metadata" });
  const budgeted = applyExecutionBudget(
    outcome,
    "codegraph__explore",
    "definitions",
    resolveGatewayConfig({ tokenBudgets: { default: 300 } }),
    artifactStore,
  );

  assert.equal(budgeted.decision?.truncated, true);
  assert.equal(budgeted.outcome.result._meta, undefined);
  assert.match(String(budgeted.outcome.result.content[0]?.type === "text" ? budgeted.outcome.result.content[0].text : ""), /budgeted-metadata/);
  assert.equal(artifactStore.retrieve("mx_budgeted-metadata")?.text.includes("diagnostic"), true);
});

// --- fitsResultBudget: byte-budget boundary coverage (issue: budget must include marker/escaping overhead) ---

test("fitsResultBudget: exact fit passes, one byte over fails", () => {
  const targetBytes = 100;
  const overhead = Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: "" }] }), "utf8");
  const fillLength = targetBytes - overhead;
  const exact: CallToolResult = { content: [{ type: "text", text: "x".repeat(fillLength) }] };
  assert.equal(Buffer.byteLength(JSON.stringify(exact), "utf8"), targetBytes);
  assert.equal(fitsResultBudget(exact, targetBytes), true);

  const over: CallToolResult = { content: [{ type: "text", text: "x".repeat(fillLength + 1) }] };
  assert.equal(Buffer.byteLength(JSON.stringify(over), "utf8"), targetBytes + 1);
  assert.equal(fitsResultBudget(over, targetBytes), false);
});

test("fitsResultBudget counts UTF-8 bytes, not UTF-16/string length, for Japanese text and emoji", () => {
  const text = `日本語のテキストです${"🎉".repeat(5)}`;
  const candidate: CallToolResult = { content: [{ type: "text", text }] };
  const byteLength = Buffer.byteLength(JSON.stringify(candidate), "utf8");
  assert.ok(byteLength > text.length, "multi-byte characters must inflate byte length beyond JS string length");
  assert.equal(fitsResultBudget(candidate, byteLength), true);
  assert.equal(fitsResultBudget(candidate, byteLength - 1), false);
});

test("fitsResultBudget accounts for JSON escaping overhead from quotes and backslashes", () => {
  const text = String.raw`she said "hi" \ and \n literal backslash-n, newline-heavy:` + "\n".repeat(20);
  const candidate: CallToolResult = { content: [{ type: "text", text }] };
  const jsonText = JSON.stringify(candidate);
  const byteLength = Buffer.byteLength(jsonText, "utf8");
  assert.ok(byteLength > Buffer.byteLength(text, "utf8"), "JSON escaping must add bytes beyond the raw text length");
  assert.equal(fitsResultBudget(candidate, byteLength), true);
  assert.equal(fitsResultBudget(candidate, byteLength - 1), false);
});

// --- execution result byte budget: marker/escaping overhead must be inside the budget check ---

test("applyExecutionBudget's final truncated result always fits inside targetBytes including marker overhead", () => {
  const config = resolveGatewayConfig({ tokenBudgets: { default: 300 } });
  const store = new InMemoryArtifactStore({ createId: () => "marker-overhead" });
  const outcome = normalizeExecutionOutcome({
    result: { content: [{ type: "text", text: "line one\n".repeat(2000) }] },
    selectedProvider: "local", selectedTool: "mottainai_exec", capability: "runtime_state", risk: "read_only",
  });
  const budgeted = applyExecutionBudget(outcome, "mottainai_exec", "runtime_state", config, store);
  assert.equal(budgeted.decision?.truncated, true);
  const targetBytes = (budgeted.decision?.target_tokens ?? 0) * 4;
  assert.ok(fitsResultBudget(budgeted.outcome.result, targetBytes));
});

test("execution budget never stores an unreferenced artifact when the marker-bearing result still exceeds the budget", () => {
  const inner = new InMemoryArtifactStore({ createId: () => "should-not-leak" });
  let storeCount = 0;
  const countingStore: ArtifactStore = {
    put: (result: CallToolResult, id?: string) => { storeCount += 1; return inner.put(result, id); },
    putArtifact: (artifact: StoredArtifactInput, id?: string) => { storeCount += 1; return inner.putArtifact(artifact, id); },
    getStoredArtifactBytes: (id: string) => inner.getStoredArtifactBytes(id),
    retrieve: (id: string, options?: RetrieveOptions): RetrievedArtifact | undefined => inner.retrieve(id, options),
    search: (query: string, maxResults?: number): ArtifactSearchResult[] => inner.search(query, maxResults),
    nextId: () => inner.nextId(),
  };
  // 40-byte budget: far too small for even a single compaction marker, so the with-marker
  // path must never fit and must therefore never call put/putArtifact for it.
  const config = resolveGatewayConfig({ tokenBudgets: { default: 10 } });
  const outcome = normalizeExecutionOutcome({
    result: { content: [{ type: "text", text: "line one\n".repeat(2000) }] },
    selectedProvider: "local", selectedTool: "mottainai_exec", capability: "runtime_state", risk: "read_only",
  });
  const budgeted = applyExecutionBudget(outcome, "mottainai_exec", "runtime_state", config, countingStore);
  assert.equal(budgeted.decision?.truncated, true);
  assert.equal(storeCount, 1, "only the single referenced fallback artifact should ever be stored");
});

test("budgeted results reference mottainai_result_get, never the unregistered mottainai_retrieve", () => {
  const config = resolveGatewayConfig({ tokenBudgets: { default: 300 } });
  const store = new InMemoryArtifactStore({ createId: () => "retrieve-name" });
  const outcome = normalizeExecutionOutcome({
    result: { content: [{ type: "text", text: "line one\n".repeat(2000) }] },
    selectedProvider: "local", selectedTool: "mottainai_exec", capability: "runtime_state", risk: "read_only",
  });
  const budgeted = applyExecutionBudget(outcome, "mottainai_exec", "runtime_state", config, store);
  const text = budgeted.outcome.result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  assert.match(text, /retrieve=mottainai_result_get/);
  assert.doesNotMatch(text, /mottainai_retrieve\b/);
});

// --- consistency: every tool name referenced by a generated retrieval marker must be both
// advertised (localToolsFor) and dispatchable (callLocalTool's switch) ---

test("every retrieval tool name referenced in execution.ts markers is advertised and dispatchable", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const executionSource = await fs.readFile(path.join(here, "execution.ts"), "utf8");

  const referencedNames = [...executionSource.matchAll(/retrieve=([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  assert.ok(referencedNames.length > 0, "expected at least one retrieval marker in execution.ts");

  const advertisedNames = new Set(allLocalTools.map((tool) => tool.name));
  const config = resolveGatewayConfig({});
  const store = new InMemoryArtifactStore();

  for (const name of referencedNames) {
    assert.ok(advertisedNames.has(name), `${name} must be in the advertised local tool surface`);
    // Behavioral dispatchability check: call the tool with no arguments and assert the
    // rejection is not "Unknown local tool" — any other rejection (e.g. a missing required
    // argument) proves callLocalTool's switch actually routed to the tool's implementation.
    await assert.rejects(
      () => callLocalTool(name, {}, config, store),
      (error: unknown) => error instanceof Error && error.message !== `Unknown local tool: ${name}`,
      `${name} must be dispatchable by callLocalTool`,
    );
  }
});
