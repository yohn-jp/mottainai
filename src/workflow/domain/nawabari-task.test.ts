import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { startNawabariTask } from "./nawabari-task.js";
import { startTask } from "./task.js";
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

test("task start dry-run preserves the real-start active local task blocker", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const local = await startTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "local-blocker",
    branchType: "fix",
    issueRef: "533",
  });
  assert.equal(local.ok, true, JSON.stringify(local));
  if (!local.ok || local.worktree === undefined) throw new Error("legacy task fixture setup failed");

  const client = fakeNawabari(root);
  const input = {
    workspaceRoot: local.worktree.canonicalPath,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "preview",
    branchType: "fix",
    issueRef: "534",
    nawabari: client,
  };
  const realStart = await startNawabariTask(input);
  const dryRun = await startNawabariTask({ ...input, dryRun: true });

  assert.equal(realStart.ok, false, JSON.stringify(realStart));
  assert.equal(dryRun.ok, false, JSON.stringify(dryRun));
  if (realStart.ok || dryRun.ok) return;
  assert.equal(realStart.reason, "active-task-in-workspace");
  assert.equal(dryRun.reason, realStart.reason);
});

test("task start dry-run preserves the real-start current Nawabari task blocker without mutation", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const claims = new Map<string, Record<string, unknown>[]>();
  const ownerClient = fakeNawabari(root, { sessions, claims });
  const owner = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "owner",
    branchType: "fix",
    issueRef: "535",
    nawabari: ownerClient,
  });
  assert.equal(owner.ok, true, JSON.stringify(owner));
  if (!owner.ok) throw new Error("Nawabari owner fixture setup failed");

  const calls: string[][] = [];
  const client = fakeNawabari(root, {
    sessions,
    claims,
    currentSessionId: owner.execution.sessionId,
    calls,
  });
  const input = {
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "preview",
    branchType: "fix",
    issueRef: "536",
    nawabari: client,
  };
  const markerPath = path.join(root, ".git", "mottainai-instance-id");
  const markerBefore = fs.readFileSync(markerPath, "utf8");
  const tasksBefore = JSON.stringify(store.listTasks());
  const sessionsBefore = JSON.stringify([...sessions.entries()]);

  const realStart = await startNawabariTask(input);
  const dryRun = await startNawabariTask({ ...input, dryRun: true });

  assert.equal(realStart.ok, false, JSON.stringify(realStart));
  assert.equal(dryRun.ok, false, JSON.stringify(dryRun));
  if (realStart.ok || dryRun.ok) return;
  assert.equal(realStart.reason, "active-task-in-workspace");
  assert.equal(dryRun.reason, realStart.reason);
  assert.equal(fs.readFileSync(markerPath, "utf8"), markerBefore);
  assert.equal(JSON.stringify(store.listTasks()), tasksBefore);
  assert.equal(JSON.stringify([...sessions.entries()]), sessionsBefore);
  assert.equal(
    calls.some(
      (args) => args[0] === "session" && ["create", "claim", "update", "release", "close"].includes(args[1] ?? ""),
    ),
    false,
    "readiness parity must not cross a Nawabari mutation boundary",
  );
});

test("task start dry-run and real start both pass readiness when no blocker exists", async (t) => {
  const realRoot = createTempGitRepo(t);
  const realStore = createWorkflowStore(t);
  const real = await startNawabariTask({
    workspaceRoot: realRoot,
    store: realStore,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "ready",
    branchType: "fix",
    issueRef: "537",
    nawabari: fakeNawabari(realRoot),
  });
  assert.equal(real.ok, true, JSON.stringify(real));

  const dryRoot = createTempGitRepo(t);
  const dryStore = createWorkflowStore(t);
  const calls: string[][] = [];
  const dryMarkerPath = path.join(dryRoot, ".git", "mottainai-instance-id");
  const dry = await startNawabariTask({
    workspaceRoot: dryRoot,
    store: dryStore,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "ready",
    branchType: "fix",
    issueRef: "537",
    dryRun: true,
    nawabari: fakeNawabari(dryRoot, { calls }),
  });

  assert.equal(dry.ok, true, JSON.stringify(dry));
  if (!dry.ok || !real.ok) return;
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.claimAcquisition, {
    previewed: false,
    reason: "final Nawabari claim acquisition requires an external mutation and runs only during a real start",
  });
  assert.equal(fs.existsSync(dryMarkerPath), false);
  assert.deepEqual(dryStore.listTasks(), []);
  assert.equal(
    calls.some(
      (args) => args[0] === "session" && ["create", "claim", "update", "release", "close"].includes(args[1] ?? ""),
    ),
    false,
    "dry-run must not acquire the final external claim",
  );
});
