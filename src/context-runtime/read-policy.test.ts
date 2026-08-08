import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_READ_GOVERNOR_POLICY, decideRead, resolveReadGovernorPolicy } from "./read-policy.js";
import type { ReadFileMetadata, ReadGovernorPolicy } from "./read-policy.js";

function metadata(lineCount: number, byteSize: number, lineBytes = 10): ReadFileMetadata {
  return { lineCount, byteSize, lineByteLengths: Array.from({ length: lineCount }, () => lineBytes) };
}

function policy(overrides: Partial<ReadGovernorPolicy> = {}): ReadGovernorPolicy {
  return resolveReadGovernorPolicy({ ...DEFAULT_READ_GOVERNOR_POLICY, ...overrides });
}

test("small whole-file raw is allowed in enforce mode", () => {
  const result = decideRead({ path: "src/small.ts", mode: "raw" }, metadata(3, 32), policy({ mode: "enforce" }));
  assert.equal(result.action, "allow");
  assert.equal(result.allowed, true);
  assert.equal(result.policyRule, "NONE");
});

test("large whole-file raw is denied before source disclosure in enforce mode", () => {
  const result = decideRead({ path: "src/large.ts", mode: "raw" }, metadata(900, 9_000), policy({ mode: "enforce" }));
  assert.equal(result.action, "deny");
  assert.equal(result.allowed, false);
  assert.equal(result.policyRule, "WHOLE_FILE_RAW_LINE_LIMIT");
  assert.ok(result.suggestedNextActions.includes("use mode:auto"));
  assert.ok(result.suggestedNextActions.includes("request raw lines 1-400"));
});

test("bounded explicit raw stays practical when line and byte limits hold", () => {
  const result = decideRead(
    { path: "src/large.ts", mode: "raw", startLine: 120, endLine: 140 },
    metadata(900, 9_000),
    policy({ mode: "enforce" }),
  );
  assert.equal(result.action, "allow");
  assert.deepEqual(result.normalizedRequest, {
    path: "src/large.ts",
    mode: "raw",
    startLine: 120,
    endLine: 140,
    bounded: true,
  });
  assert.equal(result.metadata.requestedRangeBytes, 230);
});

test("line and byte overflow are distinct deterministic policy rules", () => {
  const lineOverflow = decideRead(
    { path: "src/large.ts", mode: "raw", startLine: 1, endLine: 401 },
    metadata(900, 9_000),
    policy({ mode: "enforce" }),
  );
  const byteOverflow = decideRead(
    { path: "src/large.ts", mode: "raw", startLine: 1, endLine: 2 },
    metadata(900, 9_000, 9_000),
    policy({ mode: "enforce" }),
  );
  assert.equal(lineOverflow.policyRule, "RAW_RANGE_LINE_LIMIT");
  assert.equal(byteOverflow.policyRule, "RAW_RANGE_BYTE_LIMIT");
});

test("off, observe, and warn preserve access with distinct outcomes", () => {
  const request = { path: "src/large.ts", mode: "raw" as const };
  const file = metadata(900, 9_000);
  assert.equal(decideRead(request, file, policy({ mode: "off" })).action, "allow");
  const observed = decideRead(request, file, policy({ mode: "observe" }));
  assert.equal(observed.action, "observe");
  assert.equal(observed.allowed, true);
  const warned = decideRead(request, file, policy({ mode: "warn" }));
  assert.equal(warned.action, "warn");
  assert.equal(warned.allowed, true);
  assert.equal(warned.diagnostics[0]?.severity, "warning");
});

test("auto chooses raw for a small file and bounded outline for a large file", () => {
  const small = decideRead({ path: "src/small.ts", mode: "auto" }, metadata(3, 32), policy({ mode: "enforce" }));
  assert.equal(small.normalizedRequest.mode, "raw");
  const large = decideRead({ path: "src/large.ts", mode: "auto" }, metadata(900, 9_000), policy({ mode: "enforce" }));
  assert.equal(large.action, "allow");
  assert.equal(large.normalizedRequest.mode, "outline");
  assert.deepEqual(
    { startLine: large.normalizedRequest.startLine, endLine: large.normalizedRequest.endLine },
    { startLine: 1, endLine: 400 },
  );
});

test("boundary failures deny independently of rollout mode", () => {
  const result = decideRead(
    { path: "link.ts", mode: "raw" },
    { ...metadata(1, 1), symlinkBoundaryValid: false },
    policy({ mode: "off" }),
  );
  assert.equal(result.action, "deny");
  assert.equal(result.policyRule, "SYMLINK_BOUNDARY_INVALID");
  assert.deepEqual(result.suggestedNextActions, []);
});

test("policy decisions and diagnostics are deterministic", () => {
  const request = { path: "src/large.ts", mode: "raw" as const };
  const file = metadata(900, 9_000);
  const first = decideRead(request, file, policy({ mode: "enforce" }));
  const second = decideRead(request, file, policy({ mode: "enforce" }));
  assert.deepEqual(second, first);
});
