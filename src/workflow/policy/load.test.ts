import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getPreset } from "./presets.js";
import { loadWorkflowPolicy, resolveWorkflowPolicyPath } from "./load.js";

function workspaceWithPolicy(content: string | undefined): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-workflow-policy-test-"));
  if (content !== undefined) {
    const filePath = resolveWorkflowPolicyPath(root);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

test("missing policy file returns ok:false reason:not-found, not an exception", () => {
  const root = workspaceWithPolicy(undefined);
  const result = loadWorkflowPolicy(root);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "not-found");
});

test("valid policy file loads and validates", () => {
  const root = workspaceWithPolicy(JSON.stringify(getPreset("strict-worktree")));
  const result = loadWorkflowPolicy(root);
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.document.preset, "strict-worktree");
});

test("invalid JSON fails closed with a diagnostic reason", () => {
  const root = workspaceWithPolicy("{not valid json");
  const result = loadWorkflowPolicy(root);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /invalid JSON/);
});

test("unsupported schemaVersion fails closed", () => {
  const document = { ...getPreset("minimal"), schemaVersion: 999 };
  const root = workspaceWithPolicy(JSON.stringify(document));
  const result = loadWorkflowPolicy(root);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /unsupported schemaVersion/);
});

test("unknown top-level key fails closed rather than being silently ignored", () => {
  const document = { ...getPreset("minimal"), unknownField: "should not be ignored" };
  const root = workspaceWithPolicy(JSON.stringify(document));
  const result = loadWorkflowPolicy(root);
  assert.equal(result.ok, false);
});

test("missing schemaVersion fails closed", () => {
  const { schemaVersion: _schemaVersion, ...withoutVersion } = getPreset("minimal");
  const root = workspaceWithPolicy(JSON.stringify(withoutVersion));
  const result = loadWorkflowPolicy(root);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /missing schemaVersion/);
});
