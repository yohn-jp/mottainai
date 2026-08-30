import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { MANAGER_API_PREFIX, type ManagerHttpHandler } from "../dashboard/http.js";
import {
  ManagerError,
  ManagerSessionService,
  type ManagerSessionFilter,
  type NewManagerSessionInput,
} from "./service.js";
import type { ManagerUpgradeHandler } from "./terminal-bridge.js";
import { isCanonicalManagerSessionId } from "./zellij.js";
import { isCanonicalNawabariSessionId } from "../workflow/nawabari.js";
import {
  MANAGER_AGENT_KINDS,
  MANAGER_RUNTIME_STATES,
  type ManagerAgentKind,
  type ManagerSessionId,
  type ManagerSessionRecord,
} from "../workflow/state/store.js";
import { LIFECYCLE_STATES } from "../workflow/domain/lifecycle.js";

const SEMANTIC_LIFECYCLE_STATES = [...LIFECYCLE_STATES, "unbound"] as const;

const MAX_BODY_BYTES = 1 * 1024 * 1024;

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(payload);
}

function sendError(response: ServerResponse, error: ManagerError | Error): void {
  if (error instanceof ManagerError) {
    sendJson(response, error.statusCode, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }
  sendJson(response, 500, {
    error: {
      code: "internal_error",
      message: "manager request failed",
    },
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ManagerError("invalid_request", "request body is too large", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ManagerError("invalid_request", "request body must be valid JSON", 400);
  }
}

function decodedSessionIdFromPath(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ManagerError("invalid_request", "invalid session id", 400);
  }
  return decoded;
}

function sessionIdFromPath(value: string): ManagerSessionId {
  const decoded = decodedSessionIdFromPath(value);
  if (!isCanonicalManagerSessionId(decoded)) throw new ManagerError("invalid_request", "invalid session id", 400);
  return decoded as ManagerSessionId;
}

function nawabariSessionIdFromPath(value: string): string {
  const decoded = decodedSessionIdFromPath(value);
  if (!isCanonicalNawabariSessionId(decoded)) throw new ManagerError("invalid_request", "invalid session id", 400);
  return decoded;
}

function inputFromBody(value: unknown): NewManagerSessionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagerError("invalid_request", "request body must be an object", 400);
  }
  const body = value as Record<string, unknown>;
  return {
    ...(body.schemaVersion === undefined ? {} : { schemaVersion: body.schemaVersion as number }),
    instruction: body.instruction as string,
    ...(body.agentKind === undefined ? {} : { agentKind: body.agentKind as string }),
    ...(body.launchProfile === undefined ? {} : { launchProfile: body.launchProfile as string }),
    ...(body.provider === undefined ? {} : { provider: body.provider as string }),
    ...(body.model === undefined ? {} : { model: body.model as string }),
    ...(body.taskSlug === undefined ? {} : { taskSlug: body.taskSlug as string }),
    ...(body.issueRef === undefined ? {} : { issueRef: body.issueRef as string }),
    ...(body.branchType === undefined ? {} : { branchType: body.branchType as string }),
    ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey as string }),
    ...(body.scope === undefined ? {} : { scope: body.scope as NewManagerSessionInput["scope"] }),
    ...(body.paths === undefined ? {} : { paths: body.paths as NewManagerSessionInput["paths"] }),
    ...(body.claims === undefined ? {} : { claims: body.claims as NewManagerSessionInput["claims"] }),
  };
}

function normalizeAgentAliasValue(value: string): string {
  return value === "claude-code" ? "claude" : value;
}

