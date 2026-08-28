import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTempGitRepo, runGit } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import { resolveRepositoryIdentity } from "../workflow/domain/identity.js";
import { transitionTask } from "../workflow/domain/task-lifecycle.js";
import type { ManagerExecutionAuthority } from "../workflow/domain/manager-execution.js";
import type { ManagerSessionId } from "../workflow/state/store.js";
import type { ZellijObservedState, ZellijRuntime } from "./zellij.js";
import { PI_GUARD_ASSET_MARKER } from "./pi-guard.js";
import { ManagerError, ManagerSessionService } from "./service.js";

function writeFakePiGuard(t: { after: (fn: () => void) => void }, name: string): string {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mottainai-pi-guard-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const guardPath = path.join(directory, name);
  fs.writeFileSync(
    guardPath,
    `// ${PI_GUARD_ASSET_MARKER}\nexport default function mottainaiManagedPiGuard() {}\n`,
  );
  return guardPath;
}

class ContinueRuntime implements ZellijRuntime {
  readonly sessions = new Set<string>();
  readonly started: string[] = [];
  readonly terminated: string[] = [];

  async checkAvailability(): Promise<{ version: string }> {
    return { version: "fake-zellij 0.44.0" };
  }

  async inspect(sessionName: string): Promise<ZellijObservedState> {
    return this.sessions.has(sessionName) ? "running" : "absent";
  }

  async start(input: { sessionName: string; cwd: string; command: string; args: readonly string[] }): Promise<void> {
    this.started.push(input.args.at(-1) ?? "");
    this.sessions.add(input.sessionName);
  }

  async attach(): Promise<void> {}

  async terminate(sessionName: string): Promise<void> {
    this.terminated.push(sessionName);
    this.sessions.delete(sessionName);
  }

  binaryName(): string {
    return "fake-zellij";
  }
}

test("Manager continue relaunches the same persisted execution context", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const identity = resolveRepositoryIdentity(root);
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  store.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });
  const reserved = store.reserveTask({
    instanceId: identity.identity.instanceId,
    taskSlug: "continue-task",
    issueRef: undefined,
    baseBranch: "main",
    baseCommit: runGit(["rev-parse", "HEAD"], root),
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const active = transitionTask(store, reserved.task.taskId, "active");
  assert.equal(active.ok, true);

  const authority: ManagerExecutionAuthority = {
    async start() {
      throw new Error("not used");
    },
    async validate() {
      return { ok: true };
    },
    async observe(context) {
      const task = context.taskId === undefined ? undefined : store.getTask(context.taskId);
      return {
        semanticLifecycleState: task?.lifecycleState ?? "unbound",
        status: undefined,
        receipt: undefined,
      };
    },
  };
  const runtime = new ContinueRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, executionAuthority: authority });
  const session = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000548" as ManagerSessionId,
    workspaceRoot: root,
    idempotencyKey: "continue-key",
    taskId: reserved.task.taskId,
    executionSessionId: "nawabari-session-548",
    executionMode: "task-bound",
    worktreePath: root,
    branchName: "feat/continue-task",
    agentKind: "codex",
    launchProfile: "codex",
    instruction: "initial instruction",
    launchCommand: "codex",
    launchArgs: ["--", "initial instruction"],
    runtimeName: "mottainai-continue-runtime",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "active",
  });
  runtime.sessions.add(session.runtimeName);

  const continued = await service.continueWork(session.sessionId, "follow-up instruction");
  assert.equal(continued.sessionId, session.sessionId);
  assert.equal(continued.taskId, session.taskId);
  assert.equal(continued.worktreePath, session.worktreePath);
  assert.match(continued.instruction, /initial instruction[\s\S]*follow-up instruction/u);
  assert.equal(continued.launchArgs.at(-1), continued.instruction);
  assert.equal(continued.runtimeState, "running");
  assert.equal(continued.restartCount, 1);
  assert.deepEqual(runtime.terminated, [session.runtimeName]);
  assert.deepEqual(runtime.started, [continued.instruction]);
});

test("Manager continue rejects a terminal semantic task lifecycle", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const identity = resolveRepositoryIdentity(root);
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  store.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });
  const reserved = store.reserveTask({
    instanceId: identity.identity.instanceId,
    taskSlug: "terminal-continue",
    issueRef: undefined,
    baseBranch: "main",
    baseCommit: runGit(["rev-parse", "HEAD"], root),
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  assert.equal(transitionTask(store, reserved.task.taskId, "active").ok, true);
  assert.equal(transitionTask(store, reserved.task.taskId, "committed").ok, true);
  const authority: ManagerExecutionAuthority = {
    async start() {
      throw new Error("not used");
    },
    async validate() {
      return { ok: true };
    },
    async observe() {
      return { semanticLifecycleState: "committed" as const, status: undefined, receipt: undefined };
    },
  };
  const runtime = new ContinueRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, executionAuthority: authority });
  const session = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000549" as ManagerSessionId,
    workspaceRoot: root,
    taskId: reserved.task.taskId,
    executionSessionId: "nawabari-session-549",
    executionMode: "task-bound",
    worktreePath: root,
    branchName: "feat/terminal-continue",
    agentKind: "codex",
    launchProfile: "codex",
    instruction: "terminal instruction",
    launchCommand: "codex",
    launchArgs: ["--", "terminal instruction"],
    runtimeName: "mottainai-terminal-runtime",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "committed",
  });
  runtime.sessions.add(session.runtimeName);

  await assert.rejects(
    service.continueWork(session.sessionId, "must not run"),
    (error: unknown) => error instanceof ManagerError && error.code === "session_continue_rejected",
  );
  assert.deepEqual(runtime.terminated, []);
  assert.deepEqual(runtime.started, []);
});

