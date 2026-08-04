import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUILTIN_POLICY,
  approvePolicy,
  loadActivePolicy,
  loadPolicies,
  newPolicyVersion,
  normalizePolicyDocument,
  resolvePlan,
  savePolicy,
} from "./policy.js";
import type { PolicyDocument } from "./policy.js";

function temporaryDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-policy-"));
}

function candidate(version: string, capabilities: string[]): PolicyDocument {
  // version は newPolicyVersion() 形式（例: "20260720T000000Z"）。日付部分 [6, 8) を
  // そのまま抜き出す（version.slice(-2) は末尾2文字 "0Z" になり不正な日付を作ってしまう）。
  return {
    policy_version: version,
    status: "candidate",
    source: "proposed",
    generated_at: `2026-07-${version.slice(6, 8)}T00:00:00.000Z`,
    rules: [{ task_category: "bug_investigation", capabilities }],
  };
}

test("policy adds its capabilities after the caller's, without reordering the caller", () => {
  const plan = resolvePlan(BUILTIN_POLICY, "bug_investigation", ["runtime_state", "callers"]);
  assert.deepEqual(plan.capabilities.slice(0, 2), ["runtime_state", "callers"]);
  assert.deepEqual(plan.added_by_policy, ["definitions", "tests", "recent_changes"]);
  assert.equal(plan.matched_default_rule, false);
});

test("an unknown category falls back to the default rule", () => {
  const plan = resolvePlan(BUILTIN_POLICY, "migration_audit", []);
  assert.deepEqual(plan.capabilities, ["text_matches", "file_content"]);
  assert.equal(plan.matched_default_rule, true);
});

test("avoid_capabilities never removes what the caller asked for", () => {
  const policy: PolicyDocument = {
    ...BUILTIN_POLICY,
    rules: [{ task_category: "bug_investigation", capabilities: ["callers", "tests"], avoid_capabilities: ["tests"] }],
  };
  const withoutCaller = resolvePlan(policy, "bug_investigation", []);
  assert.deepEqual(withoutCaller.capabilities, ["callers"]);
  assert.deepEqual(withoutCaller.suppressed, ["tests"]);

  const withCaller = resolvePlan(policy, "bug_investigation", ["tests"]);
  assert.deepEqual(withCaller.capabilities, ["tests", "callers"]);
  assert.deepEqual(withCaller.suppressed, []);
});

test("a candidate policy on disk never becomes active", () => {
  const directory = temporaryDir();
  savePolicy(directory, candidate("20260720T000000Z", ["callers", "ownership"]));
  const active = loadActivePolicy({ MOTTAINAI_POLICY_DIR: directory });
  assert.equal(active.policy_version, BUILTIN_POLICY.policy_version);
});

test("approval activates the candidate and keeps the newest approved policy", () => {
  const directory = temporaryDir();
  savePolicy(directory, candidate("20260720T000000Z", ["callers", "ownership"]));
  savePolicy(directory, candidate("20260722T000000Z", ["callers", "tests", "docs"]));

  approvePolicy(directory, "20260720T000000Z", "reviewer");
  assert.equal(loadActivePolicy({ MOTTAINAI_POLICY_DIR: directory }).policy_version, "20260720T000000Z");

  approvePolicy(directory, "20260722T000000Z", "reviewer");
  const active = loadActivePolicy({ MOTTAINAI_POLICY_DIR: directory });
  assert.equal(active.policy_version, "20260722T000000Z");
  assert.equal(active.approved_by, "reviewer");
  assert.deepEqual(resolvePlan(active, "bug_investigation", []).capabilities, ["callers", "tests", "docs"]);
});

test("loadActivePolicy sorts approved policies by generated_at, not by policy_version lexical order", () => {
  const directory = temporaryDir();
  // policy_version の辞書順だけで並べると "9-old" が "1-new" より新しいと誤判定される。
  // generated_at が本当に primary sort key として使われているかをこれで検証する。
  const older: PolicyDocument = {
    policy_version: "9-old",
    status: "approved",
    source: "proposed",
    generated_at: "2026-07-01T00:00:00.000Z",
    rules: [{ task_category: "bug_investigation", capabilities: ["callers"] }],
  };
  const newer: PolicyDocument = {
    policy_version: "1-new",
    status: "approved",
    source: "proposed",
    generated_at: "2026-07-31T00:00:00.000Z",
    rules: [{ task_category: "bug_investigation", capabilities: ["tests"] }],
  };
  savePolicy(directory, older);
  savePolicy(directory, newer);
  assert.equal(loadActivePolicy({ MOTTAINAI_POLICY_DIR: directory }).policy_version, "1-new");
});

test("approvePolicy returns the path it actually wrote and removes a stale differently-named candidate file", () => {
  const directory = temporaryDir();
  const document = candidate("20260720T000000Z", ["callers"]);
  // savePolicy が使うはずの正規名とは異なる名前で候補ファイルを置く状況を再現する
  // （loadPolicies は directory 内の *.json を無差別に読むため、こうしたズレが起こりうる）。
  const staleFilePath = path.join(directory, "manually-renamed-candidate.json");
  fs.writeFileSync(staleFilePath, `${JSON.stringify(document, null, 2)}\n`);

  const result = approvePolicy(directory, document.policy_version, "reviewer");

  assert.equal(fs.existsSync(staleFilePath), false);
  assert.equal(result.filePath, path.join(directory, "policy-20260720T000000Z.json"));
  assert.equal(fs.existsSync(result.filePath), true);

  const stored = loadPolicies(directory).filter((entry) => entry.document.policy_version === document.policy_version);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.document.status, "approved");
});

test("MOTTAINAI_POLICY=0 pins routing to the builtin policy", () => {
  const directory = temporaryDir();
  savePolicy(directory, { ...candidate("20260720T000000Z", ["callers"]), status: "approved" });
  assert.equal(loadActivePolicy({ MOTTAINAI_POLICY_DIR: directory, MOTTAINAI_POLICY: "0" }).policy_version, "builtin-1");
});

test("a corrupt policy file is skipped instead of breaking routing", () => {
  const directory = temporaryDir();
  savePolicy(directory, { ...candidate("20260720T000000Z", ["callers"]), status: "approved" });
  fs.writeFileSync(path.join(directory, "policy-broken.json"), "{ not json");
  assert.equal(loadPolicies(directory).length, 1);
  assert.equal(loadActivePolicy({ MOTTAINAI_POLICY_DIR: directory }).policy_version, "20260720T000000Z");
});

test("policy documents are validated and capability names normalized on load", () => {
  const document = normalizePolicyDocument({
    policy_version: "x", status: "approved", generated_at: "2026-07-30T00:00:00.000Z",
    rules: [{ task_category: "Bug Investigation", capabilities: ["code.search"] }],
  }, "test");
  assert.deepEqual(document.rules[0], { task_category: "bug_investigation", capabilities: ["text_matches"], avoid_capabilities: undefined, support: undefined, confidence: undefined });
  assert.throws(() => normalizePolicyDocument({ policy_version: "x", status: "active", rules: [] }, "test"), /invalid policy status/);
  assert.throws(() => normalizePolicyDocument({ status: "approved", rules: [] }, "test"), /invalid policy_version/);
});

test("generated policy versions sort chronologically", () => {
  const older = newPolicyVersion(new Date("2026-07-30T10:00:00.000Z"));
  const newer = newPolicyVersion(new Date("2026-07-31T10:00:00.000Z"));
  assert.equal(older, "20260730T100000Z");
  assert.ok(newer > older);
});
