import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTempGitRepo, runGit } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import { fakeNawabari } from "../test-support/nawabari-fixture.js";
import type { ZellijRuntime, ZellijObservedState } from "./zellij.js";
import {
  buildManagerLaunchInvocation,
  ManagerError,
  ManagerSessionService,
  resolvePiGuardPath,
  selectControllingManagerSession,
  type ManagerResourceScope,
  type NewManagerSessionInput,
} from "./service.js";
import type { ManagerExecutionAuthority } from "../workflow/domain/manager-execution.js";
import type { ManagerSessionId, ManagerSessionRecord, NawabariSessionId } from "../workflow/state/store.js";
import type { RepositoryInstanceId, RootCommitDigest } from "../workflow/domain/identity.js";
import type { SemanticExecutionPlan } from "../semantics/execution-plan.js";

class FakeRuntime implements ZellijRuntime {
  readonly sessions = new Set<string>();
  readonly started: { sessionName: string; cwd: string; command: string; args: readonly string[] }[] = [];
  readonly attached: string[] = [];
  readonly terminated: string[] = [];

  async checkAvailability(): Promise<{ version: string }> {
    return { version: "fake-zellij 0.0.0" };
  }

  async inspect(sessionName: string): Promise<ZellijObservedState> {
    return this.sessions.has(sessionName) ? "running" : "absent";
  }

  async start(input: { sessionName: string; cwd: string; command: string; args: readonly string[] }): Promise<void> {
    this.started.push(input);
    this.sessions.add(input.sessionName);
  }

  async attach(sessionName: string): Promise<void> {
    if (!this.sessions.has(sessionName)) throw new Error("missing fake session");
    this.attached.push(sessionName);
  }

  async terminate(sessionName: string): Promise<void> {
    this.terminated.push(sessionName);
    this.sessions.delete(sessionName);
  }

  binaryName(): string {
    return "fake-zellij";
  }
}

test("operational projection keeps semantic lifecycle authoritative when the agent process exits", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime: new FakeRuntime() });
  const session = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000406" as ManagerSessionId,
    workspaceRoot: root,
    executionMode: "workspace",
    worktreePath: root,
    agentKind: "pi",
    launchProfile: "pi",
    instruction: "projection test",
    launchCommand: "pi",
    launchArgs: ["--", "projection test"],
    runtimeName: "mottainai-test-runtime",
    lifecycleState: "exited",
    runtimeState: "exited",
    semanticLifecycleState: "active",
    reconciliationState: "drifted",
    latestStatus: "managed Zellij agent pane exited; semantic task completion was not inferred",
  });

  const projection = service.projectSession(session);
  assert.equal(projection.operational.state, "attention");
  assert.equal(projection.operational.phaseRail.find((phase) => phase.id === "active")?.state, "current");
  assert.match(projection.operational.attention?.reason ?? "", /not semantic completion/u);
  assert.equal(projection.operational.identities.managerSessionId, session.sessionId);
  assert.equal(projection.operational.validation.state, "unavailable");
  assert.equal(projection.operational.pullRequest.state, "unavailable");
});

test("operational state is not blocked by conflict-shaped free text in the diagnostic", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime: new FakeRuntime() });
  const session = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000407" as ManagerSessionId,
    workspaceRoot: root,
    executionMode: "workspace",
    worktreePath: root,
    agentKind: "pi",
    launchProfile: "pi",
    instruction: "diagnostic text regression",
    launchCommand: "pi",
    launchArgs: ["--", "diagnostic text regression"],
    runtimeName: "mottainai-test-runtime-407",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "active",
    reconciliationState: "synced",
    latestStatus: "claim preflight clear; no conflict, nothing blocked here",
  });

  const projection = service.projectSession(session);
  assert.notEqual(projection.operational.state, "blocked");
  assert.equal(projection.operational.state, "healthy");
});

test("operational state is blocked only by a structured claim-preflight receipt code", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime: new FakeRuntime() });
  const session = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000408" as ManagerSessionId,
    workspaceRoot: root,
    executionMode: "workspace",
    worktreePath: root,
    agentKind: "pi",
    launchProfile: "pi",
    instruction: "structured conflict regression",
    launchCommand: "pi",
    launchArgs: ["--", "structured conflict regression"],
    runtimeName: "mottainai-test-runtime-408",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "active",
    reconciliationState: "unresolved",
    latestStatus: "session start rejected before any Manager mutation",
    latestReceipt: {
      code: "claim_conflict",
      message: "Nawabari reports an active conflicting claim",
      source: "workflow",
      recordedAt: Date.now(),
    },
  });

  const projection = service.projectSession(session);
  assert.equal(projection.operational.state, "blocked");
});

test("operational state covers blocked and stale classifications with structured signals", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime: new FakeRuntime() });

  const staleSession = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000409" as ManagerSessionId,
    workspaceRoot: root,
    executionMode: "workspace",
    worktreePath: root,
    agentKind: "pi",
    launchProfile: "pi",
    instruction: "stale runtime",
    launchCommand: "pi",
    launchArgs: ["--", "stale runtime"],
    runtimeName: "mottainai-test-runtime-409",
    lifecycleState: "running",
    runtimeState: "stale",
    semanticLifecycleState: "active",
    reconciliationState: "unresolved",
    latestStatus: "runtime unavailable",
  });
  assert.equal(service.projectSession(staleSession).operational.state, "stale");

  const preflightStaleSession = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000410" as ManagerSessionId,
    workspaceRoot: root,
    executionMode: "workspace",
    worktreePath: root,
    agentKind: "pi",
    launchProfile: "pi",
    instruction: "preflight stale",
    launchCommand: "pi",
    launchArgs: ["--", "preflight stale"],
    runtimeName: "mottainai-test-runtime-410",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "active",
    reconciliationState: "unresolved",
    latestReceipt: {
      code: "claim_preflight_stale",
      message: "claim registry evidence is stale",
      source: "workflow",
      recordedAt: Date.now(),
    },
  });
  assert.equal(service.projectSession(preflightStaleSession).operational.state, "blocked");
});

function recordingExecutionAuthority(root: string, plans: SemanticExecutionPlan[]): ManagerExecutionAuthority {
  return {
    async start(input) {
      if (input.semanticPlan === undefined) throw new Error("semantic plan missing");
      plans.push(input.semanticPlan);
      return {
        context: {
          taskId: undefined,
          executionSessionId: undefined,
          worktreeId: undefined,
          worktreePath: root,
          branchName: undefined,
          taskSlug: input.taskSlug,
          issueRef: input.issueRef,
          branchType: input.branchType,
          semanticLifecycleState: "unbound",
        },
      };
    },
    async validate() {
      return { ok: true };
    },
    async observe(context) {
      return { semanticLifecycleState: context.semanticLifecycleState, status: undefined, receipt: undefined };
    },
  };
}

