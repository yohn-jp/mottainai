import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { bundledGovernedBranchTypes, validateBranchNameAgainstGovernance } from "./branch.js";

test("validateBranchNameAgainstGovernance falls back to the bundled Mottainai rules when the target repository has none", async (t) => {
  const root = createTempDir(t, "mottainai-branch-governance-test-");
  const valid = await validateBranchNameAgainstGovernance("fix/33-my-task", root);
  assert.deepEqual(valid, { ok: true });

  const invalid = await validateBranchNameAgainstGovernance("not-a-valid-branch", root);
  assert.equal(invalid.ok, false);
});

test("validateBranchNameAgainstGovernance prefers the target repository's own governance-rules.json branch pattern", async (t) => {
  const root = createTempDir(t, "mottainai-branch-governance-test-");
  fs.mkdirSync(path.join(root, ".mottainai"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".mottainai", "governance-rules.json"),
    JSON.stringify({ pullRequest: { branchPattern: "^custom/[a-z]+$" } }),
  );

  const matchesCustomPattern = await validateBranchNameAgainstGovernance("custom/anything", root);
  assert.deepEqual(matchesCustomPattern, { ok: true });

  // Mottainai 自身の bundled rule では有効な形式でも、対象 repository の
  // 独自ルールに従わない限り reject されることを確認する。
  const rejectedByCustomPattern = await validateBranchNameAgainstGovernance("fix/33-my-task", root);
  assert.equal(rejectedByCustomPattern.ok, false);
  if (rejectedByCustomPattern.ok) return;
  assert.equal(rejectedByCustomPattern.kind, "invalid");
});

test("validateBranchNameAgainstGovernance falls back to bundled rules when the repository's governance-rules.json is malformed", async (t) => {
  const root = createTempDir(t, "mottainai-branch-governance-test-");
  fs.mkdirSync(path.join(root, ".mottainai"), { recursive: true });
  fs.writeFileSync(path.join(root, ".mottainai", "governance-rules.json"), "{not valid json");

  const result = await validateBranchNameAgainstGovernance("fix/33-my-task", root);
  assert.deepEqual(result, { ok: true });
});

test("bundledGovernedBranchTypes is derived from the bundled governance-rules.json branchPattern and rejects ungoverned types", () => {
  const types = bundledGovernedBranchTypes();
  assert.deepEqual([...types].sort(), ["chore", "docs", "feat", "fix", "refactor", "test"]);
  assert.equal(types.includes("research"), false);
});

test("validateBranchNameAgainstGovernance rejects a branch type outside the bundled governed set (e.g. \"research\")", async (t) => {
  const root = createTempDir(t, "mottainai-branch-governance-test-");
  const result = await validateBranchNameAgainstGovernance("research/1-my-task", root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "invalid");
});
