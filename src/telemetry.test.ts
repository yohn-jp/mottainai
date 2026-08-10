import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  compressionRatio,
  createTelemetrySink,
  isTelemetryEnabled,
  resolveTelemetryPath,
  retrievalRate,
} from "./telemetry.js";

test("telemetry is disabled by default and enabled only by MOTTAINAI_TELEMETRY=1/true", () => {
  assert.equal(isTelemetryEnabled({}), false);
  assert.equal(isTelemetryEnabled({ MOTTAINAI_TELEMETRY: "0" }), false);
  assert.equal(isTelemetryEnabled({ MOTTAINAI_TELEMETRY: "1" }), true);
  assert.equal(isTelemetryEnabled({ MOTTAINAI_TELEMETRY: "true" }), true);
});

test("resolveTelemetryPath defaults under .mottainai/telemetry and honors MOTTAINAI_TELEMETRY_FILE", () => {
  assert.match(resolveTelemetryPath({}), /\.mottainai[\\/]telemetry[\\/]summary\.json$/);
  assert.equal(resolveTelemetryPath({ MOTTAINAI_TELEMETRY_FILE: "/tmp/x.json" }), "/tmp/x.json");
});

test("a disabled sink is a no-op and never touches the filesystem", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-telemetry-off-"));
  const filePath = path.join(dir, "telemetry", "summary.json");
  const sink = createTelemetrySink({ MOTTAINAI_TELEMETRY_FILE: filePath });
  assert.equal(sink.enabled, false);
  sink.recordToolCall({ provider: "fff", originalBytes: 1000, compressedBytes: 100, isError: false });
  sink.recordRetrieval();
  assert.equal(sink.snapshot().enabled, false);
  await assert.rejects(() => fs.access(filePath));
  await fs.rm(dir, { recursive: true, force: true });
});

test("an enabled sink aggregates calls, errors, bytes and retrievals by provider and capability", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-telemetry-on-"));
  const filePath = path.join(dir, "telemetry", "summary.json");
  const sink = createTelemetrySink({ MOTTAINAI_TELEMETRY: "1", MOTTAINAI_TELEMETRY_FILE: filePath });
  assert.equal(sink.enabled, true);

  sink.recordToolCall({ provider: "fff", capability: "text_matches", originalBytes: 1000, compressedBytes: 200, isError: false });
  sink.recordToolCall({ provider: "fff", capability: "text_matches", originalBytes: 500, compressedBytes: 500, isError: true });
  sink.recordToolCall({ provider: "codegraph", capability: "definitions", originalBytes: 300, compressedBytes: 300, isError: false });
  sink.recordProjection({ rawBytes: 2_000, storedBytes: 1_800, returnedBytes: 600, omittedBytes: 1_400, projectedTokens: 150, omittedTokens: 350 });
  sink.recordExpansion({ bytes: 2_400, estimatedTokens: 600 });
  sink.recordReadGovernor({
    action: "deny",
    requestedMode: "raw",
    rawLinesReturned: 0,
    rawBytesReturned: 0,
    policyRule: "WHOLE_FILE_RAW_LINE_LIMIT",
    reasonCategory: "line_limit",
  });
  sink.recordReadGovernor({
    action: "allow",
    requestedMode: "auto",
    rawLinesReturned: 20,
    rawBytesReturned: 200,
    policyRule: "AUTO_BOUNDED_REPRESENTATION",
    reasonCategory: "semantic_projection",
  });
  sink.recordHookDecision({ provider: "workflow", state: "authoritative", decision: "deny", reason: "workflow_protected_branch" });
  sink.recordHookDecision({ provider: "semantic", state: "unavailable", decision: "allow", reason: "semantic_authority_unavailable" });
  sink.recordRetrieval();

  const snapshot = sink.snapshot();
  assert.equal(snapshot.totals.calls, 3);
  assert.equal(snapshot.totals.errors, 1);
  assert.equal(snapshot.totals.original_bytes, 1800);
  assert.equal(snapshot.totals.compressed_bytes, 1000);
  assert.equal(snapshot.totals.retrievals, 1);
  assert.equal(snapshot.by_provider.fff.calls, 2);
  assert.equal(snapshot.by_provider.codegraph.calls, 1);
  assert.equal(snapshot.by_capability.text_matches.calls, 2);
  assert.equal(snapshot.by_capability.definitions.calls, 1);
  assert.deepEqual(snapshot.projection, {
    raw_bytes: 2_000, stored_bytes: 1_800, returned_bytes: 600, omitted_bytes: 1_400, projected_tokens: 150, omitted_tokens: 350,
  });
  assert.deepEqual(snapshot.expansion, { count: 1, bytes: 2_400, estimated_tokens: 600 });
  assert.deepEqual(snapshot.read_governor, {
    allow: 1, observe: 0, warn: 0, deny: 1, raw_lines_returned: 20, raw_bytes_returned: 200,
    by_mode: { raw: 1, auto: 1 },
    by_rule: { WHOLE_FILE_RAW_LINE_LIMIT: 1, AUTO_BOUNDED_REPRESENTATION: 1 },
    by_reason_category: { line_limit: 1, semantic_projection: 1 },
  });
  assert.deepEqual(snapshot.hooks, {
    evaluations: 2,
    by_provider: { workflow: 1, semantic: 1 },
    by_state: { authoritative: 1, unavailable: 1 },
    by_decision: { deny: 1, allow: 1 },
    by_reason: { workflow_protected_branch: 1, semantic_authority_unavailable: 1 },
  });

  assert.equal(compressionRatio(snapshot.totals), 1000 / 1800);
  assert.equal(retrievalRate(snapshot.totals), 1 / 3);

  // 非同期の書き込みキューが flush されるまで待つ。
  await new Promise((resolve) => setTimeout(resolve, 50));
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as { totals: { calls: number } };
  assert.equal(persisted.totals.calls, 3);

  await fs.rm(dir, { recursive: true, force: true });
});