test("Manager preview derives path scope and preserves explicit claim modes", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const plans: SemanticExecutionPlan[] = [];
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime,
    executionAuthority: recordingExecutionAuthority(root, plans),
  });
  const input = {
    instruction: "bounded scope",
    taskSlug: "bounded-scope",
    issueRef: "1001",
    branchType: "fix",
    scope: {
      paths: ["src/a.ts", "src/b.ts"],
      claims: [
        { resource: "src/a.ts", mode: "read" as const },
        { resource: "src/c.ts", mode: "write" as const },
        { resource: "src/d.ts", mode: "exclusive-write" as const },
      ],
    },
  };
  const preview = await service.preview(input);
  assert.deepEqual(preview.claims, [
    { resource: "src/a.ts", mode: "exclusive-write" },
    { resource: "src/a.ts", mode: "read" },
    { resource: "src/b.ts", mode: "exclusive-write" },
    { resource: "src/c.ts", mode: "write" },
    { resource: "src/d.ts", mode: "exclusive-write" },
  ]);
  assert.equal(preview.claimGeneration.strategy, "declared");
  assert.equal(preview.claimGeneration.source, "explicit-paths");
  assert.equal(preview.identity.executionMode, "task-bound");
  assert.equal(preview.identity.task.taskSlug, "bounded-scope");
  assert.equal(preview.identity.branch.name, "fix/1001-bounded-scope");
  assert.deepEqual(preview.nawabariDeclaration.claims, preview.claims);
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.listManagerSessions(root).length, 0);
  assert.equal(runtime.started.length, 0);

  await service.start(input);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0], preview.semanticExecutionPlan);
  assert.equal(runtime.started.length, 1);
});

test("Manager preview exposes the no-scope repository-wide read fallback", async (t) => {
  const root = createTempGitRepo(t);
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime: new FakeRuntime(),
  });
  const preview = await service.preview({
    instruction: "compatibility launch",
    taskSlug: "fallback",
    issueRef: "1002",
  });
  assert.deepEqual(preview.claims, [{ resource: "**", mode: "read" }]);
  assert.equal(preview.claimGeneration.strategy, "conservative-broad");
  assert.equal(preview.claimGeneration.source, "unknown-scope");
  assert.match(preview.claimGeneration.warnings[0] ?? "", /repository-wide read fallback/u);
  assert.deepEqual(preview.nawabariDeclaration.claims, [{ resource: "**", mode: "read" }]);
  assert.equal(preview.fields.find((field) => field.name === "scope")?.state, "defaulted");
  assert.equal(preview.fields.find((field) => field.name === "branchType")?.state, "defaulted");
  assert.equal(preview.fields.find((field) => field.name === "agent")?.state, "derived");
});

test("Manager task start rejects duplicated Issue identity before mutation and repeats the same rejection on retry", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const calls: string[][] = [];
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime,
    nawabari: fakeNawabari(root, { calls }),
  });
  const input = {
    instruction: "reject duplicated Issue identity",
    taskSlug: "378-nawabari-integration-close",
    issueRef: "378",
    branchType: "fix",
    idempotencyKey: "duplicate-identity-378",
  };
  const assertRejected = async () =>
    assert.rejects(service.start(input), (error: unknown) => {
      assert.ok(error instanceof ManagerError);
      assert.equal(error.code, "task_start_failed");
      assert.match(error.message, /repeats issue identity/);
      return true;
    });

  await assertRejected();
  await assertRejected();
  assert.deepEqual(store.listTasks(), []);
  assert.deepEqual(store.listManagerSessions(root), []);
  assert.equal(runtime.started.length, 0);
  assert.equal(
    calls.some((args) => args[0] === "session" && ["create", "claim", "update", "release", "close"].includes(args[1] ?? "")),
    false,
    "duplicate identity must be rejected before Nawabari mutation",
  );
});

test("Manager workspace launch previews use the workspace root when Git identity is unavailable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-manager-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime: new FakeRuntime(),
  });
  const preview = await service.preview({ instruction: "workspace launch" });
  assert.deepEqual(preview.repository, { name: path.basename(root), root });
  assert.equal(preview.identity.executionMode, "workspace");
  assert.equal(preview.claimPreflight.status, "not-applicable");
});

test("Manager preview projects a canonical launch request and dependency-aware identity", async (t) => {
  const root = createTempGitRepo(t);
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime: new FakeRuntime(),
  });
  const preview = await service.preview({
    instruction: "project launch intent",
    launchProfile: "pi",
    provider: "anthropic",
    model: "claude-sonnet-4",
    taskSlug: "projected-intent",
    issueRef: "1060",
    branchType: "fix",
    scope: { paths: ["src/manager/service.ts"] },
  });
  assert.equal(preview.schemaVersion, 1);
  assert.deepEqual(preview.request, {
    schemaVersion: 1,
    instruction: "project launch intent",
    agentKind: "pi",
    launchProfile: "pi",
    provider: "anthropic",
    model: "claude-sonnet-4",
    taskSlug: "projected-intent",
    issueRef: "1060",
    branchType: "fix",
    scope: { paths: ["src/manager/service.ts"] },
  });
  assert.equal(preview.repository.name, path.basename(root));
  assert.equal(preview.profile.agent, "pi");
  assert.equal(preview.profile.provider, "anthropic");
  assert.deepEqual(preview.scope.effectiveClaims, [{ resource: "src/manager/service.ts", mode: "exclusive-write" }]);
  assert.equal(preview.fields.find((field) => field.name === "branchType")?.state, "provided");
  assert.equal(preview.fields.find((field) => field.name === "agent")?.state, "derived");
  assert.equal(preview.fields.find((field) => field.name === "scope")?.state, "provided");
});

test("Manager rejects invalid branch/profile/schema combinations before external mutation", async (t) => {
  const cases: NewManagerSessionInput[] = [
    { instruction: "invalid branch", taskSlug: "invalid-branch", issueRef: "1061", branchType: "bad type" },
    { instruction: "invalid provider", agentKind: "codex", provider: "anthropic" },
    { instruction: "invalid schema", schemaVersion: 2 },
  ];
  for (const input of cases) {
    const root = createTempGitRepo(t);
    const store = createWorkflowStore(t);
    const runtime = new FakeRuntime();
    const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
    await assert.rejects(
      service.start(input),
      (error: unknown) => error instanceof ManagerError && error.code === "invalid_request",
    );
    assert.equal(store.listTasks().length, 0);
    assert.equal(store.listManagerSessions(root).length, 0);
    assert.equal(runtime.started.length, 0);
  }
});

