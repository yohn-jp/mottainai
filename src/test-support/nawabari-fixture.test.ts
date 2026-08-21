import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeNawabari } from "./nawabari-fixture.js";

/**
 * Proves the fake Nawabari fixture's success responses agree with its own
 * internal state mutation. A fixture that answers `ok: true` for `session
 * claim` without actually recording the claim would make every preflight
 * test that relies on it pass for the wrong reason: the assertion "no
 * conflict" would be true only because the claim silently never existed.
 */
test("session claim always materializes the claim for a session injected via options.sessions", async () => {
  const root = "/repo";
  const sessions = new Map<string, Record<string, unknown>>([
    [
      "injected-session",
      {
        session_id: "injected-session",
        repository: `${root}/.git`,
        worktree: root,
        branch: "feat/injected",
        state: "active",
      },
    ],
  ]);
  // Deliberately omit `claims` from options: no array is pre-seeded for
  // "injected-session", matching how session.test.ts/service.test.ts inject
  // owner sessions today.
  const nawabari = fakeNawabari(root, { sessions });
  await nawabari.claimSession({ cwd: root, sessionId: "injected-session", claims: [{ resource: "src/a.ts", mode: "exclusive-write" }] });
  const claims = await nawabari.listClaims({ cwd: root, sessionId: "injected-session" });
  assert.equal(claims.length, 1, "the claim must be recorded, not silently dropped by an unguarded optional chain");
  assert.equal(claims[0]?.resource, "src/a.ts");
  assert.equal(claims[0]?.mode, "exclusive-write");
});

test("session claim ids and session ids are realistic UUIDs, matching Nawabari's real contract", async () => {
  const root = "/repo";
  const nawabari = fakeNawabari(root, {});
  const session = await nawabari.createSession({ cwd: root, branch: "feat/uuid-shape" });
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  assert.match(session.sessionId, UUID_PATTERN);
  const [claim] = await nawabari.claimSession({ cwd: root, sessionId: session.sessionId, claims: [{ resource: "src/a.ts", mode: "read" }] });
  assert.match((claim as unknown as { claim_id: string }).claim_id, UUID_PATTERN);
});

test("session close releases every claim the closed session held", async () => {
  const root = "/repo";
  const nawabari = fakeNawabari(root, {});
  const session = await nawabari.createSession({ cwd: root, branch: "feat/close-releases" });
  await nawabari.claimSession({
    cwd: root,
    sessionId: session.sessionId,
    claims: [
      { resource: "src/a.ts", mode: "exclusive-write" },
      { resource: "src/b.ts", mode: "read" },
    ],
  });
  assert.equal((await nawabari.listClaims({ cwd: root, sessionId: session.sessionId })).length, 2);

  await nawabari.closeSession({ cwd: root, sessionId: session.sessionId });

  const claimsAfterClose = await nawabari.listClaims({ cwd: root, sessionId: session.sessionId });
  assert.deepEqual(claimsAfterClose, [], "closing a session must release every claim it held");
});