test("Manager continue rebuilds pi launch argv through the authoritative construction, not the stale stored guard path", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const identity = resolveRepositoryIdentity(root);
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  store.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });
  const reserved = store.reserveTask({
    instanceId: identity.identity.instanceId,
    taskSlug: "continue-pi-task",
    issueRef: undefined,
    baseBranch: "main",
    baseCommit: runGit(["rev-parse", "HEAD"], root),
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  assert.equal(transitionTask(store, reserved.task.taskId, "active").ok, true);

  const authority: ManagerExecutionAuthority = {
    async start() {
      throw new Error("not used");
    },
    async validate() {
      return { ok: true };
    },
    async observe(context) {
      const task = context.taskId === undefined ? undefined : store.getTask(context.taskId);
      return { semanticLifecycleState: task?.lifecycleState ?? "unbound", status: undefined, receipt: undefined };
    },
  };
  const runtime = new ContinueRuntime();
  // Simulates a package upgrade relocating the packaged Pi guard asset between
  // the original launch and this continue call: the stored launchArgs still
  // reference the old (now stale) path, but the authoritative construction
  // must resolve and use the currently configured guard, not replay the old one.
  const oldGuardPath = writeFakePiGuard(t, "old-pi-guard.js");
  const newGuardPath = writeFakePiGuard(t, "new-pi-guard.js");
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime,
    executionAuthority: authority,
    piGuardPath: newGuardPath,
  });
  const session = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000550" as ManagerSessionId,
    workspaceRoot: root,
    taskId: reserved.task.taskId,
    executionSessionId: "nawabari-session-550",
    executionMode: "task-bound",
    worktreePath: root,
    branchName: "feat/continue-pi-task",
    agentKind: "pi",
    launchProfile: "pi",
    provider: "anthropic",
    model: "claude-sonnet-4",
    instruction: "initial pi instruction",
    launchCommand: "pi",
    launchArgs: ["--provider", "anthropic", "--model", "claude-sonnet-4", "--extension", oldGuardPath, "--", "initial pi instruction"],
    runtimeName: "mottainai-continue-pi-runtime",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "active",
  });
  runtime.sessions.add(session.runtimeName);

  const continued = await service.continueWork(session.sessionId, "pi follow-up instruction");
  assert.deepEqual(continued.launchArgs, [
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4",
    "--extension",
    newGuardPath,
    "--",
    continued.instruction,
  ]);
  assert.equal(continued.launchArgs.includes(oldGuardPath), false);
  assert.equal(continued.restartCount, 1);
});

test("Manager continue reconstructs claude/model launch argv rather than positionally editing stored argv", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const identity = resolveRepositoryIdentity(root);
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  store.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });
  const reserved = store.reserveTask({
    instanceId: identity.identity.instanceId,
    taskSlug: "continue-claude-task",
    issueRef: undefined,
    baseBranch: "main",
    baseCommit: runGit(["rev-parse", "HEAD"], root),
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  assert.equal(transitionTask(store, reserved.task.taskId, "active").ok, true);

  const authority: ManagerExecutionAuthority = {
    async start() {
      throw new Error("not used");
    },
    async validate() {
      return { ok: true };
    },
    async observe(context) {
      const task = context.taskId === undefined ? undefined : store.getTask(context.taskId);
      return { semanticLifecycleState: task?.lifecycleState ?? "unbound", status: undefined, receipt: undefined };
    },
  };
  const runtime = new ContinueRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, executionAuthority: authority });
  const session = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000551" as ManagerSessionId,
    workspaceRoot: root,
    taskId: reserved.task.taskId,
    executionSessionId: "nawabari-session-551",
    executionMode: "task-bound",
    worktreePath: root,
    branchName: "feat/continue-claude-task",
    agentKind: "claude",
    launchProfile: "claude",
    model: "claude-opus-4",
    instruction: "initial claude instruction",
    launchCommand: "claude",
    launchArgs: ["--model", "claude-opus-4", "--", "initial claude instruction"],
    runtimeName: "mottainai-continue-claude-runtime",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "active",
  });
  runtime.sessions.add(session.runtimeName);

  const continued = await service.continueWork(session.sessionId, "claude follow-up instruction");
  assert.deepEqual(continued.launchArgs, ["--model", "claude-opus-4", "--", continued.instruction]);
  assert.equal(continued.launchCommand, "claude");
});
