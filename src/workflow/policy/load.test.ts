import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getPreset } from "./presets.js";
import { loadWorkflowPolicy, resolveEffectiveWorkflowPolicy, resolveWorkflowPolicyPath } from "./load.js";

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

test("unknown key nested inside a rule object fails closed rather than being silently stripped", () => {
  const preset = getPreset("minimal");
  const document = { ...preset, cleanup: { ...preset.cleanup, unknownNested: "should not be stripped" } };
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

test("resolveEffectiveWorkflowPolicy falls back to the standard preset when no file exists", () => {
  const root = workspaceWithPolicy(undefined);
  const result = resolveEffectiveWorkflowPolicy(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, "preset");
  assert.deepEqual(result.document, getPreset("standard"));
});

test("resolveEffectiveWorkflowPolicy uses the repository file when present", () => {
  const root = workspaceWithPolicy(JSON.stringify(getPreset("strict-worktree")));
  const result = resolveEffectiveWorkflowPolicy(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, "repository");
  assert.equal(result.document.preset, "strict-worktree");
});

test("resolveEffectiveWorkflowPolicy fails closed on a corrupted file instead of silently falling back to a preset", () => {
  const root = workspaceWithPolicy("{not valid json");
  const result = resolveEffectiveWorkflowPolicy(root);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /invalid JSON/);
});
