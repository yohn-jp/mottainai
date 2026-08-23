import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { startNawabariTask } from "./nawabari-task.js";
import { fakeNawabari } from "../../test-support/nawabari-fixture.js";
import { createTempGitRepo } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";

test("task start enriches a resource claim conflict with Nawabari and local task identity", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const claims = new Map<string, Record<string, unknown>[]>();
  const calls: string[][] = [];
  const fixtureOptions: {
    sessions: Map<string, Record<string, unknown>>;
    claims: Map<string, Record<string, unknown>[]>;
    calls: string[][];
    failSessionClaim: boolean | { code: string; message: string; details: Record<string, unknown> };
  } = { sessions, claims, calls, failSessionClaim: false };
  const nawabari = fakeNawabari(root, fixtureOptions);

  const owner = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "blocking-task",
    branchType: "fix",
    issueRef: "481",
    nawabari,
  });
  assert.equal(owner.ok, true, JSON.stringify(owner));
  if (!owner.ok) throw new Error("fixture setup failed");

  fixtureOptions.failSessionClaim = {
    code: "RESOURCE_CLAIM_CONFLICT",
    message: "Resource claim conflicts with an active session claim",
    details: {
      ownerSessionId: owner.execution.sessionId,
      ownerBranch: owner.execution.branch,
      ownerWorktree: owner.execution.worktree,
      ownerResource: "**",
      ownerMode: "exclusive-write",
    },
  };
  const blocked = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "diagnostic-task",
    branchType: "fix",
    issueRef: "482",
    nawabari,
  });

  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  if (blocked.ok) throw new Error("expected claim conflict");
  assert.equal(blocked.reason, "nawabari-rejected");
  assert.match(blocked.detail, new RegExp(`sessionId=${owner.execution.sessionId}`));
  assert.match(blocked.detail, new RegExp(`branch=${owner.execution.branch}`));
  assert.match(blocked.detail, new RegExp(`taskId=${owner.task.taskId}`));
  assert.match(blocked.detail, /taskSlug=blocking-task/u);
  assert.match(blocked.detail, /issueRef=481/u);

  assert.ok(calls.some((args) => args[0] === "session" && args[1] === "claims"));
  assert.ok(calls.some((args) => args[0] === "session" && args[1] === "list"));
  assert.equal(
    calls.some((args) => args[0] === "session" && (args[1] === "update" || args[1] === "release")),
    false,
    "conflict diagnostics must not mutate Nawabari claims",
  );
});
