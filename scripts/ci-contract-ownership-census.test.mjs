import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CI_CLASS_GATE_CONSUMERS,
  DIRECT_GATE_CONTRACTS,
  EXEMPT_PATH_PATTERNS,
  findUnconsumedOwnershipClasses,
  findUnownedTrackedFiles,
  isDirectlyGatedPath,
  isExemptPath,
  listTrackedFiles,
} from "./ci-contract-ownership-census.mjs";
import { classifyChangedFiles, loadContractOwnershipClasses } from "./ci-contract-ownership.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const classes = loadContractOwnershipClasses(repositoryRoot);
const trackedFiles = listTrackedFiles(repositoryRoot);

test("exemption list is explicit and has no catch-all wildcard", () => {
  assert.ok(EXEMPT_PATH_PATTERNS.length > 0);
  for (const pattern of EXEMPT_PATH_PATTERNS) {
    assert.notEqual(pattern, "*");
    assert.notEqual(pattern, "**");
  }
});

test("every ownership class reaches an actual required CI gate", () => {
  assert.deepEqual(findUnconsumedOwnershipClasses(repositoryRoot, { classes }), []);
  for (const className of Object.keys(CI_CLASS_GATE_CONSUMERS)) {
    assert.ok(classes[className], "missing class: " + className);
  }
});

test("direct workflow-owned paths have pull_request jobs that consume them", () => {
  for (const [filePath, contract] of Object.entries(DIRECT_GATE_CONTRACTS)) {
    assert.equal(isDirectlyGatedPath(filePath, repositoryRoot), true, filePath);
    assert.ok(contract.jobs.length > 0);
  }
});

test("review-pages changes reach real Node/integration gates after #879", () => {
  const selected = classifyChangedFiles(classes, [
    "review-pages/src/publish-to-pages.mjs",
    ".github/workflows/review-pages.yml",
  ]);
  assert.equal(selected.node, true);
  assert.equal(selected.integration, true);
  assert.equal(isDirectlyGatedPath(".github/workflows/review-pages.yml", repositoryRoot), true);
});

test("publish workflow is not falsely treated as self-governing", () => {
  assert.equal(isExemptPath(".github/workflows/publish.yml"), false);
  assert.deepEqual(
    findUnownedTrackedFiles(repositoryRoot, {
      trackedFiles: [".github/workflows/publish.yml"],
      classes,
    }),
    [],
  );
});

test("census enumerates a substantial tracked-file set", () => {
  assert.ok(trackedFiles.length > 100, "expected a substantial tracked-file set");
});

test("census: every tracked file is owned or directly gated", () => {
  const unowned = findUnownedTrackedFiles(repositoryRoot, { trackedFiles, classes });
  assert.deepEqual(unowned, [], "unowned paths:\n" + unowned.map((filePath) => "  - " + filePath).join("\n"));
});

test("mutation: a brand-new top-level path fails closed", () => {
  const unowned = findUnownedTrackedFiles(repositoryRoot, {
    trackedFiles: [...trackedFiles, "new-unowned-tool.sh"],
    classes,
  });
  assert.deepEqual(unowned, ["new-unowned-tool.sh"]);
});

test("mutation: a new script under an existing directory fails closed", () => {
  const unowned = findUnownedTrackedFiles(repositoryRoot, {
    trackedFiles: [...trackedFiles, "scripts/totally-new-unclassified-tool.py"],
    classes,
  });
  assert.deepEqual(unowned, ["scripts/totally-new-unclassified-tool.py"]);
});

test("workflow exemptions are not used for executable workflow paths", () => {
  for (const filePath of Object.keys(DIRECT_GATE_CONTRACTS)) {
    assert.equal(isExemptPath(filePath), false);
  }
});
