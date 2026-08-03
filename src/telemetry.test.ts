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

  assert.equal(compressionRatio(snapshot.totals), 1000 / 1800);
  assert.equal(retrievalRate(snapshot.totals), 1 / 3);

  // 非同期の書き込みキューが flush されるまで待つ。
  await new Promise((resolve) => setTimeout(resolve, 50));
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as { totals: { calls: number } };
  assert.equal(persisted.totals.calls, 3);

  await fs.rm(dir, { recursive: true, force: true });
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
