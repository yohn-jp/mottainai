import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { ExecutionClaim } from "../semantics/execution-plan.js";
import { NawabariExecutionClient } from "../workflow/nawabari.js";
import { createTempGitRepo, isolatedGitEnvironment } from "../test-support/tmp-git-repo.js";
import { createClaimPreflight } from "./claim-preflight.js";

/**
 * Proves that Manager's advisory `resourcePatternsOverlap`/`modesConflict`
 * matcher agrees with the real installed `nawabari` binary's authoritative
 * claim-conflict decision, for the mode matrix and representative/boundary
 * glob corpus below. Nawabari has no dry-run or machine-readable
 * conflict-check surface in its CLI contract (verified against
 * `nawabari capabilities --json`), so parity can only be proven empirically:
 * attempt the same claim pair as two real sessions and observe whether
 * Nawabari's `session claim` accepts or rejects with
 * `RESOURCE_CLAIM_CONFLICT`.
 *
 * Skips (not fails) when the `nawabari` binary is not on PATH: it is a dev
 * dependency pin, not a guaranteed CI runtime.
 */
function nawabariAvailable(): boolean {
  try {
    execFileSync("nawabari", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const MODES: ExecutionClaim["mode"][] = ["read", "write", "exclusive-write"];

// Representative overlap plus explicit boundary cases: exact match,
// disjoint, single-segment glob, multi-segment `**`, glob-vs-glob,
// mid-pattern `**`, and `?` single-character wildcards at both length
// boundaries. Each pair is exercised against the full 3x3 mode matrix below,
// so this stays intentionally small — real subprocess round trips dominate
// runtime.
const RESOURCE_PAIRS: readonly [string, string][] = [
  ["src/a.ts", "src/a.ts"],
  ["src/a.ts", "src/b.ts"],
  ["src/*.ts", "src/nested/a.ts"],
  ["src/**", "docs/a.ts"],
  ["**", "**"],
  ["src/a?.ts", "src/a12.ts"],
  ["src/**/x.ts", "src/nested/deep/x.ts"],
];

test("Manager claim matcher agrees with real Nawabari for the mode matrix and glob corpus", async (t) => {
  if (!nawabariAvailable()) {
    t.skip("nawabari binary not found on PATH; skipping real-binary parity smoke");
    return;
  }
  const root = createTempGitRepo(t);
  const client = new NawabariExecutionClient();
  const owner = await client.createSession({ cwd: root, branch: "feat/parity-owner", base: "HEAD" });

  for (const [ownerResource, requestedResource] of RESOURCE_PAIRS) {
    for (const ownerMode of MODES) {
      for (const requestedMode of MODES) {
        // Reset to a single claim on the owner session for each case.
        execFileSync("nawabari", ["session", "release", "--session", owner.sessionId], {
          cwd: root,
          env: isolatedGitEnvironment(),
        });
        await client.claimSession({ cwd: root, sessionId: owner.sessionId, claims: [{ resource: ownerResource, mode: ownerMode }] });

        const snapshot = await client.listClaimEvidence(root);
        const requested: ExecutionClaim = { resource: requestedResource, mode: requestedMode };
        const preflight = createClaimPreflight([requested], snapshot);
        const managerPredictsConflict = preflight.status === "conflict";

        const requester = await client.createSession({ cwd: root, branch: `feat/parity-req-${Date.now()}-${Math.random().toString(36).slice(2)}`, base: "HEAD" });
        let nawabariRejected = false;
        try {
          await client.claimSession({ cwd: root, sessionId: requester.sessionId, claims: [requested] });
        } catch (error) {
          nawabariRejected = true;
          assert.match(
            String((error as { message?: string }).message ?? error),
            /RESOURCE_CLAIM_CONFLICT/u,
            `unexpected rejection reason for owner ${ownerResource}/${ownerMode} vs requested ${requestedResource}/${requestedMode}`,
          );
        }
        await client.releaseClaims({ cwd: root, sessionId: requester.sessionId });
        execFileSync("nawabari", ["session", "close", "--session", requester.sessionId], {
          cwd: root,
          env: isolatedGitEnvironment(),
        });

        assert.equal(
          managerPredictsConflict,
          nawabariRejected,
          `parity mismatch: owner=${ownerResource}/${ownerMode} requested=${requestedResource}/${requestedMode} manager=${managerPredictsConflict} nawabari=${nawabariRejected}`,
        );
      }
    }
  }
});
