import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MUTATION_POLICY,
  MUTATION_SCHEMA_VERSION,
  MUTATIONS,
  mutationExpectation,
  validateMutationCatalog,
} from "./mutation-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROPERTY_SUITE_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 2_000;
const MUTATION_OUTCOMES = new Set(["killed", "survived", "timeout", "error"]);

function parseOptions(argv) {
  const options = {
    seed: MUTATION_POLICY.seed,
    runs: MUTATION_POLICY.propertyRuns,
    timeoutMs: MUTATION_POLICY.timeoutMs,
    report: "test-artifacts/mutation-report.json",
    baseline: MUTATION_POLICY.scoreRegression.baselinePath,
    updateBaseline: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--seed") options.seed = Number(argv[++index]);
    else if (argument === "--runs") options.runs = Number(argv[++index]);
    else if (argument === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (argument === "--report") options.report = argv[++index];
    else if (argument === "--baseline") options.baseline = argv[++index];
    else if (argument === "--update-baseline") options.updateBaseline = true;
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 0)
    throw new Error("--seed must be a non-negative safe integer");
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 200)
    throw new Error("--runs must be between 1 and 200");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000)
    throw new Error("--timeout-ms is outside the bounded range");
  if (typeof options.report !== "string" || options.report.length === 0)
    throw new Error("--report must be a non-empty path");
  if (typeof options.baseline !== "string" || options.baseline.length === 0)
    throw new Error("--baseline must be a non-empty path");
  return options;
}

function copySandbox(destination) {
  fs.cpSync(root, destination, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(root, source);
      if (relative === "") return true;
      const first = relative.split(path.sep)[0];
      return !new Set([".git", ".mottainai", ".codegraph", "node_modules", "dist", "coverage", "test-artifacts"]).has(
        first,
      );
    },
  });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(destination, "node_modules"), "dir");
}

export function applyMutation(sandbox, mutation) {
  const filePath = path.join(sandbox, mutation.file);
  const original = fs.readFileSync(filePath, "utf8");
  const occurrences = original.split(mutation.search).length - 1;
  if (occurrences !== 1) throw new Error(`${mutation.id}: expected one source match, found ${occurrences}`);
  fs.writeFileSync(
    filePath,
    original.replace(mutation.search, () => mutation.replacement),
  );
  return { filePath, original };
}

function boundedText(value, limit = MAX_DIAGNOSTIC_LENGTH) {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(-limit);
}

function errorDescription(error) {
  if (error instanceof Error) return error.code ? `${error.code}: ${error.message}` : error.message;
  if (error !== undefined && error !== null && typeof error === "object") {
    const code = "code" in error ? String(error.code) : "error";
    const message = "message" in error ? String(error.message) : String(error);
    return `${code}: ${message}`;
  }
  return String(error);
}

function runnerDiagnostic(child) {
  const parts = [];
  if (child?.error !== undefined) parts.push(`error=${errorDescription(child.error)}`);
  if (child?.status === null || child?.status === undefined) parts.push(`exitCode=${child?.status ?? "null"}`);
  if (child?.signal !== undefined && child?.signal !== null) parts.push(`signal=${child.signal}`);
  const stderr = boundedText(child?.stderr);
  if (stderr.length > 0) parts.push(`stderr_tail=${JSON.stringify(stderr)}`);
  return boundedText(parts.join("; ") || "property runner exited abnormally");
}

export function classifyPropertySuiteResult(child) {
  const timedOut = child?.error?.code === "ETIMEDOUT";
  const spawnFailed = !timedOut && child?.error !== undefined;
  const abnormalExit =
    !timedOut &&
    !spawnFailed &&
    (child === undefined ||
      child === null ||
      child.status === null ||
      child.status === undefined ||
      child.signal != null);
  const harnessFailure = spawnFailed || abnormalExit;
  const killed = !timedOut && !harnessFailure && child.status !== 0;
  const outcome = timedOut ? "timeout" : harnessFailure ? "error" : killed ? "killed" : "survived";
  return {
    outcome,
    exitCode: child?.status ?? null,
    ...(harnessFailure ? { diagnostic: runnerDiagnostic(child) } : {}),
  };
}

export function runPropertySuite(sandbox, options, reportPath, spawn = spawnSync) {
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/property-tests.mjs",
      "--seed",
      String(options.seed),
      "--runs",
      String(options.runs),
      "--report",
      reportPath,
    ],
    {
      cwd: sandbox,
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: PROPERTY_SUITE_MAX_BUFFER,
      stdio: "pipe",
      env: { ...process.env, MOTTAINAI_CONFIG: "" },
    },
  );
}

export function buildMutationReport({ options, results }) {
  const scored = results.filter((result) => result.expected !== "equivalent");
  const killed = scored.filter((result) => result.outcome === "killed").length;
  const survived = scored.filter((result) => result.outcome !== "killed");
  const score = scored.length === 0 ? 1 : killed / scored.length;
  return {
    schemaVersion: MUTATION_SCHEMA_VERSION,
    seed: options.seed,
    propertyRuns: options.runs,
    mutationTimeoutMs: options.timeoutMs,
    policy: MUTATION_POLICY,
    scope: [...new Set(MUTATIONS.map((mutation) => mutation.file))],
    totals: { selected: results.length, killed, survived: survived.length, equivalent: results.length - scored.length },
    score,
    mutations: results,
    survivingMutants: survived,
    passed: survived.length === 0 && score >= MUTATION_POLICY.minimumScore,
  };
}

