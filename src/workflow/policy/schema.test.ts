import assert from "node:assert/strict";
import { test } from "node:test";
import { POLICY_SCHEMA_VERSION, workflowPolicySchema } from "./schema.js";

const validDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  preset: "strict-worktree",
  protectedBranches: ["main"],
  protectedBranchRule: {
    sourceWrite: "enforce",
    stage: "enforce",
    commit: "enforce",
    directPush: "enforce",
    forcePush: "enforce",
    destructiveBranchOp: "enforce",
  },
  controlPlaneRole: "primary-checkout",
  worktree: {
    required: "enforce",
    issueRequired: "off",
    bootstrapMode: "off",
    multipleActiveTasksPerIssue: "off",
    multipleWorktreesPerTask: "off",
  },
  stagingMode: "explicit",
  cleanup: {
    worktreeRemoval: "enforce",
    localBranchDeletion: "advisory",
    remoteBranchDeletion: "off",
    worktreePrune: "advisory",
    forceCleanup: "off",
  },
};

test("valid document parses", () => {
  const result = workflowPolicySchema.parse(validDocument);
  assert.equal(result.preset, "strict-worktree");
});

test("unknown top-level key is rejected (strict schema)", () => {
  assert.throws(() => workflowPolicySchema.parse({ ...validDocument, unknownKey: true }));
});

test("unsupported schema version is rejected", () => {
  assert.throws(() => workflowPolicySchema.parse({ ...validDocument, schemaVersion: 999 }));
});

test("invalid rule mode is rejected", () => {
  assert.throws(() =>
    workflowPolicySchema.parse({
      ...validDocument,
      protectedBranchRule: { ...validDocument.protectedBranchRule, commit: "sometimes" },
    }),
  );
});

test("preset is optional (repository policy may omit it)", () => {
  const { preset: _preset, ...withoutPreset } = validDocument;
  const result = workflowPolicySchema.parse(withoutPreset);
  assert.equal(result.preset, undefined);
});

test("unknown key nested in protectedBranchRule is rejected, not silently stripped", () => {
  const result = workflowPolicySchema.safeParse({
    ...validDocument,
    protectedBranchRule: { ...validDocument.protectedBranchRule, unknownNested: true },
  });
  assert.equal(result.success, false);
});

test("unknown key nested in worktree is rejected, not silently stripped", () => {
  const result = workflowPolicySchema.safeParse({
    ...validDocument,
    worktree: { ...validDocument.worktree, unknownNested: true },
  });
  assert.equal(result.success, false);
});

test("issueRequired defaults to off when omitted (existing schemaVersion=1 documents keep parsing)", () => {
  const { issueRequired: _issueRequired, ...worktreeWithoutIssueRequired } = validDocument.worktree;
  const result = workflowPolicySchema.parse({ ...validDocument, worktree: worktreeWithoutIssueRequired });
  assert.equal(result.worktree.issueRequired, "off");
});

test("unknown key nested in cleanup is rejected, not silently stripped", () => {
  const result = workflowPolicySchema.safeParse({
    ...validDocument,
    cleanup: { ...validDocument.cleanup, unknownNested: true },
  });
  assert.equal(result.success, false);
});
