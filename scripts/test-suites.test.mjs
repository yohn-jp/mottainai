import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run as runTestSuite } from "./run-test-suite.mjs";
import {
  FULL_VERIFICATION_SUITES,
  classifyTestFile,
  discoverRepositoryTestFiles,
  getTestSuiteFiles,
  parseShardArgument,
  shardTestFiles,
  validateTestArchitecture,
} from "./test-suites.mjs";

const architecture = validateTestArchitecture();
const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

test("every recognized repository test belongs to exactly one suite", () => {
  assert.deepEqual(architecture.errors, []);
  const classifiedFiles = Object.values(architecture.suites).flat();
  assert.deepEqual([...new Set(classifiedFiles)].sort(), architecture.files);
});

test("fast suite excludes expensive integration, process, package, and e2e files", () => {
  assert.equal(classifyTestFile("src/e2e/mcp-stdio.e2e.spec.ts"), "e2e");
  assert.equal(classifyTestFile("src/init.test.ts"), "integration");
  assert.equal(classifyTestFile("scripts/lib/mcp-blackbox-client.test.mjs"), "integration");
  assert.equal(classifyTestFile("scripts/smoke-test.mjs"), "package");
  assert.equal(classifyTestFile("scripts/mcp-stdio-package.test.mjs"), "package");
  for (const integrationFile of [
    "src/auth.test.ts",
    "src/code-search.test.ts",
    "src/config.test.ts",
    "src/context-runtime/gh-checks.test.ts",
    "src/context-runtime/identity.test.ts",
    "src/context-runtime/read-adapter.test.ts",
    "src/envelope.test.ts",
    "src/gitignore.test.ts",
    "src/hooks/hooks.test.ts",
    "src/proxy.test.ts",
    "src/read-governor-cli.test.ts",
    "src/runtime-diagnostic.test.ts",
    "src/telemetry.test.ts",
    "src/upstream.test.ts",
  ]) {
    assert.equal(architecture.suites.fast.includes(integrationFile), false, `${integrationFile} must stay out of fast`);
    assert.equal(
      architecture.suites.integration.includes(integrationFile),
      true,
      `${integrationFile} must stay covered`,
    );
  }
  assert.equal(architecture.suites.fast.includes("src/e2e/mcp-stdio.e2e.spec.ts"), false);
  assert.equal(architecture.suites.fast.includes("src/init.test.ts"), false);
  assert.equal(architecture.suites.fast.includes("scripts/smoke-test.mjs"), false);
  assert.equal(architecture.suites.standards.includes("scripts/mcp-stdio-package.test.mjs"), false);
  assert.equal(architecture.suites.standards.includes("scripts/lib/mcp-blackbox-client.test.mjs"), false);
});

test("full verification names every classified suite exactly once", () => {
  assert.deepEqual([...new Set(FULL_VERIFICATION_SUITES)].sort(), [
    "e2e",
    "fast",
    "integration",
    "package",
    "standards",
  ]);
  const fullFiles = FULL_VERIFICATION_SUITES.flatMap((suiteName) => architecture.suites[suiteName]);
  assert.deepEqual([...new Set(fullFiles)].sort(), discoverRepositoryTestFiles());
});

test("full verification builds before any built-dist E2E test", () => {
  const steps = packageJson.scripts.verify.split(" && ");
  const buildIndex = steps.indexOf("pnpm run build");
  const e2eIndex = steps.indexOf("pnpm run test:e2e");

  assert.notEqual(buildIndex, -1, "verify must build its artifact explicitly");
  assert.notEqual(e2eIndex, -1, "verify must run the E2E suite");
  assert.ok(buildIndex < e2eIndex, "verify must build before running built-dist E2E tests");
});

test("build configuration does not trust stale incremental metadata for dist output", () => {
  assert.match(packageJson.scripts.build, /^tsc -p tsconfig\.build\.json --incremental false\b/);
});

test("parseShardArgument accepts well-formed 1-based index/total pairs", () => {
  assert.deepEqual(parseShardArgument("1/4"), { index: 1, total: 4 });
  assert.deepEqual(parseShardArgument("4/4"), { index: 4, total: 4 });
  assert.deepEqual(parseShardArgument("1/1"), { index: 1, total: 1 });
});

test("parseShardArgument fails closed on malformed or out-of-range shard specs", () => {
  for (const invalidValue of ["0/4", "5/4", "1/0", "abc", "1/", "/4", "1/4/2", "-1/4", "1.5/4", undefined, ""]) {
    assert.throws(() => parseShardArgument(invalidValue), /invalid --shard value/u);
  }
});

test("shardTestFiles partitions a sorted file list with no overlap or gaps", () => {
  const files = getTestSuiteFiles("integration");
  const total = 4;
  const shards = Array.from({ length: total }, (_unused, zeroBasedIndex) =>
    shardTestFiles(files, { index: zeroBasedIndex + 1, total }),
  );

  const reassembled = shards.flat();
  assert.deepEqual([...reassembled].sort(), [...files].sort());
  assert.equal(reassembled.length, files.length);
  assert.equal(new Set(reassembled).size, files.length);

  for (const shard of shards) {
    assert.ok(shard.length > 0, "every shard of the integration suite must receive at least one file");
  }
});

test("shardTestFiles assignment is deterministic across repeated calls", () => {
  const files = getTestSuiteFiles("integration");
  assert.deepEqual(shardTestFiles(files, { index: 2, total: 4 }), shardTestFiles(files, { index: 2, total: 4 }));
});

test("run-test-suite fails closed on an invalid --shard argument", () => {
  const errors = [];
  const status = runTestSuite({
    argv: ["node", "scripts/run-test-suite.mjs", "integration", "--shard=0/4"],
    spawnSyncImpl: () => ({ error: undefined, status: 0 }),
    write: () => {},
    writeError: (message) => errors.push(message),
  });

  assert.equal(status, 1);
  assert.ok(errors.some((message) => message.includes("invalid --shard value")));
});

test("run-test-suite shards the integration suite's files into the spawned node --test argv", () => {
  const spawnCalls = [];
  const status = runTestSuite({
    argv: ["node", "scripts/run-test-suite.mjs", "integration", "--shard=1/4"],
    spawnSyncImpl: (command, args) => {
      spawnCalls.push({ command, args });
      return { error: undefined, status: 0 };
    },
    write: () => {},
    writeError: () => {},
  });

  assert.equal(status, 0);
  assert.equal(spawnCalls.length, 1);
  const testIndex = spawnCalls[0].args.indexOf("--test");
  const spawnedFiles = spawnCalls[0].args.slice(testIndex + 1);
  const expectedFiles = shardTestFiles(getTestSuiteFiles("integration"), { index: 1, total: 4 });
  assert.deepEqual(spawnedFiles, expectedFiles);
  assert.ok(spawnedFiles.length < getTestSuiteFiles("integration").length);
});

test("a slow hosted-runner sample does not fail a passing fast suite", () => {
  const output = [];
  const errors = [];
  const clockValues = [0, 10_907];
  const status = runTestSuite({
    argv: ["node", "scripts/run-test-suite.mjs", "fast"],
    spawnSyncImpl: () => ({ error: undefined, status: 0 }),
    now: () => clockValues.shift(),
    write: (message) => output.push(message),
    writeError: (message) => errors.push(message),
  });

  assert.equal(status, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(output, ["test suite timing: fast 10907ms"]);
});
