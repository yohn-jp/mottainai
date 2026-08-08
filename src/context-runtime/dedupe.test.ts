import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveGatewayConfig } from "../config.js";
import { callLocalTool } from "../local-tools.js";
import { InMemoryArtifactStore } from "../retrieve.js";
import { finalizeToolResult } from "./adapter.js";
import { IdentitySession } from "./dedupe.js";
import { createIdentityHint } from "./identity.js";
import type { IdentityDedupeContext } from "./adapter.js";

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function readResult(
  store: InMemoryArtifactStore,
  input: {
    contentId: string;
    projectionKey: string;
    sourceKey?: string;
    text?: string;
    diagnostics?: unknown[];
    ifChangedFrom?: string;
  },
) {
  const resultId = store.putArtifact({ text: input.text ?? "source body\n", metadata: { operation: "read" } });
  return {
    content: [{ type: "text" as const, text: "read result" }],
    structuredContent: {
      operation: "read",
      status: "success",
      summary: "src/example.ts",
      facts: [],
      diagnostics: input.diagnostics ?? [],
      metrics: {},
      result_id: resultId,
      truncated: false,
      path: "src/example.ts",
      mode: "raw",
      text: input.text ?? "source body\n",
      identity: createIdentityHint({
        content_id: input.contentId,
        adapter: "local_file_read_v1",
        source_key: input.sourceKey ?? "file:src/example.ts",
        projection_key: input.projectionKey,
        ...(input.ifChangedFrom === undefined ? {} : { if_changed_from: input.ifChangedFrom }),
      }),
    },
  };
}

function context(session: IdentitySession, telemetry?: IdentityDedupeContext["telemetry"]): IdentityDedupeContext {
  return { session, adapter: "local_file_read_v1", telemetry };
}

function storedContext(session: IdentitySession): IdentityDedupeContext {
  return { session, adapter: "stored_artifact_v1" };
}

test("same content and projection returns unchanged compact response with backing retrieval", () => {
  const store = new InMemoryArtifactStore({ createId: (() => {
    let count = 0;
    return () => `dedupe-${++count}`;
  })() });
  const config = resolveGatewayConfig({ workspaceRoot: process.cwd(), responseBudget: { hardBytes: 12_000 } });
  const session = new IdentitySession();

  const first = finalizeToolResult(readResult(store, {
    contentId: "ci1:sha256:same",
    projectionKey: "rk1:same",
    text: "source body\n".repeat(400),
  }), config, store, undefined, context(session));
  const firstStructured = structured(first.result);
  const firstIdentity = firstStructured.identity as Record<string, unknown>;
  assert.equal(firstIdentity.changed, true);

  const second = finalizeToolResult(readResult(store, {
    contentId: "ci1:sha256:same",
    projectionKey: "rk1:same",
    text: "source body\n".repeat(400),
  }), config, store, undefined, context(session));
  const secondStructured = structured(second.result);
  const secondIdentity = secondStructured.identity as Record<string, unknown>;
  assert.equal(secondStructured.status, "unchanged");
  assert.equal(secondIdentity.changed, false);
  assert.equal(secondStructured.result_id, firstStructured.result_id);
  assert.equal("text" in secondStructured, false);
  assert.equal((second.result.content ?? []).length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(second.result), "utf8") < Buffer.byteLength(JSON.stringify(first.result), "utf8") / 3);
  assert.match(String(store.retrieve(String(secondStructured.result_id))?.text), /source body/);
});

test("projection policy/version changes and changed diagnostics never deduplicate", () => {
  const store = new InMemoryArtifactStore({ createId: (() => {
    let count = 0;
    return () => `policy-${++count}`;
  })() });
  const config = resolveGatewayConfig({ workspaceRoot: process.cwd() });
  const session = new IdentitySession();
  const first = finalizeToolResult(readResult(store, { contentId: "ci1:sha256:same", projectionKey: "rk1:a" }), config, store, undefined, context(session));
  const firstIdentity = structured(first.result).identity as Record<string, unknown>;

  const policyChanged = finalizeToolResult(readResult(store, { contentId: "ci1:sha256:same", projectionKey: "rk1:b" }), config, store, undefined, context(session));
  const policyIdentity = structured(policyChanged.result).identity as Record<string, unknown>;
  assert.equal(policyIdentity.changed, true);
  assert.notEqual(policyIdentity.projection_id, firstIdentity.projection_id);

  const diagnosticsChanged = finalizeToolResult(readResult(store, {
    contentId: "ci1:sha256:same",
    projectionKey: "rk1:a",
    diagnostics: [{ severity: "warning", message: "changed diagnostic" }],
  }), config, store, undefined, context(session));
  const diagnosticIdentity = structured(diagnosticsChanged.result).identity as Record<string, unknown>;
  assert.equal(diagnosticIdentity.changed, true);
  assert.notEqual(diagnosticIdentity.projection_id, firstIdentity.projection_id);
});

