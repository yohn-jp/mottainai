import assert from "node:assert/strict";
import { test } from "node:test";
import { createSemanticExecutionPlan } from "../../semantics/execution-plan.js";
import type { NawabariRepositoryEvidence } from "../nawabari.js";
import type { ManagerSessionRecord, TaskRecord } from "../state/store.js";
import {
  EXECUTION_MANIFEST_CONTRACT_ID,
  createExecutionManifest,
  isExecutionManifestValid,
  serializeExecutionManifest,
  validateExecutionManifest,
} from "./execution-manifest.js";

const task = {
  taskId: "task-948",
  instanceId: "instance-948",
  taskSlug: "issue-948",
  issueRef: "#948",
  lifecycleState: "active",
  version: 1,
  baseBranch: "main",
  baseCommit: "base-948",
  createdAt: 1,
  updatedAt: 1,
} as unknown as TaskRecord;

const manager = {
  sessionId: "manager-948",
  runtimeId: "runtime-948",
  workspaceRoot: "/workspace",
  taskId: task.taskId,
  executionSessionId: "01948e00-0000-7000-8000-000000000948",
  executionMode: "task-bound",
  worktreePath: "/workspace/.worktrees/issue-948",
  branchName: "feat/948-governed-execution-manifest",
  agentKind: "codex",
  launchProfile: "codex",
  instruction: "prompt text is deliberately not projected",
  launchCommand: "codex",
  launchArgs: [],
  runtimeName: "runtime-948",
  lifecycleState: "running",
  runtimeState: "running",
  semanticLifecycleState: "active",
  attachable: true,
  reconciliationState: "synced",
  startedAt: 1,
  updatedAt: 1,
  restartCount: 0,
} as unknown as ManagerSessionRecord;

const semanticPlan = createSemanticExecutionPlan({
  semanticTargets: [
    {
      kind: "path",
      id: "src/workflow/domain/execution-manifest.ts",
      paths: ["src/workflow/domain/execution-manifest.ts"],
    },
    { kind: "symbol", id: "ExecutionManifest", paths: ["src/workflow/domain/execution-manifest.ts"] },
  ],
  claims: [{ resource: "src/workflow/domain/execution-manifest.ts", mode: "exclusive-write" }],
  verification: { requiredChecks: ["pnpm run verify"], rationale: "prove the bounded domain contract" },
});

function evidence(overrides: Partial<NawabariRepositoryEvidence> = {}): NawabariRepositoryEvidence {
  return {
    schemaVersion: 1,
    repository: "/workspace/.git",
    worktree: "/workspace/.worktrees/issue-948",
    branchId: "branch-948",
    branch: "feat/948-governed-execution-manifest",
    sessionId: "01948e00-0000-7000-8000-000000000948",
    sessionState: "active",
    sessionCreatedAt: "2026-09-22T00:00:00Z",
    sessionUpdatedAt: "2026-09-22T00:00:01Z",
    baseRevision: "base-948",
    baseRevisionProven: true,
    head: "head-948",
    clean: true,
    complete: true,
    incompleteReasons: [],
    evidenceHash: "evidence-948",
    raw: { ok: true, command: "evidence snapshot" },
    ...overrides,
  };
}

test("ExecutionManifest v1 keeps governed intent separate from Nawabari attachment", () => {
  const manifest = createExecutionManifest({
    task,
    manager,
    canon: { prefix_id: "cp1:948", execution_state_id: "es1:948" },
    semanticPlan,
    nawabari: { authority: "nawabari", evidence: evidence() },
  });

  assert.equal(manifest.contractId, EXECUTION_MANIFEST_CONTRACT_ID);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.diagnostics.completeness, "complete");
  assert.equal(manifest.attachment.authority, "nawabari");
  assert.equal(manifest.attachment.status, "attached");
  assert.equal(manifest.attachment.physical?.branch, "feat/948-governed-execution-manifest");
  assert.equal("instruction" in (manifest.intent.manager ?? {}), false);
  assert.equal(JSON.stringify(manifest).includes("prompt text"), false);
  assert.equal(isExecutionManifestValid(manifest), true);
});

test("equivalent input ordering has one deterministic serialization", () => {
  const first = createExecutionManifest({
    task,
    manager,
    semanticPlan,
    nawabari: { authority: "nawabari", evidence: evidence() },
  });
  const second = createExecutionManifest({
    task,
    manager,
    semanticPlan: {
      ...semanticPlan,
      semanticTargets: [...semanticPlan.semanticTargets].reverse(),
      claims: [...semanticPlan.claims].reverse(),
      verification: {
        ...semanticPlan.verification,
        requiredChecks: [...semanticPlan.verification.requiredChecks].reverse(),
      },
    },
    nawabari: { authority: "nawabari", evidence: evidence() },
  });
  assert.equal(serializeExecutionManifest(first), serializeExecutionManifest(second));
});

test("missing, stale, and ambiguous attachment evidence fail closed", () => {
  const missing = createExecutionManifest({ task, manager, semanticPlan });
  assert.equal(missing.attachment.status, "missing");
  assert.equal(missing.attachment.physical, undefined);
  assert.equal(missing.diagnostics.completeness, "incomplete");

  const stale = createExecutionManifest({
    task,
    manager,
    semanticPlan,
    nawabari: { authority: "nawabari", evidence: evidence({ sessionState: "stopped" }) },
  });
  assert.equal(stale.attachment.status, "stale");
  assert.equal(stale.attachment.completeness, "incomplete");
  assert.equal(stale.attachment.physical?.worktree, "/workspace/.worktrees/issue-948");

  const ambiguous = createExecutionManifest({
    task,
    manager,
    semanticPlan,
    nawabari: { authority: "nawabari", status: "ambiguous", reason: "two active sessions matched" },
  });
  assert.equal(ambiguous.attachment.status, "ambiguous");
  assert.equal(ambiguous.attachment.physical, undefined);
});

test("blocked semantic scope is represented without inventing claims", () => {
  const manifest = createExecutionManifest({ task, manager });
  assert.equal(manifest.intent.semanticPlan.claims.length, 0);
  assert.equal(manifest.intent.semanticPlan.claimGeneration.strategy, "blocked");
  assert.equal(manifest.diagnostics.completeness, "incomplete");
});

test("missing Canon identity keeps an otherwise attached projection incomplete", () => {
  const manifest = createExecutionManifest({
    task,
    manager,
    semanticPlan,
    nawabari: { authority: "nawabari", evidence: evidence() },
  });
  assert.equal(manifest.attachment.completeness, "complete");
  assert.equal(manifest.diagnostics.completeness, "incomplete");
  assert.equal(manifest.diagnostics.reasons.includes("complete Canon identity was not supplied"), true);
});

test("validation remains structured for malformed manifests", () => {
  const result = validateExecutionManifest({});
  assert.equal(result.valid, false);
  assert.equal(result.errors.includes("manifest intent is missing"), true);
});

test("validation rejects physical attachment without authority", () => {
  const manifest = createExecutionManifest({ task, manager, semanticPlan });
  const invalid = {
    ...manifest,
    attachment: {
      ...manifest.attachment,
      authority: "none",
      physical: {
        sessionId: "untrusted",
        worktree: "/untrusted",
        branch: "untrusted",
        branchId: "untrusted",
        sessionState: "active",
      },
    },
  };
  const result = validateExecutionManifest(invalid);
  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((error) => error.includes("authority")),
    true,
  );
});
