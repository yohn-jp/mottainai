import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ignoredDirectories = new Set([".git", ".codegraph", ".mottainai", "coverage", "dist", "node_modules"]);
const testFilePattern = /\.(?:test|spec)\.(?:ts|mjs)$/u;

const integrationPatterns = Object.freeze([
  "src/commands/**/*.test.ts",
  "src/init.test.ts",
  "src/local-tools.test.ts",
  "src/logging.test.ts",
  "src/mcp-cli.test.ts",
  "src/state/**/*.test.ts",
  "src/workflow/**/*.test.ts",
]);

export const TEST_SUITE_RULES = Object.freeze({
  fast: Object.freeze({
    include: Object.freeze(["src/**/*.test.ts"]),
    exclude: integrationPatterns,
  }),
  integration: Object.freeze({
    include: integrationPatterns,
    exclude: Object.freeze([]),
  }),
  e2e: Object.freeze({
    include: Object.freeze(["src/e2e/**/*.spec.ts"]),
    exclude: Object.freeze([]),
  }),
  standards: Object.freeze({
    include: Object.freeze(["scripts/**/*.test.mjs"]),
    exclude: Object.freeze([]),
  }),
  package: Object.freeze({
    include: Object.freeze(["scripts/smoke-test.mjs"]),
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
  if (!suites.e2e.every((file) => file.startsWith("src/e2e/") && file.endsWith(".spec.ts"))) {
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
