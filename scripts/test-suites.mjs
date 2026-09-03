import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ignoredDirectories = new Set([".git", ".codegraph", ".mottainai", "coverage", "dist", "node_modules"]);
const testFilePattern = /\.(?:test|spec)\.(?:ts|mjs)$/u;

// Fast is reserved for deterministic in-process unit/contract checks. Repository-scale
// extraction, process/server/CLI boundaries, Git or filesystem fixtures, and polling or
// retry behavior remain meaningful integration tests.
const integrationPatterns = Object.freeze([
  "src/auth.test.ts",
  "src/code-search.test.ts",
  "src/commands/**/*.test.ts",
  "src/config.test.ts",
  "src/cli.test.ts",
  "src/context-runtime/gh-checks.test.ts",
  "src/context-runtime/identity.test.ts",
  "src/context-runtime/process-registry.test.ts",
  "src/context-runtime/read-adapter.test.ts",
  "src/dashboard-cli.test.ts",
  "src/dashboard/command.integration.test.ts",
  "src/dashboard/http.test.ts",
  "src/dashboard/provider.integration.test.ts",
  "src/manager/**/*.test.ts",
  "src/envelope.test.ts",
  "src/gitignore.test.ts",
  "src/hooks/hooks.test.ts",
  "src/proxy.test.ts",
  "src/read-governor-cli.test.ts",
  "src/runtime-diagnostic.test.ts",
  "src/semantics/cache/cache.test.ts",
  "src/semantics/effects/effects.test.ts",
  "src/semantics/extractors/typescript/extractor.test.ts",
  "src/semantics/model/query.test.ts",
  "src/semantics/mutations.test.ts",
  "src/semantics/enforcement.test.ts",
  "src/telemetry.test.ts",
  "src/fault-injection.test.ts",
  "src/gh-inari.test.ts",
  "src/gh-makami.test.ts",
  "src/init.test.ts",
  "src/local-tools.test.ts",
  "src/logging.test.ts",
  "src/mcp-cli.test.ts",
  "src/state/**/*.test.ts",
  "src/upstream.test.ts",
  "src/workflow/**/*.test.ts",
  "scripts/lib/mcp-blackbox-client.test.mjs",
  "review-pages/test/generate-review-package.test.mjs",
  "review-pages/test/publish-to-pages.test.mjs",
  "review-pages/test/bounded-output.test.mjs",
]);

const e2ePatterns = Object.freeze(["src/e2e/**/*.spec.ts"]);
const packagePatterns = Object.freeze(["scripts/smoke-test.mjs", "scripts/mcp-stdio-package.test.mjs"]);
const nonStandardsTestFiles = Object.freeze([
  "scripts/lib/mcp-blackbox-client.test.mjs",
  "scripts/mcp-stdio-package.test.mjs",
]);

// Representative GitHub-hosted runner measurements from the CI runs that
// motivated Issue #694. These are deliberately repository-controlled and
// conservative: unknown/new files receive the bounded baseline estimate and
// are still assigned, so adding a test can never silently drop coverage.
export const INTEGRATION_TEST_TIMINGS_MS = Object.freeze({
  "src/manager/claim-preflight.parity.test.ts": 72_000,
  "src/mcp-cli.test.ts": 57_000,
  "src/cli.test.ts": 20_000,
  "src/init.test.ts": 12_000,
});
const DEFAULT_INTEGRATION_TEST_TIMING_MS = 1_000;

export const TEST_SUITE_RULES = Object.freeze({
  fast: Object.freeze({
    include: Object.freeze(["src/**/*.test.ts", "review-pages/test/*.test.mjs"]),
    exclude: integrationPatterns,
  }),
  integration: Object.freeze({
    include: integrationPatterns,
    exclude: Object.freeze([]),
  }),
  e2e: Object.freeze({
    include: e2ePatterns,
    exclude: Object.freeze([]),
  }),
  standards: Object.freeze({
    include: Object.freeze(["scripts/**/*.test.mjs"]),
    exclude: nonStandardsTestFiles,
  }),
  package: Object.freeze({
    include: packagePatterns,
    exclude: Object.freeze([]),
  }),
});

