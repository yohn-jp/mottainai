import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { startDashboardServer } from "../dashboard/http.js";
import { createFixtureQuery } from "../dashboard/fixture.js";
import { parseDashboardOptions } from "../dashboard/command.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const activeServers: { close: () => Promise<void> }[] = [];

interface ProjectBody {
  apiVersion: string;
  project: { id: string; name: string };
}

interface GraphBody {
  nodes: unknown[];
  truncated: boolean;
}

interface CollectionBody {
  length: number;
}

interface EntriesBody {
  entries: unknown[];
}

interface DependencyBody {
  items: unknown[];
}

interface EntityBody {
  agentProjection: { source: { available: boolean } };
}

interface ProjectionBody {
  source: { available: boolean };
}

interface ErrorBody {
  error: { code: string };
}

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  return port;
}

async function responseBody<T>(url: string): Promise<{ response: Response; body: T }> {
  const response = await fetch(url);
  return { response, body: (await response.json()) as T };
}

test("dashboard HTTP adapter serves the viewer and all versioned query routes", async () => {
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "<!doctype html><title>fixture viewer</title>",
    query: createFixtureQuery(),
  });
  activeServers.push(handle);
  assert.equal(handle.host, "127.0.0.1");
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const viewer = await fetch(handle.url);
  assert.equal(viewer.status, 200);
  assert.match(viewer.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await viewer.text(), /fixture viewer/);

  const project = await responseBody<ProjectBody>(`${handle.url}api/v1/project`);
  assert.equal(project.response.status, 200);
  assert.equal(project.body.apiVersion, "v1");
  assert.equal(project.body.project.name, "mottainai");

  const graph = await responseBody<GraphBody>(`${handle.url}api/v1/graph?limit=2`);
  assert.equal(graph.response.status, 200);
  assert.equal(graph.body.nodes.length, 2);
  assert.equal(graph.body.truncated, true);

  const components = await responseBody<CollectionBody>(`${handle.url}api/v1/components`);
  assert.equal(components.response.status, 200);
  assert.equal(components.body.length, 4);
  const dependencies = await responseBody<DependencyBody>(`${handle.url}api/v1/dependencies`);
  assert.ok(dependencies.body.items.length > 0);
  const changes = await responseBody<EntriesBody>(`${handle.url}api/v1/changes`);
  assert.equal(changes.body.entries.length, 7);
  const knowledge = await responseBody<EntriesBody>(`${handle.url}api/v1/knowledge`);
  assert.equal(knowledge.body.entries.length, 6);

  const entity = await responseBody<EntityBody>(`${handle.url}api/v1/entities/${encodeURIComponent("component:read-authorization")}`);
  assert.equal(entity.response.status, 200);
  assert.equal(entity.body.agentProjection.source.available, false);
  const projection = await responseBody<ProjectionBody>(`${handle.url}api/v1/projections/agent/${encodeURIComponent("symbol:decide-read")}`);
  assert.equal(projection.response.status, 200);
  assert.equal(projection.body.source.available, false);

  const missing = await responseBody<ErrorBody>(`${handle.url}api/v1/entities/${encodeURIComponent("entity:missing")}`);
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, "not_found");
  const unknownRoute = await responseBody<ErrorBody>(`${handle.url}unknown`);
  assert.equal(unknownRoute.response.status, 404);
  assert.equal(unknownRoute.body.error.code, "not_found");
});

test("dashboard parser supports no-open and explicit ports", () => {
  assert.deepEqual(parseDashboardOptions(["--no-open", "--port", "4321"]), { noOpen: true, port: 4321 });
  assert.throws(() => parseDashboardOptions(["--port"]), /missing value/);
  assert.throws(() => parseDashboardOptions(["--port", "70000"]), /invalid dashboard port/);
  assert.throws(() => parseDashboardOptions(["--unexpected"]), /unknown dashboard option/);
});

test("dashboard CLI starts without browser opening and shuts down on SIGTERM", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "dashboard", "--no-open", "--port", String(port)], {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise<string>((resolve, reject) => {
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
      const match = stdout.match(/Mottainai dashboard listening at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match?.[1] !== undefined) resolve(match[1]);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`dashboard exited before ready: ${code}\n${stderr}`)));
  });
  try {
    const url = await ready;
    const project = await responseBody<ProjectBody>(`${url}api/v1/project`);
    assert.equal(project.response.status, 200);
    assert.equal(project.body.project.id, "project:mottainai");
    child.kill("SIGTERM");
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
  } finally {
    if (!child.killed) child.kill("SIGTERM");
  }
});