test("Manager rejects invalid scope before task, record, Nawabari, or Zellij mutation", async (t) => {
  const invalidScopes = [
    { paths: [""] },
    { paths: ["/absolute/file.ts"] },
    { paths: ["src/../secret.ts"] },
    { paths: ["src/line\nfeed.ts"] },
    { claims: [{ resource: "src/file.ts", mode: "not-a-mode" }] },
  ];
  for (const [index, scope] of invalidScopes.entries()) {
    const root = createTempGitRepo(t);
    const store = createWorkflowStore(t);
    const runtime = new FakeRuntime();
    const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
    await assert.rejects(
      service.start({
        instruction: `invalid scope ${index}`,
        taskSlug: `invalid-scope-${index}`,
        issueRef: String(1010 + index),
        scope: scope as unknown as ManagerResourceScope,
      }),
      (error: unknown) => error instanceof ManagerError && error.code === "invalid_request",
    );
    assert.equal(store.listTasks().length, 0);
    assert.equal(store.listManagerSessions(root).length, 0);
    assert.equal(runtime.started.length, 0);
  }
});

test("Manager accepts a single scope/paths or scope/claims alias representation", async (t) => {
  const root = createTempGitRepo(t);
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime: new FakeRuntime(),
  });

  const byScope = await service.preview({
    instruction: "canonical scope only",
    taskSlug: "single-alias-scope",
    issueRef: "1040",
    scope: { paths: ["src/a.ts"] },
  });
  assert.deepEqual(byScope.claims, [{ resource: "src/a.ts", mode: "exclusive-write" }]);

  const byTopLevel = await service.preview({
    instruction: "top-level alias only",
    taskSlug: "single-alias-top-level",
    issueRef: "1041",
    paths: ["src/a.ts"],
    claims: [{ resource: "src/b.ts", mode: "read" }],
  });
  assert.deepEqual(byTopLevel.claims, [
    { resource: "src/a.ts", mode: "exclusive-write" },
    { resource: "src/b.ts", mode: "read" },
  ]);
});

test("Manager accepts duplicate scope.paths/paths and scope.claims/claims that normalize identically", async (t) => {
  const root = createTempGitRepo(t);
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime: new FakeRuntime(),
  });

  const preview = await service.preview({
    instruction: "equal duplicate scope representation",
    taskSlug: "equal-duplicate-scope",
    issueRef: "1042",
    scope: {
      paths: ["src/a.ts"],
      claims: [{ resource: "src/b.ts", mode: "read" }],
    },
    // Trailing whitespace and backslash separators normalize to the same
    // effective declaration as the canonical scope above.
    paths: [" src/a.ts "],
    claims: [{ resource: "src\\b.ts", mode: "read" }],
  });
  assert.deepEqual(preview.claims, [
    { resource: "src/a.ts", mode: "exclusive-write" },
    { resource: "src/b.ts", mode: "read" },
  ]);
});

test("Manager rejects conflicting duplicate scope representations instead of widening effective scope", async (t) => {
  const conflicts: NewManagerSessionInput[] = [
    { instruction: "x", scope: { paths: ["src/a.ts"] }, paths: ["src/b.ts"] },
    {
      instruction: "x",
      scope: { claims: [{ resource: "src/a.ts", mode: "read" }] },
      claims: [{ resource: "src/a.ts", mode: "write" }],
    },
  ];
  for (const [index, conflict] of conflicts.entries()) {
    const root = createTempGitRepo(t);
    const store = createWorkflowStore(t);
    const runtime = new FakeRuntime();
    const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
    await assert.rejects(
      service.start({
        ...conflict,
        instruction: `conflicting duplicate scope ${index}`,
        taskSlug: `conflict-scope-${index}`,
        issueRef: String(1050 + index),
      }),
      (error: unknown) => error instanceof ManagerError && error.code === "invalid_request",
    );
    assert.equal(store.listTasks().length, 0);
    assert.equal(store.listManagerSessions(root).length, 0);
    assert.equal(runtime.started.length, 0);
  }
});

test("Manager rejects conflicting launchProfile/agentKind and accepts equivalent aliases", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();

  await assert.rejects(
    service.start({ instruction: "conflicting agent kind", agentKind: "codex", launchProfile: "pi" }),
    (error: unknown) => error instanceof ManagerError && error.code === "invalid_request",
  );
  assert.equal(runtime.started.length, 0);

  const session = await service.start({
    instruction: "equivalent agent kind alias",
    agentKind: "claude",
    launchProfile: "claude-code",
  });
  assert.equal(session.agentKind, "claude");
});

test("Manager preview is side-effect free and does not initialize Zellij", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const plans: SemanticExecutionPlan[] = [];
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime,
    executionAuthority: recordingExecutionAuthority(root, plans),
  });
  const preview = await service.preview({
    instruction: "inspect only",
    taskSlug: "preview-only",
    issueRef: "1020",
    scope: { claims: [{ resource: "src/readme.md", mode: "read" }] },
  });
  assert.equal(preview.claims[0]?.mode, "read");
  assert.equal(plans.length, 0);
  assert.equal(runtime.started.length, 0);
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.listManagerSessions(root).length, 0);
  assert.throws(() => service.health(), /availability has not been established/u);
});

function seededNawabariEvidence(root: string, calls: string[][], claims: Map<string, Record<string, unknown>[]>) {
  const sessions = new Map<string, Record<string, unknown>>([
    [
      "owner-session",
      {
        session_id: "owner-session",
        repository: `${root}/.git`,
        worktree: `${root}-owner`,
        branch: "feat/owner",
        state: "active",
        label: "owner-task",
      },
    ],
  ]);
  return {
    sessions,
    nawabari: fakeNawabari(root, { calls, sessions, claims }),
  };
}

