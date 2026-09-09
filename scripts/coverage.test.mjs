import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertBaselineNotStale,
  assertCriticalModuleTestsPresent,
  evaluateCoverage,
  mergeLcov,
  parseLcov,
  partitionTestFiles,
  summarizeCoverage,
  validateCoveragePolicy,
  validatePolicyReviewMetadata,
} from "./coverage.mjs";

const validPolicy = {
  schemaVersion: 1,
  baseline: {
    measuredAt: "2026-08-08",
    sourceRevision: "4c40896 (historical measurement)",
    metrics: { lines: 80, functions: 80, branches: 80 },
    thresholds: { lines: 70, functions: 70, branches: 70 },
  },
  policyReview: {
    reviewedAt: "2026-09-09",
    policyReviewedRevision: "0bca989877471c0ad9f09686c5453694672b7834",
  },
  criticalModules: [
    {
      path: "src/config.ts",
      reason: "configuration resolution controls every startup and upstream boundary",
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  ],
};

const sampleLcov = [
  "TN:",
  "SF:src/config.ts",
  "FNF:2",
  "FNH:2",
  "BRF:4",
  "BRH:4",
  "DA:1,1",
  "LF:2",
  "LH:2",
  "end_of_record",
].join("\n");

test("lcov parser produces line, function, and branch metrics", () => {
  const records = parseLcov(sampleLcov);
  assert.equal(records.length, 1);
  assert.deepEqual(summarizeCoverage(records).totals, {
    lines: { covered: 2, total: 2, percent: 100 },
    functions: { covered: 2, total: 2, percent: 100 },
    branches: { covered: 4, total: 4, percent: 100 },
  });
});

test("coverage policy rejects unsafe or ambiguous thresholds", () => {
  assert.doesNotThrow(() => validateCoveragePolicy(validPolicy));
  assert.throws(
    () => validateCoveragePolicy({ ...validPolicy, baseline: { ...validPolicy.baseline, thresholds: { lines: 101 } } }),
    /functions|branches|baseline\.thresholds\.lines|exceeds/,
  );
  assert.throws(
    () =>
      validateCoveragePolicy({
        ...validPolicy,
        criticalModules: [...validPolicy.criticalModules, ...validPolicy.criticalModules],
      }),
    /duplicate critical module/,
  );
});

test("coverage measurement provenance stays separate from policy-review provenance", () => {
  assert.doesNotThrow(() => validatePolicyReviewMetadata(validPolicy));
  assert.equal(validPolicy.baseline.measuredAt, "2026-08-08");
  assert.equal(validPolicy.policyReview.reviewedAt, "2026-09-09");
  assert.throws(
    () => validatePolicyReviewMetadata({ ...validPolicy, policyReview: { reviewedAt: "2026-09-09" } }),
    /policyReviewedRevision must be a full commit SHA/u,
  );
  assert.throws(() => validateCoveragePolicy({ ...validPolicy, policyReview: undefined }), /policyReview is required/u);
});

test("coverage gate checks repository and critical-module thresholds", () => {
  const passing = evaluateCoverage(parseLcov(sampleLcov), validPolicy);
  assert.equal(passing.passed, true);
  const failing = evaluateCoverage(
    parseLcov(sampleLcov.replace("LH:2", "LH:1").replace("FNH:2", "FNH:1").replace("BRH:4", "BRH:3")),
    validPolicy,
  );
  assert.equal(failing.passed, false);
  assert.ok(failing.failures.some((failure) => failure.includes("repository lines")));
  assert.ok(failing.failures.some((failure) => failure.includes("src/config.ts functions")));
});

test("a critical-module directory pattern aggregates every record under that directory", () => {
  const directoryPolicy = {
    ...validPolicy,
    criticalModules: [
      {
        path: "src/semantics/enforcement/*",
        reason: "enforcement policy is the final accept/reject boundary for semantic mutations",
        thresholds: { lines: 70, functions: 70, branches: 70 },
      },
    ],
  };
  const lcov = [
    "TN:",
    "SF:src/semantics/enforcement/policy.ts",
    "FNF:1",
    "FNH:1",
    "BRF:2",
    "BRH:2",
    "DA:1,1",
    "LF:1",
    "LH:1",
    "end_of_record",
    "TN:",
    "SF:src/semantics/enforcement/service.ts",
    "FNF:1",
    "FNH:0",
    "BRF:2",
    "BRH:0",
    "DA:1,0",
    "LF:1",
    "LH:0",
    "end_of_record",
  ].join("\n");
  const result = evaluateCoverage(parseLcov(lcov), directoryPolicy);
  assert.equal(result.critical[0].metrics.lines.covered, 1);
  assert.equal(result.critical[0].metrics.lines.total, 2);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.startsWith("src/semantics/enforcement/* lines")));

  const missingPolicy = {
    ...directoryPolicy,
    criticalModules: [{ ...directoryPolicy.criticalModules[0], path: "src/semantics/missing-dir/*" }],
  };
  const missingResult = evaluateCoverage(parseLcov(lcov), missingPolicy);
  assert.ok(missingResult.failures.some((failure) => failure.includes("critical module missing from coverage")));
});

