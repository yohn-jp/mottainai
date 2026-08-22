import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  ENTITY_STATUSES,
  KNOWLEDGE_ENTRY_KINDS,
  KNOWLEDGE_ENTRY_STATUSES,
  REVIEW_LEVELS,
  SemanticQueryError,
  boundedLimit,
  type ChangeQuery,
  type ComponentQuery,
  type DependencyQuery,
  type EntityStatus,
  type GraphQuery,
  type KnowledgeEntry,
  type KnowledgeQuery,
  type RelationKind,
  type RepositorySemanticQuery,
  type ReviewLevel,
} from "../semantics/query.js";
import { createSemanticProjectionQuery, type SemanticProjectionQuery } from "../semantics/projections/index.js";

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 4317;
const API_PREFIX = "/api/v1";
export const MANAGER_API_PREFIX = "/api/v1/manager";

export interface ManagerHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void>;
  /**
   * Optional WebSocket upgrade handler. When present, upgrade requests whose
   * pathname is under MANAGER_API_PREFIX are delegated here instead of being
   * rejected; the handler owns the raw socket from this point forward.
   */
  handleUpgrade?(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void;
}

export interface DashboardServerOptions {
  query: RepositorySemanticQuery;
  /** Optional domain projection adapter; defaults to the same query provider. */
  projections?: SemanticProjectionQuery;
  viewerHtml: string;
  serviceName?: string;
  host?: string;
  port?: number;
  manager?: ManagerHttpHandler;
  staticAssets?: Readonly<Record<string, { body: string; contentType: string }>>;
}

export interface DashboardServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

interface JsonError {
  error: {
    code: string;
    message: string;
    path?: string;
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

function sendError(response: ServerResponse, statusCode: number, code: string, message: string, path?: string): void {
  const body: JsonError = { error: { code, message, ...(path === undefined ? {} : { path }) } };
  sendJson(response, statusCode, body);
}

function sendViewer(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(html),
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function sendStaticAsset(response: ServerResponse, asset: { body: string; contentType: string }): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(asset.body),
    "content-type": asset.contentType,
  });
  response.end(asset.body);
}

function parseOptionalLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return boundedLimit(parsed, 1);
}

function parseRelationKinds(value: string | null): RelationKind[] | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const allowed: readonly RelationKind[] = [
    "contains",
    "owns",
    "shares",
    "defines",
    "provides",
    "requires",
    "constrained-by",
    "depends-on",
    "calls",
    "references",
    "imports",
    "extends",
    "implements",
    "uses-package",
    "imports-api",
    "tests",
    "verifies",
    "governs",
    "evidence-for",
  ];
  const requested = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = requested.find((item) => !allowed.includes(item as RelationKind));
  if (invalid !== undefined) throw new SemanticQueryError("invalid_query", `unknown relation kind: ${invalid}`);
  return requested as RelationKind[];
}

function parseEnum<T extends string>(value: string | null, allowed: readonly T[], label: string): T | undefined {
  if (value === null) return undefined;
  if (!allowed.includes(value as T)) throw new SemanticQueryError("invalid_query", `unknown ${label}: ${value}`);
  return value as T;
}

