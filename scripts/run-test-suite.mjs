import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { FULL_VERIFICATION_SUITES, getTestSuiteFiles, validateTestArchitecture } from "./test-suites.mjs";

const root = process.cwd();

function fail(message) {
  console.error(`test suite failed: ${message}`);
  process.exitCode = 1;
}

function run() {
  const suiteName = process.argv[2];
  if (suiteName === "full") {
    fail(`full suite is composed by pnpm run verify: ${FULL_VERIFICATION_SUITES.join(", ")}`);
    return;
  }
  if (suiteName === undefined) {
    fail("suite name is required");
    return;
  }

  const validation = validateTestArchitecture(root);
  if (validation.errors.length > 0) {
    fail(validation.errors.join("\n"));
    return;
  }

  let files;
  try {
    files = getTestSuiteFiles(suiteName, root);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  if (suiteName === "package") {
    fail("package suite requires pnpm run test:package, not the node test runner");
    return;
  }
  if (files.length === 0) {
    fail(`${suiteName} suite has no files`);
    return;
  }

  const argumentsForNode = [];
  if (files.some((file) => file.endsWith(".ts"))) argumentsForNode.push("--import", "tsx");
  argumentsForNode.push("--test", ...files);
  const result = spawnSync(process.execPath, argumentsForNode, { cwd: root, stdio: "inherit" });
  if (result.error) {
    fail(result.error.message);
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) run();
