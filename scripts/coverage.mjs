import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getTestSuiteFiles, validateTestArchitecture } from "./test-suites.mjs";

export const COVERAGE_INCLUDE_PATTERNS = Object.freeze(["src/**/*.ts", "src/**/*.mjs"]);
export const COVERAGE_EXCLUDE_PATTERNS = Object.freeze([
  "src/**/*.test.ts",
  "src/**/*.spec.ts",
  "src/test-support/**",
  "src/e2e/**",
  "src/**/fixtures/**",
  "src/**/test-fixtures/**",
  "src/**/*.d.ts",
]);

const metricNames = Object.freeze(["lines", "functions", "branches"]);

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function reportPath(value, root) {
  const normalized = value.replaceAll("\\", "/");
  return normalizePath(path.isAbsolute(normalized) ? path.relative(root, normalized) : normalized);
}

function percentage(covered, total) {
  return total === 0 ? 100 : (covered / total) * 100;
}

export function parseLcov(source, root = process.cwd()) {
  const records = [];
  let record;
  for (const line of source.split(/\r?\n/u)) {
    if (line.startsWith("SF:")) {
      record = { file: reportPath(line.slice(3), root), lines: {}, functions: {}, branches: {} };
    } else if (!record) {
      continue;
    } else if (line.startsWith("FNF:")) {
      record.functions.total = Number(line.slice(4));
    } else if (line.startsWith("FNH:")) {
      record.functions.covered = Number(line.slice(4));
    } else if (line.startsWith("BRF:")) {
      record.branches.total = Number(line.slice(4));
    } else if (line.startsWith("BRH:")) {
      record.branches.covered = Number(line.slice(4));
    } else if (line.startsWith("LF:")) {
      record.lines.total = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      record.lines.covered = Number(line.slice(3));
    } else if (line === "end_of_record") {
      records.push(record);
      record = undefined;
    }
  }
  return records;
}

function metricFromRecord(record, metricName) {
  const metric = record[metricName];
  return {
    covered: metric.covered ?? 0,
    total: metric.total ?? 0,
    percent: percentage(metric.covered ?? 0, metric.total ?? 0),
  };
}

export function summarizeCoverage(records) {
  const totals = Object.fromEntries(
    metricNames.map((metricName) => {
      const values = records.map((record) => metricFromRecord(record, metricName));
      const covered = values.reduce((sum, value) => sum + value.covered, 0);
      const total = values.reduce((sum, value) => sum + value.total, 0);
      return [metricName, { covered, total, percent: percentage(covered, total) }];
    }),
  );
  return { files: records.length, totals };
}

function assertPercent(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(`${label} must be greater than 0 and at most 100`);
  }
}

export function validateCoveragePolicy(policy) {
  if (policy?.schemaVersion !== 1) throw new Error("coverage policy schemaVersion must be 1");
  if (typeof policy.baseline !== "object" || policy.baseline === null) {
    throw new Error("coverage policy baseline is required");
  }
  if (typeof policy.baseline.measuredAt !== "string" || policy.baseline.measuredAt.length === 0) {
    throw new Error("coverage policy baseline measuredAt is required");
  }
  for (const metricName of metricNames) {
    assertPercent(policy.baseline.metrics?.[metricName], `baseline.metrics.${metricName}`);
    assertPercent(policy.baseline.thresholds?.[metricName], `baseline.thresholds.${metricName}`);
    if (policy.baseline.thresholds[metricName] > policy.baseline.metrics[metricName]) {
      throw new Error(`baseline threshold for ${metricName} exceeds measured baseline`);
    }
  }
  if (!Array.isArray(policy.criticalModules) || policy.criticalModules.length === 0) {
    throw new Error("coverage policy criticalModules must not be empty");
  }
  const paths = new Set();
  for (const modulePolicy of policy.criticalModules) {
    if (typeof modulePolicy?.path !== "string" || modulePolicy.path.length === 0) {
      throw new Error("critical module path is required");
    }
    if (paths.has(modulePolicy.path)) throw new Error(`duplicate critical module: ${modulePolicy.path}`);
    paths.add(modulePolicy.path);
    if (typeof modulePolicy.reason !== "string" || modulePolicy.reason.length === 0) {
      throw new Error(`critical module reason is required: ${modulePolicy.path}`);
    }
    for (const metricName of metricNames) {
      assertPercent(modulePolicy.thresholds?.[metricName], `${modulePolicy.path}.${metricName}`);
      if (modulePolicy.thresholds[metricName] < policy.baseline.thresholds[metricName]) {
        throw new Error(`critical threshold for ${modulePolicy.path}/${metricName} is below repository threshold`);
      }
    }
  }
  return policy;
}

function findRecord(records, file) {
  const normalizedFile = normalizePath(file);
  return records.find((record) => record.file === normalizedFile || record.file.endsWith(`/${normalizedFile}`));
}