function ownerClaim(
  root: string,
  resource: string,
  mode: "read" | "write" | "exclusive-write",
): Record<string, unknown> {
  return {
    schema_version: 2,
    claim_id: `owner-${resource}-${mode}`,
    session_id: "owner-session",
    repository: `${root}/.git`,
    worktree: `${root}-owner`,
    resource,
    mode,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

test("Manager preflight reports a broad Nawabari conflict before any Manager mutation", async (t) => {
  const root = createTempGitRepo(t);
  const calls: string[][] = [];
  const claims = new Map<string, Record<string, unknown>[]>([
    ["owner-session", [ownerClaim(root, "**", "exclusive-write")]],
  ]);
  const seeded = seededNawabariEvidence(root, calls, claims);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime,
    nawabari: seeded.nawabari,
    executionAuthority: recordingExecutionAuthority(root, []),
  });
  const input = {
    instruction: "read broad scope",
    taskSlug: "conflicting-read",
    issueRef: "3741",
    scope: { claims: [{ resource: "**", mode: "read" as const }] },
  };
  const preview = await service.preview(input);
  assert.equal(preview.claimPreflight.status, "conflict", JSON.stringify(preview.claimPreflight));
  assert.deepEqual(preview.claimPreflight.conflicts[0], {
    requested: { resource: "**", mode: "read" },
    existing: {
      sessionId: "owner-session",
      resource: "**",
      mode: "exclusive-write",
      worktree: `${root}-owner`,
      branch: "feat/owner",
      state: "active",
      label: "owner-task",
      claimId: "owner-**-exclusive-write",
    },
  });
  await assert.rejects(
    service.start(input),
    (error: unknown) => error instanceof ManagerError && error.code === "claim_conflict",
  );
  assert.equal(runtime.started.length, 0);
  assert.equal(
    calls.some((args) => args[0] === "session" && ["create", "claim", "update"].includes(args[1]!)),
    false,
  );
  assert.equal(claims.get("owner-session")?.length, 1);
});

test("non-overlapping Manager preflight remains clear while the existing Nawabari session stays active", async (t) => {
  const root = createTempGitRepo(t);
  const calls: string[][] = [];
  const claims = new Map<string, Record<string, unknown>[]>([
    ["owner-session", [ownerClaim(root, "src/owner.ts", "exclusive-write")]],
  ]);
  const seeded = seededNawabariEvidence(root, calls, claims);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime,
    nawabari: seeded.nawabari,
    executionAuthority: recordingExecutionAuthority(root, []),
  });
  const input = {
    instruction: "read unrelated scope",
    taskSlug: "non-overlapping-read",
    issueRef: "3742",
    scope: { claims: [{ resource: "docs/other.md", mode: "read" as const }] },
  };
  const preview = await service.preview(input);
  assert.equal(preview.claimPreflight.status, "clear", JSON.stringify(preview.claimPreflight));
  const started = await service.start(input);
  assert.equal(started.runtimeState, "running");
  assert.equal(runtime.started.length, 1);
  assert.equal(claims.get("owner-session")?.[0]?.resource, "src/owner.ts");
  assert.equal(claims.get("owner-session")?.[0]?.mode, "exclusive-write");
});

test("idempotent retry resumes its own session instead of self-conflicting against its own prior claim", async (t) => {
  // Regression for a retry-vs-preflight ordering bug: a retry with the same
  // idempotency key resolves to the session it already owns, and that
  // session's own broad claim from the first successful start must never
  // read back as a Nawabari conflict against the identical retry request.
  const root = createTempGitRepo(t);
  const calls: string[][] = [];
  const claims = new Map<string, Record<string, unknown>[]>();
  const sessions = new Map<string, Record<string, unknown>>();
  const nawabari = fakeNawabari(root, { calls, sessions, claims });
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime,
    nawabari,
    executionAuthority: recordingExecutionAuthority(root, []),
  });
  const input = {
    instruction: "retry read",
    taskSlug: "idempotent-retry",
    issueRef: "3746",
    idempotencyKey: "retry-key-3746",
    scope: { claims: [{ resource: "**", mode: "read" as const }] },
  };
  const first = await service.start(input);
  assert.equal(runtime.started.length, 1);

  // Simulate the session's own broad claim being live in the Nawabari
  // registry after the first successful start (as a real Nawabari-backed
  // execution authority would leave behind), exactly overlapping the
  // identical retry request.
  claims.set(first.sessionId, [
    {
      schema_version: 2,
      claim_id: `self-${first.sessionId}`,
      session_id: first.sessionId,
      repository: `${root}/.git`,
      worktree: root,
      resource: "**",
      mode: "exclusive-write",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ]);
  sessions.set(first.sessionId, {
    session_id: first.sessionId,
    repository: `${root}/.git`,
    worktree: root,
    branch: "feat/idempotent-retry",
    state: "active",
  });

  const retried = await service.start(input);
  assert.equal(retried.sessionId, first.sessionId);
  // Resume must not have started a second runtime or created a second claim.
  assert.equal(runtime.started.length, 1);
  assert.equal(claims.get(first.sessionId)?.length, 1);
});

test("unavailable or stale claim evidence blocks Manager start conservatively", async (t) => {
  for (const kind of ["unavailable", "stale"] as const) {
    const root = createTempGitRepo(t);
    const calls: string[][] = [];
    const claims = new Map<string, Record<string, unknown>[]>();
    const seeded = seededNawabariEvidence(root, calls, claims);
    const nawabari =
      kind === "unavailable"
        ? fakeNawabari(root, { calls, sessions: seeded.sessions, claims, failSessionList: true })
        : fakeNawabari(root, {
            calls,
            sessions: seeded.sessions,
            claims: new Map([
              ["orphan-session", [{ ...ownerClaim(root, "**", "exclusive-write"), session_id: "orphan-session" }]],
            ]),
          });
    const service = new ManagerSessionService({
      workspaceRoot: root,
      store: createWorkflowStore(t),
      runtime: new FakeRuntime(),
      nawabari,
      executionAuthority: recordingExecutionAuthority(root, []),
    });
    const input = {
      instruction: `uncertain ${kind}`,
      taskSlug: `uncertain-${kind}`,
      issueRef: kind === "unavailable" ? "3743" : "3744",
      scope: { claims: [{ resource: "**", mode: "read" as const }] },
    };
    const preview = await service.preview(input);
    assert.equal(preview.claimPreflight.status, kind);
    const expectedCode = kind === "stale" ? "claim_preflight_stale" : "claim_preflight_unavailable";
    await assert.rejects(
      service.start(input),
      (error: unknown) => error instanceof ManagerError && error.code === expectedCode,
    );
  }
});

