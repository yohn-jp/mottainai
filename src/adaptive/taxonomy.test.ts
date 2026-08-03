import assert from "node:assert/strict";
import test from "node:test";
import {
  isKnownCapability,
  normalizeCapability,
  normalizeCapabilityList,
  normalizeIntent,
  normalizeNoiseList,
  normalizeTaskCategory,
} from "./taxonomy.js";

test("capability aliases collapse to a canonical id", () => {
  assert.deepEqual(normalizeCapability("code.search"), { id: "text_matches", known: true });
  assert.deepEqual(normalizeCapability("Git History"), { id: "recent_changes", known: true });
  assert.deepEqual(normalizeCapability("CALLERS"), { id: "callers", known: true });
});

test("unknown capabilities pass through normalized instead of being rejected", () => {
  assert.deepEqual(normalizeCapability("Terraform Plan!"), { id: "terraform_plan", known: false });
  assert.equal(isKnownCapability("terraform_plan"), false);
});

test("capability lists drop duplicates and keep caller order", () => {
  const capabilities = normalizeCapabilityList(["callers", "code.search", "text_matches", "callers"]);
  assert.deepEqual(capabilities.map((entry) => entry.id), ["callers", "text_matches"]);
});

test("task categories keep unknown values but flag them", () => {
  assert.deepEqual(normalizeTaskCategory("bug_investigation"), { id: "bug_investigation", known: true });
  assert.deepEqual(normalizeTaskCategory("migration audit"), { id: "migration_audit", known: false });
});

test("noise labels normalize without a closed vocabulary", () => {
  const labels = normalizeNoiseList(["Generated Files", "vendor blobs"]);
  assert.deepEqual(labels, [{ label: "generated_files", known: true }, { label: "vendor_blobs", known: false }].map((entry) => ({ id: entry.label, known: entry.known })));
});

test("intent normalizes without a known set", () => {
  assert.equal(normalizeIntent("Locate Root Cause"), "locate_root_cause");
});

test("empty and non-string labels are rejected", () => {
  assert.throws(() => normalizeCapability("   "), /must be a non-empty label/);
  assert.throws(() => normalizeCapability(42), /must be a string/);
  assert.throws(() => normalizeCapabilityList("callers"), /must be an array/);
});
