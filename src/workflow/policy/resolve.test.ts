import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRule } from "./resolve.js";
import type { PolicySource, ResolvedPolicy, ResolvedRule } from "./resolve.js";

/**
 * 配列フィールド（protectedBranches）が要素単位にマッピングされず、単一の
 * ResolvedRule<string[]> として解決されることをコンパイル時に検証する。
 * `extends object` 分岐だけだと配列も object 扱いされ、要素キーごとに
 * マッピングされてしまう回帰を防ぐ。
 */
type _ProtectedBranchesIsSingleRule = ResolvedPolicy["protectedBranches"] extends ResolvedRule<string[]> ? true : never;
const _protectedBranchesTypeCheck: _ProtectedBranchesIsSingleRule = true;
void _protectedBranchesTypeCheck;

test("higher authority strengthens the rule freely", () => {
  const sources: PolicySource<boolean>[] = [
    { authority: "built-in", value: false, mode: "off" },
    { authority: "preset", value: true, mode: "advisory" },
    { authority: "repository", value: true, mode: "enforce" },
  ];
  const resolved = resolveRule(sources);
  assert.equal(resolved.mode, "enforce");
  assert.equal(resolved.authority, "repository");
});

test("invocation override can never weaken an enforce rule set by repository policy", () => {
  const sources: PolicySource<boolean>[] = [
    { authority: "repository", value: true, mode: "enforce" },
    { authority: "invocation", value: false, mode: "off" },
  ];
  const resolved = resolveRule(sources);
  assert.equal(resolved.mode, "enforce", "invocation must not weaken enforce");
  assert.equal(resolved.authority, "repository");
});

test("invocation override can still strengthen a weaker rule", () => {
  const sources: PolicySource<boolean>[] = [
    { authority: "repository", value: false, mode: "advisory" },
    { authority: "invocation", value: true, mode: "enforce" },
  ];
  const resolved = resolveRule(sources);
  assert.equal(resolved.mode, "enforce");
  assert.equal(resolved.authority, "invocation");
});

test("repository-authority weakening of an enforce rule requires human approval", () => {
  const withoutApproval: PolicySource<boolean>[] = [
    { authority: "preset", value: true, mode: "enforce" },
    { authority: "repository", value: false, mode: "advisory" },
  ];
  const resolvedWithout = resolveRule(withoutApproval);
  assert.equal(resolvedWithout.mode, "enforce", "weakening without human approval must be rejected");

  const withApproval: PolicySource<boolean>[] = [
    { authority: "preset", value: true, mode: "enforce" },
    {
      authority: "repository",
      value: false,
      mode: "advisory",
      humanApproval: { confirmedBy: "yohnark", confirmedAt: "2026-08-06T00:00:00Z" },
    },
  ];
  const resolvedWith = resolveRule(withApproval);
  assert.equal(resolvedWith.mode, "advisory", "weakening with explicit human approval is allowed");
  assert.equal(resolvedWith.confirmation?.confirmedBy, "yohnark");
});

test("equal-strength mode change from a lower authority is not treated as weakening", () => {
  const sources: PolicySource<string>[] = [
    { authority: "preset", value: "explicit", mode: "enforce" },
    { authority: "repository", value: "tracked", mode: "enforce" },
  ];
  const resolved = resolveRule(sources);
  assert.equal(resolved.value, "tracked");
  assert.equal(resolved.authority, "repository");
});

test("confirm mode carries a structured confirmation record, not a bare boolean", () => {
  const sources: PolicySource<boolean>[] = [
    {
      authority: "repository",
      value: true,
      mode: "confirm",
      humanApproval: { confirmedBy: "yohnark", confirmedAt: "2026-08-06T00:00:00Z", evidence: "manual review in PR #1" },
    },
  ];
  const resolved = resolveRule(sources);
  assert.equal(resolved.mode, "confirm");
  assert.equal(resolved.confirmation?.evidence, "manual review in PR #1");
});

test("single source resolves directly and enforce defaults to human-only weakening", () => {
  const resolved = resolveRule([{ authority: "built-in", value: true, mode: "enforce" }]);
  assert.equal(resolved.weakening, "human-only");
});

test("resolveRule throws on empty source list", () => {
  assert.throws(() => resolveRule([]));
});