test("ifChangedFrom supports stateless conditional identity and session reset/connection isolation", () => {
  const config = resolveGatewayConfig({ workspaceRoot: process.cwd() });
  const firstStore = new InMemoryArtifactStore({ createId: () => "conditional-first" });
  const firstSession = new IdentitySession();
  const first = finalizeToolResult(readResult(firstStore, { contentId: "ci1:sha256:conditional", projectionKey: "rk1:conditional" }), config, firstStore, undefined, context(firstSession));
  const identityId = String((structured(first.result).identity as Record<string, unknown>).id);

  const statelessStore = new InMemoryArtifactStore({ createId: () => "conditional-current" });
  const stateless = finalizeToolResult(readResult(statelessStore, {
    contentId: "ci1:sha256:conditional",
    projectionKey: "rk1:conditional",
    ifChangedFrom: identityId,
  }), config, statelessStore, undefined, context(new IdentitySession()));
  assert.equal(structured(stateless.result).status, "unchanged");
  assert.equal(structured(stateless.result).result_id, "mx_conditional-current");

  firstSession.reset();
  const afterReset = finalizeToolResult(readResult(firstStore, { contentId: "ci1:sha256:conditional", projectionKey: "rk1:conditional" }), config, firstStore, undefined, context(firstSession));
  assert.equal((structured(afterReset.result).identity as Record<string, unknown>).changed, true);

  const isolated = finalizeToolResult(readResult(firstStore, { contentId: "ci1:sha256:conditional", projectionKey: "rk1:conditional" }), config, firstStore, undefined, context(new IdentitySession()));
  assert.equal((structured(isolated.result).identity as Record<string, unknown>).changed, true);
});

test("dedupe telemetry records only compact counters and avoids no hashes/body", () => {
  const store = new InMemoryArtifactStore({ createId: (() => {
    let count = 0;
    return () => `telemetry-${++count}`;
  })() });
  const config = resolveGatewayConfig({ workspaceRoot: process.cwd() });
  const session = new IdentitySession();
  const records: Array<{ hit: boolean; bytesAvoided: number; estimatedTokensAvoided: number }> = [];
  const telemetry = { recordDedupe(input: (typeof records)[number]): void { records.push(input); } };
  finalizeToolResult(readResult(store, {
    contentId: "ci1:sha256:telemetry",
    projectionKey: "rk1:telemetry",
    text: "private body should not be telemetry\n".repeat(100),
  }), config, store, undefined, context(session, telemetry));
  finalizeToolResult(readResult(store, {
    contentId: "ci1:sha256:telemetry",
    projectionKey: "rk1:telemetry",
    text: "private body should not be telemetry\n".repeat(100),
  }), config, store, undefined, context(session, telemetry));
  assert.deepEqual(records.map((record) => record.hit), [false, true]);
  assert.ok(records[1].bytesAvoided > 0);
  assert.ok(records[1].estimatedTokensAvoided > 0);
  assert.equal(JSON.stringify(records).includes("private body"), false);
  assert.equal(JSON.stringify(records).includes("sha256"), false);
});

