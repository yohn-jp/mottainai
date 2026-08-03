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
  return {
    policy_version: version,
    status: "candidate",
    source: "proposed",
    generated_at: `2026-07-${version.slice(-2)}T00:00:00.000Z`,
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
