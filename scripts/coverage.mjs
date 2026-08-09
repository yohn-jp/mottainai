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
const SHARD_FLAG_NAMES = Object.freeze(["--shard-index", "--shard-count"]);
export const COVERAGE_SHARD_COUNT = 7;
const V8_COVERAGE_DIRECTORY_NAME = "v8";

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
  return parseDetailedLcov(source, root).map((record) => ({
    file: record.file,
    lines: {
      total: record.counts.lines.total ?? record.lines.length,
      covered: record.counts.lines.covered ?? record.lines.filter((line) => line.hits > 0).length,
    },
    functions: {
      total: record.counts.functions.total ?? record.functions.length,
      covered: record.counts.functions.covered ?? record.functions.filter((fn) => fn.hits > 0).length,
    },
    branches: {
      total: record.counts.branches.total ?? record.branches.length,
      covered: record.counts.branches.covered ?? record.branches.filter((branch) => branch.hits > 0).length,
    },
  }));
}

/**
 * Parse the complete LCOV counters emitted by Node's built-in test runner.
 * Keeping the per-line/function/branch counters is required to merge shards
 * without changing the meaning of the existing coverage gate.
 */
export function parseDetailedLcov(source, root = process.cwd()) {
  const records = [];
  let record;
  let functionDataIndex = 0;
  for (const line of source.split(/\r?\n/u)) {
    if (line.startsWith("SF:")) {
      if (record !== undefined) throw new Error("LCOV source record was not terminated");
      record = {
        file: reportPath(line.slice(3), root),
        lines: [],
        functions: [],
        branches: [],
        counts: { lines: {}, functions: {}, branches: {} },
      };
      functionDataIndex = 0;
    } else if (line.startsWith("FN:")) {
      if (!record) continue;
      const separator = line.indexOf(",", 3);
      if (separator === -1) throw new Error(`invalid LCOV function definition: ${line}`);
      record.functions.push({ line: Number(line.slice(3, separator)), name: line.slice(separator + 1), hits: 0 });
    } else if (line.startsWith("FNDA:")) {
      if (!record) continue;
      const separator = line.indexOf(",", 5);
      if (separator === -1) throw new Error(`invalid LCOV function data: ${line}`);
      const hits = Number(line.slice(5, separator));
      const name = line.slice(separator + 1);
      const fn = record.functions[functionDataIndex];
      if (fn === undefined || fn.name !== name)
        throw new Error(`LCOV function data has no matching definition: ${line}`);
      fn.hits = hits;
      functionDataIndex += 1;
    } else if (line.startsWith("BRDA:")) {
      if (!record) continue;
      const [lineNumber, block, branch, rawHits] = line.slice(5).split(",");
      if (lineNumber === undefined || block === undefined || branch === undefined || rawHits === undefined) {
        throw new Error(`invalid LCOV branch data: ${line}`);
      }
      record.branches.push({
        line: Number(lineNumber),
        block,
        branch,
        hits: rawHits === "-" ? 0 : Number(rawHits),
      });
    } else if (line.startsWith("DA:")) {
      if (!record) continue;
      const [lineNumber, rawHits, checksum] = line.slice(3).split(",");
      if (lineNumber === undefined || rawHits === undefined) throw new Error(`invalid LCOV line data: ${line}`);
      record.lines.push({ line: Number(lineNumber), hits: Number(rawHits), checksum });
    } else if (line.startsWith("FNF:")) {
      if (record) record.counts.functions.total = Number(line.slice(4));
    } else if (line.startsWith("FNH:")) {
      if (record) record.counts.functions.covered = Number(line.slice(4));
    } else if (line.startsWith("BRF:")) {
      if (record) record.counts.branches.total = Number(line.slice(4));
    } else if (line.startsWith("BRH:")) {
      if (record) record.counts.branches.covered = Number(line.slice(4));
    } else if (line.startsWith("LF:")) {
      if (record) record.counts.lines.total = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      if (record) record.counts.lines.covered = Number(line.slice(3));
    } else if (!record) {
      continue;
    } else if (line === "end_of_record") {
      records.push(record);
      record = undefined;
    }
  }
  if (record !== undefined) throw new Error("LCOV source record was not terminated");
  return records;
}