test("Manager start observably fails closed for duplicate claim id and non-active owner registry corruption", async (t) => {
  const cases: {
    name: string;
    sessionState: string;
    claims: (root: string) => Record<string, unknown>[];
    expectedCode: "claim_preflight_unavailable" | "claim_preflight_stale";
  }[] = [
    {
      name: "duplicate claim id (REGISTRY_CORRUPT)",
      sessionState: "active",
      claims: (root) => [
        { ...ownerClaim(root, "src/a.ts", "exclusive-write"), claim_id: "dup-claim" },
        { ...ownerClaim(root, "src/b.ts", "exclusive-write"), claim_id: "dup-claim" },
      ],
      expectedCode: "claim_preflight_unavailable",
    },
    {
      name: "non-active owner (STALE_REGISTRY)",
      sessionState: "closing",
      claims: (root) => [ownerClaim(root, "src/a.ts", "exclusive-write")],
      expectedCode: "claim_preflight_stale",
    },
  ];
  for (const testCase of cases) {
    const root = createTempGitRepo(t);
    const claims = new Map<string, Record<string, unknown>[]>([["owner-session", testCase.claims(root)]]);
    const sessions = new Map<string, Record<string, unknown>>([
      [
        "owner-session",
        {
          session_id: "owner-session",
          repository: `${root}/.git`,
          worktree: `${root}-owner`,
          branch: "feat/owner",
          state: testCase.sessionState,
        },
      ],
    ]);
    const nawabari = fakeNawabari(root, { sessions, claims });
    const service = new ManagerSessionService({
      workspaceRoot: root,
      store: createWorkflowStore(t),
      runtime: new FakeRuntime(),
      nawabari,
      executionAuthority: recordingExecutionAuthority(root, []),
    });
    const input = {
      instruction: testCase.name,
      taskSlug: "registry-corruption",
      issueRef: "3747",
      scope: { claims: [{ resource: "**", mode: "read" as const }] },
    };
    await assert.rejects(
      service.start(input),
      (error: unknown) => error instanceof ManagerError && error.code === testCase.expectedCode,
      testCase.name,
    );
  }
});

test("final Nawabari conflict after a clear preview is surfaced as refreshed evidence", async (t) => {
  const root = createTempGitRepo(t);
  const calls: string[][] = [];
  const claims = new Map<string, Record<string, unknown>[]>();
  const seeded = seededNawabariEvidence(root, calls, claims);
  const runtime = new FakeRuntime();
  const authority = recordingExecutionAuthority(root, []);
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime,
    nawabari: seeded.nawabari,
    executionAuthority: {
      ...authority,
      async start(input) {
        claims.set("owner-session", [ownerClaim(root, "**", "exclusive-write")]);
        throw new Error("nawabari-rejected: RESOURCE_CLAIM_CONFLICT: changed after preview");
      },
    },
  });
  const input = {
    instruction: "TOCTOU read",
    taskSlug: "toctou-read",
    issueRef: "3745",
    scope: { claims: [{ resource: "**", mode: "read" as const }] },
  };
  await assert.rejects(service.start(input), (error: unknown) => {
    assert.ok(error instanceof ManagerError);
    assert.equal(error.code, "claim_conflict");
    const preflight = (error.details as { claimPreflight?: { status?: string; conflicts?: unknown[] } }).claimPreflight;
    assert.equal(preflight?.status, "conflict");
    assert.equal(preflight?.conflicts?.length, 1);
    return true;
  });
  assert.equal(runtime.started.length, 0);
});

test("final Nawabari conflict without matching detail stays bounded and does not clean a foreign session", async (t) => {
  const root = createTempGitRepo(t);
  const calls: string[][] = [];
  const foreignSessionId = "foreign-session";
  const sessions = new Map<string, Record<string, unknown>>([
    [
      foreignSessionId,
      {
        session_id: foreignSessionId,
        repository: `${root}/.git`,
        worktree: `${root}-foreign`,
        branch: "feat/foreign",
        state: "active",
        label: "foreign-task",
      },
    ],
  ]);
  const claims = new Map<string, Record<string, unknown>[]>([
    // The follow-up observation has a live but unrelated claim, so it cannot
    // identify a holder for the final rejection.
    [
      foreignSessionId,
      [
        {
          ...ownerClaim(root, "docs/unrelated.md", "exclusive-write"),
          session_id: foreignSessionId,
          worktree: `${root}-foreign`,
        },
      ],
    ],
  ]);
  const fixtureOptions = {
    calls,
    sessions,
    claims,
    failSessionClaim: {
      code: "RESOURCE_CLAIM_CONFLICT",
      message: "claim holder detail unavailable",
    },
  };
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime: new FakeRuntime(),
    nawabari: fakeNawabari(root, fixtureOptions),
  });
  const input = {
    instruction: "missing conflict detail",
    taskSlug: "missing-conflict-detail",
    issueRef: "522",
    scope: { claims: [{ resource: "src/requested.ts", mode: "exclusive-write" as const }] },
  };
  await assert.rejects(service.start(input), (error: unknown) => {
    assert.ok(error instanceof ManagerError);
    assert.equal(error.code, "claim_conflict");
    const details = error.details as {
      finalNawabariCode?: string;
      claimPreflight?: {
        status?: string;
        conflicts?: unknown[];
        safeActions?: string[];
        nawabariCode?: string;
        message?: string;
      };
    };
    assert.equal(details.finalNawabariCode, "RESOURCE_CLAIM_CONFLICT");
    assert.equal(details.claimPreflight?.status, "stale");
    assert.deepEqual(details.claimPreflight?.conflicts, []);
    assert.deepEqual(details.claimPreflight?.safeActions, [
      "retry-after-stabilization",
      "refresh-preflight",
      "reconcile",
    ]);
    assert.equal(details.claimPreflight?.nawabariCode, "RESOURCE_CLAIM_CONFLICT");
    assert.match(details.claimPreflight?.message ?? "", /fresh evidence no longer reproduces/u);
    return true;
  });

  assert.ok(
    calls.some((args) => args[0] === "session" && args[1] === "claim"),
    "the final Nawabari claim acquisition must be attempted",
  );
  assert.equal(sessions.get(foreignSessionId)?.state, "active");
  assert.equal(claims.get(foreignSessionId)?.length, 1);
  assert.equal(
    calls.some(
      (args) =>
        args[0] === "session" &&
        ["update", "release", "close"].includes(args[1] ?? "") &&
        args.includes(foreignSessionId),
    ),
    false,
    "missing conflict detail must not trigger cleanup of a foreign session",
  );
});

test("Manager starts concurrent task-bound Codex sessions on distinct managed worktrees", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const [first, second] = await Promise.all([
    service.start({ instruction: "first; $(not shell)", taskSlug: "first-task", issueRef: "801", branchType: "fix" }),
    service.start({ instruction: "second", taskSlug: "second-task", issueRef: "802", branchType: "fix" }),
  ]);
  assert.equal(first.agentKind, "codex");
  assert.equal(second.agentKind, "codex");
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.runtimeName, second.runtimeName);
  assert.notEqual(first.worktreePath, second.worktreePath);
  assert.equal(first.lifecycleState, "running");
  assert.equal(second.lifecycleState, "running");
  assert.equal(runtime.started.length, 2);
  assert.deepEqual(
    runtime.started.map((entry) => entry.command),
    ["codex", "codex"],
  );
  assert.deepEqual(runtime.started.find((entry) => entry.args.includes("first; $(not shell)"))?.args, [
    "--",
    "first; $(not shell)",
  ]);
  // The canonical worktree root belongs to Nawabari; Manager only consumes
  // the returned launch directory and must not prescribe Mottainai's former root.
  assert.ok(runtime.started.every((entry) => entry.cwd !== root));

  await service.openTerminal(first.sessionId);
  assert.deepEqual(runtime.attached, [first.runtimeName]);
  const stopped = await service.stop(second.sessionId);
  assert.equal(stopped.lifecycleState, "stopped");
  assert.deepEqual(runtime.terminated, [second.runtimeName]);
  assert.equal(runtime.sessions.has(first.runtimeName), true);
  runtime.sessions.delete(first.runtimeName);
  const reconciled = await service.list();
  assert.equal(reconciled.find((session) => session.sessionId === first.sessionId)?.lifecycleState, "exited");
});

