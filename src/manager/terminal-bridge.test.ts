import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, test } from "node:test";
import { WebSocket } from "ws";
import { startDashboardServer } from "../dashboard/http.js";
import { createFixtureQuery } from "../semantics/fixtures/dashboard-fixture.js";
import { createTempGitRepo } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import { ManagerHttpApi } from "./http.js";
import { ManagerSessionService } from "./service.js";
import { createManagerTerminalBridge, TERMINAL_CLOSE_CODES } from "./terminal-bridge.js";
import type { ZellijObservedState, ZellijRuntime } from "./zellij.js";

/**
 * Attach argv is always ["attach", runtimeName]; this wrapper ignores both
 * and execs `cat` under the PTY so the bridge tests can assert real
 * bidirectional I/O without a real Zellij binary.
 */
function writeCatWrapper(): string {
  const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-pty-")), "fake-attach.sh");
  fs.writeFileSync(scriptPath, "#!/bin/sh\nexec cat\n", { mode: 0o755 });
  return scriptPath;
}

class TerminalFakeRuntime implements ZellijRuntime {
  readonly sessions = new Set<string>();
  readonly wrapperPath = writeCatWrapper();

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
  }
  async terminate(name: string): Promise<void> {
    this.sessions.delete(name);
  }
  binaryName(): string {
    return this.wrapperPath;
  }
}

const activeServers: { close: () => Promise<void> }[] = [];
const activeSockets: WebSocket[] = [];

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

afterEach(async () => {
  await Promise.all(activeSockets.splice(0).map((socket) => withTimeout(new Promise<void>((resolve) => {
    if (socket.readyState === socket.CLOSED) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
    socket.close();
  }), 5000)));
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

test("Manager browser terminal bridge relays PTY I/O bidirectionally over WebSocket", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new TerminalFakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const created = await service.start({ instruction: "run the task", agentKind: "codex" });
  runtime.sessions.add(created.runtimeName);

  const terminalBridge = createManagerTerminalBridge({ service, runtime });
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "<!doctype html><title>manager</title>",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service, terminalBridge),
  });
  activeServers.push({
    close: async () => {
      terminalBridge.close();
      await handle.close();
    },
  });

  const wsUrl = handle.url.replace(/^http:/u, "ws:") + `api/v1/manager/sessions/${created.sessionId}/terminal`;
  const socket = new WebSocket(wsUrl, { headers: { origin: handle.url.replace(/\/$/u, "") } });
  activeSockets.push(socket);

  await withTimeout(new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  }), 5000);

  // PTY output is not framed per write: two writes in quick succession may
  // arrive as one WebSocket message or two, so accumulate and match on
  // substrings rather than asserting message boundaries.
  let received = "";
  const sawBoth = new Promise<void>((resolve) => {
    socket.on("message", (data) => {
      received += data.toString("utf8");
      if (received.includes("hello-bridge") && received.includes("still-alive")) resolve();
    });
  });
  socket.send("hello-bridge\n");
  socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  socket.send("still-alive\n");
  await withTimeout(sawBoth, 5000);
  assert.match(received, /hello-bridge\r\n/u);
  assert.match(received, /still-alive\r\n/u);
});

test("Manager browser terminal bridge buffers immediate post-open input until delayed PTY preparation completes", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new TerminalFakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const created = await service.start({ instruction: "run the task", agentKind: "codex" });
  runtime.sessions.add(created.runtimeName);

  let preparationStartedResolve!: () => void;
  const preparationStarted = new Promise<void>((resolve) => {
    preparationStartedResolve = resolve;
  });
  let releasePreparation!: () => void;
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const prepareTerminalAttach = service.prepareTerminalAttach.bind(service);
  service.prepareTerminalAttach = async (sessionId) => {
    preparationStartedResolve();
    await preparationGate;
    return prepareTerminalAttach(sessionId);
  };

  const terminalBridge = createManagerTerminalBridge({ service, runtime });
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "<!doctype html><title>manager</title>",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service, terminalBridge),
  });
  activeServers.push({
    close: async () => {
      terminalBridge.close();
      await handle.close();
    },
  });

  const wsUrl = handle.url.replace(/^http:/u, "ws:") + `api/v1/manager/sessions/${created.sessionId}/terminal`;
  const socket = new WebSocket(wsUrl, { headers: { origin: handle.url.replace(/\/$/u, "") } });
  activeSockets.push(socket);

  await withTimeout(preparationStarted, 5000);
  await withTimeout(new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  }), 5000);

  let received = "";
  const sawBoth = new Promise<void>((resolve) => {
    socket.on("message", (data) => {
      received += data.toString("utf8");
      if (received.includes("immediate-after-open") && received.includes("ordered-after-open")) resolve();
    });
  });
  try {
    socket.send("immediate-after-open\n");
    socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    socket.send("ordered-after-open\n");
    assert.equal(received, "");
  } finally {
    releasePreparation();
  }

  await withTimeout(sawBoth, 5000);
  assert.match(received, /immediate-after-open\r\n/u);
  assert.match(received, /ordered-after-open\r\n/u);
  assert.ok(received.indexOf("immediate-after-open") < received.indexOf("ordered-after-open"));
  assert.doesNotMatch(received, /\{"type":"resize"/u);
});

test("Manager browser terminal bridge closes with an actionable diagnostic when the session is not attachable", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new TerminalFakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const created = await service.start({ instruction: "run the task", agentKind: "codex" });
  // service.start() records the runtime as present via TerminalFakeRuntime.start;
  // remove it here so inspect() reports "absent" and reconciliation marks the
  // session un-attachable, reproducing the issue's attach-failure boundary.
  runtime.sessions.delete(created.runtimeName);
  await service.reconcileNow();

  const terminalBridge = createManagerTerminalBridge({ service, runtime });
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "<!doctype html><title>manager</title>",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service, terminalBridge),
  });
  activeServers.push({
    close: async () => {
      terminalBridge.close();
      await handle.close();
    },
  });

  const wsUrl = handle.url.replace(/^http:/u, "ws:") + `api/v1/manager/sessions/${created.sessionId}/terminal`;
  const socket = new WebSocket(wsUrl, { headers: { origin: handle.url.replace(/\/$/u, "") } });
  activeSockets.push(socket);

  const closeEvent = await withTimeout(new Promise<{ code: number; reason: string }>((resolve, reject) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    socket.once("error", reject);
  }), 5000);
  assert.equal(closeEvent.code, TERMINAL_CLOSE_CODES.attachRejected);
  assert.match(closeEvent.reason, /not running|not attachable/u);
});

test("Manager browser terminal bridge rejects an unknown session id with a not-found diagnostic", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new TerminalFakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();

  const terminalBridge = createManagerTerminalBridge({ service, runtime });
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "<!doctype html><title>manager</title>",
    query: createFixtureQuery(),
    manager: new ManagerHttpApi(service, terminalBridge),
  });
  activeServers.push({
    close: async () => {
      terminalBridge.close();
      await handle.close();
    },
  });

  const missingSessionId = "00000000-0000-4000-8000-000000000000";
  const wsUrl = handle.url.replace(/^http:/u, "ws:") + `api/v1/manager/sessions/${missingSessionId}/terminal`;
  const socket = new WebSocket(wsUrl, { headers: { origin: handle.url.replace(/\/$/u, "") } });
  activeSockets.push(socket);

  const closeEvent = await withTimeout(new Promise<{ code: number }>((resolve, reject) => {
    socket.once("close", (code) => resolve({ code }));
    socket.once("error", reject);
  }), 5000);
  assert.equal(closeEvent.code, TERMINAL_CLOSE_CODES.notFound);
});
