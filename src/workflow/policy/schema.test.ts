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
