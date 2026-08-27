import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { request } from "node:http";
import { startDashboardServer } from "../dashboard/http.js";
import { createFixtureQuery } from "../semantics/fixtures/dashboard-fixture.js";
import { readManagerAssets } from "./assets.js";
import { createTempGitRepo } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import { fakeNawabari } from "../test-support/nawabari-fixture.js";
import { ManagerHttpApi } from "./http.js";
import { ManagerSessionService } from "./service.js";
import type { ZellijObservedState, ZellijRuntime } from "./zellij.js";

class HttpFakeRuntime implements ZellijRuntime {
  readonly sessions = new Set<string>();
  attached = 0;

  async checkAvailability(): Promise<{ version: string }> {
    return { version: "fake-zellij 0.0.0" };
  }
  async inspect(name: string): Promise<ZellijObservedState> {
    return this.sessions.has(name) ? "running" : "absent";
  }
  async start(input: { sessionName: string }): Promise<void> {
    this.sessions.add(input.sessionName);
  }
  async attach(name: string): Promise<void> {
    if (!this.sessions.has(name)) throw new Error("not running");
    this.attached += 1;
  }
  async terminate(name: string): Promise<void> {
    this.sessions.delete(name);
  }
  binaryName(): string {
    return "fake-zellij";
  }
}

const activeServers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

test("Manager HTTP API exposes session state and selected open/stop actions", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new HttpFakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "<!doctype html><title>manager</title>",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service),
    staticAssets: readManagerAssets(),
  });
  activeServers.push(handle);
  const health = await fetch(handle.url + "api/v1/manager/health");
  assert.equal(health.status, 200);
  const stylesheet = await fetch(handle.url + "styles.css");
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type") ?? "", /^text\/css/u);
  assert.match(await stylesheet.text(), /\.mottainai/u);
  const wabachi = await fetch(handle.url + "mockups/wabachi.html");
  assert.equal(wabachi.status, 200);
  assert.match(await wabachi.text(), /Wabachi/u);
  assert.equal((await health.json()).zellij.available, true);

  const createdResponse = await fetch(`${handle.url}api/v1/manager/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: "run the task", agentKind: "codex" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).session;
  assert.equal(created.lifecycleState, "running");

  const listed = await fetch(`${handle.url}api/v1/manager/sessions`);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).sessions.length, 1);
  const filtered = await fetch(`${handle.url}api/v1/manager/sessions?runtimeState=running&agent=codex&limit=1`);
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.json()).sessions.length, 1);
  const detail = await fetch(`${handle.url}api/v1/manager/sessions/${created.sessionId}`);
  assert.equal(detail.status, 200);
  const detailSession = (await detail.json()).session;
  assert.equal(detailSession.runtimeName, created.runtimeName);
  assert.equal(detailSession.operational.task.lifecycleState, "unbound");
  const activePhase = detailSession.operational.phaseRail.find((phase: { id: string }) => phase.id === "active");
  assert.equal(activePhase?.state, "current");
  assert.equal(detailSession.operational.validation.state, "unavailable");
  const opened = await fetch(`${handle.url}api/v1/manager/sessions/${created.sessionId}/open-terminal`, {
    method: "POST",
  });
  assert.equal(opened.status, 200);
  assert.equal(runtime.attached, 1);
  const stopped = await fetch(`${handle.url}api/v1/manager/sessions/${created.sessionId}/stop`, {
    method: "POST",
  });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).session.lifecycleState, "stopped");
  const restarted = await fetch(`${handle.url}api/v1/manager/sessions/${created.sessionId}/restart`, {
    method: "POST",
  });
  assert.equal(restarted.status, 200);
  assert.equal((await restarted.json()).session.runtimeState, "running");
  const reconciled = await fetch(`${handle.url}api/v1/manager/reconcile`, {
    method: "POST",
  });
  assert.equal(reconciled.status, 200);

  const rejected = await fetch(`${handle.url}api/v1/manager/sessions`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(rejected.status, 415);

  const missingContentType = await fetch(`${handle.url}api/v1/manager/sessions`, {
    method: "POST",
  });
  assert.equal(missingContentType.status, 415);

  const malformedJson = await fetch(`${handle.url}api/v1/manager/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformedJson.status, 400);
});