function recordKey(value) {
  return JSON.stringify(value);
}

function mergeRecords(records) {
  const merged = new Map();
  for (const record of records) {
    const current = merged.get(record.file);
    if (current === undefined) {
      merged.set(record.file, {
        file: record.file,
        lines: record.lines.map((line) => ({ ...line })),
        functions: record.functions.map((fn) => ({ ...fn })),
        branches: record.branches.map((branch) => ({ ...branch })),
      });
      continue;
    }

    const lineMap = new Map(current.lines.map((line) => [lineKey(line), line]));
    for (const line of record.lines) {
      const existing = lineMap.get(lineKey(line));
      if (existing === undefined) {
        current.lines.push({ ...line });
        lineMap.set(lineKey(line), current.lines.at(-1));
      } else {
        existing.hits += line.hits;
      }
    }

    const functionMap = new Map(current.functions.map((fn, index) => [functionKey(fn, index, current.functions), fn]));
    for (const [index, fn] of record.functions.entries()) {
      const existing = functionMap.get(functionKey(fn, index, record.functions));
      if (existing === undefined) {
        current.functions.push({ ...fn });
        functionMap.set(functionKey(fn, index, record.functions), current.functions.at(-1));
      } else {
        existing.hits += fn.hits;
      }
    }

    const branchMap = new Map(
      current.branches.map((branch, index) => [branchKey(branch, index, current.branches), branch]),
    );
    for (const [index, branch] of record.branches.entries()) {
      const existing = branchMap.get(branchKey(branch, index, record.branches));
      if (existing === undefined) {
        current.branches.push({ ...branch });
        branchMap.set(branchKey(branch, index, record.branches), current.branches.at(-1));
      } else {
        existing.hits += branch.hits;
      }
    }
  }
  return [...merged.values()].sort((left, right) => left.file.localeCompare(right.file));
}

function lineKey(line) {
  return recordKey(line.line);
}

function functionKey(fn, index, functions) {
  return recordKey([fn.line, functions.slice(0, index).filter((candidate) => candidate.line === fn.line).length]);
}

function branchKey(branch, index, branches) {
  return recordKey([
    branch.line,
    branches.slice(0, index).filter((candidate) => candidate.line === branch.line).length,
  ]);
}

/** Merge LCOV records from independent test processes by summing hit counts. */
export function mergeLcov(sources, root = process.cwd()) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("at least one LCOV source is required");
  return serializeLcov(mergeRecords(sources.flatMap((source) => parseDetailedLcov(source, root))));
}

function serializeLcov(records) {
  const lines = [];
  for (const record of records) {
    const functions = record.functionEntries ?? record.functions;
    const branches = record.branchEntries ?? record.branches;
    const lineEntries = record.lineEntries ?? record.lines;
    lines.push("TN:", `SF:${record.file}`);
    for (const fn of functions) lines.push(`FN:${fn.line},${fn.name}`);
    for (const fn of functions) lines.push(`FNDA:${fn.hits},${fn.name}`);
    lines.push(`FNF:${functions.length}`);
    lines.push(`FNH:${functions.filter((fn) => fn.hits > 0).length}`);
    for (const branch of branches) {
      lines.push(`BRDA:${branch.line},${branch.block},${branch.branch},${branch.hits}`);
    }
    lines.push(`BRF:${branches.length}`);
    lines.push(`BRH:${branches.filter((branch) => branch.hits > 0).length}`);
    for (const line of lineEntries)
      lines.push(`DA:${line.line},${line.hits}${line.checksum ? `,${line.checksum}` : ""}`);
    lines.push(`LF:${lineEntries.length}`);
    lines.push(`LH:${lineEntries.filter((line) => line.hits > 0).length}`);
    lines.push("end_of_record");
  }
  return `${lines.join("\n")}\n`;
}

function relativeCoveragePath(root, url) {
  const absolutePath = url.startsWith("file:") ? fileURLToPath(url) : url;
  const relative = normalizePath(path.relative(root, absolutePath));
  if (!relative.startsWith("../")) return relative;
  const sourceMarker = absolutePath.replaceAll("\\", "/").indexOf("/src/");
  if (sourceMarker !== -1) return absolutePath.replaceAll("\\", "/").slice(sourceMarker + 1);
  return relative;
}

