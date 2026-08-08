import assert from "node:assert/strict";
import { request } from "node:http";
import { afterEach, test } from "node:test";
import { startDashboardServer } from "./http.js";
import { createFixtureQuery } from "../semantics/fixtures/dashboard-fixture.js";

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

test("dashboard HTTP adapter rejects non-loopback Host headers", async () => {
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "<!doctype html><title>fixture viewer</title>",
    query: createFixtureQuery(),
  });
  activeServers.push(handle);
  const { statusCode, body } = await new Promise<{ statusCode: number | undefined; body: ErrorBody }>((resolve, reject) => {
    const clientRequest = request(
      { host: handle.host, port: handle.port, path: "/api/v1/project", headers: { host: "evil.example:1" } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) as ErrorBody });
        });
      },
    );
    clientRequest.once("error", reject);
    clientRequest.end();
  });
  assert.equal(statusCode, 403);
  assert.equal(body.error.code, "forbidden");
});

test("dashboard HTTP adapter rejects unknown enum query values", async () => {
  const handle = await startDashboardServer({
    port: 0,
    viewerHtml: "<!doctype html><title>fixture viewer</title>",
    query: createFixtureQuery(),
  });
  activeServers.push(handle);
  const response = await fetch(`${handle.url}api/v1/components?status=bogus`);
  assert.equal(response.status, 400);
  const body = (await response.json()) as ErrorBody;
  assert.equal(body.error.code, "invalid_query");
});