test("Manager HTTP API accepts and filters the Pi launch profile", async (t) => {
  const root = createTempGitRepo(t);
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime: new HttpFakeRuntime(),
    agentCommands: { pi: { command: "fake-pi" } },
  });
  await service.initialize();
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "manager",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service),
  });
  activeServers.push(handle);

  const created = await fetch(`${handle.url}api/v1/manager/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instruction: "run Pi",
      agentKind: "pi",
      provider: "anthropic",
      model: "claude-sonnet-4",
    }),
  });
  assert.equal(created.status, 201);
  const session = (await created.json()).session;
  assert.equal(session.agentKind, "pi");
  assert.equal(session.provider, "anthropic");

  const filtered = await fetch(`${handle.url}api/v1/manager/sessions?agent=pi`);
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.json()).sessions.length, 1);
});

test("Manager HTTP API rejects conflicting compatibility alias query parameters and accepts equivalent ones", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new HttpFakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "manager",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service),
  });
  activeServers.push(handle);

  const conflictingState = await fetch(`${handle.url}api/v1/manager/sessions?runtimeState=running&state=failed`);
  assert.equal(conflictingState.status, 400);
  assert.equal((await conflictingState.json()).error.code, "invalid_request");

  const conflictingAgent = await fetch(`${handle.url}api/v1/manager/sessions?agent=codex&agentKind=claude`);
  assert.equal(conflictingAgent.status, 400);
  assert.equal((await conflictingAgent.json()).error.code, "invalid_request");

  const equalState = await fetch(`${handle.url}api/v1/manager/sessions?runtimeState=running&state=running`);
  assert.equal(equalState.status, 200);

  const equivalentAgent = await fetch(`${handle.url}api/v1/manager/sessions?agent=claude-code&agentKind=claude`);
  assert.equal(equivalentAgent.status, 200);
});

test("Manager HTTP preview returns the effective declaration without external mutation", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new HttpFakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "manager",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service),
  });
  activeServers.push(handle);

  const response = await fetch(`${handle.url}api/v1/manager/sessions/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instruction: "preview",
      taskSlug: "http-preview",
      issueRef: "1030",
      scope: { paths: ["src/app.ts"], claims: [{ resource: "src/readme.md", mode: "read" }] },
    }),
  });
  assert.equal(response.status, 200);
  const preview = (await response.json()).preview;
  assert.equal(preview.schemaVersion, 1);
  assert.deepEqual(preview.request, {
    schemaVersion: 1,
    instruction: "preview",
    agentKind: "codex",
    launchProfile: "codex",
    taskSlug: "http-preview",
    issueRef: "1030",
    branchType: "feat",
    scope: { paths: ["src/app.ts"], claims: [{ resource: "src/readme.md", mode: "read" }] },
  });
  assert.equal(preview.profile.agent, "codex");
  assert.equal(preview.fields.find((field: { name: string }) => field.name === "scope").state, "provided");
  assert.deepEqual(preview.claims, [
    { resource: "src/app.ts", mode: "exclusive-write" },
    { resource: "src/readme.md", mode: "read" },
  ]);
  assert.equal(preview.nawabariDeclaration.branch, "feat/1030-http-preview");
  assert.equal(preview.claimPreflight.status, "clear");
  const preflightAlias = await fetch(`${handle.url}api/v1/manager/sessions/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instruction: "preflight alias",
      taskSlug: "http-preflight-alias",
      issueRef: "1032",
      scope: { claims: [{ resource: "docs/alias.md", mode: "read" }] },
    }),
  });
  assert.equal(preflightAlias.status, 200);
  assert.equal((await preflightAlias.json()).preview.claimPreflight.status, "clear");
  assert.equal(runtime.sessions.size, 0);
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.listManagerSessions(root).length, 0);
});

test("Manager HTTP preflight exposes bounded conflict evidence and safe inspect action", async (t) => {
  const root = createTempGitRepo(t);
  const ownerSessionId = "00000000-0000-4000-8000-000000000001";
  const sessions = new Map<string, Record<string, unknown>>([
    [
      ownerSessionId,
      {
        session_id: ownerSessionId,
        repository: `${root}/.git`,
        worktree: root,
        branch: "feat/owner",
        state: "active",
        label: "owner-task",
      },
    ],
  ]);
  const claims = new Map<string, Record<string, unknown>[]>([
    [
      ownerSessionId,
      [
        {
          schema_version: 2,
          claim_id: "owner-claim",
          session_id: ownerSessionId,
          repository: `${root}/.git`,
          worktree: root,
          resource: "**",
          mode: "exclusive-write",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    ],
  ]);
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime: new HttpFakeRuntime(),
    nawabari: fakeNawabari(root, { sessions, claims }),
  });
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "manager",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service),
  });
  activeServers.push(handle);
  const body = {
    instruction: "preflight conflict",
    taskSlug: "http-conflict",
    issueRef: "1031",
    scope: { claims: [{ resource: "**", mode: "read" }] },
  };
  const previewResponse = await fetch(`${handle.url}api/v1/manager/sessions/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).preview;
  assert.equal(preview.claimPreflight.status, "conflict");
  assert.equal(preview.claimPreflight.conflicts[0].existing.sessionId, ownerSessionId);
  assert.equal(preview.claimPreflight.conflicts[0].existing.mode, "exclusive-write");

  const startResponse = await fetch(`${handle.url}api/v1/manager/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(startResponse.status, 409);
  const startError = (await startResponse.json()).error;
  assert.equal(startError.code, "claim_conflict");
  assert.equal(startError.details.claimPreflight.conflicts[0].existing.resource, "**");

  const inspectResponse = await fetch(`${handle.url}api/v1/manager/nawabari/sessions/${ownerSessionId}/inspect`, {
    method: "POST",
  });
  assert.equal(inspectResponse.status, 200);
  assert.equal((await inspectResponse.json()).session.sessionId, ownerSessionId);
});

test("Manager API remains loopback host protected and rejects malformed session ids", async (t) => {
  const root = createTempGitRepo(t);
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime: new HttpFakeRuntime(),
  });
  await service.initialize();
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "manager",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service),
  });
  activeServers.push(handle);
  const malformed = await fetch(`${handle.url}api/v1/manager/sessions/not-safe/stop`, {
    method: "POST",
  });
  assert.equal(malformed.status, 400);
  const hostile = await new Promise<number | undefined>((resolve, reject) => {
    const client = request(
      { host: handle.host, port: handle.port, path: "/api/v1/manager/health", headers: { host: "public.example" } },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    client.once("error", reject);
    client.end();
  });
  assert.equal(hostile, 403);
});

test("Manager HTTP API redacts unexpected internal errors at the HTTP boundary", async (t) => {
  const root = createTempGitRepo(t);
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store: createWorkflowStore(t),
    runtime: new HttpFakeRuntime(),
  });
  await service.initialize();
  const internalDetail = "ENOENT: no such file or directory, open '/home/user/mottainai/.secret/internal.sqlite'";
  service.health = () => {
    throw new Error(internalDetail);
  };
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "manager",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service),
  });
  activeServers.push(handle);

  const response = await fetch(`${handle.url}api/v1/manager/health`);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: { code: "internal_error", message: "manager request failed" } });
  const rawBody = JSON.stringify(body);
  assert.equal(rawBody.includes("ENOENT"), false);
  assert.equal(rawBody.includes("/home/user/mottainai"), false);
  assert.equal(rawBody.includes(internalDetail), false);
});

test("Manager mutation Origin policy blocks hostile bodyless requests and permits same-origin/local clients", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new HttpFakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const handle = await startDashboardServer({
    host: "localhost",
    port: 0,
    viewerHtml: "manager",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service),
  });
  activeServers.push(handle);

  const createdResponse = await fetch(`${handle.url}api/v1/manager/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: "origin policy" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).session;

  const hostileBodyless = await fetch(`${handle.url}api/v1/manager/sessions/${created.sessionId}/stop`, {
    method: "POST",
    headers: { origin: "http://evil.example" },
  });
  assert.equal(hostileBodyless.status, 403);
  assert.equal((await hostileBodyless.json()).error.code, "forbidden");
  assert.equal(runtime.sessions.has(created.runtimeName), true);

  const sameOrigin = await fetch(`${handle.url}api/v1/manager/sessions/${created.sessionId}/stop`, {
    method: "POST",
    headers: { origin: new URL(handle.url).origin },
  });
  assert.equal(sameOrigin.status, 200);

  const missingOrigin = await fetch(`${handle.url}api/v1/manager/sessions/${created.sessionId}/restart`, {
    method: "POST",
  });
  assert.equal(missingOrigin.status, 200);
  assert.equal((await missingOrigin.json()).session.runtimeState, "running");
});
