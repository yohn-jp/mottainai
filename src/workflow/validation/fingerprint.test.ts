import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { computeStateFingerprint } from "./fingerprint.js";

test("a clean repository yields a stable fingerprint across repeated calls (determinism)", async (t) => {
  const root = createTempGitRepo(t);
  const first = await computeStateFingerprint({ workspaceRoot: root });
  const second = await computeStateFingerprint({ workspaceRoot: root });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.snapshot.overallClean, true);
  assert.equal(first.snapshot.wholeWorktreeScope, true);
  assert.equal(first.snapshot.changed.length, 0);
});

test("editing a tracked file changes the fingerprint (default whole-worktree scope)", async (t) => {
  const root = createTempGitRepo(t);
  const clean = await computeStateFingerprint({ workspaceRoot: root });
  assert.equal(clean.ok, true);

  fs.writeFileSync(path.join(root, "file.txt"), "changed\n");
  const dirty = await computeStateFingerprint({ workspaceRoot: root });
  assert.equal(dirty.ok, true);
  if (!clean.ok || !dirty.ok) return;
  assert.notEqual(clean.fingerprint, dirty.fingerprint);
  assert.equal(dirty.snapshot.overallClean, false);
  assert.equal(dirty.snapshot.changed.length, 1);
  assert.equal(dirty.snapshot.changed[0]?.path, "file.txt");
});

test("committing a change updates headCommit and produces a new clean fingerprint", async (t) => {
  const root = createTempGitRepo(t);
  const dirtyBefore = await computeStateFingerprint({ workspaceRoot: root });
  fs.writeFileSync(path.join(root, "file.txt"), "changed\n");
  const dirty = await computeStateFingerprint({ workspaceRoot: root });
  runGit(["add", "file.txt"], root);
  runGit(["commit", "--quiet", "-m", "update"], root);
  const afterCommit = await computeStateFingerprint({ workspaceRoot: root });

  assert.equal(dirtyBefore.ok, true);
  assert.equal(dirty.ok, true);
  assert.equal(afterCommit.ok, true);
  if (!dirtyBefore.ok || !dirty.ok || !afterCommit.ok) return;
  assert.notEqual(dirtyBefore.headCommit, afterCommit.headCommit);
  assert.notEqual(dirty.fingerprint, afterCommit.fingerprint);
  assert.equal(afterCommit.snapshot.overallClean, true);
});

test("declared scope: a change outside scope does not affect the fingerprint", async (t) => {
  const root = createTempGitRepo(t);
  fs.writeFileSync(path.join(root, "docs.md"), "docs\n");
  runGit(["add", "docs.md"], root);
  runGit(["commit", "--quiet", "-m", "add docs"], root);
  const baseline = await computeStateFingerprint({ workspaceRoot: root, scope: ["src/**"] });

  fs.writeFileSync(path.join(root, "docs.md"), "docs changed\n");
  const afterOutOfScopeEdit = await computeStateFingerprint({ workspaceRoot: root, scope: ["src/**"] });

  assert.equal(baseline.ok, true);
  assert.equal(afterOutOfScopeEdit.ok, true);
  if (!baseline.ok || !afterOutOfScopeEdit.ok) return;
  assert.equal(baseline.fingerprint, afterOutOfScopeEdit.fingerprint);
});

test("declared scope: a change inside scope changes the fingerprint", async (t) => {
  const root = createTempGitRepo(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  runGit(["add", "src/index.ts"], root);
  runGit(["commit", "--quiet", "-m", "add src"], root);
  const baseline = await computeStateFingerprint({ workspaceRoot: root, scope: ["src/**"] });

  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1;\n");
  const afterInScopeEdit = await computeStateFingerprint({ workspaceRoot: root, scope: ["src/**"] });

  assert.equal(baseline.ok, true);
  assert.equal(afterInScopeEdit.ok, true);
  if (!baseline.ok || !afterInScopeEdit.ok) return;
  assert.notEqual(baseline.fingerprint, afterInScopeEdit.fingerprint);
});

test("configPaths fold declared config file content into the fingerprint even outside scope", async (t) => {
  const root = createTempGitRepo(t);
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  runGit(["add", "tsconfig.json"], root);
  runGit(["commit", "--quiet", "-m", "add tsconfig"], root);
  const baseline = await computeStateFingerprint({ workspaceRoot: root, scope: ["src/**"], configPaths: ["tsconfig.json"] });

  fs.writeFileSync(path.join(root, "tsconfig.json"), '{"strict":true}\n');
  const afterConfigEdit = await computeStateFingerprint({
    workspaceRoot: root,
    scope: ["src/**"],
    configPaths: ["tsconfig.json"],
  });

  assert.equal(baseline.ok, true);
  assert.equal(afterConfigEdit.ok, true);
  if (!baseline.ok || !afterConfigEdit.ok) return;
  assert.notEqual(baseline.fingerprint, afterConfigEdit.fingerprint);
});

test("a missing declared config file is folded in as absent without failing the fingerprint", async (t) => {
  const root = createTempGitRepo(t);
  const result = await computeStateFingerprint({ workspaceRoot: root, configPaths: ["does-not-exist.json"] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.configFileDigests["does-not-exist.json"], "absent");
});

test("an untracked new file within scope is included in the fingerprint", async (t) => {
  const root = createTempGitRepo(t);
  const baseline = await computeStateFingerprint({ workspaceRoot: root });
  fs.writeFileSync(path.join(root, "new-file.txt"), "new\n");
  const afterAdd = await computeStateFingerprint({ workspaceRoot: root });
  assert.equal(baseline.ok, true);
  assert.equal(afterAdd.ok, true);
  if (!baseline.ok || !afterAdd.ok) return;
  assert.notEqual(baseline.fingerprint, afterAdd.fingerprint);
  assert.equal(afterAdd.snapshot.changed.some((entry) => entry.path === "new-file.txt"), true);
});

test("a non-git directory yields ok: false (uncertain, must not be treated as reusable)", async (t) => {
  const root = createTempDir(t, "mottainai-not-a-repo-");
  const result = await computeStateFingerprint({ workspaceRoot: root });
  assert.equal(result.ok, false);
});

test("a git repo with no commits (unborn HEAD) yields ok: false", async (t) => {
  const root = createTempGitRepo(t, { initialCommit: false });
  const result = await computeStateFingerprint({ workspaceRoot: root });
  assert.equal(result.ok, false);
});

test("a staged deletion does not break fingerprint computation (regression: fully-staged delete must be excluded from hash-object)", async (t) => {
  const root = createTempGitRepo(t);
  fs.writeFileSync(path.join(root, "removable.txt"), "bye\n");
  runGit(["add", "removable.txt"], root);
  runGit(["commit", "--quiet", "-m", "add removable"], root);

  runGit(["rm", "--quiet", "removable.txt"], root);
  const afterStagedDelete = await computeStateFingerprint({ workspaceRoot: root });
  assert.equal(afterStagedDelete.ok, true);
  if (!afterStagedDelete.ok) return;
  const entry = afterStagedDelete.snapshot.changed.find((item) => item.path === "removable.txt");
  assert.notEqual(entry, undefined);
  assert.equal(entry?.contentDigest, "deleted");
});
