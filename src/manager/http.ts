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
  const statusCode = error instanceof ManagerError ? error.statusCode : 500;
  const code = error instanceof ManagerError ? error.code : "internal_error";
  const details = error instanceof ManagerError ? error.details : undefined;
  sendJson(response, statusCode, {
    error: {
      code,
      message: error.message,
      ...(details === undefined ? {} : { details }),
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

function sessionIdFromPath(value: string): ManagerSessionId {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ManagerError("invalid_request", "invalid session id", 400);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(decoded))
    throw new ManagerError("invalid_request", "invalid session id", 400);
  return decoded as ManagerSessionId;
}

function inputFromBody(value: unknown): NewManagerSessionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagerError("invalid_request", "request body must be an object", 400);
  }
  const body = value as Record<string, unknown>;
  return {
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
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") requireSameOrigin(request);
      if (method === "POST") requireJsonContentType(request);
      const segments = url.pathname.slice(MANAGER_API_PREFIX.length).split("/").filter(Boolean);
      if (segments.length === 1 && segments[0] === "health" && method === "GET") {
        sendJson(response, 200, this.service.health());
        return;
      }
      if (segments.length === 1 && segments[0] === "sessions" && method === "GET") {
        const sessions = await this.service.list(filterFromQuery(url));
        sendJson(response, 200, { sessions: sessions.map((session) => this.service.projectSessionSummary(session)) });
        return;
      }
      if (segments.length === 1 && segments[0] === "sessions" && method === "POST") {
        sendJson(response, 201, {
          session: this.service.projectSession(await this.service.start(inputFromBody(await readJsonBody(request)))),
        });
        return;
      }
      if (
        ((segments.length === 2 &&
          segments[0] === "sessions" &&
          (segments[1] === "preview" || segments[1] === "preflight")) ||
          (segments.length === 1 && (segments[0] === "preview" || segments[0] === "preflight"))) &&
        method === "POST"
      ) {
        sendJson(response, 200, { preview: await this.service.preview(inputFromBody(await readJsonBody(request))) });
        return;
      }
      if (segments.length === 2 && segments[0] === "sessions" && method === "GET") {
        const session = await this.service.get(sessionIdFromPath(segments[1] ?? ""));
        sendJson(response, 200, { session: this.service.projectSession(session) });
        return;
      }
      if (segments.length === 1 && segments[0] === "reconcile" && method === "POST") {
        sendJson(response, 200, {
          sessions: (await this.service.reconcileNow()).map((session) => this.service.projectSession(session)),
        });
        return;
      }
      if (
        segments.length === 4 &&
        segments[0] === "nawabari" &&
        segments[1] === "sessions" &&
        segments[3] === "inspect" &&
        method === "POST"
      ) {
        sendJson(response, 200, {
          session: await this.service.inspectNawabariSession(sessionIdFromPath(segments[2] ?? "")),
        });
        return;
      }
      if (segments.length === 3 && segments[0] === "sessions" && method === "POST") {
        const sessionId = sessionIdFromPath(segments[1] ?? "");
        if (segments[2] === "open-terminal") {
          sendJson(response, 200, { session: this.service.projectSession(await this.service.openTerminal(sessionId)) });
          return;
        }
        if (segments[2] === "stop") {
          sendJson(response, 200, { session: this.service.projectSession(await this.service.stop(sessionId)) });
          return;
        }
        if (segments[2] === "restart") {
          sendJson(response, 200, { session: this.service.projectSession(await this.service.restart(sessionId)) });
          return;
        }
      }
      response.setHeader("allow", "GET, POST");
      sendJson(response, 404, { error: { code: "not_found", message: "Manager route not found" } });
    } catch (error) {
      sendError(
        response,
        error instanceof ManagerError ? error : error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}