test("local read integration materially reduces repeated visible bytes and tokens", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-dedupe-integration-"));
  try {
    const filePath = path.join(root, "sample.txt");
    await fs.writeFile(filePath, "line with enough visible content\n".repeat(180));
    const config = resolveGatewayConfig({
      workspaceRoot: root,
      responseBudget: { softTokens: 4_000, hardTokens: 6_000, hardBytes: 24_000 },
    });
    const store = new InMemoryArtifactStore({ createId: (() => {
      let count = 0;
      return () => `integration-${++count}`;
    })() });
    const session = new IdentitySession();
    const firstRaw = await callLocalTool("mottainai_read", { path: "sample.txt", mode: "raw" }, config, store);
    const first = finalizeToolResult(firstRaw, config, store, undefined, context(session));
    const secondRaw = await callLocalTool("mottainai_read", { path: "sample.txt", mode: "raw" }, config, store);
    const second = finalizeToolResult(secondRaw, config, store, undefined, context(session));
    const firstBytes = Buffer.byteLength(JSON.stringify(first.result), "utf8");
    const secondBytes = Buffer.byteLength(JSON.stringify(second.result), "utf8");
    const firstStructured = structured(first.result);
    const secondStructured = structured(second.result);
    assert.ok(firstStructured.identity, JSON.stringify(firstStructured));
    assert.ok(secondStructured.identity, JSON.stringify(secondStructured));
    assert.deepEqual(
      (secondStructured.identity as Record<string, unknown>).projection_id,
      (firstStructured.identity as Record<string, unknown>).projection_id,
      JSON.stringify({ first: firstStructured.identity, second: secondStructured.identity }),
    );
    assert.equal(secondStructured.status, "unchanged");
    assert.ok(secondBytes < firstBytes / 3, `expected ${secondBytes} < ${firstBytes / 3}`);
    assert.ok(Math.ceil(secondBytes / 4) < Math.ceil(firstBytes / 4) / 3);
    assert.equal(secondStructured.result_id, firstStructured.result_id);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("result_get on two different read ranges of the same unchanged file never collapses to unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-dedupe-range-collision-"));
  try {
    const filePath = path.join(root, "sample.txt");
    const lines = Array.from({ length: 200 }, (_, index) => `line-${index + 1}`);
    await fs.writeFile(filePath, `${lines.join("\n")}\n`);
    const config = resolveGatewayConfig({ workspaceRoot: root });
    const store = new InMemoryArtifactStore({ createId: (() => {
      let count = 0;
      return () => `range-${++count}`;
    })() });
    const session = new IdentitySession();

    const readA = structured(
      await callLocalTool("mottainai_read", { path: "sample.txt", mode: "raw", startLine: 1, endLine: 5 }, config, store),
    );
    const readB = structured(
      await callLocalTool("mottainai_read", { path: "sample.txt", mode: "raw", startLine: 100, endLine: 104 }, config, store),
    );
    // Both ranges come from the same unchanged, untracked file: whole-file content_id is identical.
    assert.deepEqual(
      (readA.identity as Record<string, unknown>).content_id,
      (readB.identity as Record<string, unknown>).content_id,
    );
    assert.notEqual(readA.text, readB.text);

    const getA = structured(await callLocalTool("mottainai_result_get", { id: readA.result_id }, config, store));
    const finalizedA = finalizeToolResult(
      { content: [{ type: "text", text: "a" }], structuredContent: getA },
      config,
      store,
      undefined,
      storedContext(session),
    );
    const getB = structured(await callLocalTool("mottainai_result_get", { id: readB.result_id }, config, store));
    const finalizedB = finalizeToolResult(
      { content: [{ type: "text", text: "b" }], structuredContent: getB },
      config,
      store,
      undefined,
      storedContext(session),
    );

    const structuredB = structured(finalizedB.result);
    assert.notEqual(structuredB.status, "unchanged", JSON.stringify(structuredB));
    assert.equal(structuredB.text, getB.text);
    assert.equal(structured(finalizedA.result).status === "unchanged", false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a file rewritten between hash inspection and authorized read never carries stale identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-dedupe-toctou-"));
  try {
    const filePath = path.join(root, "sample.txt");
    await fs.writeFile(filePath, "original content\n".repeat(50));
    const config = resolveGatewayConfig({ workspaceRoot: root });
    const store = new InMemoryArtifactStore();

    const { inspectReadFile } = await import("./read-adapter.js");
    const inspected = await inspectReadFile(filePath);
    // Simulate a concurrent writer mutating the file after the hash/snapshot was taken
    // but before readTool's authorized read materializes the returned bytes.
    await fs.writeFile(filePath, "rewritten by a concurrent process\n".repeat(50));

    const result = structured(await callLocalTool("mottainai_read", { path: "sample.txt", mode: "raw" }, config, store));
    // readTool re-inspects on its own, so this call alone would not reproduce the race;
    // assert directly against the snapshot captured before the rewrite to prove detection.
    const { verifyFileSnapshotUnchanged } = await import("./read-adapter.js");
    assert.equal(await verifyFileSnapshotUnchanged(filePath, inspected.snapshot), false);
    assert.match(String(result.text), /rewritten by a concurrent process/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verifyFileSnapshotUnchanged fails closed when size, mtime, or inode diverge from the hashed snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-snapshot-verify-"));
  try {
    const filePath = path.join(root, "sample.txt");
    await fs.writeFile(filePath, "stable content\n");
    const { inspectReadFile, verifyFileSnapshotUnchanged } = await import("./read-adapter.js");
    const inspected = await inspectReadFile(filePath);
    assert.equal(await verifyFileSnapshotUnchanged(filePath, inspected.snapshot), true);

    await fs.writeFile(filePath, "stable content\n2");
    assert.equal(await verifyFileSnapshotUnchanged(filePath, inspected.snapshot), false);

    await fs.rm(filePath);
    assert.equal(await verifyFileSnapshotUnchanged(filePath, inspected.snapshot), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