function parseGraphQuery(url: URL): GraphQuery {
  const limit = parseOptionalLimit(url.searchParams.get("limit"));
  const nodeLimit = parseOptionalLimit(url.searchParams.get("nodeLimit"));
  const edgeLimit = parseOptionalLimit(url.searchParams.get("edgeLimit"));
  const depthValue = url.searchParams.get("depth");
  const depth = depthValue === null ? undefined : Number(depthValue);
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 0 || depth > 20)) {
    throw new SemanticQueryError("invalid_query", "depth must be an integer between 0 and 20");
  }
  const directionValue = url.searchParams.get("direction");
  const direction = directionValue === null ? undefined : directionValue;
  if (direction !== undefined && direction !== "outgoing" && direction !== "incoming" && direction !== "both") {
    throw new SemanticQueryError("invalid_query", `unknown graph direction: ${direction}`);
  }
  const relationKinds = parseRelationKinds(url.searchParams.get("relationKinds"));
  return {
    ...(url.searchParams.get("componentId") === null
      ? {}
      : { componentId: url.searchParams.get("componentId") ?? undefined }),
    ...(url.searchParams.get("entityId") === null ? {} : { entityId: url.searchParams.get("entityId") ?? undefined }),
    ...(relationKinds === undefined ? {} : { relationKinds }),
    ...(direction === undefined ? {} : { direction }),
    ...(depth === undefined ? {} : { depth }),
    ...(nodeLimit === undefined ? {} : { nodeLimit }),
    ...(edgeLimit === undefined ? {} : { edgeLimit }),
    ...(limit === undefined ? {} : { limit }),
  };
}