function filterFromQuery(url: URL): ManagerSessionFilter {
  const runtimeStateParam = url.searchParams.get("runtimeState");
  const stateParam = url.searchParams.get("state");
  if (runtimeStateParam !== null && stateParam !== null && runtimeStateParam !== stateParam) {
    throw new ManagerError("invalid_request", "runtimeState and state declare conflicting runtime states", 400);
  }
  const runtimeState = runtimeStateParam ?? stateParam;
  if (
    runtimeState !== null &&
    !MANAGER_RUNTIME_STATES.includes(runtimeState as (typeof MANAGER_RUNTIME_STATES)[number])
  ) {
    throw new ManagerError("invalid_request", `unknown runtime state: ${runtimeState}`, 400);
  }
  const agentParam = url.searchParams.get("agent");
  const agentKindParam = url.searchParams.get("agentKind");
  if (
    agentParam !== null &&
    agentKindParam !== null &&
    normalizeAgentAliasValue(agentParam) !== normalizeAgentAliasValue(agentKindParam)
  ) {
    throw new ManagerError("invalid_request", "agent and agentKind declare conflicting agent kinds", 400);
  }
  const agent = agentParam ?? agentKindParam;
  if (
    agent !== null &&
    agent !== "claude-code" &&
    !MANAGER_AGENT_KINDS.includes(agent as (typeof MANAGER_AGENT_KINDS)[number])
  ) {
    throw new ManagerError("invalid_request", `unknown agent kind: ${agent}`, 400);
  }
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
    throw new ManagerError("invalid_request", "limit must be an integer between 1 and 500", 400);
  }
  const semanticLifecycleState = url.searchParams.get("semanticLifecycleState");
  if (
    semanticLifecycleState !== null &&
    !SEMANTIC_LIFECYCLE_STATES.includes(semanticLifecycleState as (typeof SEMANTIC_LIFECYCLE_STATES)[number])
  ) {
    throw new ManagerError("invalid_request", `unknown semantic lifecycle state: ${semanticLifecycleState}`, 400);
  }
  return {
    ...(runtimeState === null ? {} : { runtimeState: runtimeState as ManagerSessionFilter["runtimeState"] }),
    ...(agent === null ? {} : { agentKind: normalizeAgentAliasValue(agent) as ManagerAgentKind }),
    ...(semanticLifecycleState === null
      ? {}
      : { semanticLifecycleState: semanticLifecycleState as ManagerSessionRecord["semanticLifecycleState"] }),
    ...(url.searchParams.get("taskId") === null
      ? {}
      : { taskId: url.searchParams.get("taskId") as ManagerSessionFilter["taskId"] }),
    ...(url.searchParams.get("issueRef") === null ? {} : { issueRef: url.searchParams.get("issueRef") ?? undefined }),
    ...(url.searchParams.get("search") === null ? {} : { search: url.searchParams.get("search") ?? undefined }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function requireJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new ManagerError("invalid_request", "Manager POST requests require Content-Type: application/json", 415);
  }
}

/**
 * Browser mutations must carry the exact HTTP origin served by Manager. A
 * missing Origin is deliberately accepted for non-browser local clients that
 * cannot provide browser request metadata; loopback Host validation remains a
 * separate boundary in the dashboard server.
 */
function requireSameOrigin(request: IncomingMessage): void {
  const requestOrigin = request.headers.origin;
  if (requestOrigin === undefined) return;

  const host = request.headers.host;
  if (typeof requestOrigin !== "string" || typeof host !== "string" || host.length === 0) {
    throw new ManagerError("forbidden", "Manager mutation requests require a same-origin Origin", 403);
  }

  try {
    const expectedOrigin = new URL(`http://${host}`).origin;
    if (new URL(requestOrigin).origin !== expectedOrigin) {
      throw new ManagerError("forbidden", "Manager mutation requests require a same-origin Origin", 403);
    }
  } catch (error) {
    if (error instanceof ManagerError) throw error;
    throw new ManagerError("forbidden", "Manager mutation requests require a same-origin Origin", 403);
  }
}

type ManagerRouteMethod = "GET" | "POST";
type ManagerRouteName =
  | "health"
  | "sessions"
  | "sessions-preview"
  | "sessions-preflight"
  | "preview"
  | "preflight"
  | "session"
  | "reconcile"
  | "nawabari-inspect"
  | "open-terminal"
  | "stop"
  | "restart";

type ManagerRouteDefinition = {
  readonly name: ManagerRouteName;
  readonly path: readonly string[];
  readonly methods: readonly ManagerRouteMethod[];
};