export function evaluateCoverage(records, policy) {
  validateCoveragePolicy(policy);
  const summary = summarizeCoverage(records);
  const failures = [];
  for (const metricName of metricNames) {
    const actual = summary.totals[metricName].percent;
    const threshold = policy.baseline.thresholds[metricName];
    if (actual < threshold) failures.push(`repository ${metricName} ${actual.toFixed(2)}% < ${threshold}%`);
  }

  const critical = policy.criticalModules.map((modulePolicy) => {
    const record = findRecord(records, modulePolicy.path);
    const metrics = record
      ? Object.fromEntries(metricNames.map((metricName) => [metricName, metricFromRecord(record, metricName)]))
      : undefined;
    if (!record) failures.push(`critical module missing from coverage: ${modulePolicy.path}`);
    if (record) {
      for (const metricName of metricNames) {
        const actual = metrics[metricName].percent;
        const threshold = modulePolicy.thresholds[metricName];
        if (actual < threshold) {
          failures.push(`${modulePolicy.path} ${metricName} ${actual.toFixed(2)}% < ${threshold}%`);
        }
      }
    }
    return { ...modulePolicy, metrics };
  });
  return { critical, failures, passed: failures.length === 0, summary };
}

function readPolicy(root) {
  const policyPath = path.join(root, "scripts", "coverage-policy.json");
  if (!fs.existsSync(policyPath)) throw new Error(`${policyPath} is missing; measure a baseline first`);
  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
}

function parseArguments(argumentsFromCommandLine) {
  const outputIndex = argumentsFromCommandLine.indexOf("--output");
  return {
    measureOnly: argumentsFromCommandLine.includes("--measure-only"),
    outputDirectory: outputIndex === -1 ? "coverage" : argumentsFromCommandLine[outputIndex + 1],
  };
}

function printSummary(evaluation) {
  console.log("coverage summary");
  for (const metricName of metricNames) {
    const metric = evaluation.summary.totals[metricName];
    console.log(`  ${metricName}: ${metric.percent.toFixed(2)}% (${metric.covered}/${metric.total})`);
  }
  for (const modulePolicy of evaluation.critical) {
    const metrics = modulePolicy.metrics;
    const values = metrics
      ? metricNames.map((metricName) => `${metricName} ${metrics[metricName].percent.toFixed(2)}%`).join(", ")
      : "not measured";
    console.log(`  critical ${modulePolicy.path}: ${values}`);
  }
}

function run() {
  const root = process.cwd();
  const options = parseArguments(process.argv.slice(2));
  const architecture = validateTestArchitecture(root);
  if (architecture.errors.length > 0) throw new Error(architecture.errors.join("\n"));
  const testFiles = [...new Set([...getTestSuiteFiles("fast", root), ...getTestSuiteFiles("integration", root)])];
  if (testFiles.length === 0) throw new Error("coverage suite has no test files");

  const outputDirectory = path.resolve(root, options.outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const lcovPath = path.join(outputDirectory, "lcov.info");
  const summaryPath = path.join(outputDirectory, "summary.json");
  for (const artifactPath of [lcovPath, summaryPath]) {
    if (fs.existsSync(artifactPath)) fs.rmSync(artifactPath);
  }

  const argumentsForNode = ["--import", "tsx", "--experimental-test-coverage"];
  for (const pattern of COVERAGE_INCLUDE_PATTERNS) argumentsForNode.push(`--test-coverage-include=${pattern}`);
  for (const pattern of COVERAGE_EXCLUDE_PATTERNS) argumentsForNode.push(`--test-coverage-exclude=${pattern}`);
  argumentsForNode.push(
    "--test-reporter=dot",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcovPath}`,
    "--test",
    ...testFiles,
  );
  const testResult = spawnSync(process.execPath, argumentsForNode, { cwd: root, stdio: "inherit" });
  if (testResult.error) throw testResult.error;
  if (testResult.status !== 0) process.exitCode = testResult.status ?? 1;
  if (!fs.existsSync(lcovPath)) throw new Error(`coverage artifact was not generated: ${lcovPath}`);

  const records = parseLcov(fs.readFileSync(lcovPath, "utf8"), root);
  if (records.length === 0) throw new Error("coverage artifact contains no source records");
  const policy = options.measureOnly ? undefined : readPolicy(root);
  const gate = policy
    ? evaluateCoverage(records, policy)
    : { critical: [], failures: [], passed: true, summary: summarizeCoverage(records) };
  const artifact = {
    generatedAt: new Date().toISOString(),
    include: COVERAGE_INCLUDE_PATTERNS,
    exclude: COVERAGE_EXCLUDE_PATTERNS,
    testFiles,
    gate: options.measureOnly ? "measure-only" : gate.passed ? "passed" : "failed",
    ...gate,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(artifact, null, 2)}\n`);
  printSummary(gate);
  console.log(`coverage artifacts: ${lcovPath}, ${summaryPath}`);
  if (testResult.status !== 0) return;
  if (!gate.passed) {
    for (const failure of gate.failures) console.error(`coverage gate: ${failure}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    run();
  } catch (error) {
    console.error(`coverage failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
