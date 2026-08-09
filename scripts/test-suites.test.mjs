import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_VERIFICATION_SUITES,
  classifyTestFile,
  discoverRepositoryTestFiles,
  validateTestArchitecture,
} from "./test-suites.mjs";

const architecture = validateTestArchitecture();

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
