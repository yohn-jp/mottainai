import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MUTATIONS, validateMutationCatalog } from "./mutation-catalog.mjs";
import {
  applyMutation,
  buildMutationReport,
  classifyPropertySuiteResult,
  compareMutationBaseline,
  PROPERTY_SUITE_MAX_BUFFER,
  runPropertySuite,
  validateMutationBaseline,
} from "./mutation-test.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const propertyModule = JSON.stringify(pathToFileURL(path.join(root, "scripts/property-tests.mjs")).href);

function runPropertyModule(source) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("mutation runner treats spawn and abnormal exit failures as harness errors", () => {
  const error = Object.assign(new Error("output limit"), { code: "ENOBUFS" });
  const result = classifyPropertySuiteResult({ error, status: null, signal: null, stderr: "diagnostic" });
  assert.equal(result.outcome, "error");
  assert.match(result.diagnostic, /ENOBUFS/);
  assert.ok(result.diagnostic.length <= 2_000);
  assert.equal(classifyPropertySuiteResult({ status: null, signal: "SIGTERM", stderr: "" }).outcome, "error");

  let spawnOptions;
  runPropertySuite("/tmp/sandbox", { seed: 1, runs: 1, timeoutMs: 100 }, "/tmp/report.json", (...args) => {
    spawnOptions = args[2];
    return { status: 0, signal: null, stdout: "", stderr: "" };
  });
  assert.equal(spawnOptions.maxBuffer, PROPERTY_SUITE_MAX_BUFFER);
});

test("mutation replacements preserve special replacement sequences literally", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-mutation-replacement-"));
  try {
    const original = "prefix needle suffix";
    const replacement = "$& $$ $` $' $1";
    fs.writeFileSync(path.join(sandbox, "target.txt"), original);

    const applied = applyMutation(sandbox, {
      id: "literal-replacement",
      file: "target.txt",
      operator: "test",
      search: "needle",
      replacement,
    });

    assert.equal(applied.original, original);
    assert.equal(fs.readFileSync(applied.filePath, "utf8"), `prefix ${replacement} suffix`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("equivalent mutation descriptors require rationale and are excluded from the score", () => {
  const equivalent = {
    ...MUTATIONS[0],
    id: "equivalent-test",
    equivalence: { status: "equivalent", rationale: "the replacement preserves the observable result" },
  };
  assert.doesNotThrow(() => validateMutationCatalog([equivalent]));
  assert.throws(
    () => validateMutationCatalog([{ ...equivalent, equivalence: { status: "equivalent", rationale: " " } }]),
    /non-empty equivalence rationale/u,
  );

  const report = buildMutationReport({
    options: { seed: 1, runs: 1, timeoutMs: 100 },
    results: [
      { id: equivalent.id, expected: "equivalent", equivalence: equivalent.equivalence, outcome: "survived" },
      { id: "non-equivalent-test", expected: "non-equivalent", outcome: "survived" },
    ],
  });
  assert.deepEqual(report.totals, { selected: 2, killed: 0, survived: 1, equivalent: 1 });
  assert.equal(report.score, 0);
});

test("mutation baseline is canonical and enforces catalog parity and score floors", () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, "docs/mutation-baseline.json"), "utf8"));
  assert.doesNotThrow(() => validateMutationCatalog());
  assert.doesNotThrow(() => validateMutationBaseline(baseline));
  assert.deepEqual(
    baseline.mutations.map(({ id }) => id),
    MUTATIONS.map(({ id }) => id),
  );

  const report = buildMutationReport({
    options: { seed: baseline.seed, runs: baseline.propertyRuns, timeoutMs: baseline.mutationTimeoutMs },
    results: baseline.mutations,
  });
  assert.equal(compareMutationBaseline(report, baseline).ok, true);
  assert.equal(compareMutationBaseline({ ...report, score: baseline.score - 0.01 }, baseline).ok, false);

  const stale = structuredClone(baseline);
  delete stale.mutations[0].operator;
  assert.throws(() => validateMutationBaseline(stale), /does not match the catalog schema/);
});

test("shrinking stops at the first failing candidate", () => {
  const output = runPropertyModule(`
    const { minimizeCounterexample } = await import(${propertyModule});
    const result = await minimizeCounterexample("abcdef", async () => { throw new Error("still failing"); });
    console.log(JSON.stringify(result));
  `);
  assert.equal(output, '""');
});

test("containment checks use canonical root and candidate paths", () => {
  const output = runPropertyModule(`
    const { isContainedPath } = await import(${propertyModule});
    if (!isContainedPath("/private/var/folder", "/private/var/folder/nested")) process.exit(1);
    if (isContainedPath("/private/var/folder", "/private/var/folder-sibling")) process.exit(1);
    console.log("ok");
  `);
  assert.equal(output, "ok");
});

test("property failure reports contain bounded metadata without generated payload", () => {
  const output = runPropertyModule(`
    const { buildPropertyReport } = await import(${propertyModule});
    const report = buildPropertyReport(
      { seed: 240824, runs: 48 },
      [{ name: "passed-property", runs: 2 }],
      { property: "failing-property", seed: 240824, case: 3, minimized: true },
    );
    if (JSON.stringify(report).includes("super-secret-generated-payload")) process.exit(1);
    console.log(JSON.stringify(report));
  `);
  const report = JSON.parse(output);
  assert.equal(report.passed, false);
  assert.deepEqual(report.failure, { property: "failing-property", seed: 240824, case: 3, minimized: true });
  assert.equal(Object.hasOwn(report.failure, "counterexample"), false);
});

test("failed effectiveness runs still upload optional reports and template has no unenforced block", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/test-effectiveness.yml"), "utf8");
  assert.match(workflow, /timeout-minutes: 15/u);
  assert.match(workflow, /- name: Upload effectiveness reports\n\s+if: always\(\)/u);
  assert.match(workflow, /if-no-files-found: warn/u);

  const template = fs.readFileSync(path.join(root, ".github/PULL_REQUEST_TEMPLATE.md"), "utf8");
  assert.doesNotMatch(template, /Effectiveness evidence \(when applicable\)/u);
});
