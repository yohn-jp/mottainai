import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  FULL_VERIFICATION_SUITES,
  getTestSuiteFiles,
  parseShardArgument,
  shardTestFiles,
  validateTestArchitecture,
} from "./test-suites.mjs";

function failure(message, writeError) {
  writeError(`test suite failed: ${message}`);
  return 1;
}

export function run({
  argv = process.argv,
  root = process.cwd(),
  spawnSyncImpl = spawnSync,
  now = () => performance.now(),
  write = console.log,
  writeError = console.error,
} = {}) {
  const suiteName = argv[2];
  if (suiteName === "full") {
    return failure(`full suite is composed by pnpm run verify: ${FULL_VERIFICATION_SUITES.join(", ")}`, writeError);
  }
  if (suiteName === undefined) {
    return failure("suite name is required", writeError);
  }

  const validation = validateTestArchitecture(root);
  if (validation.errors.length > 0) {
    return failure(validation.errors.join("\n"), writeError);
  }

  let files;
  try {
    files = getTestSuiteFiles(suiteName, root);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), writeError);
  }
  if (suiteName === "package") {
    return failure("package suite requires pnpm run test:package, not the node test runner", writeError);
  }

  const shardArgument = argv.slice(3).find((argument) => argument.startsWith("--shard="));
  if (shardArgument !== undefined) {
    let shard;
    try {
      shard = parseShardArgument(shardArgument.slice("--shard=".length));
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), writeError);
    }
    files = shardTestFiles(files, shard);
  }

  if (files.length === 0) {
    return failure(`${suiteName} suite has no files`, writeError);
  }

  const argumentsForNode = [];
  // The integration suite runs live TypeScript Repository Model extraction
  // (src/dashboard/command.integration.test.ts) alongside the rest of the
  // suite in one process; the default V8 heap is not enough headroom on
  // standard CI runners and the process aborts with an OOM.
  if (suiteName === "integration") argumentsForNode.push("--max-old-space-size=8192");
  if (files.some((file) => file.endsWith(".ts"))) argumentsForNode.push("--import", "tsx");
  argumentsForNode.push("--test", ...files);
  const startedAt = now();
  const result = spawnSyncImpl(process.execPath, argumentsForNode, { cwd: root, stdio: "inherit" });
  const elapsedMs = Math.round(now() - startedAt);
  write(`test suite timing: ${suiteName} ${elapsedMs}ms`);
  if (result.error) {
    return failure(result.error.message, writeError);
  }
  if (result.status !== 0) {
    return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = run();
}