function sourceCoverageScript(root, script) {
  const file = relativeCoveragePath(root, script.url);
  return { ...script, url: `file://${file}`, file };
}

function sameRange(left, right) {
  return left.startOffset === right.startOffset && left.endOffset === right.endOffset;
}

function containsRange(container, nested) {
  return container.startOffset <= nested.startOffset && container.endOffset >= nested.endOffset;
}

// Mirrors Node 22's range merge: exact V8 source ranges are the identity.
function mergeCoverageRanges(oldFunction, newFunction) {
  const mergedRanges = [];
  const add = (range) => {
    if (!mergedRanges.includes(range)) mergedRanges.push(range);
  };
  for (const range of oldFunction.ranges) {
    if (range.count > 0) add(range);
  }
  for (const newRange of newFunction.ranges) {
    let exactMatch = false;
    for (const oldRange of oldFunction.ranges) {
      if (sameRange(newRange, oldRange)) {
        oldRange.count += newRange.count;
        add(oldRange);
        exactMatch = true;
        break;
      }
      if (oldRange.count === 0 && newRange.count === 0) {
        if (containsRange(oldRange, newRange)) add(newRange);
        else if (containsRange(newRange, oldRange)) add(oldRange);
      }
    }
    if (newRange.count > 0 && !exactMatch) add(newRange);
  }
  oldFunction.ranges = mergedRanges;
}

function mergeCoverageScripts(oldScript, newScript) {
  for (const newFunction of newScript.functions) {
    const oldFunction = oldScript.functions.find(
      (candidate) =>
        candidate.functionName === newFunction.functionName &&
        sameRange(candidate.ranges?.[0] ?? {}, newFunction.ranges?.[0] ?? {}),
    );
    if (oldFunction === undefined) {
      oldScript.functions.push(newFunction);
      continue;
    }
    if (!newFunction.isBlockCoverage) continue;
    if (oldFunction.isBlockCoverage) mergeCoverageRanges(oldFunction, newFunction);
    else {
      oldFunction.isBlockCoverage = true;
      oldFunction.ranges = newFunction.ranges;
    }
  }
}

function isCoveredSourcePath(file) {
  return (
    file.startsWith("src/") &&
    /\.(?:ts|mjs)$/u.test(file) &&
    !file.endsWith(".test.ts") &&
    !file.endsWith(".spec.ts") &&
    !file.startsWith("src/test-support/") &&
    !file.startsWith("src/e2e/") &&
    !file.includes("/fixtures/") &&
    !file.includes("/test-fixtures/")
  );
}

