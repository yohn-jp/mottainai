import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MUTATION_POLICY, MUTATIONS } from "./mutation-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseOptions(argv) {
  const options = {
    seed: MUTATION_POLICY.seed,
    runs: MUTATION_POLICY.propertyRuns,
    timeoutMs: MUTATION_POLICY.timeoutMs,
    report: "test-artifacts/mutation-report.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--seed") options.seed = Number(argv[++index]);
    else if (argument === "--runs") options.runs = Number(argv[++index]);
    else if (argument === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (argument === "--report") options.report = argv[++index];
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 0)
    throw new Error("--seed must be a non-negative safe integer");
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 200)
    throw new Error("--runs must be between 1 and 200");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000)
    throw new Error("--timeout-ms is outside the bounded range");
  if (typeof options.report !== "string" || options.report.length === 0)
    throw new Error("--report must be a non-empty path");
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

function applyMutation(sandbox, mutation) {
  const filePath = path.join(sandbox, mutation.file);
  const original = fs.readFileSync(filePath, "utf8");
  const occurrences = original.split(mutation.search).length - 1;
  if (occurrences !== 1) throw new Error(`${mutation.id}: expected one source match, found ${occurrences}`);
  fs.writeFileSync(filePath, original.replace(mutation.search, mutation.replacement));
  return { filePath, original };
}

function runPropertySuite(sandbox, options, reportPath) {
  return spawnSync(
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
      stdio: "pipe",
      env: { ...process.env, MOTTAINAI_CONFIG: "" },
    },
  );
}

function main() {
  const options = parseOptions(process.argv.slice(2));
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
      } finally {
        if (applied) fs.writeFileSync(applied.filePath, applied.original);
      }
      const timedOut = child?.error?.code === "ETIMEDOUT";
      const killed = !timedOut && child?.status !== 0;
      results.push({
        id: mutation.id,
        file: mutation.file,
        operator: mutation.operator,
        expected: "non-equivalent",
        outcome: timedOut ? "timeout" : killed ? "killed" : "survived",
        exitCode: child?.status ?? null,
      });
      console.log(`${mutation.id}: ${results.at(-1).outcome}`);
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  const scored = results.filter((result) => result.expected !== "equivalent");
  const killed = scored.filter((result) => result.outcome === "killed").length;
  const survived = scored.filter((result) => result.outcome !== "killed");
  const score = scored.length === 0 ? 1 : killed / scored.length;
  const report = {
    schemaVersion: 1,
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
  const reportPath = path.resolve(root, options.report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`mutation tests: ${killed}/${scored.length} non-equivalent mutants killed, seed=${options.seed}`);
  if (survived.length > 0 || report.score < MUTATION_POLICY.minimumScore) {
    const survivorMessage =
      survived.length > 0 ? ` survivors=${survived.map((result) => `${result.id}=${result.outcome}`).join(",")}` : "";
    console.error(`mutation tests failed: score=${report.score}${survivorMessage}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`mutation tests failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
