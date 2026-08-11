import type { IncomingMessage, ServerResponse } from "node:http";
import { MANAGER_API_PREFIX, type ManagerHttpHandler } from "../dashboard/http.js";
import { ManagerError, ManagerSessionService, type NewManagerSessionInput } from "./service.js";
import type { ManagerSessionId } from "../workflow/state/store.js";

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
  sendJson(response, statusCode, { error: { code, message: error.message } });
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
    ...(body.model === undefined ? {} : { model: body.model as string }),
    ...(body.taskSlug === undefined ? {} : { taskSlug: body.taskSlug as string }),
    ...(body.issueRef === undefined ? {} : { issueRef: body.issueRef as string }),
    ...(body.branchType === undefined ? {} : { branchType: body.branchType as string }),
  };
}

export class ManagerHttpApi implements ManagerHttpHandler {
  constructor(private readonly service: ManagerSessionService) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const segments = url.pathname.slice(MANAGER_API_PREFIX.length).split("/").filter(Boolean);
      if (segments.length === 1 && segments[0] === "health" && method === "GET") {
        sendJson(response, 200, this.service.health());
        return;
      }
      if (segments.length === 1 && segments[0] === "sessions" && method === "GET") {
        sendJson(response, 200, { sessions: await this.service.list() });
        return;
      }
      if (segments.length === 1 && segments[0] === "sessions" && method === "POST") {
        sendJson(response, 201, { session: await this.service.start(inputFromBody(await readJsonBody(request))) });
        return;
      }
      if (segments.length === 3 && segments[0] === "sessions" && method === "POST") {
        const sessionId = sessionIdFromPath(segments[1] ?? "");
        if (segments[2] === "open-terminal") {
          sendJson(response, 200, { session: await this.service.openTerminal(sessionId) });
          return;
        }
        if (segments[2] === "stop") {
          sendJson(response, 200, { session: await this.service.stop(sessionId) });
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
