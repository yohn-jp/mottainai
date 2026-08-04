import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCapabilityIndex } from "./capabilities.js";
import {
  bareToolName,
  planCodeSearch,
  planCodeSymbol,
  resolveCodeSearchKind,
  UNSUPPORTED_BACKEND,
} from "./code-search.js";

test("resolveCodeSearchKind detects ast-grep metavariables and honors explicit kind", () => {
  assert.equal(resolveCodeSearchKind({ pattern: "useState($$$)" }), "ast");
  assert.equal(resolveCodeSearchKind({ pattern: "const $VALUE = 1" }), "ast");
  assert.equal(resolveCodeSearchKind({ pattern: "function useful()" }), "text");
  assert.equal(resolveCodeSearchKind({ pattern: "useState($$$)", kind: "text" }), "text");
});

test("planCodeSearch falls back to builtin rg alone when no provider declares text_matches", () => {
  const index = buildCapabilityIndex([]);
  const candidates = planCodeSearch({ pattern: "needle" }, index);
  assert.deepEqual(candidates.map((c) => c.backend), ["rg"]);
  assert.equal(candidates[0].reason, `text_matches_rank_1`);
});

test("planCodeSearch ranks a configured text_matches provider ahead of builtin rg", () => {
  const index = buildCapabilityIndex([
    { name: "fff", command: "noop", capabilities: ["text_matches"] },
  ]);
  const candidates = planCodeSearch({ pattern: "needle" }, index);
  assert.deepEqual(candidates.map((c) => c.backend), ["fff", "rg"]);
});

test("planCodeSearch returns only git grep when scope is tracked, excluding rg and other text_matches providers", () => {
  const index = buildCapabilityIndex([
    { name: "fff", command: "noop", capabilities: ["text_matches"] },
  ]);
  const candidates = planCodeSearch({ pattern: "needle", scope: "tracked" }, index);
  assert.deepEqual(candidates.map((c) => c.backend), ["git_grep"]);
  assert.equal(candidates[0].reason, "scope_tracked");
});

test("planCodeSearch routes ast patterns to ast-grep only, with no lossy text fallback", () => {
  const index = buildCapabilityIndex([
    { name: "fff", command: "noop", capabilities: ["text_matches"] },
  ]);
  const candidates = planCodeSearch({ pattern: "$FN($$$)", kind: "ast" }, index);
  assert.deepEqual(candidates.map((c) => c.backend), ["ast_grep"]);
  assert.equal(candidates[0].reason, "ast_pattern");
  assert.equal(candidates[0].tool, "ast-grep");
});

test("planCodeSearch returns an explicit unsupported outcome for ast pattern + tracked scope", () => {
  const index = buildCapabilityIndex([]);
  const candidates = planCodeSearch({ pattern: "$FN($$$)", kind: "ast", scope: "tracked" }, index);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].backend, UNSUPPORTED_BACKEND);
  assert.equal(candidates[0].tool, undefined);
  assert.equal(candidates[0].reason, "ast_tracked_scope_unsupported");
});

// planCodeSearch is a planner only: it decides which backend a tracked-scope search should use,
// it does not execute it. The executor that consumes CodeSearchCandidate (spawning `git grep`,
// `rg`, etc.) is the top-level code-search dispatcher, which is intentionally not part of this
// PR (see PR description: "code-search.ts (top-level dispatcher) ... land in the final import
// PR"). This test therefore verifies the lower-level assumption the planner's choice relies on —
// that the exact backend/tool planCodeSearch selects (`git grep`, via candidate.tool) restricts
// results to Git-tracked files on a real repository — using a temporary Git repo with one tracked
// and one untracked matching file. Once the dispatcher exists, add a companion test that exercises
// it end-to-end with this same fixture.
test("planCodeSearch tracked scope: the selected git_grep backend never returns an untracked matching file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-code-search-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    await fs.writeFile(path.join(root, "tracked.txt"), "needle in tracked file\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });
    await fs.writeFile(path.join(root, "untracked.txt"), "needle in untracked file\n");

    const index = buildCapabilityIndex([]);
    const candidates = planCodeSearch({ pattern: "needle", scope: "tracked" }, index);
    assert.deepEqual(candidates.map((c) => c.backend), ["git_grep"]);
    assert.equal(candidates[0].tool, "git");

    // Invoke exactly the tool/backend the planner selected, from the workspace root it would run in.
    const output = execFileSync(candidates[0].tool!, ["grep", "-n", "needle"], { cwd: root, encoding: "utf8" });
    assert.match(output, /tracked\.txt/);
    assert.doesNotMatch(output, /untracked\.txt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("planCodeSymbol ranks a configured relation provider before the rg text-search fallback", () => {
  const index = buildCapabilityIndex(
    [{ name: "codegraph", command: "noop" }],
    { codegraph__find_callers: ["callers"] },
  );
  const candidates = planCodeSymbol({ symbol: "useful", relation: "callers" }, index);
  assert.deepEqual(candidates.map((c) => c.backend), ["codegraph", "rg"]);
  assert.equal(candidates[0].tool, "codegraph__find_callers");
  assert.equal(candidates[1].reason, "symbol_backend_unavailable_fallback_to_text_search");
});

test("planCodeSymbol falls back to rg alone when no provider satisfies the relation", () => {
  const index = buildCapabilityIndex([]);
  const candidates = planCodeSymbol({ symbol: "useful" }, index);
  assert.deepEqual(candidates.map((c) => c.backend), ["rg"]);
});

test("bareToolName strips the provider prefix used by capabilityMap entries", () => {
  assert.equal(bareToolName("codegraph", "codegraph__find_callers"), "find_callers");
  assert.equal(bareToolName("local", "mottainai_search"), "mottainai_search");
  assert.equal(bareToolName("codegraph", undefined), undefined);
});
