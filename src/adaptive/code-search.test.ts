import assert from "node:assert/strict";
import test from "node:test";
import { buildCapabilityIndex } from "./capabilities.js";
import {
  bareToolName,
  planCodeSearch,
  planCodeSymbol,
  resolveCodeSearchKind,
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

test("planCodeSearch prepends git grep when scope is tracked", () => {
  const index = buildCapabilityIndex([]);
  const candidates = planCodeSearch({ pattern: "needle", scope: "tracked" }, index);
  assert.deepEqual(candidates.map((c) => c.backend), ["git_grep", "rg"]);
  assert.equal(candidates[0].reason, "scope_tracked");
});

test("planCodeSearch routes ast patterns to ast-grep with rg as the only fallback", () => {
  const index = buildCapabilityIndex([
    { name: "fff", command: "noop", capabilities: ["text_matches"] },
  ]);
  const candidates = planCodeSearch({ pattern: "$FN($$$)", kind: "ast" }, index);
  assert.deepEqual(candidates.map((c) => c.backend), ["ast_grep", "rg"]);
  assert.equal(candidates[1].reason, "ast_unavailable_fallback_to_text");
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