export const FULL_VERIFICATION_SUITES = Object.freeze(["standards", "fast", "integration", "e2e", "package"]);

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function globToRegularExpression(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += /[\\^$+?.()|[\]{}]/u.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${expression}$`, "u");
}

const compiledPatterns = new Map();

function matchesGlob(relativePath, pattern) {
  let expression = compiledPatterns.get(pattern);
  if (expression === undefined) {
    expression = globToRegularExpression(pattern);
    compiledPatterns.set(pattern, expression);
  }
  return expression.test(relativePath);
}

function matchesRule(relativePath, rule) {
  return (
    rule.include.some((pattern) => matchesGlob(relativePath, pattern)) &&
    !rule.exclude.some((pattern) => matchesGlob(relativePath, pattern))
  );
}

function isRecognizedTestFile(relativePath) {
  return testFilePattern.test(relativePath) || relativePath === "scripts/smoke-test.mjs";
}

function collectFiles(root, current = root, output = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, fullPath, output);
      continue;
    }
    const relativePath = normalizePath(path.relative(root, fullPath));
    if (isRecognizedTestFile(relativePath)) output.push(relativePath);
  }
  return output.sort();
}

export function discoverRepositoryTestFiles(root = process.cwd()) {
  return collectFiles(path.resolve(root));
}

export function classifyTestFile(relativePath) {
  const normalizedPath = normalizePath(relativePath);
  const matches = Object.entries(TEST_SUITE_RULES)
    .filter(([, rule]) => matchesRule(normalizedPath, rule))
    .map(([suiteName]) => suiteName);
  return matches.length === 1 ? matches[0] : undefined;
}

export function validateTestArchitecture(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const files = discoverRepositoryTestFiles(resolvedRoot);
  const errors = [];
  const suites = Object.fromEntries(Object.keys(TEST_SUITE_RULES).map((suiteName) => [suiteName, []]));

  for (const file of files) {
    const matches = Object.entries(TEST_SUITE_RULES)
      .filter(([, rule]) => matchesRule(file, rule))
      .map(([suiteName]) => suiteName);
    if (matches.length === 0) {
      errors.push(`${file}: no test suite rule matches`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`${file}: multiple test suites match (${matches.join(", ")})`);
      continue;
    }
    suites[matches[0]].push(file);
  }

  for (const [suiteName, suiteFiles] of Object.entries(suites)) {
    if (new Set(suiteFiles).size !== suiteFiles.length) {
      errors.push(`${suiteName}: duplicate test file assignment`);
    }
  }

  const fastFiles = new Set(suites.fast);
  for (const file of suites.e2e) {
    if (fastFiles.has(file)) errors.push(`${file}: e2e file is included in fast suite`);
  }
  for (const file of suites.integration) {
    if (fastFiles.has(file)) errors.push(`${file}: integration file is included in fast suite`);
  }
  if (!suites.e2e.every((file) => e2ePatterns.some((pattern) => matchesGlob(file, pattern)))) {
    errors.push("e2e: every file must be an src/e2e/*.spec.ts test");
  }
  if (!suites.package.includes("scripts/smoke-test.mjs")) {
    errors.push("package: scripts/smoke-test.mjs must belong to the package suite");
  }

  return { errors, files, suites, root: resolvedRoot };
}

export function getTestSuiteFiles(suiteName, root = process.cwd()) {
  if (!Object.hasOwn(TEST_SUITE_RULES, suiteName)) throw new Error(`unknown test suite: ${suiteName}`);
  const result = validateTestArchitecture(root);
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  return [...result.suites[suiteName]];
}

// `--shard=<index>/<total>` addresses one Nth of a suite's sorted file list. Parsing
// fails closed on anything that is not a well-formed 1-based index within total.
export function parseShardArgument(rawValue) {
  const match = /^(\d+)\/(\d+)$/u.exec(rawValue ?? "");
  if (!match) throw new Error(`invalid --shard value: ${JSON.stringify(rawValue)} (expected <index>/<total>)`);
  const index = Number.parseInt(match[1], 10);
  const total = Number.parseInt(match[2], 10);
  if (total < 1) throw new Error(`invalid --shard value: ${JSON.stringify(rawValue)} (total must be >= 1)`);
  if (index < 1 || index > total) {
    throw new Error(`invalid --shard value: ${JSON.stringify(rawValue)} (index must be between 1 and ${total})`);
  }
  return { index, total };
}

// Deterministic longest-processing-time assignment. Files are sorted by the
// checked-in timing estimate and then by their stable suite order; each file
// goes to the currently lightest shard. Returning files in suite order keeps
// Node's invocation order stable while the assignment remains duration-aware.
export function shardTestFiles(files, { index, total }) {
  const assignments = new Map();
  const loads = Array.from({ length: total }, () => 0);
  const orderedFiles = files
    .map((file, fileIndex) => ({
      file,
      fileIndex,
      timing: INTEGRATION_TEST_TIMINGS_MS[file] ?? DEFAULT_INTEGRATION_TEST_TIMING_MS,
    }))
    .sort((left, right) => right.timing - left.timing || left.fileIndex - right.fileIndex);

  for (const entry of orderedFiles) {
    let target = 0;
    for (let candidate = 1; candidate < total; candidate += 1) {
      if (loads[candidate] < loads[target]) target = candidate;
    }
    assignments.set(entry.file, target);
    loads[target] += entry.timing;
  }

  return files.filter((file) => assignments.get(file) === index - 1);
}

function runAsCommand() {
  const result = validateTestArchitecture(process.argv[2] ?? process.cwd());
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`test architecture: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`test architecture: ${result.files.length} files classified`);
  for (const suiteName of FULL_VERIFICATION_SUITES) {
    console.log(`  ${suiteName}: ${result.suites[suiteName].length} file(s)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runAsCommand();
}