async function routeApi(
  url: URL,
  response: ServerResponse,
  query: RepositorySemanticQuery,
  projections: SemanticProjectionQuery,
): Promise<void> {
  const segments = url.pathname.slice(API_PREFIX.length).split("/").filter(Boolean);
  const [resource, identifier] = segments;
  if (segments.length === 0) {
    sendError(response, 404, "not_found", "API route not found", url.pathname);
    return;
  }
  if (resource === "project" && segments.length === 1) {
    sendJson(response, 200, await query.getProject());
    return;
  }
  if (resource === "graph" && segments.length === 1) {
    sendJson(response, 200, await query.getGraph(parseGraphQuery(url)));
    return;
  }
  if (resource === "entities" && segments.length === 2 && identifier !== undefined) {
    const entityId = decodeURIComponent(identifier);
    const entity = await query.getEntity(entityId);
    if (entity === undefined) {
      sendError(response, 404, "not_found", `unknown semantic entity: ${entityId}`, url.pathname);
      return;
    }
    sendJson(response, 200, entity);
    return;
  }
  if (resource === "components" && segments.length === 1) {
    const status = parseEnum<EntityStatus>(url.searchParams.get("status"), ENTITY_STATUSES, "component status");
    const componentQuery: ComponentQuery = {
      ...(url.searchParams.get("search") === null ? {} : { search: url.searchParams.get("search") ?? undefined }),
      ...(status === undefined ? {} : { status }),
      ...(parseOptionalLimit(url.searchParams.get("limit")) === undefined
        ? {}
        : { limit: parseOptionalLimit(url.searchParams.get("limit")) }),
    };
    sendJson(response, 200, await query.listComponents(componentQuery));
    return;
  }
  if (resource === "dependencies" && segments.length === 1) {
    const dependencyQuery: DependencyQuery = {
      ...(url.searchParams.get("componentId") === null
        ? {}
        : { componentId: url.searchParams.get("componentId") ?? undefined }),
      ...(parseOptionalLimit(url.searchParams.get("limit")) === undefined
        ? {}
        : { limit: parseOptionalLimit(url.searchParams.get("limit")) }),
    };
    sendJson(response, 200, await query.getDependencies(dependencyQuery));
    return;
  }
  if (resource === "changes" && segments.length === 1) {
    const reviewLevel = parseEnum<ReviewLevel>(url.searchParams.get("reviewLevel"), REVIEW_LEVELS, "review level");
    const changeQuery: ChangeQuery = reviewLevel === undefined ? {} : { reviewLevel };
    sendJson(response, 200, await query.getChangeSet(changeQuery));
    return;
  }
  if (resource === "knowledge" && segments.length === 1) {
    const kind = parseEnum<KnowledgeEntry["kind"]>(
      url.searchParams.get("kind"),
      KNOWLEDGE_ENTRY_KINDS,
      "knowledge kind",
    );
    const status = parseEnum<KnowledgeEntry["status"]>(
      url.searchParams.get("status"),
      KNOWLEDGE_ENTRY_STATUSES,
      "knowledge status",
    );
    const knowledgeQuery: KnowledgeQuery = {
      ...(kind === undefined ? {} : { kind }),
      ...(status === undefined ? {} : { status }),
    };
    sendJson(response, 200, await query.getKnowledge(knowledgeQuery));
    return;
  }
  if (resource === "projections" && identifier === "agent" && segments.length === 3) {
    const entityId = decodeURIComponent(segments[2] ?? "");
    sendJson(response, 200, await projections.getAgentContext(entityId));
    return;
  }
  if (resource === "projections" && identifier === "review" && segments.length === 2) {
    sendJson(response, 200, await projections.getReviewProjection());
    return;
  }
  if (resource === "projections" && identifier === "jsdoc" && segments.length === 3) {
    const entityId = decodeURIComponent(segments[2] ?? "");
    sendJson(response, 200, await projections.getJsdocProjection(entityId));
    return;
  }
  sendError(response, 404, "not_found", "API route not found", url.pathname);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: DashboardServerOptions,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${options.host ?? LOOPBACK_HOST}`);
  const hostName = (request.headers.host ?? "").split(":")[0];
  if (hostName !== LOOPBACK_HOST && hostName !== "localhost") {
    sendError(response, 403, "forbidden", "dashboard accepts loopback host headers only", url.pathname);
    return;
  }
  if (
    options.manager !== undefined &&
    (url.pathname === MANAGER_API_PREFIX || url.pathname.startsWith(`${MANAGER_API_PREFIX}/`))
  ) {
    await options.manager.handle(request, response, url);
    return;
  }
  if (method !== "GET") {
    response.setHeader("allow", "GET");
    sendError(response, 405, "method_not_allowed", "dashboard accepts GET requests only", url.pathname);
    return;
  }
  const staticAsset = options.staticAssets?.[url.pathname];
  if (staticAsset !== undefined) {
    sendStaticAsset(response, staticAsset);
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendViewer(response, options.viewerHtml);
    return;
  }
  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
    await routeApi(url, response, options.query, options.projections ?? createSemanticProjectionQuery(options.query));
    return;
  }
  sendError(response, 404, "not_found", "dashboard route not found", url.pathname);
}

function errorDetails(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof SemanticQueryError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  return { statusCode: 500, code: "internal_error", message: "dashboard request failed" };
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<DashboardServerHandle> {
  const host = options.host ?? LOOPBACK_HOST;
  const port = options.port ?? DEFAULT_DASHBOARD_PORT;
  const serviceName = options.serviceName ?? "dashboard";
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("dashboard port must be an integer between 0 and 65535");
  if (host !== LOOPBACK_HOST && host !== "localhost") throw new Error("dashboard host must be loopback");

  const server: Server = createServer((request, response) => {
    void route(request, response, {
      ...options,
      host,
      projections: options.projections ?? createSemanticProjectionQuery(options.query),
    }).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const details = errorDetails(error);
      sendError(response, details.statusCode, details.code, details.message);
    });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    const hostName = (request.headers.host ?? "").split(":")[0];
    const isManagerPath = url.pathname === MANAGER_API_PREFIX || url.pathname.startsWith(`${MANAGER_API_PREFIX}/`);
    if (
      (hostName !== LOOPBACK_HOST && hostName !== "localhost") ||
      !isManagerPath ||
      options.manager?.handleUpgrade === undefined
    ) {
      socket.destroy();
      return;
    }
    options.manager.handleUpgrade(request, socket, head, url);
  });

  const address = await new Promise<AddressInfo>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        reject(
          new Error(
            `${serviceName} port ${port} is already in use (another ${serviceName} may already be running)\n` +
              `stop it first, or retry with: mottainai ${serviceName} --port <port>`,
          ),
        );
        return;
      }
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("dashboard did not expose a bound address"));
        return;
      }
      resolve(bound);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  let closed = false;
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}/`,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error?: Error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