test("Manager records failed launches without leaving a running runtime claim", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  runtime.start = async () => {
    throw new Error("fake launch failed");
  };
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  await assert.rejects(service.start({ instruction: "fail" }), /fake launch failed/);
  const sessions = await service.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.lifecycleState, "failed");
  assert.equal(runtime.sessions.size, 0);
});

test("Manager reconciles a deleted managed worktree as failed and terminates its selected runtime", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const session = await service.start({
    instruction: "missing worktree",
    taskSlug: "missing-worktree",
    issueRef: "803",
    branchType: "fix",
  });
  runGit(["worktree", "remove", "--force", session.worktreePath], root);
  const reconciled = await service.list();
  assert.equal(reconciled[0]?.lifecycleState, "failed");
  assert.deepEqual(runtime.terminated, [session.runtimeName]);
});

test("launch profiles construct deterministic argv without shell interpolation", () => {
  const piGuardPath = resolvePiGuardPath();
  assert.deepEqual(
    buildManagerLaunchInvocation({
      agentKind: "codex",
      model: "o4-mini",
      instruction: "$(not shell); --flag",
    }),
    { agentKind: "codex", command: "codex", args: ["--model", "o4-mini", "--", "$(not shell); --flag"] },
  );
  assert.deepEqual(buildManagerLaunchInvocation({ agentKind: "claude", instruction: "review this" }), {
    agentKind: "claude",
    command: "claude",
    args: ["--", "review this"],
  });
  assert.deepEqual(
    buildManagerLaunchInvocation({
      agentKind: "pi",
      provider: "anthropic",
      model: "claude-sonnet-4",
      instruction: "$(not shell); opaque Pi instruction",
    }),
    {
      agentKind: "pi",
      command: "pi",
      args: [
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4",
        "--extension",
        piGuardPath,
        "--",
        "$(not shell); opaque Pi instruction",
      ],
    },
  );
});

test("Manager launches and persists Pi as an explicit profile in the Nawabari execution context", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime,
    agentCommands: { pi: { command: "fake-pi" } },
  });
  await service.initialize();
  const session = await service.start({
    agentKind: "pi",
    provider: "anthropic",
    model: "claude-sonnet-4",
    instruction: "preserve $(this) as an argv value",
    taskSlug: "pi-task",
    issueRef: "901",
    branchType: "feat",
  });

  assert.equal(session.agentKind, "pi");
  assert.equal(session.launchProfile, "pi");
  assert.equal(session.executionMode, "task-bound");
  assert.ok(session.taskId);
  assert.equal(session.provider, "anthropic");
  assert.notEqual(session.worktreePath, root);
  assert.deepEqual(session.launchArgs, [
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4",
    "--extension",
    resolvePiGuardPath(),
    "--",
    "preserve $(this) as an argv value",
  ]);
  assert.deepEqual(runtime.started[0], {
    sessionName: session.runtimeName,
    cwd: session.worktreePath,
    command: "fake-pi",
    args: session.launchArgs,
  });
  assert.equal((await service.list({ agentKind: "pi" })).length, 1);
  assert.equal(store.getManagerSession(session.sessionId)?.provider, "anthropic");

  runtime.sessions.delete(session.runtimeName);
  const stale = await service.get(session.sessionId);
  assert.equal(stale.runtimeState, "stale");
  const restarted = await service.restart(session.sessionId);
  assert.equal(restarted.runtimeState, "running");
  assert.equal(restarted.provider, "anthropic");
  assert.deepEqual(runtime.started.at(-1), {
    sessionName: session.runtimeName,
    cwd: session.worktreePath,
    command: "fake-pi",
    args: session.launchArgs,
  });
});

test("Missing Pi fails explicitly without falling back to another agent", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  runtime.start = async (input) => {
    if (input.command === "pi") throw new Error("pi executable not found");
    runtime.started.push(input);
    runtime.sessions.add(input.sessionName);
  };
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  await assert.rejects(service.start({ agentKind: "pi", instruction: "must not fallback" }), /pi executable not found/);
  const [session] = await service.list();
  assert.equal(session?.agentKind, "pi");
  assert.equal(session?.launchCommand, "pi");
  assert.equal(session?.lifecycleState, "failed");
  assert.equal(runtime.started.length, 0);
});

test("Managed Pi fails closed before task creation when its guard asset is unavailable", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime,
    piGuardPath: `${root}/missing-pi-guard.js`,
  });
  await service.initialize();

  await assert.rejects(
    service.start({ agentKind: "pi", instruction: "must fail closed", taskSlug: "guarded", issueRef: "902" }),
    (error: unknown) => error instanceof ManagerError && error.code === "pi_guard_unavailable",
  );
  assert.equal(runtime.started.length, 0);
  assert.equal((await service.list()).length, 0);
});

test("Managed Pi rejects a marker-only or otherwise malformed guard asset", async (t) => {
  const root = createTempGitRepo(t);
  const brokenGuard = `${root}/broken-pi-guard.js`;
  fs.writeFileSync(brokenGuard, "mottainai-managed-pi-guard-v1\n");
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, piGuardPath: brokenGuard });
  await service.initialize();

  await assert.rejects(
    service.start({ agentKind: "pi", instruction: "must reject broken guard" }),
    (error: unknown) => error instanceof ManagerError && error.code === "pi_guard_unavailable",
  );
  assert.equal(runtime.started.length, 0);
});

test("Manager starts Claude sessions and exposes bounded status/filter projections", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const session = await service.start({ agentKind: "claude", instruction: "claude task", issueRef: undefined });
  assert.equal(session.agentKind, "claude");
  assert.equal(session.launchProfile, "claude");
  assert.deepEqual(session.launchArgs, ["--", "claude task"]);
  assert.equal(session.runtimeState, "running");
  assert.equal((await service.list({ agentKind: "claude", limit: 1 })).length, 1);
  assert.equal((await service.list({ agentKind: "codex" })).length, 0);
});

