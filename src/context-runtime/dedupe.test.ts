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

// `fs.readFile` は read-adapter.ts が `import fs from "node:fs/promises"` で束縛
// するのと同一のモジュール namespace object を指す。default export のプロパティ
// は書き換え可能なため、readTool の実経路上で inspectReadFile が hash を確定
// させた後・readAuthorizedFile がその bytes を実際に materialize する直前に
// mutation を注入する race hook として使える（raw mode かつ範囲未指定の read は
// readAuthorizedFile 内部で fs.readFile を呼ぶ）。
async function withReadFileHook<T>(hook: () => Promise<void>, run: () => Promise<T>): Promise<T> {
  const originalReadFile = fs.readFile;
  (fs as { readFile: typeof fs.readFile }).readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    await hook();
    (fs as { readFile: typeof fs.readFile }).readFile = originalReadFile;
    return originalReadFile(...args);
  }) as typeof fs.readFile;
  try {
    return await run();
  } finally {
    (fs as { readFile: typeof fs.readFile }).readFile = originalReadFile;
  }
}

test("a file rewritten between hash inspection and authorized read never carries stale identity on readTool's real path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-dedupe-toctou-"));
  try {
    const filePath = path.join(root, "sample.txt");
    await fs.writeFile(filePath, "original content\n".repeat(50));
    const config = resolveGatewayConfig({ workspaceRoot: root });
    const store = new InMemoryArtifactStore();

    // inspectReadFile has already hashed the original content by the time
    // readAuthorizedFile calls fs.readFile; rewrite right there, before the bytes
    // are materialized.
    const result = structured(
      await withReadFileHook(
        () => fs.writeFile(filePath, "rewritten by a concurrent process\n".repeat(50)),
        () => callLocalTool("mottainai_read", { path: "sample.txt", mode: "raw" }, config, store),
      ),
    );
    assert.equal(result.identity, undefined, "identity must be dropped when content changed mid-read");
    assert.match(String(result.text), /rewritten by a concurrent process/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a same-size rewrite with mtime restored to the original value still fails closed on readTool's real path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-dedupe-toctou-samesize-"));
  try {
    const filePath = path.join(root, "sample.txt");
    const original = "line content here\n".repeat(50);
    await fs.writeFile(filePath, original);
    const originalStat = await fs.stat(filePath);
    const config = resolveGatewayConfig({ workspaceRoot: root });
    const store = new InMemoryArtifactStore();

    // Same byte length as the original, so a stat-only (size/mtime) check would not
    // detect this — only re-hashing the content can.
    const rewritten = "line CONTENT here\n".repeat(50);
    assert.equal(Buffer.byteLength(rewritten, "utf8"), Buffer.byteLength(original, "utf8"));

    const result = structured(
      await withReadFileHook(
        async () => {
          await fs.writeFile(filePath, rewritten);
          await fs.utimes(filePath, originalStat.atime, originalStat.mtime);
        },
        () => callLocalTool("mottainai_read", { path: "sample.txt", mode: "raw" }, config, store),
      ),
    );
    assert.equal(result.identity, undefined, "identity must be dropped even when size/mtime were restored");
    assert.match(String(result.text), /line CONTENT here/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verifyFileContentUnchanged fails closed on content change and on deletion, independent of stat", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-content-verify-"));
  try {
    const filePath = path.join(root, "sample.txt");
    await fs.writeFile(filePath, "stable content\n");
    const { inspectReadFile, verifyFileContentUnchanged } = await import("./read-adapter.js");
    const inspected = await inspectReadFile(filePath);
    assert.equal(await verifyFileContentUnchanged(filePath, { contentHash: inspected.contentHash }), true);

    const stat = await fs.stat(filePath);
    await fs.writeFile(filePath, "STABLE content\n");
    await fs.utimes(filePath, stat.atime, stat.mtime);
    assert.equal(Buffer.byteLength("STABLE content\n"), Buffer.byteLength("stable content\n"));
    assert.equal(await verifyFileContentUnchanged(filePath, { contentHash: inspected.contentHash }), false);

    await fs.rm(filePath);
    assert.equal(await verifyFileContentUnchanged(filePath, { contentHash: inspected.contentHash }), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