// HEAD and OPTIONS are deliberately not implicit aliases here. They are
// rejected explicitly below so their behavior is stable and local to Manager.
const MANAGER_ROUTES: readonly ManagerRouteDefinition[] = [
  { name: "health", path: ["health"], methods: ["GET"] },
  { name: "sessions", path: ["sessions"], methods: ["GET", "POST"] },
  // Keep static session aliases ahead of the dynamic session detail route.
  { name: "sessions-preview", path: ["sessions", "preview"], methods: ["POST"] },
  { name: "sessions-preflight", path: ["sessions", "preflight"], methods: ["POST"] },
  { name: "preview", path: ["preview"], methods: ["POST"] },
  { name: "preflight", path: ["preflight"], methods: ["POST"] },
  { name: "session", path: ["sessions", ":sessionId"], methods: ["GET"] },
  { name: "reconcile", path: ["reconcile"], methods: ["POST"] },
  {
    name: "nawabari-inspect",
    path: ["nawabari", "sessions", ":sessionId", "inspect"],
    methods: ["POST"],
  },
  { name: "open-terminal", path: ["sessions", ":sessionId", "open-terminal"], methods: ["POST"] },
  { name: "stop", path: ["sessions", ":sessionId", "stop"], methods: ["POST"] },
  { name: "restart", path: ["sessions", ":sessionId", "restart"], methods: ["POST"] },
];

function routePathMatches(path: readonly string[], segments: readonly string[]): boolean {
  return (
    path.length === segments.length && path.every((part, index) => part.startsWith(":") || part === segments[index])
  );
}

function routeForPath(segments: readonly string[]): ManagerRouteDefinition | undefined {
  return MANAGER_ROUTES.find(({ path }) => routePathMatches(path, segments));
}

function sendMethodNotAllowed(response: ServerResponse, allowedMethods: readonly ManagerRouteMethod[]): void {
  response.setHeader("allow", allowedMethods.join(", "));
  sendJson(response, 405, {
    error: {
      code: "method_not_allowed",
      message: "Manager route does not allow this method",
    },
  });
}

export class ManagerHttpApi implements ManagerHttpHandler {
  constructor(
    private readonly service: ManagerSessionService,
    private readonly terminalBridge?: ManagerUpgradeHandler,
  ) {}

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    if (this.terminalBridge === undefined) {
      socket.destroy();
      return;
    }
    this.terminalBridge.handleUpgrade(request, socket, head, url);
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const segments = url.pathname.slice(MANAGER_API_PREFIX.length).split("/").filter(Boolean);
      const route = routeForPath(segments);
      if (route === undefined) {
        sendJson(response, 404, { error: { code: "not_found", message: "Manager route not found" } });
        return;
      }
      const routeMethod = method as ManagerRouteMethod;
      if (!route.methods.includes(routeMethod)) {
        sendMethodNotAllowed(response, route.methods);
        return;
      }
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") requireSameOrigin(request);
      switch (route.name) {
        case "health":
          sendJson(response, 200, this.service.health());
          return;
        case "sessions":
          if (method === "GET") {
            const sessions = await this.service.list(filterFromQuery(url));
            sendJson(response, 200, {
              sessions: sessions.map((session) => this.service.projectSessionSummary(session)),
            });
            return;
          }
          requireJsonContentType(request);
          sendJson(response, 201, {
            session: this.service.projectSession(await this.service.start(inputFromBody(await readJsonBody(request)))),
          });
          return;
        case "sessions-preview":
        case "sessions-preflight":
        case "preview":
        case "preflight":
          requireJsonContentType(request);
          sendJson(response, 200, { preview: await this.service.preview(inputFromBody(await readJsonBody(request))) });
          return;
        case "session": {
          const session = await this.service.get(sessionIdFromPath(segments[1] ?? ""));
          sendJson(response, 200, { session: this.service.projectSession(session) });
          return;
        }
        case "reconcile":
          sendJson(response, 200, {
            sessions: (await this.service.reconcileNow()).map((session) => this.service.projectSession(session)),
          });
          return;
        case "nawabari-inspect":
          sendJson(response, 200, {
            session: await this.service.inspectNawabariSession(nawabariSessionIdFromPath(segments[2] ?? "")),
          });
          return;
        case "open-terminal":
        case "stop":
        case "restart": {
          const sessionId = sessionIdFromPath(segments[1] ?? "");
          if (route.name === "open-terminal") {
            sendJson(response, 200, {
              session: this.service.projectSession(await this.service.openTerminal(sessionId)),
            });
            return;
          }
          if (route.name === "stop") {
            sendJson(response, 200, { session: this.service.projectSession(await this.service.stop(sessionId)) });
            return;
          }
          sendJson(response, 200, { session: this.service.projectSession(await this.service.restart(sessionId)) });
          return;
        }
      }
      sendJson(response, 404, { error: { code: "not_found", message: "Manager route not found" } });
    } catch (error) {
      sendError(
        response,
        error instanceof ManagerError ? error : error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}