test("Manager restart reuses the selected persisted execution context only after runtime disappearance", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const firstService = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await firstService.initialize();
  const created = await firstService.start({ instruction: "restart me" });
  runtime.sessions.delete(created.runtimeName);

  const restartedManager = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await restartedManager.initialize();
  const stale = await restartedManager.get(created.sessionId);
  assert.equal(stale.runtimeState, "stale");
  assert.equal(stale.reconciliationState, "unresolved");
  const relaunched = await restartedManager.restart(created.sessionId);
  assert.equal(relaunched.runtimeState, "running");
  assert.equal(relaunched.restartCount, 1);
  assert.equal(relaunched.worktreePath, created.worktreePath);
});

test("Manager rejects restart when the runtime name is present but its managed identity is unresolved", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const session = await service.start({ instruction: "identity check" });
  runtime.sessions.delete(session.runtimeName);
  const stale = await service.get(session.sessionId);
  assert.equal(stale.runtimeState, "stale");
  runtime.sessions.add(session.runtimeName);
  await assert.rejects(
    service.restart(session.sessionId),
    (error: unknown) => error instanceof ManagerError && error.code === "session_restart_rejected",
  );
});

test("Manager restart is rejected after semantic task completion", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const authority: ManagerExecutionAuthority = {
    async start(input) {
      return {
        context: {
          taskId: undefined,
          executionSessionId: undefined,
          worktreeId: undefined,
          worktreePath: input.workspaceRoot,
          branchName: undefined,
          taskSlug: undefined,
          issueRef: undefined,
          branchType: undefined,
          semanticLifecycleState: "merged",
        },
      };
    },
    async validate() {
      return { ok: true };
    },
    async observe(context) {
      return { semanticLifecycleState: context.semanticLifecycleState, status: "task is merged", receipt: undefined };
    },
  };
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, executionAuthority: authority });
  await service.initialize();
  const session = await service.start({ instruction: "completed semantic task" });
  runtime.sessions.delete(session.runtimeName);
  await service.get(session.sessionId);
  await assert.rejects(service.restart(session.sessionId), /semantic task lifecycle is merged/);
});

test("Manager serializes restart and stop operations for the selected session", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const session = await service.start({ instruction: "serialize me" });
  await service.stop(session.sessionId);

  let releaseStart!: () => void;
  let signalStart!: () => void;
  const startEntered = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  runtime.start = async (input) => {
    runtime.started.push(input);
    signalStart();
    await startGate;
    runtime.sessions.add(input.sessionName);
  };

  const restarted = service.restart(session.sessionId);
  await startEntered;
  const duplicateRestart = service.restart(session.sessionId);
  const stopped = service.stop(session.sessionId);
  releaseStart();

  assert.equal((await restarted).runtimeState, "running");
  await assert.rejects(duplicateRestart, /restart is only valid for a non-running managed runtime/);
  assert.equal((await stopped).runtimeState, "stopped");
  assert.equal(runtime.started.length, 2, "only the initial start and one restart may launch an agent");
});

test("Manager refreshes stopped-session semantics before deciding whether restart is valid", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  let semanticLifecycleState: "active" | "merged" = "active";
  const authority: ManagerExecutionAuthority = {
    async start(input) {
      return {
        context: {
          taskId: undefined,
          executionSessionId: undefined,
          worktreeId: undefined,
          worktreePath: input.workspaceRoot,
          branchName: undefined,
          taskSlug: undefined,
          issueRef: undefined,
          branchType: undefined,
          semanticLifecycleState,
        },
      };
    },
    async validate() {
      return { ok: true };
    },
    async observe() {
      return { semanticLifecycleState, status: `task is ${semanticLifecycleState}`, receipt: undefined };
    },
  };
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, executionAuthority: authority });
  await service.initialize();
  const session = await service.start({ instruction: "do not relaunch completed work" });
  await service.stop(session.sessionId);
  semanticLifecycleState = "merged";

  await assert.rejects(service.restart(session.sessionId), /semantic task lifecycle is merged/);
  assert.equal(store.getManagerSession(session.sessionId)?.semanticLifecycleState, "merged");
});

test("Manager keeps an older active session visible ahead of the bounded recent history", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const activeId = "00000000-0000-4000-8000-000000000001" as ManagerSessionId;
  const activeRuntime = "mottainai-00000000-0000-4000-8000-000000000001";
  store.createManagerSession({
    sessionId: activeId,
    workspaceRoot: root,
    worktreePath: root,
    agentKind: "codex",
    launchCommand: "codex",
    launchArgs: ["--", "active"],
    runtimeName: activeRuntime,
    lifecycleState: "running",
    runtimeState: "running",
    startedAt: 1,
  });
  runtime.sessions.add(activeRuntime);
  for (let index = 0; index < 501; index += 1) {
    const suffix = String(index + 2).padStart(12, "0");
    store.createManagerSession({
      sessionId: `00000000-0000-4000-8000-${suffix}` as ManagerSessionId,
      workspaceRoot: root,
      worktreePath: root,
      agentKind: "codex",
      launchCommand: "codex",
      launchArgs: ["--", "recent"],
      runtimeName: `mottainai-00000000-0000-4000-8000-${suffix}`,
      lifecycleState: "stopped",
      runtimeState: "stopped",
      startedAt: index + 2,
    });
  }

  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const listed = await service.list();
  assert.equal(service.health().sessions.active, 1);
  assert.equal(listed.length, 500);
  assert.equal(listed[0]?.sessionId, activeId);
});