function readV8Coverage(root, directory) {
  if (!fs.existsSync(directory)) throw new Error(`V8 coverage artifact is missing: ${directory}`);
  const stat = fs.statSync(directory);
  const files = stat.isDirectory()
    ? fs
        .readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => path.join(directory, file))
    : [directory];
  if (files.length === 0) throw new Error(`V8 coverage directory contains no JSON artifacts: ${directory}`);
  const merged = new Map();
  for (const file of files) {
    let coverage;
    try {
      coverage = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(
        `V8 coverage artifact is invalid: ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(coverage.result)) throw new Error(`V8 coverage artifact has no result: ${file}`);
    for (const rawScript of coverage.result) {
      if (!rawScript.url?.startsWith("file:")) continue;
      const script = sourceCoverageScript(root, rawScript);
      if (!isCoveredSourcePath(script.file)) continue;
      const existing = merged.get(script.file);
      if (existing === undefined) merged.set(script.file, script);
      else mergeCoverageScripts(existing, script);
    }
  }
  return [...merged.values()].sort((left, right) => left.file.localeCompare(right.file));
}

function sourceLines(root, file) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const lines = [];
  let startOffset = 0;
  for (const lineText of source.split("\n")) {
    const endOffset = startOffset + lineText.length;
    lines.push({ line: lines.length + 1, startOffset, endOffset, count: 0 });
    startOffset = endOffset + 1;
  }
  return lines;
}

function mapRangeToLines(range, lines) {
  for (const line of lines) {
    if (range.startOffset <= line.startOffset && range.endOffset >= line.endOffset) line.count = range.count;
  }
}

function sourceLineForOffset(lines, offset) {
  return (lines.find((line) => offset >= line.startOffset && offset <= line.endOffset) ?? lines.at(-1)).line;
}

function v8CoverageRecords(root, scripts) {
  return scripts.map((script) => {
    const lines = sourceLines(root, script.file);
    const functions = [];
    const branches = [];
    for (const [index, coveredFunction] of script.functions.entries()) {
      if (!Array.isArray(coveredFunction.ranges) || coveredFunction.ranges.length === 0) continue;
      let maxCount = 0;
      for (const range of coveredFunction.ranges) {
        maxCount = Math.max(maxCount, range.count);
        mapRangeToLines(range, lines);
        if (coveredFunction.isBlockCoverage) {
          branches.push({
            line: sourceLineForOffset(lines, range.startOffset),
            block: String(branches.length),
            branch: "0",
            hits: range.count,
          });
        }
      }
      if (index > 0) {
        functions.push({
          line: sourceLineForOffset(lines, coveredFunction.ranges[0].startOffset),
          name: coveredFunction.functionName,
          hits: maxCount,
        });
      }
    }
    const counts = {
      lines: { total: lines.length, covered: lines.filter((line) => line.count > 0).length },
      functions: { total: functions.length, covered: functions.filter((fn) => fn.hits > 0).length },
      branches: { total: branches.length, covered: branches.filter((branch) => branch.hits > 0).length },
    };
    return {
      file: script.file,
      lineEntries: lines.map((line) => ({ line: line.line, hits: line.count })),
      functionEntries: functions,
      branchEntries: branches,
      ...counts,
    };
  });
}

export function partitionTestFiles(testFiles, shardIndex, shardCount, weightForFile = defaultTestFileWeight) {
  if (!Number.isInteger(shardIndex) || shardIndex < 1) throw new Error("shard index must be a positive integer");
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error("shard count must be a positive integer");
  if (shardIndex > shardCount) throw new Error("shard index must not exceed shard count");
  if (new Set(testFiles).size !== testFiles.length) throw new Error("coverage test file manifest contains duplicates");
  if (testFiles.length < shardCount) throw new Error("coverage shard count exceeds test file count");
  const assignments = Array.from({ length: shardCount }, () => ({ load: 0, files: [] }));
  const weightedFiles = testFiles
    .map((file, index) => ({ file, index, weight: weightForFile(file) }))
    .sort((left, right) => right.weight - left.weight || left.index - right.index);
  for (const entry of weightedFiles) {
    const target = assignments.reduce((leastLoaded, candidate) =>
      candidate.load < leastLoaded.load ? candidate : leastLoaded,
    );
    target.files.push(entry);
    target.load += entry.weight;
  }
  return assignments[shardIndex - 1].files.sort((left, right) => left.index - right.index).map((entry) => entry.file);
}

function defaultTestFileWeight(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 1;
  }
}

/**
 * Build a complete deterministic plan. A test file is never present in more
 * than one shard; this keeps test-local resources and process fixtures
 * isolated while preserving complete suite execution.
 */
export function buildCoverageShardPlan(root, allTestFiles, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error("coverage shard count must be positive");
  const plans = Array.from({ length: shardCount }, (_, index) => {
    const testFiles = partitionTestFiles(allTestFiles, index + 1, shardCount, (file) => {
      try {
        return fs.statSync(path.join(root, file)).size;
      } catch {
        return 1;
      }
    });
    return { testFiles, testNames: null, testNamePattern: null, testUnits: testFiles };
  });
  const allTestUnits = [...allTestFiles];
  return { plans, allTestUnits };
}

function coveragePlanManifest(plan) {
  return {
    shardCount: plan.plans.length,
    shards: plan.plans.map((selection, index) => ({
      index: index + 1,
      testFiles: selection.testFiles,
      testUnits: selection.testUnits,
      testNamePattern: selection.testNamePattern,
    })),
  };
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
  const options = {
    measureOnly: false,
    outputDirectory: "coverage",
    mergeInputs: [],
    shardIndex: undefined,
    shardCount: undefined,
  };
  for (let index = 0; index < argumentsFromCommandLine.length; index += 1) {
    const argument = argumentsFromCommandLine[index];
    if (argument === "--measure-only") {
      options.measureOnly = true;
    } else if (argument === "--output" || SHARD_FLAG_NAMES.includes(argument)) {
      const value = argumentsFromCommandLine[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--output") options.outputDirectory = value;
      else if (argument === "--shard-index") options.shardIndex = Number(value);
      else options.shardCount = Number(value);
    } else if (argument === "--merge") {
      const value = argumentsFromCommandLine[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error("--merge requires an input directory or LCOV file");
      options.mergeInputs.push(value);
      index += 1;
    }
  }
  if ((options.shardIndex === undefined) !== (options.shardCount === undefined)) {
    throw new Error("--shard-index and --shard-count must be provided together");
  }
  if (options.mergeInputs.length > 0 && options.shardIndex !== undefined) {
    throw new Error("--merge cannot be combined with coverage shard execution");
  }
  if (options.shardIndex !== undefined && !options.measureOnly) {
    throw new Error("coverage shard execution requires --measure-only; the merge job enforces the coverage policy");
  }
  return options;
}

function coverageInput(root, input) {
  const resolved = path.resolve(root, input);
  if (!fs.existsSync(resolved)) throw new Error(`coverage shard input is missing: ${resolved}`);
  const stat = fs.statSync(resolved);
  const directory = stat.isDirectory() ? resolved : path.dirname(resolved);
  const lcovPath = stat.isFile() ? resolved : path.join(directory, "lcov.info");
  const summaryPath = path.join(directory, "summary.json");
  const v8ArtifactPath = path.join(directory, "v8-merged.json");
  if (!fs.existsSync(lcovPath)) throw new Error(`coverage LCOV artifact is missing: ${lcovPath}`);
  if (!fs.existsSync(summaryPath)) throw new Error(`coverage summary artifact is missing: ${summaryPath}`);
  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  } catch (error) {
    throw new Error(
      `coverage summary artifact is invalid: ${summaryPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    input: resolved,
    lcovPath,
    summaryPath,
    v8ArtifactPath,
    summary,
    lcov: fs.readFileSync(lcovPath, "utf8"),
    v8Coverage: readV8Coverage(root, v8ArtifactPath),
  };
}

function sameFileList(left, right) {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

function mergeCoverage(root, options) {
  const inputs = options.mergeInputs.map((input) => coverageInput(root, input));
  if (inputs.length === 0) throw new Error("coverage merge requires at least one input");
  const first = inputs[0].summary;
  const shardCount = first.shard?.count;
  if (!Number.isInteger(shardCount) || shardCount < 1)
    throw new Error("coverage shard metadata is missing a valid count");
  if (inputs.length !== shardCount) {
    throw new Error(`coverage merge expected ${shardCount} shard artifacts but received ${inputs.length}`);
  }
  const allTestFiles = first.allTestFiles;
  if (!Array.isArray(allTestFiles) || allTestFiles.length === 0) {
    throw new Error("coverage shard manifest is missing allTestFiles");
  }
  if (new Set(allTestFiles).size !== allTestFiles.length)
    throw new Error("coverage allTestFiles manifest contains duplicates");
  const allTestUnits = first.allTestUnits;
  const plan = first.plan;
  if (!plan || plan.shardCount !== shardCount || !Array.isArray(plan.shards) || plan.shards.length !== shardCount) {
    throw new Error("coverage shard plan is missing or inconsistent");
  }

  const indices = new Set();
  const executedUnits = [];
  for (const input of inputs) {
    const { summary } = input;
    const shard = summary.shard;
    if (!Number.isInteger(shard?.index) || shard.count !== shardCount) {
      throw new Error(`coverage shard metadata is inconsistent: ${input.input}`);
    }
    if (indices.has(shard.index)) throw new Error(`coverage shard ${shard.index} is duplicated`);
    indices.add(shard.index);
    if (summary.testStatus !== 0) throw new Error(`coverage shard ${shard.index} did not pass its tests`);
    if (summary.gate !== "shard") throw new Error(`coverage shard ${shard.index} was not produced in shard mode`);
    if (!sameFileList(summary.include, COVERAGE_INCLUDE_PATTERNS)) {
      throw new Error(`coverage shard ${shard.index} has a different include policy`);
    }
    if (!sameFileList(summary.exclude, COVERAGE_EXCLUDE_PATTERNS)) {
      throw new Error(`coverage shard ${shard.index} has a different exclude policy`);
    }
    if (!Array.isArray(summary.testFiles) || summary.testFiles.length === 0) {
      throw new Error(`coverage shard ${shard.index} has no executed test file manifest`);
    }
    if (new Set(summary.testFiles).size !== summary.testFiles.length) {
      throw new Error(`coverage shard ${shard.index} test file manifest contains duplicates`);
    }
    if (!sameFileList(summary.allTestFiles, allTestFiles)) {
      throw new Error(`coverage shard ${shard.index} has a different allTestFiles manifest`);
    }
    if (!sameFileList(summary.allTestUnits, allTestUnits)) {
      throw new Error(`coverage shard ${shard.index} has a different allTestUnits manifest`);
    }
    if (JSON.stringify(summary.plan) !== JSON.stringify(plan)) {
      throw new Error(`coverage shard ${shard.index} has a different deterministic shard plan`);
    }
    const expectedSelection = plan.shards[shard.index - 1];
    if (expectedSelection?.index !== shard.index)
      throw new Error(`coverage shard ${shard.index} is outside the coverage plan`);
    const expectedFiles = expectedSelection.testFiles;
    if (!sameFileList(summary.testFiles, expectedFiles)) {
      throw new Error(`coverage shard ${shard.index} does not match the deterministic test-file partition`);
    }
    if (!sameFileList(summary.testUnits, expectedSelection.testUnits)) {
      throw new Error(`coverage shard ${shard.index} does not match the deterministic test-case partition`);
    }
    if (summary.testNamePattern !== expectedSelection.testNamePattern) {
      throw new Error(`coverage shard ${shard.index} has a different test-name pattern`);
    }
    executedUnits.push(...summary.testUnits);
  }
  for (let index = 1; index <= shardCount; index += 1) {
    if (!indices.has(index)) throw new Error(`coverage shard ${index} is missing`);
  }
  if (new Set(executedUnits).size !== executedUnits.length) throw new Error("coverage shard manifests overlap");
  if (!sameFileList([...executedUnits].sort(), [...allTestUnits].sort())) {
    throw new Error("coverage shard manifests do not cover exactly the complete test-case set");
  }

  const mergedScripts = new Map();
  for (const input of inputs) {
    for (const script of input.v8Coverage) {
      const existing = mergedScripts.get(script.file);
      if (existing === undefined) mergedScripts.set(script.file, script);
      else mergeCoverageScripts(existing, script);
    }
  }
  const v8Records = v8CoverageRecords(root, [...mergedScripts.values()]);
  if (v8Records.length === 0) throw new Error("merged V8 coverage artifact contains no source records");

  const outputDirectory = path.resolve(root, options.outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const lcovPath = path.join(outputDirectory, "lcov.info");
  const summaryPath = path.join(outputDirectory, "summary.json");
  const mergedLcov = mergeLcov(
    inputs.map((input) => input.lcov),
    root,
  );
  const lcovRecords = parseLcov(mergedLcov, root);
  const lcovDetails = parseDetailedLcov(mergedLcov, root);
  const records = v8Records.map((v8Record) => {
    const lcovRecord = lcovRecords.find((record) => record.file === v8Record.file);
    const lcovDetail = lcovDetails.find((record) => record.file === v8Record.file);
    return {
      ...v8Record,
      lines: lcovRecord?.lines ?? v8Record.lines,
      functions: v8Record.functions,
      branches: v8Record.branches,
      lineEntries: lcovDetail?.lines ?? v8Record.lineEntries,
      functionEntries: v8Record.functionEntries,
      branchEntries: v8Record.branchEntries,
    };
  });
  fs.writeFileSync(lcovPath, serializeLcov(records));
  const gate = evaluateCoverage(records, readPolicy(root));
  const artifact = {
    generatedAt: new Date().toISOString(),
    include: COVERAGE_INCLUDE_PATTERNS,
    exclude: COVERAGE_EXCLUDE_PATTERNS,
    testFiles: allTestFiles,
    allTestFiles,
    testUnits: allTestUnits,
    allTestUnits,
    testNamePattern: null,
    plan,
    coverageFormat: "v8-ranges-v1",
    shard: null,
    mergedShards: [...indices].sort((left, right) => left - right),
    testStatus: 0,
    gate: gate.passed ? "passed" : "failed",
    ...gate,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(artifact, null, 2)}\n`);
  printSummary(gate);
  console.log(`merged coverage artifacts: ${lcovPath}, ${summaryPath}`);
  if (!gate.passed) {
    for (const failure of gate.failures) console.error(`coverage gate: ${failure}`);
    process.exitCode = 1;
  }
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
  if (options.mergeInputs.length > 0) {
    mergeCoverage(root, options);
    return;
  }
  const architecture = validateTestArchitecture(root);
  if (architecture.errors.length > 0) throw new Error(architecture.errors.join("\n"));
  const allTestFiles = [...getTestSuiteFiles("fast", root), ...getTestSuiteFiles("integration", root)];
  if (allTestFiles.length === 0) throw new Error("coverage suite has no test files");
  if (new Set(allTestFiles).size !== allTestFiles.length)
    throw new Error("coverage suite contains duplicate test files");
  const coveragePlan =
    options.shardIndex === undefined ? undefined : buildCoverageShardPlan(root, allTestFiles, options.shardCount);
  const selection = options.shardIndex === undefined ? undefined : coveragePlan.plans[options.shardIndex - 1];
  if (options.shardIndex !== undefined && selection === undefined) {
    throw new Error(`coverage shard ${options.shardIndex} is outside the coverage plan`);
  }
  const testFiles = selection?.testFiles ?? allTestFiles;
  const testUnits = selection?.testUnits ?? allTestFiles;
  const allTestUnits = coveragePlan?.allTestUnits ?? allTestFiles;
  if (testFiles.length === 0) throw new Error("coverage shard has no test files");

  const outputDirectory = path.resolve(root, options.outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const lcovPath = path.join(outputDirectory, "lcov.info");
  const summaryPath = path.join(outputDirectory, "summary.json");
  const v8Directory = path.join(outputDirectory, V8_COVERAGE_DIRECTORY_NAME);
  for (const artifactPath of [lcovPath, summaryPath]) {
    if (fs.existsSync(artifactPath)) fs.rmSync(artifactPath);
  }
  if (fs.existsSync(v8Directory)) fs.rmSync(v8Directory, { recursive: true, force: true });
  fs.mkdirSync(v8Directory, { recursive: true });

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
  const childEnvironment = { ...process.env, NODE_V8_COVERAGE: v8Directory };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const testResult = spawnSync(process.execPath, argumentsForNode, {
    cwd: root,
    stdio: "inherit",
    env: childEnvironment,
  });
  if (testResult.error) throw testResult.error;
  if (testResult.status !== 0) process.exitCode = testResult.status ?? 1;
  if (!fs.existsSync(lcovPath)) throw new Error(`coverage artifact was not generated: ${lcovPath}`);

  const v8Coverage = readV8Coverage(root, v8Directory);
  const v8ArtifactPath = path.join(outputDirectory, "v8-merged.json");
  fs.writeFileSync(
    v8ArtifactPath,
    `${JSON.stringify({ result: v8Coverage.map((script) => ({ ...script, url: `file://${path.resolve(root, script.file)}` })) }, null, 2)}\n`,
  );
  fs.rmSync(v8Directory, { recursive: true, force: true });

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
    allTestFiles,
    testUnits,
    allTestUnits,
    testNamePattern: selection?.testNamePattern ?? null,
    plan: coveragePlan ? coveragePlanManifest(coveragePlan) : null,
    coverageFormat: "v8-ranges-v1",
    shard: options.shardIndex === undefined ? null : { index: options.shardIndex, count: options.shardCount },
    testStatus: testResult.status,
    gate:
      options.shardIndex !== undefined
        ? "shard"
        : options.measureOnly
          ? "measure-only"
          : gate.passed
            ? "passed"
            : "failed",
    ...gate,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(artifact, null, 2)}\n`);
  printSummary(gate);
  console.log(`coverage artifacts: ${lcovPath}, ${summaryPath}, ${v8ArtifactPath}`);
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