test("telemetry loads legacy read-governor keys into the visible-disclosure schema", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-telemetry-legacy-"));
  const filePath = path.join(dir, "telemetry", "summary.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({
    enabled: true,
    generated_at: "2026-08-08T00:00:00.000Z",
    totals: { calls: 0, errors: 0, original_bytes: 0, compressed_bytes: 0, retrievals: 0 },
    by_provider: {},
    by_capability: {},
    projection: {},
    read_governor: {
      allow: 2,
      observe: 0,
      warn: 0,
      deny: 1,
      raw_lines: 12,
      raw_bytes: 120,
      requested_modes: { raw: 2 },
      policy_rules: { NONE: 2 },
    },
  })}\n`);

  const sink = createTelemetrySink({ MOTTAINAI_TELEMETRY: "1", MOTTAINAI_TELEMETRY_FILE: filePath });
  assert.deepEqual(sink.snapshot().read_governor, {
    allow: 2,
    observe: 0,
    warn: 0,
    deny: 1,
    raw_lines_returned: 12,
    raw_bytes_returned: 120,
    by_mode: { raw: 2 },
    by_rule: { NONE: 2 },
    by_reason_category: {},
  });

  await fs.rm(dir, { recursive: true, force: true });
});

test("recordAwait aggregates poll count, elapsed wait, state changes and avoided responses without storing payloads (Issue #74)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-telemetry-await-"));
  const filePath = path.join(dir, "telemetry", "summary.json");
  const sink = createTelemetrySink({ MOTTAINAI_TELEMETRY: "1", MOTTAINAI_TELEMETRY_FILE: filePath });

  sink.recordAwait({ pollCount: 5, elapsedMs: 1_200, stateChanges: 2, avoidedResponses: 4, outcome: "terminal" });
  sink.recordAwait({ pollCount: 1, elapsedMs: 300, stateChanges: 0, avoidedResponses: 0, outcome: "timeout" });
  sink.recordAwait({ pollCount: 1, elapsedMs: 10, stateChanges: 0, avoidedResponses: 0, outcome: "cancelled" });

  const snapshot = sink.snapshot();
  assert.deepEqual(snapshot.await, {
    awaits: 3, poll_count: 7, elapsed_ms: 1_510, state_changes: 2, avoided_responses: 4,
    terminal: 1, timeouts: 1, cancelled: 1,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as { await: { awaits: number } };
  assert.equal(persisted.await.awaits, 3);

  await fs.rm(dir, { recursive: true, force: true });
});

test("a disabled sink's recordAwait is a no-op", () => {
  const sink = createTelemetrySink({});
  sink.recordAwait({ pollCount: 5, elapsedMs: 1_000, stateChanges: 1, avoidedResponses: 4, outcome: "terminal" });
  assert.equal(sink.snapshot().await.awaits, 0);
});

test("a new sink resumes accumulating from a previously persisted summary", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-telemetry-resume-"));
  const filePath = path.join(dir, "telemetry", "summary.json");
  const first = createTelemetrySink({ MOTTAINAI_TELEMETRY: "1", MOTTAINAI_TELEMETRY_FILE: filePath });
  first.recordToolCall({ provider: "fff", originalBytes: 100, compressedBytes: 10, isError: false });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const second = createTelemetrySink({ MOTTAINAI_TELEMETRY: "1", MOTTAINAI_TELEMETRY_FILE: filePath });
  assert.equal(second.snapshot().totals.calls, 1);
  second.recordToolCall({ provider: "fff", originalBytes: 100, compressedBytes: 10, isError: false });
  assert.equal(second.snapshot().totals.calls, 2);

  await new Promise((resolve) => setTimeout(resolve, 50));
  await fs.rm(dir, { recursive: true, force: true });
});

test("snapshot returns deep copies of mutable counters", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-telemetry-copy-"));
  const filePath = path.join(dir, "telemetry", "summary.json");
  const sink = createTelemetrySink({ MOTTAINAI_TELEMETRY: "1", MOTTAINAI_TELEMETRY_FILE: filePath });
  sink.recordToolCall({ provider: "fff", capability: "grep", originalBytes: 100, compressedBytes: 10, isError: false });

  const snapshot = sink.snapshot();
  snapshot.totals.calls = 999;
  snapshot.by_provider.fff.calls = 999;
  snapshot.by_capability.grep.calls = 999;

  const next = sink.snapshot();
  assert.equal(next.totals.calls, 1);
  assert.equal(next.by_provider.fff.calls, 1);
  assert.equal(next.by_capability.grep.calls, 1);

  await new Promise((resolve) => setTimeout(resolve, 50));
  await fs.rm(dir, { recursive: true, force: true });
});

test("compressionRatio and retrievalRate are undefined when there is nothing to divide by", () => {
  assert.equal(compressionRatio({ original_bytes: 0, compressed_bytes: 0 }), undefined);
  assert.equal(retrievalRate({ calls: 0, retrievals: 0 }), undefined);
});
