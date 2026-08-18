import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { request } from "node:http";
import { startDashboardServer } from "../dashboard/http.js";
import { createFixtureQuery } from "../semantics/fixtures/dashboard-fixture.js";
import { createTempGitRepo } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
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
  });
  activeServers.push(handle);
  const health = await fetch(`${handle.url}api/v1/manager/health`);
  assert.equal(health.status, 200);
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
  assert.equal((await detail.json()).session.runtimeName, created.runtimeName);
  const opened = await fetch(`${handle.url}api/v1/manager/sessions/${created.sessionId}/open-terminal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(opened.status, 200);
  assert.equal(runtime.attached, 1);
  const stopped = await fetch(`${handle.url}api/v1/manager/sessions/${created.sessionId}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).session.lifecycleState, "stopped");
  const restarted = await fetch(`${handle.url}api/v1/manager/sessions/${created.sessionId}/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(restarted.status, 200);
  assert.equal((await restarted.json()).session.runtimeState, "running");
  const reconciled = await fetch(`${handle.url}api/v1/manager/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(reconciled.status, 200);

  const rejected = await fetch(`${handle.url}api/v1/manager/sessions`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(rejected.status, 415);
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
  assert.deepEqual(preview.claims, [
    { resource: "src/app.ts", mode: "exclusive-write" },
    { resource: "src/readme.md", mode: "read" },
  ]);
  assert.equal(preview.nawabariDeclaration.branch, "feat/1030-http-preview");
  assert.equal(runtime.sessions.size, 0);
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.listManagerSessions(root).length, 0);
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
    headers: { "content-type": "application/json" },
    body: "{}",
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