function expectedScope(catalog) {
  return [...new Set(catalog.map((mutation) => mutation.file))];
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateMutationBaseline(baseline, catalog = MUTATIONS) {
  validateMutationCatalog(catalog);
  if (baseline === null || typeof baseline !== "object") throw new Error("mutation baseline must be an object");
  if (baseline.schemaVersion !== MUTATION_SCHEMA_VERSION) {
    throw new Error(`mutation baseline schemaVersion must be ${MUTATION_SCHEMA_VERSION}`);
  }
  if (!sameJson(baseline.policy, MUTATION_POLICY))
    throw new Error("mutation baseline policy does not match the catalog");
  if (!sameJson(baseline.scope, expectedScope(catalog))) throw new Error("mutation baseline scope is stale");
  if (!Array.isArray(baseline.mutations) || baseline.mutations.length !== catalog.length) {
    throw new Error("mutation baseline must contain exactly one entry per catalog mutation");
  }
  const entries = new Map();
  for (const entry of baseline.mutations) {
    if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || entries.has(entry.id)) {
      throw new Error("mutation baseline contains an invalid or duplicate mutation entry");
    }
    entries.set(entry.id, entry);
  }
  for (const mutation of catalog) {
    const entry = entries.get(mutation.id);
    if (entry === undefined) throw new Error(`${mutation.id}: mutation baseline entry is missing`);
    if (
      entry.file !== mutation.file ||
      entry.operator !== mutation.operator ||
      entry.expected !== mutationExpectation(mutation) ||
      !Object.hasOwn(entry, "exitCode") ||
      !MUTATION_OUTCOMES.has(entry.outcome) ||
      (mutation.equivalence === undefined
        ? entry.equivalence !== undefined
        : !sameJson(entry.equivalence, mutation.equivalence))
    ) {
      throw new Error(`${mutation.id}: mutation baseline entry does not match the catalog schema`);
    }
    if (entry.expected === "equivalent") {
      const rationale = mutation.equivalence?.rationale;
      if (typeof rationale !== "string" || rationale.trim().length === 0) {
        throw new Error(`${mutation.id}: equivalent baseline exclusion lacks governance rationale`);
      }
    }
  }
  if (baseline.totals?.selected !== catalog.length) throw new Error("mutation baseline totals.selected is stale");
  if (typeof baseline.score !== "number" || baseline.score < 0 || baseline.score > 1) {
    throw new Error("mutation baseline score is invalid");
  }
  if (!Array.isArray(baseline.survivingMutants) || typeof baseline.passed !== "boolean") {
    throw new Error("mutation baseline is missing canonical result fields");
  }
  return baseline;
}

export function compareMutationBaseline(report, baseline) {
  validateMutationBaseline(baseline);
  if (report.score < baseline.score) {
    return {
      ok: false,
      reason: `score regression: current=${report.score} baseline=${baseline.score}; update requires explicit baseline governance evidence`,
    };
  }
  return { ok: true };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeReport(filePath, report) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  validateMutationCatalog();
  const options = parseOptions(argv);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-mutation-"));
  const results = [];
  const propertyReport = path.join(sandbox, "property-report.json");
  try {
    copySandbox(sandbox);
    for (const mutation of MUTATIONS) {
      let applied;
      let child;
      try {
        applied = applyMutation(sandbox, mutation);
        child = runPropertySuite(sandbox, options, propertyReport);
      } catch (error) {
        child = { error, status: null, signal: null, stderr: "" };
      } finally {
        if (applied) fs.writeFileSync(applied.filePath, applied.original);
      }
      const classification = classifyPropertySuiteResult(child);
      results.push({
        id: mutation.id,
        file: mutation.file,
        operator: mutation.operator,
        expected: mutationExpectation(mutation),
        ...(mutation.equivalence === undefined ? {} : { equivalence: mutation.equivalence }),
        ...classification,
      });
      console.log(`${mutation.id}: ${results.at(-1).outcome}`);
      if (classification.diagnostic !== undefined) {
        console.error(`${mutation.id}: harness failure: ${classification.diagnostic}`);
      }
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  const report = buildMutationReport({ options, results });
  let regression = { ok: true };
  if (!options.updateBaseline) {
    try {
      const baselinePath = path.resolve(root, options.baseline);
      regression = compareMutationBaseline(report, readJson(baselinePath));
    } catch (error) {
      regression = { ok: false, reason: boundedText(errorDescription(error)) };
    }
  }
  if (!regression.ok) {
    report.passed = false;
    console.error(`mutation tests failed: ${regression.reason}`);
  }
  const reportPath = path.resolve(root, options.report);
  writeReport(reportPath, report);
  const scored = results.filter((result) => result.expected !== "equivalent");
  const survivorMessage =
    report.survivingMutants.length > 0
      ? ` survivors=${report.survivingMutants.map((result) => `${result.id}=${result.outcome}`).join(",")}`
      : "";
  console.log(
    `mutation tests: ${report.totals.killed}/${scored.length} non-equivalent mutants killed, seed=${options.seed}`,
  );
  if (!report.passed) {
    console.error(`mutation tests failed: score=${report.score}${survivorMessage}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`mutation tests failed: ${errorDescription(error)}`);
    process.exitCode = 1;
  }
}
