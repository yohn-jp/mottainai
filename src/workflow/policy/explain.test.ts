import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { explainWorkflowPolicy } from "./explain.js";
import { getPreset } from "./presets.js";
import { resolveWorkflowPolicyPath } from "./load.js";

function workspaceWithPolicy(content: string | undefined): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-policy-explain-test-"));
  if (content !== undefined) {
    const filePath = resolveWorkflowPolicyPath(root);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

test("explainWorkflowPolicy falls back to the standard preset when no file exists, with authority=preset throughout", () => {
  const root = workspaceWithPolicy(undefined);
  const result = explainWorkflowPolicy(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.explained.policySourceAuthority, "preset");
  assert.equal(result.explained.preset, "standard");
  const standard = getPreset("standard");
  assert.equal(result.explained.rules.protectedBranchRule.directPush.mode, standard.protectedBranchRule.directPush);
  assert.equal(result.explained.rules.protectedBranchRule.directPush.authority, "preset");
  assert.deepEqual(result.explained.descriptive.protectedBranches, standard.protectedBranches);
  assert.equal(result.explained.descriptive.stagingMode, standard.stagingMode);
  assert.equal(result.explained.descriptive.bootstrapMode, standard.worktree.bootstrapMode);
});

test("explainWorkflowPolicy without a declared preset treats the file as the sole repository-authority source", () => {
  const document = { ...getPreset("minimal"), preset: undefined };
  const root = workspaceWithPolicy(JSON.stringify(document));
  const result = explainWorkflowPolicy(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.explained.policySourceAuthority, "repository");
  assert.equal(result.explained.rules.cleanup.forceCleanup.authority, "repository");
  assert.equal(result.explained.rules.cleanup.forceCleanup.mode, "off");
});

test("explainWorkflowPolicy strengthening a declared preset's rule is reflected with authority=repository", () => {
  const document = {
    ...getPreset("standard"),
    protectedBranchRule: { ...getPreset("standard").protectedBranchRule, sourceWrite: "enforce" },
  };
  const root = workspaceWithPolicy(JSON.stringify(document));
  const result = explainWorkflowPolicy(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(getPreset("standard").protectedBranchRule.sourceWrite, "advisory");
  assert.equal(result.explained.rules.protectedBranchRule.sourceWrite.mode, "enforce");
  assert.equal(result.explained.rules.protectedBranchRule.sourceWrite.authority, "repository");
});

test("explainWorkflowPolicy rejects weakening a declared preset's enforce rule (no humanApproval channel exists yet)", () => {
  const document = {
    ...getPreset("strict-worktree"),
    worktree: { ...getPreset("strict-worktree").worktree, required: "off" },
  };
  const root = workspaceWithPolicy(JSON.stringify(document));
  const result = explainWorkflowPolicy(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(getPreset("strict-worktree").worktree.required, "enforce");
  // ファイル自身は "off" を指定しているが、宣言した preset (strict-worktree) の enforce は
  // human approval なしに弱体化できないため、resolveRule() は preset 側を採用したままになる。
  assert.equal(result.explained.rules.worktree.required.mode, "enforce");
  assert.equal(result.explained.rules.worktree.required.authority, "preset");
});

test("explainWorkflowPolicy fails closed on a corrupted policy file instead of silently falling back to a preset", () => {
  const root = workspaceWithPolicy("{not valid json");
  const result = explainWorkflowPolicy(root);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /invalid JSON/);
});
