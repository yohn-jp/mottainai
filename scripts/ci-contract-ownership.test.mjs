import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyChangedFiles, loadContractOwnershipClasses, matchesPattern } from "./ci-contract-ownership.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const classes = loadContractOwnershipClasses(repositoryRoot);

const RUNTIME_CLASSES = ["runtime_nix", "runtime_vm", "runtime_appliance"];
const ALL_PATH_CLASSES = ["host_bootstrap", ...RUNTIME_CLASSES, "node", "integration", "package", "governance"];

function assertSelection(changedFiles, expected) {
  const selected = classifyChangedFiles(classes, changedFiles);
  for (const className of ALL_PATH_CLASSES) {
    const expectedValue = Boolean(expected[className]);
    assert.equal(
      selected[className],
      expectedValue,
      `expected ${className}=${expectedValue} for ${JSON.stringify(changedFiles)}, got ${selected[className]}`,
    );
  }
}

test("required contract-ownership classes exist", () => {
  for (const className of ALL_PATH_CLASSES) {
    assert.ok(Array.isArray(classes[className]) && classes[className].length > 0, `missing filter class: ${className}`);
  }
});

test("host-bootstrap-only control-plane change selects only host_bootstrap (PR #763 shape)", () => {
  assertSelection(
    [
      "host-bootstrap/src/deployment_descriptor.rs",
      "host-bootstrap/src/error.rs",
      "host-bootstrap/src/lib.rs",
      "host-bootstrap/src/lima.rs",
      "host-bootstrap/src/main.rs",
      "host-bootstrap/tests/reconciliation.rs",
    ],
    { host_bootstrap: true },
  );
});

test("Route 2 / managed-generation Nix change selects only runtime_nix", () => {
  assertSelection(["nix/managed-generation.nix"], { runtime_nix: true });
});

test("Nix package catalog change selects only runtime_nix", () => {
  assertSelection(["nix/packages/nawabari.nix"], { runtime_nix: true });
});

test("guest/VM-semantic module change selects runtime_nix and runtime_vm, not runtime_appliance", () => {
  assertSelection(["nix/modules/runtime.nix"], { runtime_nix: true, runtime_vm: true });
});

test("VM-specific test change selects runtime_nix and runtime_vm", () => {
  assertSelection(["nix/tests/runtime.nix"], { runtime_nix: true, runtime_vm: true });
});

test("Appliance-defining change selects runtime_nix and runtime_appliance, not runtime_vm", () => {
  assertSelection(["nix/runtime-appliance-image.nix"], { runtime_nix: true, runtime_appliance: true });
});

test("Appliance manifest scripts select only runtime_appliance", () => {
  assertSelection(["scripts/build-runtime-appliance-manifest.mjs"], { runtime_appliance: true });
});

test("shared Appliance contract consumed by host-bootstrap selects both true dependent classes", () => {
  assertSelection(["host-bootstrap/src/appliance.rs"], { host_bootstrap: true, runtime_appliance: true });
  assertSelection(["host-bootstrap/tests/appliance_real.rs"], { host_bootstrap: true, runtime_appliance: true });
});

test("shared Appliance manifest contract change on the TypeScript side also gates the Rust consumer (host_bootstrap)", () => {
  for (const filePath of [
    "src/runtime-contract/appliance-manifest.ts",
    "src/runtime-contract/appliance-manifest.test.ts",
  ]) {
    const selected = classifyChangedFiles(classes, [filePath]);
    assert.equal(selected.host_bootstrap, true, `${filePath} did not select host_bootstrap`);
    assert.equal(selected.runtime_appliance, true, `${filePath} did not select runtime_appliance`);
    assert.equal(selected.runtime_vm, false, `${filePath} unexpectedly selected runtime_vm`);
  }
});

test("host-bootstrap change that does not touch a shared Appliance/VM file never selects runtime classes", () => {
  const selected = classifyChangedFiles(classes, ["host-bootstrap/src/reconcile.rs"]);
  assert.equal(selected.host_bootstrap, true);
  for (const runtimeClass of RUNTIME_CLASSES) {
    assert.equal(selected[runtimeClass], false, `host-bootstrap-only change unexpectedly selected ${runtimeClass}`);
  }
});

test("Node/source-only change selects node/integration/package but no host-bootstrap or runtime class", () => {
  const selected = classifyChangedFiles(classes, ["src/atomic-file.ts"]);
  assert.equal(selected.host_bootstrap, false);
  // src/atomic-file.ts is a Route 2 bootstrap dependency (docs/architecture/ci/topology.md),
  // so it is a true shared runtime_nix consumer in addition to node/integration/package.
  assert.equal(selected.runtime_nix, true);
  assert.equal(selected.runtime_vm, false);
  assert.equal(selected.runtime_appliance, false);
  assert.equal(selected.node, true);
});

test("docs-only change selects no governed executable contract class", () => {
  assertSelection(["docs/architecture/ci/topology.md"], {});
});

test("workflow/config change conservatively invalidates every class its selection logic can change", () => {
  const selected = classifyChangedFiles(classes, [".github/workflows/ci.yml"]);
  assert.equal(selected.host_bootstrap, true);
  for (const runtimeClass of RUNTIME_CLASSES) {
    assert.equal(selected[runtimeClass], true, `ci.yml change did not conservatively select ${runtimeClass}`);
  }
  assert.equal(selected.node, true);
  assert.equal(selected.integration, true);
  assert.equal(selected.package, true);
});

test("matchesPattern treats ** as arbitrary depth and * as a single path segment", () => {
  assert.equal(matchesPattern("nix/**", "nix/modules/runtime.nix"), true);
  assert.equal(matchesPattern("nix/**", "nix-adjacent/file.nix"), false);
  assert.equal(matchesPattern("scripts/lib/mcp-blackbox-*.mjs", "scripts/lib/mcp-blackbox-client.mjs"), true);
  assert.equal(matchesPattern("scripts/lib/mcp-blackbox-*.mjs", "scripts/lib/mcp-blackbox-client.test.mjs"), true);
  assert.equal(matchesPattern("package.json", "package.json"), true);
  assert.equal(matchesPattern("package.json", "src/package.json"), false);
});
