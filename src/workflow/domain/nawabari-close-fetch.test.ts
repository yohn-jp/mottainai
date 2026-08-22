import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { fakeNawabari } from "../../test-support/nawabari-fixture.js";
import { createTempGitRepo } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { closeNawabariExecution } from "./nawabari-close.js";
import { startNawabariTask } from "./nawabari-task.js";

test("merged close forwards durable remote and base branch for explicit integration proof fetch", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const calls: string[][] = [];
  const nawabari = fakeNawabari(root, { sessions, calls });

  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "integration-proof-fetch",
    branchType: "fix",
    issueRef: "495",
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) throw new Error("fixture setup failed");

  const session = sessions.get(started.task.nawabariSessionId!)!;
  const targetBranch = String(session.branch);
  store.beginPushReconciliation({
    taskId: started.task.taskId,
    instanceId: started.task.instanceId,
    nawabariSessionId: started.task.nawabariSessionId!,
    sourceCommit: "source-sha",
    remote: "origin",
    targetBranch,
    targetRef: `refs/heads/${targetBranch}`,
    forceRequested: false,
    createUpstream: true,
  });

  const mergeRevision = "a".repeat(40);
  const providerRecord = store.recordPullRequest({
    taskId: started.task.taskId,
    instanceId: started.task.instanceId,
    provider: "github",
    repositoryId: "yohn-jp/mottainai",
    prNumber: 495,
    url: "https://github.com/yohn-jp/mottainai/pull/495",
    headSha: "source-sha",
    mergeRevision,
    lifecycleState: "merged",
  });
  store.updateTaskLifecycleState(started.task.taskId, "merged");
  calls.length = 0;

  const task = store.getTask(started.task.taskId)!;
  const result = await closeNawabariExecution({
    workspaceRoot: root,
    store,
    client: nawabari,
    task,
    providerRecord,
  });
  assert.equal(result.ok, true, JSON.stringify(result));

  const closeCall = calls.find((args) => args[0] === "session" && args[1] === "close");
  assert.deepEqual(closeCall, [
    "session",
    "close",
    "--session",
    task.nawabariSessionId,
    "--integrated-revision",
    mergeRevision,
    "--fetch-remote",
    "origin",
    "--fetch-branch",
    task.baseBranch,
    "--json",
  ]);
});