// Mutation guard (Issue #876): the baseline attests "reviewed and accurate as of this
// date/revision". A baseline that is never re-checked can silently drift from reality, so
// assertBaselineNotStale must reject one that has aged past the configured threshold.
test("a stale coverage baseline is rejected", () => {
  const staleDate = "2020-01-01";
  assert.throws(
    () =>
      assertBaselineNotStale(
        { baseline: { measuredAt: staleDate, sourceRevision: "deadbeef" } },
        { now: new Date("2020-06-01T00:00:00Z"), maxAgeDays: 120 },
      ),
    /stale/,
  );
  assert.doesNotThrow(() =>
    assertBaselineNotStale(
      { baseline: { measuredAt: staleDate, sourceRevision: "deadbeef" } },
      { now: new Date("2020-02-01T00:00:00Z"), maxAgeDays: 120 },
    ),
  );
  assert.throws(
    () => assertBaselineNotStale({ baseline: { measuredAt: "not-a-date", sourceRevision: "deadbeef" } }),
    /valid date/,
  );
  assert.throws(
    () => assertBaselineNotStale({ baseline: { measuredAt: staleDate, sourceRevision: "" } }),
    /sourceRevision is required/,
  );
});

// Mutation guard (Issue #876): removing a critical module's dedicated test file without
// also updating coverage-policy.json (dropping or replacing that testFiles entry) must fail
// loudly here rather than being noticed only later as an unexplained coverage percentage
// drop — this is the "test fails when a critical-module test is removed without an
// accompanying policy update" acceptance criterion.
test("removing a critical module's recorded test file without updating the policy fails the check", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-critical-test-"));
  try {
    const testFileRelative = "src/example.test.ts";
    const testFileAbsolute = path.join(temporaryRoot, testFileRelative);
    fs.mkdirSync(path.dirname(testFileAbsolute), { recursive: true });
    fs.writeFileSync(testFileAbsolute, "// fixture\n");
    const policy = {
      ...validPolicy,
      criticalModules: [{ ...validPolicy.criticalModules[0], testFiles: [testFileRelative] }],
    };
    assert.doesNotThrow(() => assertCriticalModuleTestsPresent(policy, temporaryRoot));

    fs.rmSync(testFileAbsolute);
    assert.throws(
      () => assertCriticalModuleTestsPresent(policy, temporaryRoot),
      /src\/config\.ts -> src\/example\.test\.ts/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("coverage test files are partitioned exactly once across shards", () => {
  const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts", "f.test.ts"];
  const shards = [1, 2, 3].map((index) => partitionTestFiles(files, index, 3, () => 1));
  assert.deepEqual(shards, [
    ["a.test.ts", "d.test.ts"],
    ["b.test.ts", "e.test.ts"],
    ["c.test.ts", "f.test.ts"],
  ]);
  assert.deepEqual(shards.flat().sort(), files);
  assert.throws(() => partitionTestFiles(files, 1, 7, () => 1), /exceeds test file count/);
  assert.throws(() => partitionTestFiles(["a.test.ts", "a.test.ts"], 1, 2, () => 1), /contains duplicates/);
  assert.deepEqual(
    partitionTestFiles(files, 1, 2, (file) => (file === "a.test.ts" ? 100 : 1)),
    ["a.test.ts"],
  );
});

test("coverage LCOV merger sums line, function, and branch hit counts", () => {
  const source = (hits, branchHits) =>
    [
      "TN:",
      "SF:src/config.ts",
      "FN:1,fixture",
      `FNDA:${hits},fixture`,
      "FNF:1",
      `FNH:${hits > 0 ? 1 : 0}`,
      `BRDA:1,0,0,${branchHits}`,
      "BRF:1",
      `BRH:${branchHits > 0 ? 1 : 0}`,
      `DA:1,${hits}`,
      "LF:1",
      `LH:${hits > 0 ? 1 : 0}`,
      "end_of_record",
    ].join("\n");
  const merged = mergeLcov([source(2, 3), source(4, 5)]);
  assert.match(merged, /FNDA:6,fixture/u);
  assert.match(merged, /BRDA:1,0,0,8/u);
  assert.match(merged, /DA:1,6/u);
  assert.deepEqual(summarizeCoverage(parseLcov(merged)).totals, {
    lines: { covered: 1, total: 1, percent: 100 },
    functions: { covered: 1, total: 1, percent: 100 },
    branches: { covered: 1, total: 1, percent: 100 },
  });
});

test("native test runner emits the machine-readable coverage artifact", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-coverage-test-"));
  const sourcePath = path.join(temporaryDirectory, "fixture.mjs");
  const testPath = path.join(temporaryDirectory, "fixture.test.mjs");
  const lcovPath = path.join(temporaryDirectory, "lcov.info");
  try {
    fs.writeFileSync(sourcePath, "export function fixture(value) { return value ? 1 : 0; }\n");
    fs.writeFileSync(
      testPath,
      'import assert from "node:assert/strict"; import test from "node:test"; import { fixture } from "./fixture.mjs"; test("fixture", () => assert.equal(fixture(true), 1));\n',
    );
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-test-coverage",
        "--test-coverage-include=fixture.mjs",
        "--test-reporter=dot",
        "--test-reporter-destination=stdout",
        "--test-reporter=lcov",
        `--test-reporter-destination=${lcovPath}`,
        "--test",
        "fixture.test.mjs",
      ],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        env: (() => {
          const childEnvironment = { ...process.env };
          delete childEnvironment.NODE_TEST_CONTEXT;
          return childEnvironment;
        })(),
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(lcovPath), true, `${result.stdout}\n${result.stderr}`);
    assert.match(fs.readFileSync(lcovPath, "utf8"), /SF:.*fixture\.mjs/u);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
