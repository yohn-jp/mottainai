import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaimPreflight, failedClaimPreflight, MAX_MANAGER_CLAIM_CONFLICTS } from "./claim-preflight.js";
import type { ExecutionClaim } from "../semantics/execution-plan.js";
import type { NawabariClaimEvidenceSnapshot } from "../workflow/nawabari.js";

function snapshot(
  claims: readonly (ExecutionClaim & { sessionId?: string; claimId?: string })[],
): NawabariClaimEvidenceSnapshot {
  const sessions = new Map<string, NawabariClaimEvidenceSnapshot["sessions"][number]>();
  const evidence = claims.map((claim, index) => {
    const sessionId = claim.sessionId ?? `session-${index}`;
    const session = {
      sessionId,
      repository: "/repo/.git",
      worktree: `/repo-${sessionId}`,
      branch: `feat/${sessionId}`,
      state: "active",
      label: `label-${sessionId}`,
      raw: { ok: true, command: "session list" },
    };
    sessions.set(sessionId, session);
    return {
      schemaVersion: 2,
      claimId: claim.claimId ?? `claim-${index}`,
      sessionId,
      repository: "/repo/.git",
      worktree: session.worktree,
      resource: claim.resource,
      mode: claim.mode,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      raw: { ok: true, command: "session claims" },
    };
  });
  return { sessions: [...sessions.values()], claims: evidence };
}

test("preflight reports exact owner/resource/modes for broad exclusive conflict", () => {
  const preflight = createClaimPreflight(
    [{ resource: "**", mode: "read" }],
    snapshot([{ resource: "**", mode: "exclusive-write", sessionId: "owner-session", claimId: "owner-claim" }]),
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(preflight.status, "conflict");
  assert.deepEqual(preflight.conflicts, [
    {
      requested: { resource: "**", mode: "read" },
      existing: {
        sessionId: "owner-session",
        resource: "**",
        mode: "exclusive-write",
        worktree: "/repo-owner-session",
        branch: "feat/owner-session",
        state: "active",
        label: "label-owner-session",
        claimId: "owner-claim",
      },
    },
  ]);
});

test("preflight preserves Nawabari mode compatibility and glob representatives", () => {
  const clear = createClaimPreflight(
    [
      { resource: "src/read.ts", mode: "read" },
      { resource: "src/write.ts", mode: "write" },
      { resource: "docs/**", mode: "exclusive-write" },
    ],
    snapshot([
      { resource: "src/read.ts", mode: "write", sessionId: "read-owner" },
      { resource: "src/write.ts", mode: "read", sessionId: "write-owner" },
      { resource: "src/*.ts", mode: "exclusive-write", sessionId: "glob-owner" },
      { resource: "src/**", mode: "exclusive-write", sessionId: "other-owner" },
    ]),
  );
  assert.equal(clear.status, "conflict");
  assert.equal(
    clear.conflicts.some((conflict) => conflict.existing.sessionId === "read-owner"),
    false,
  );
  assert.equal(
    clear.conflicts.some((conflict) => conflict.existing.sessionId === "write-owner"),
    false,
  );
  assert.equal(
    clear.conflicts.some((conflict) => conflict.existing.sessionId === "glob-owner"),
    true,
  );
  assert.equal(
    clear.conflicts.some((conflict) => conflict.existing.sessionId === "other-owner"),
    true,
  );

  const nonOverlapping = createClaimPreflight(
    [{ resource: "src/a.ts", mode: "exclusive-write" }],
    snapshot([{ resource: "docs/**", mode: "exclusive-write" }]),
  );
  assert.equal(nonOverlapping.status, "clear");
  assert.deepEqual(nonOverlapping.conflicts, []);
});

test("preflight bounds and deterministically sorts multiple conflicts", () => {
  const existing = Array.from({ length: MAX_MANAGER_CLAIM_CONFLICTS + 8 }, (_, index) => ({
    resource: "**" as const,
    mode: "exclusive-write" as const,
    sessionId: `session-${String(MAX_MANAGER_CLAIM_CONFLICTS + 8 - index).padStart(2, "0")}`,
  }));
  const preflight = createClaimPreflight([{ resource: "**", mode: "read" }], snapshot(existing));
  assert.equal(preflight.status, "conflict");
  assert.equal(preflight.conflicts.length, MAX_MANAGER_CLAIM_CONFLICTS);
  assert.equal(preflight.conflictsTruncated, true);
  // Expected order is derived independently from the input fixture (not from
  // the function's own output) using the same code-point comparator
  // `createClaimPreflight` documents, so this proves the returned conflicts
  // really are the lowest-sorted MAX_MANAGER_CLAIM_CONFLICTS of the full
  // candidate set, not merely internally self-consistent.
  const expectedSessionIds = existing
    .map((claim) => claim.sessionId)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, MAX_MANAGER_CLAIM_CONFLICTS);
  assert.deepEqual(
    preflight.conflicts.map((conflict) => conflict.existing.sessionId),
    expectedSessionIds,
  );
});

test("uncertain evidence is not represented as conflict-free", () => {
  for (const status of ["unavailable", "ambiguous", "stale"] as const) {
    const result = failedClaimPreflight(status, "evidence unavailable", "STALE_REGISTRY");
    assert.equal(result.status, status);
    assert.notEqual(result.status, "clear");
    assert.ok(result.safeActions.includes("retry-after-stabilization"));
  }
});
