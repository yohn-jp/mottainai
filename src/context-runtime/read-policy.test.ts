import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_READ_GOVERNOR_POLICY, decideRead } from "./read-policy.js";
import type { ReadFileMetadata, ReadGovernorPolicy } from "./read-policy.js";

function metadata(overrides: Partial<ReadFileMetadata> = {}): ReadFileMetadata {
  return {
    lineCount: 20,
    byteSize: 2_000,
    rangeBytes: 100,
    withinWorkspace: true,
    symlinkSafe: true,
    ...overrides,
  };
}

function policy(mode: ReadGovernorPolicy["mode"], overrides: Partial<ReadGovernorPolicy> = {}): ReadGovernorPolicy {
  return { ...DEFAULT_READ_GOVERNOR_POLICY, mode, ...overrides };
}

test("small whole-file raw is allowed", () => {
  const decision = decideRead(
    { path: "src/small.ts", mode: "raw" },
    metadata({ lineCount: 20, byteSize: 500 }),
    policy("enforce"),
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.allowed, true);
  assert.equal(decision.normalizedRequest.mode, "raw");
});

test("large whole-file raw is denied before content is authorized", () => {
  const decision = decideRead(
    { path: "src/large.ts", mode: "raw" },
    metadata({ lineCount: 500, byteSize: 50_000 }),
    policy("enforce"),
  );
  assert.equal(decision.action, "deny");
  assert.equal(decision.allowed, false);
  assert.equal(decision.policyRule, "RAW_WHOLE_FILE_LINE_LIMIT");
  assert.equal(decision.metadata.lineCount, 500);
  assert.equal(decision.metadata.byteSize, 50_000);
  assert.ok(decision.suggestedNextActions.includes("use mode:auto"));
  assert.ok(decision.suggestedNextActions.includes("request symbols"));
});

test("explicit bounded raw range is allowed when line and byte limits hold", () => {
  const decision = decideRead(
    { path: "src/large.ts", mode: "raw", startLine: 120, endLine: 180 },
    metadata({ lineCount: 500, byteSize: 50_000, rangeBytes: 900 }),
    policy("enforce", { maxRawLines: 61, maxRawBytes: 1_000 }),
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.normalizedRequest.requestedLines, 61);
});

test("explicit bounded raw range rejects line-limit overflow", () => {
  const decision = decideRead(
    { path: "src/large.ts", mode: "raw", startLine: 1, endLine: 121 },
    metadata({ lineCount: 500, rangeBytes: 900 }),
    policy("enforce", { maxRawLines: 120 }),
  );
  assert.equal(decision.action, "deny");
  assert.equal(decision.policyRule, "RAW_RANGE_LINE_LIMIT");
  assert.equal(decision.reasonCategory, "line_limit");
});

test("explicit bounded raw range rejects byte-limit overflow", () => {
  const decision = decideRead(
    { path: "src/large.ts", mode: "raw", startLine: 1, endLine: 10 },
    metadata({ lineCount: 500, rangeBytes: 1_001 }),
    policy("enforce", { maxRawBytes: 1_000 }),
  );
  assert.equal(decision.action, "deny");
  assert.equal(decision.policyRule, "RAW_RANGE_BYTE_LIMIT");
  assert.equal(decision.reasonCategory, "byte_limit");
});

test("off preserves legacy raw access", () => {
  const decision = decideRead(
    { path: "src/large.ts", mode: "raw" },
    metadata({ lineCount: 500, byteSize: 50_000 }),
    policy("off"),
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.allowed, true);
  assert.equal(decision.policyRule, "POLICY_OFF");
});

test("observe allows the read and records what enforce would deny", () => {
  const decision = decideRead(
    { path: "src/large.ts", mode: "raw" },
    metadata({ lineCount: 500, byteSize: 50_000 }),
    policy("observe"),
  );
  assert.equal(decision.action, "observe");
  assert.equal(decision.allowed, true);
  assert.equal(decision.wouldAction, "deny");
  assert.equal(decision.diagnostics[0]?.severity, "info");
});

test("warn permits the read with a bounded structured warning", () => {
  const decision = decideRead(
    { path: "src/large.ts", mode: "raw" },
    metadata({ lineCount: 500, byteSize: 50_000 }),
    policy("warn"),
  );
  assert.equal(decision.action, "warn");
  assert.equal(decision.allowed, true);
  assert.equal(decision.diagnostics[0]?.severity, "warning");
  assert.ok(decision.reason.length < 240);
});

test("auto selects raw for a small file and a bounded symbol view for a large source file", () => {
  const small = decideRead({ path: "src/small.ts" }, metadata({ lineCount: 20, byteSize: 500 }), policy("enforce"));
  const large = decideRead({ path: "src/large.ts" }, metadata({ lineCount: 500, byteSize: 50_000 }), policy("enforce"));
  assert.equal(small.normalizedRequest.mode, "raw");
  assert.equal(large.normalizedRequest.mode, "symbols");
  assert.equal(large.action, "allow");
  assert.equal(large.policyRule, "AUTO_BOUNDED_REPRESENTATION");
});

test("preferAuto=false makes an omitted mode an explicit raw request subject to policy", () => {
  const decision = decideRead(
    { path: "src/large.ts" },
    metadata({ lineCount: 500, byteSize: 50_000 }),
    policy("enforce", { preferAuto: false }),
  );
  assert.equal(decision.normalizedRequest.requestedMode, "raw");
  assert.equal(decision.action, "deny");
});

test("outline and symbol requests do not become unrestricted raw requests", () => {
  const decision = decideRead(
    { path: "src/large.ts", mode: "symbols" },
    metadata({ lineCount: 500, byteSize: 50_000 }),
    policy("enforce"),
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.normalizedRequest.mode, "symbols");
});

test("workspace and symlink boundary failures are denied deterministically", () => {
  const outside = decideRead(
    { path: "../outside.ts", mode: "raw" },
    metadata({ withinWorkspace: false }),
    policy("off"),
  );
  const symlink = decideRead({ path: "src/link.ts", mode: "raw" }, metadata({ symlinkSafe: false }), policy("enforce"));
  assert.equal(outside.action, "deny");
  assert.equal(outside.policyRule, "WORKSPACE_BOUNDARY");
  assert.equal(symlink.action, "deny");
  assert.equal(symlink.policyRule, "SYMLINK_BOUNDARY");
});

test("policy decisions and diagnostics are deterministic", () => {
  const request = { path: "src/large.ts", mode: "raw" as const };
  const fileMetadata = metadata({ lineCount: 500, byteSize: 50_000 });
  const first = decideRead(request, fileMetadata, policy("enforce"));
  const second = decideRead(request, fileMetadata, policy("enforce"));
  assert.deepEqual(first, second);
});
