import assert from "node:assert/strict";
import { test } from "node:test";
import { getPreset } from "./presets.js";
import { PROTECTED_BRANCH_OPERATIONS, decideProtectedBranchOperation, matchesProtectedBranch } from "./protected-branch.js";
import type { WorkflowPolicyDocument } from "./schema.js";

function withProtectedBranchRule(mode: "off" | "advisory" | "enforce" | "confirm"): WorkflowPolicyDocument {
  const base = getPreset("standard");
  return {
    ...base,
    protectedBranches: ["main", "release/*"],
    protectedBranchRule: {
      sourceWrite: mode,
      stage: mode,
      commit: mode,
      directPush: mode,
      forcePush: mode,
      destructiveBranchOp: mode,
    },
    controlPlaneRole: "any",
  };
}

test("matchesProtectedBranch: exact literal match", () => {
  assert.equal(matchesProtectedBranch("main", ["main", "release/*"]).matched, true);
  assert.equal(matchesProtectedBranch("mainx", ["main"]).matched, false);
});

test("matchesProtectedBranch: glob '*' matches across slashes", () => {
  const result = matchesProtectedBranch("release/1.0/hotfix", ["release/*"]);
  assert.equal(result.matched, true);
  assert.equal(result.pattern, "release/*");
});

test("matchesProtectedBranch: regex metacharacters in pattern are treated literally", () => {
  assert.equal(matchesProtectedBranch("feature.x", ["feature.x"]).matched, true);
  assert.equal(matchesProtectedBranch("featureYx", ["feature.x"]).matched, false, "'.' must not act as regex wildcard");
});

test("matchesProtectedBranch: no patterns never matches", () => {
  assert.equal(matchesProtectedBranch("main", []).matched, false);
});

// operation × mode の全 matrix: off/advisory は許可、enforce/confirm は拒否。
for (const operation of PROTECTED_BRANCH_OPERATIONS) {
  for (const mode of ["off", "advisory", "enforce", "confirm"] as const) {
    test(`protected branch + operation=${operation} + mode=${mode}`, () => {
      const policy = withProtectedBranchRule(mode);
      const decision = decideProtectedBranchOperation({
        policy,
        branch: "main",
        operation,
        repository: { isPrimaryCheckout: false },
      });
      const expectAllowed = mode === "off" || mode === "advisory";
      assert.equal(decision.allowed, expectAllowed, `operation=${operation} mode=${mode}`);
      assert.equal(decision.mode, mode);
      assert.equal(decision.branchMatch.matched, true);
    });
  }
}

test("non-protected branch is always allowed regardless of rule mode", () => {
  const policy = withProtectedBranchRule("enforce");
  const decision = decideProtectedBranchOperation({
    policy,
    branch: "feature/anything",
    operation: "commit",
    repository: { isPrimaryCheckout: false },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "not-protected");
});

test("detached HEAD (branch undefined) is treated as unprotected for protected-branch operations", () => {
  const policy = withProtectedBranchRule("enforce");
  const decision = decideProtectedBranchOperation({
    policy,
    branch: undefined,
    operation: "commit",
    repository: { isPrimaryCheckout: false },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "detached-head-treated-as-unprotected");
});

test("glob pattern 'release/*' protects release/1.0", () => {
  const policy = withProtectedBranchRule("enforce");
  const decision = decideProtectedBranchOperation({
    policy,
    branch: "release/1.0",
    operation: "directPush",
    repository: { isPrimaryCheckout: false },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.branchMatch.pattern, "release/*");
});

test("control-plane role: primary checkout denies source-change ops even on a non-protected branch", () => {
  const policy: WorkflowPolicyDocument = { ...withProtectedBranchRule("off"), controlPlaneRole: "primary-checkout" };
  for (const operation of ["sourceWrite", "stage", "commit"] as const) {
    const decision = decideProtectedBranchOperation({
      policy,
      branch: "feature/anything",
      operation,
      repository: { isPrimaryCheckout: true },
    });
    assert.equal(decision.allowed, false, `operation=${operation} must be denied on primary checkout`);
    assert.equal(decision.reason, "control-plane-source-denied");
  }
});

test("control-plane role: primary checkout still allows push/destructive ops governed by protected-branch rule alone", () => {
  const policy: WorkflowPolicyDocument = { ...withProtectedBranchRule("off"), controlPlaneRole: "primary-checkout" };
  const decision = decideProtectedBranchOperation({
    policy,
    branch: "feature/anything",
    operation: "directPush",
    repository: { isPrimaryCheckout: true },
  });
  assert.equal(decision.allowed, true);
});

test("control-plane role: repo-sync/worktree management operations are always allowed on primary checkout", () => {
  const policy: WorkflowPolicyDocument = { ...withProtectedBranchRule("enforce"), controlPlaneRole: "primary-checkout" };
  const decision = decideProtectedBranchOperation({
    policy,
    branch: "main",
    operation: "repoSync",
    repository: { isPrimaryCheckout: true },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "control-plane-management-allowed");
});

test("control-plane role: non-primary-checkout worktree is not subject to the control-plane source restriction", () => {
  const policy: WorkflowPolicyDocument = { ...withProtectedBranchRule("off"), controlPlaneRole: "primary-checkout" };
  const decision = decideProtectedBranchOperation({
    policy,
    branch: "feature/anything",
    operation: "sourceWrite",
    repository: { isPrimaryCheckout: false },
  });
  assert.equal(decision.allowed, true);
});

test("controlPlaneRole 'any' never triggers control-plane source denial", () => {
  const policy: WorkflowPolicyDocument = { ...withProtectedBranchRule("off"), controlPlaneRole: "any" };
  const decision = decideProtectedBranchOperation({
    policy,
    branch: "feature/anything",
    operation: "commit",
    repository: { isPrimaryCheckout: true },
  });
  assert.equal(decision.allowed, true);
});

test("strict-worktree preset denies source edits, staging, commits, direct pushes, and force pushes on protected branches by default", () => {
  const policy = getPreset("strict-worktree");
  for (const operation of ["sourceWrite", "stage", "commit", "directPush", "forcePush"] as const) {
    const decision = decideProtectedBranchOperation({
      policy,
      branch: "main",
      operation,
      repository: { isPrimaryCheckout: false },
    });
    assert.equal(decision.allowed, false, `strict-worktree must deny ${operation} on main`);
  }
});