test("validation reflects the reconciled head commit, not a stale base-commit reading, once work is committed", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime: new FakeRuntime() });
  const instanceId = "instance-validation-406" as RepositoryInstanceId;
  store.observeRepositoryInstance({
    rootCommitDigest: "digest-validation-406" as RootCommitDigest,
    instanceId,
    gitCommonDir: `${root}/.git`,
    canonicalWorktreePath: root,
  });
  const reserved = store.reserveTask({
    instanceId,
    taskSlug: "validation-evidence",
    issueRef: "406",
    baseBranch: "main",
    baseCommit: "0000000000000000000000000000000000base",
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) throw new Error("unreachable");
  const task = reserved.task;
  const session = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000408" as ManagerSessionId,
    workspaceRoot: root,
    executionMode: "task-bound",
    worktreePath: root,
    taskId: task.taskId,
    agentKind: "pi",
    launchCommand: "pi",
    launchArgs: ["--", "validation evidence test"],
    runtimeName: "mottainai-test-runtime-validation",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "committed",
    reconciliationState: "synced",
  });

  // The session has already committed work, but Manager has no reconciled
  // head SHA for it yet. Evidence recorded at the pre-change base commit
  // must read as unavailable, not as if it validated the changed work.
  store.recordValidationEvidence({ instanceId, headCommit: task.baseCommit, name: "unit", status: "passed" });
  assert.equal(service.projectSession(session).operational.validation.state, "unavailable");

  // Once Nawabari reconciles the real head commit, validation must be read
  // at that head — not at baseCommit, even though evidence exists there too.
  const headCommit = "1111111111111111111111111111111111head";
  store.beginCommitReconciliation({
    taskId: task.taskId,
    instanceId,
    nawabariSessionId: "nawabari-session-408" as NawabariSessionId,
    branchName: "feat/406-validation-evidence",
    beforeCommit: task.baseCommit,
    resources: ["**"],
    message: "commit",
  });
  store.recordCommitResult(task.taskId, headCommit);
  store.recordValidationEvidence({ instanceId, headCommit, name: "unit", status: "passed" });
  const afterReconciliation = service.projectSession(session).operational.validation;
  assert.equal(afterReconciliation.state, "passed");
  assert.match(afterReconciliation.summary, /unit/u);
});

test("validation in an active/pre-commit session never reads baseCommit evidence as current PASS (regression)", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime: new FakeRuntime() });
  const instanceId = "instance-validation-active-406" as RepositoryInstanceId;
  store.observeRepositoryInstance({
    rootCommitDigest: "digest-validation-active-406" as RootCommitDigest,
    instanceId,
    gitCommonDir: `${root}/.git`,
    canonicalWorktreePath: root,
  });
  const reserved = store.reserveTask({
    instanceId,
    taskSlug: "validation-active",
    issueRef: "406",
    baseBranch: "main",
    baseCommit: "0000000000000000000000000000000000base",
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) throw new Error("unreachable");
  const task = reserved.task;
  const session = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000411" as ManagerSessionId,
    workspaceRoot: root,
    executionMode: "task-bound",
    worktreePath: root,
    taskId: task.taskId,
    agentKind: "pi",
    launchCommand: "pi",
    launchArgs: ["--", "validation active regression"],
    runtimeName: "mottainai-test-runtime-validation-active",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "active",
    reconciliationState: "synced",
  });

  // The session is active/pre-commit and has never been reconciled to a real head commit, but
  // evidence happens to exist at task.baseCommit (e.g. from before the session started editing).
  // An active session can already have uncommitted worktree edits that baseCommit does not
  // reflect, so this must never be projected as current validation success.
  store.recordValidationEvidence({ instanceId, headCommit: task.baseCommit, name: "unit", status: "passed" });
  assert.equal(service.projectSession(session).operational.validation.state, "unavailable");
});

test("list projection omits expensive validation/commit/push/PR detail that only full detail projection loads", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime: new FakeRuntime() });
  const instanceId = "instance-list-projection" as RepositoryInstanceId;
  store.observeRepositoryInstance({
    rootCommitDigest: "digest-list-projection" as RootCommitDigest,
    instanceId,
    gitCommonDir: `${root}/.git`,
    canonicalWorktreePath: root,
  });
  const reserved = store.reserveTask({
    instanceId,
    taskSlug: "list-projection",
    issueRef: "406",
    baseBranch: "main",
    baseCommit: "0000000000000000000000000000000000base",
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) throw new Error("unreachable");
  const task = reserved.task;
  const session = store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000409" as ManagerSessionId,
    workspaceRoot: root,
    executionMode: "task-bound",
    worktreePath: root,
    taskId: task.taskId,
    agentKind: "pi",
    launchCommand: "pi",
    launchArgs: ["--", "list projection test"],
    runtimeName: "mottainai-test-runtime-list",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "active",
    reconciliationState: "synced",
  });
  // Evidence must be recorded at a reconciled head commit, not task.baseCommit: an
  // active/pre-commit session can already have uncommitted edits, so baseCommit is never
  // trusted as a stand-in for current state.
  const headCommit = "2222222222222222222222222222222222head";
  store.beginCommitReconciliation({
    taskId: task.taskId,
    instanceId,
    nawabariSessionId: "nawabari-session-409" as NawabariSessionId,
    branchName: "feat/406-list-projection",
    beforeCommit: task.baseCommit,
    resources: ["**"],
    message: "commit",
  });
  store.recordCommitResult(task.taskId, headCommit);
  store.recordValidationEvidence({ instanceId, headCommit, name: "unit", status: "passed" });

  const full = service.projectSession(session).operational;
  const summary = service.projectSessionSummary(session).operational;

  assert.equal(full.validation.state, "passed");
  assert.equal(summary.validation.state, "unavailable");
  assert.equal(summary.validation.summary, "Not loaded in list projection");
  assert.equal(summary.commit.state, "unavailable");
  assert.equal(summary.push.state, "unavailable");
  assert.equal(summary.pullRequest.state, "unavailable");
  // The bounded operational summary still agrees with full detail on what
  // the polled Home view actually needs: state, attention, phase, identity.
  assert.equal(summary.state, full.state);
  assert.deepEqual(summary.phaseRail, full.phaseRail);
  assert.deepEqual(summary.identities, full.identities);
  assert.deepEqual(summary.task, full.task);
});

function fakeManagerSessionRecord(sessionId: string, runtimeState: ManagerSessionRecord["runtimeState"], startedAt: number): ManagerSessionRecord {
  return { sessionId, runtimeState, startedAt } as unknown as ManagerSessionRecord;
}

test("selectControllingManagerSession resolves the sole active session among historical rows for one task", () => {
  const active = fakeManagerSessionRecord("active", "running", 100);
  const historical = fakeManagerSessionRecord("historical", "stopped", 50);
  assert.equal(selectControllingManagerSession([historical, active]), active);
  assert.equal(selectControllingManagerSession([active]), active);
});

test("selectControllingManagerSession fails closed only when more than one session is simultaneously active", () => {
  const firstActive = fakeManagerSessionRecord("first", "running", 100);
  const secondActive = fakeManagerSessionRecord("second", "detached", 200);
  assert.equal(selectControllingManagerSession([firstActive, secondActive]), undefined);
});

test("selectControllingManagerSession falls back to the most recently started session when none are active", () => {
  const older = fakeManagerSessionRecord("older", "stopped", 100);
  const newer = fakeManagerSessionRecord("newer", "failed", 200);
  assert.equal(selectControllingManagerSession([older, newer]), newer);
});

test("selectControllingManagerSession returns undefined for an empty candidate set", () => {
  assert.equal(selectControllingManagerSession([]), undefined);
});
