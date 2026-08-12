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

  const rejected = await fetch(`${handle.url}api/v1/manager/sessions`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(rejected.status, 415);
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
