import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateRuntimeContractSelection, loadRuntimeContractGateExpressions } from "./ci-runtime-contract-gates.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateExpressions = loadRuntimeContractGateExpressions(repositoryRoot);

function baseOutputs(overrides) {
  return {
    runtime_nix: "false",
    runtime_vm: "false",
    runtime_appliance: "false",
    host_bootstrap: "false",
    ...overrides,
  };
}

test("host-bootstrap-only PR selects no Runtime job (PR #763 shape)", () => {
  const selection = evaluateRuntimeContractSelection(gateExpressions, {
    eventName: "pull_request",
    outputs: baseOutputs({ host_bootstrap: "true" }),
  });
  assert.deepEqual(selection, { "runtime-nix": false, "runtime-vm": false, "runtime-appliance": false });
});

test("Route 2 / Nix package PR selects only runtime-nix", () => {
  const selection = evaluateRuntimeContractSelection(gateExpressions, {
    eventName: "pull_request",
    outputs: baseOutputs({ runtime_nix: "true" }),
  });
  assert.deepEqual(selection, { "runtime-nix": true, "runtime-vm": false, "runtime-appliance": false });
});

test("VM-affecting PR selects runtime-nix and runtime-vm, not runtime-appliance", () => {
  const selection = evaluateRuntimeContractSelection(gateExpressions, {
    eventName: "pull_request",
    outputs: baseOutputs({ runtime_nix: "true", runtime_vm: "true" }),
  });
  assert.deepEqual(selection, { "runtime-nix": true, "runtime-vm": true, "runtime-appliance": false });
});

test("Appliance-affecting PR selects runtime-nix and runtime-appliance, not runtime-vm", () => {
  const selection = evaluateRuntimeContractSelection(gateExpressions, {
    eventName: "pull_request",
    outputs: baseOutputs({ runtime_nix: "true", runtime_appliance: "true" }),
  });
  assert.deepEqual(selection, { "runtime-nix": true, "runtime-vm": false, "runtime-appliance": true });
});

test("Appliance-only script/Rust change (no nix/** path) still selects runtime-nix and runtime-appliance", () => {
  // e.g. scripts/build-runtime-appliance-manifest.mjs: runtime_nix filter
  // does not match it directly, but the Appliance job still needs the Nix
  // Runtime prerequisite built.
  const selection = evaluateRuntimeContractSelection(gateExpressions, {
    eventName: "pull_request",
    outputs: baseOutputs({ runtime_appliance: "true" }),
  });
  assert.deepEqual(selection, { "runtime-nix": true, "runtime-vm": false, "runtime-appliance": true });
});

test("shared Runtime/Appliance change selects every true dependent class", () => {
  const selection = evaluateRuntimeContractSelection(gateExpressions, {
    eventName: "pull_request",
    outputs: baseOutputs({ runtime_nix: "true", runtime_vm: "true", runtime_appliance: "true" }),
  });
  assert.deepEqual(selection, { "runtime-nix": true, "runtime-vm": true, "runtime-appliance": true });
});

test("no selected contract on a PR runs no Runtime job", () => {
  const selection = evaluateRuntimeContractSelection(gateExpressions, {
    eventName: "pull_request",
    outputs: baseOutputs(),
  });
  assert.deepEqual(selection, { "runtime-nix": false, "runtime-vm": false, "runtime-appliance": false });
});

test("trusted main push runs the full Appliance composition whenever any Runtime class is affected", () => {
  const selection = evaluateRuntimeContractSelection(gateExpressions, {
    eventName: "push",
    outputs: baseOutputs({ runtime_nix: "true" }),
  });
  assert.deepEqual(selection, { "runtime-nix": true, "runtime-vm": false, "runtime-appliance": true });
});

test("a dependabot-authored PR gets a deterministic skip across every Runtime job", () => {
  const selection = evaluateRuntimeContractSelection(gateExpressions, {
    eventName: "pull_request",
    actor: "dependabot[bot]",
    outputs: baseOutputs({ runtime_nix: "true", runtime_vm: "true", runtime_appliance: "true" }),
  });
  assert.deepEqual(selection, { "runtime-nix": false, "runtime-vm": false, "runtime-appliance": false });
});

test("a release/* head ref PR gets a deterministic skip across every Runtime job", () => {
  const selection = evaluateRuntimeContractSelection(gateExpressions, {
    eventName: "pull_request",
    headRef: "release/1.2.3",
    outputs: baseOutputs({ runtime_nix: "true", runtime_vm: "true", runtime_appliance: "true" }),
  });
  assert.deepEqual(selection, { "runtime-nix": false, "runtime-vm": false, "runtime-appliance": false });
});
