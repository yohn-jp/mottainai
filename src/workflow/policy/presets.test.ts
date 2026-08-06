import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "./presets.js";
import { PRESET_NAMES, workflowPolicySchema } from "./schema.js";

test("every built-in preset validates against the canonical schema", () => {
  for (const name of PRESET_NAMES) {
    const result = workflowPolicySchema.safeParse(BUILTIN_PRESETS[name]);
    assert.equal(result.success, true, `preset ${name} failed schema validation: ${result.success ? "" : JSON.stringify(result.error.issues)}`);
  }
});

test("strict-worktree denies source edits, staging, commit, push, and force-push on protected branches", () => {
  const preset = BUILTIN_PRESETS["strict-worktree"];
  assert.equal(preset.protectedBranchRule.sourceWrite, "enforce");
  assert.equal(preset.protectedBranchRule.stage, "enforce");
  assert.equal(preset.protectedBranchRule.commit, "enforce");
  assert.equal(preset.protectedBranchRule.directPush, "enforce");
  assert.equal(preset.protectedBranchRule.forcePush, "enforce");
});

test("strict-worktree defaults staging mode to explicit", () => {
  assert.equal(BUILTIN_PRESETS["strict-worktree"].stagingMode, "explicit");
});

test("strict-worktree auto-removes worktree after verified merge but leaves remote branch deletion off", () => {
  const preset = BUILTIN_PRESETS["strict-worktree"];
  assert.equal(preset.cleanup.worktreeRemoval, "enforce");
  assert.equal(preset.cleanup.remoteBranchDeletion, "off");
});

test("minimal preset disables all enforcement", () => {
  const preset = BUILTIN_PRESETS.minimal;
  assert.equal(preset.protectedBranchRule.commit, "off");
  assert.equal(preset.worktree.required, "off");
});
