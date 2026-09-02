import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LATENCY_SCHEMA_VERSION,
  captureTimestamp,
  createLatencyEvidence,
  mergeLatencyEvidence,
  readLatencyFile,
  recordMilestone,
  recordStage,
  renderLatencySummary,
  writeLatencyFile,
} from "../src/lib/latency.mjs";
import { measurePagesVisibility } from "../src/measure-pages-visibility.mjs";

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-review-pages-latency-"));
  return { directory, filePath: path.join(directory, "latency.json") };
}

function timestamp(monotonicNs, wallClock) {
  return captureTimestamp({ monotonicNs: BigInt(monotonicNs), wallClock });
}

function metadata(overrides = {}) {
  return {
    repository: "yohn-jp/mottainai",
    workflow: "Review Pages",
    runId: "123",
    runAttempt: 1,
    pullRequestNumber: 721,
    headSha: "a".repeat(40),
    workflowStartedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

test("stage durations use monotonic timestamps and summaries keep milestones distinct", () => {
  const evidence = createLatencyEvidence({ metadata: metadata(), job: "generate", timestamp: null });
  recordStage(evidence, {
    job: "generate",
    stage: "generation",
    phase: "start",
    timestamp: timestamp(10_000_000, "2026-09-02T00:00:01.000Z"),
  });
  recordStage(evidence, {
    job: "generate",
    stage: "generation",
    phase: "complete",
    timestamp: timestamp(2_010_000_000, "2026-09-02T00:00:01.010Z"),
  });
  recordMilestone(evidence, {
    job: "generate",
    name: "generation-complete",
    timestamp: timestamp(2_020_000_000, "2026-09-02T00:00:01.020Z"),
  });
  recordMilestone(evidence, {
    job: "publish",
    name: "gh-pages-push-complete",
    timestamp: timestamp(3_020_000_000, "2026-09-02T00:00:02.020Z"),
  });
  recordMilestone(evidence, {
    job: "publish",
    name: "http-visible",
    timestamp: timestamp(4_020_000_000, "2026-09-02T00:00:03.020Z"),
  });

  assert.equal(evidence.schemaVersion, LATENCY_SCHEMA_VERSION);
  assert.equal(evidence.jobs.generate.stages.generation.durationMs, 2000);
  assert.equal(evidence.milestones["generation-complete"].job, "generate");
  assert.equal(evidence.milestones["gh-pages-push-complete"].job, "publish");
  assert.match(renderLatencySummary(evidence), /generation-complete: 2026-09-02T00:00:01\.020Z/u);
  assert.match(renderLatencySummary(evidence), /gh-pages-push-complete: 2026-09-02T00:00:02\.020Z/u);
  assert.match(renderLatencySummary(evidence), /HTTP visible \(wall-clock\): 1000\.000 ms/u);
});

test("latency evidence merges generate and publish jobs without copying source content", () => {
  const generate = createLatencyEvidence({ metadata: metadata(), job: "generate", timestamp: null });
  const publish = createLatencyEvidence({ metadata: metadata(), job: "publish", timestamp: null });
  recordMilestone(generate, {
    job: "generate",
    name: "generation-complete",
    timestamp: timestamp(100, "2026-09-02T00:00:01.000Z"),
  });
  recordMilestone(publish, {
    job: "publish",
    name: "gh-pages-push-complete",
    timestamp: timestamp(200, "2026-09-02T00:00:02.000Z"),
  });

  mergeLatencyEvidence(publish, generate);
  assert.deepEqual(Object.keys(publish.jobs).sort(), ["generate", "publish"]);
  assert.equal(publish.milestones["generation-complete"].job, "generate");
  assert.equal(Object.hasOwn(publish, "prBody"), false);
});

test("Pages visibility records success only for the expected immutable manifest", async () => {
  const { directory, filePath } = tempFile();
  try {
    const evidence = createLatencyEvidence({ metadata: metadata(), job: "publish", timestamp: null });
    writeLatencyFile(filePath, evidence);
    let tick = 0n;
    const result = await measurePagesVisibility({
      filePath,
      job: "publish",
      baseUrl: "https://yohn-jp.github.io/mottainai",
      repository: "yohn-jp/mottainai",
      prNumber: 721,
      headSha: "a".repeat(40),
      attempts: 2,
      delayMs: 0,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "200" },
        text: async () =>
          JSON.stringify({
            repository: { fullName: "yohn-jp/mottainai" },
            pullRequest: { number: 721 },
            revision: { id: "a".repeat(40) },
          }),
      }),
      sleepFn: async () => {},
      now: () => timestamp((tick += 1_000_000n), `2026-09-02T00:00:0${tick / 1_000_000n}.000Z`),
    });

    const saved = readLatencyFile(filePath);
    assert.equal(result.status, "success");
    assert.equal(saved.visibility.status, "success");
    assert.equal(saved.visibility.attempts, 1);
    assert.equal(saved.milestones["http-visible"].details.statusCode, 200);
    assert.equal(saved.jobs.publish.stages["pages-serving"].durationMs, 2);
    assert.equal(directory.length > 0, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Pages visibility distinguishes push failure and a stale served revision without failing measurement", async () => {
  const { directory, filePath } = tempFile();
  try {
    const evidence = createLatencyEvidence({ metadata: metadata(), job: "publish", timestamp: null });
    writeLatencyFile(filePath, evidence);
    const result = await measurePagesVisibility({
      filePath,
      job: "publish",
      baseUrl: "https://example.test/site",
      repository: "yohn-jp/mottainai",
      prNumber: 721,
      headSha: "a".repeat(40),
      publishSucceeded: false,
      fetchFn: async () => {
        throw new Error("fetch must not run after push failure");
      },
      now: () => timestamp(10_000_000n, "2026-09-02T00:00:01.000Z"),
    });
    assert.equal(result.status, "push-failure");
    assert.equal(readLatencyFile(filePath).visibility.status, "push-failure");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
