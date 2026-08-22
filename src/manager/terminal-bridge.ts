import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import { ManagerError, type ManagerSessionService } from "./service.js";
import { MANAGER_API_PREFIX } from "../dashboard/http.js";
import type { ManagerSessionId } from "../workflow/state/store.js";
import type { ZellijRuntime } from "./zellij.js";

const TERMINAL_PATH_PATTERN = /^\/sessions\/([^/]+)\/terminal$/u;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 1000;
const MAX_CONTROL_MESSAGE_BYTES = 4 * 1024;

/** WebSocket close codes in the private-use range 4000-4999, per RFC 6455. */
export const TERMINAL_CLOSE_CODES = {
  ptyExited: 4000,
  attachRejected: 4001,
  spawnFailed: 4002,
  invalidSessionId: 4003,
  notFound: 4004,
} as const;

interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

function parseControlMessage(data: string): ResizeMessage | undefined {
  if (Buffer.byteLength(data, "utf8") > MAX_CONTROL_MESSAGE_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.type !== "resize") return undefined;
  const cols = candidate.cols;
  const rows = candidate.rows;
  if (
    typeof cols !== "number" ||
    typeof rows !== "number" ||
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > MAX_DIMENSION ||
    rows > MAX_DIMENSION
  ) {
    return undefined;
  }
  return { type: "resize", cols, rows };
}

function sessionIdFromTerminalPath(pathname: string): ManagerSessionId | undefined {
  const match = TERMINAL_PATH_PATTERN.exec(pathname);
  if (match === null) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(decoded)) return undefined;
  return decoded as ManagerSessionId;
}

function closeWithDiagnostic(socket: WebSocket, code: number, reason: string): void {
  // WebSocket close reasons are capped at 123 UTF-8 bytes by RFC 6455.
  socket.close(code, reason.slice(0, 123));
}

/**
 * Bridges one browser WebSocket connection to the Zellij PTY of a managed
 * session's runtime identity. Ownership of the session and its Zellij pane
 * stays with Nawabari/Zellij; this only relays terminal I/O and never
 * creates or replaces a session.
 */
export function attachTerminalBridge(
  socket: WebSocket,
  handle: pty.IPty,
): void {
  let closing = false;

  const dataSubscription = handle.onData((chunk) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  });
  const exitSubscription = handle.onExit(({ exitCode }) => {
    closing = true;
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      closeWithDiagnostic(socket, TERMINAL_CLOSE_CODES.ptyExited, `zellij attach exited with code ${exitCode}`);
    }
  });

  socket.on("message", (data, isBinary) => {
    if (closing) return;
    if (isBinary) {
      handle.write(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      return;
    }
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    const control = parseControlMessage(text);
    if (control !== undefined) {
      handle.resize(control.cols, control.rows);
      return;
    }
    handle.write(text);
  });

  socket.on("close", () => {
    closing = true;
    dataSubscription.dispose();
    exitSubscription.dispose();
    handle.kill();
  });
}

export interface ManagerTerminalBridgeOptions {
  service: ManagerSessionService;
  runtime: ZellijRuntime;
}

export interface ManagerUpgradeHandler {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void;
  close(): void;
}

/**
 * Builds the WebSocket upgrade handler that Manager's HTTP layer delegates
 * to for `/sessions/:id/terminal`. One WebSocketServer (noServer mode) is
 * shared across connections; each accepted connection spawns its own PTY.
 */
export function createManagerTerminalBridge(options: ManagerTerminalBridgeOptions): ManagerUpgradeHandler {
  const wss = new WebSocketServer({ noServer: true });

  return {
    handleUpgrade(request, socket, head, url) {
      const sessionId = sessionIdFromTerminalPath(url.pathname.slice(MANAGER_API_PREFIX.length));
      if (sessionId === undefined) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
        void (async () => {
          try {
            const { runtimeName, worktreePath } = await options.service.prepareTerminalAttach(sessionId);
            let handle: pty.IPty;
            try {
              handle = pty.spawn(options.runtime.binaryName(), ["attach", runtimeName], {
                name: "xterm-256color",
                cols: DEFAULT_COLS,
                rows: DEFAULT_ROWS,
                cwd: worktreePath,
              });
            } catch (spawnError) {
              closeWithDiagnostic(
                ws,
                TERMINAL_CLOSE_CODES.spawnFailed,
                `PTY spawn failed: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`,
              );
              return;
            }
            attachTerminalBridge(ws, handle);
          } catch (error) {
            const code =
              error instanceof ManagerError && error.code === "session_not_found"
                ? TERMINAL_CLOSE_CODES.notFound
                : TERMINAL_CLOSE_CODES.attachRejected;
            closeWithDiagnostic(ws, code, error instanceof Error ? error.message : String(error));
          }
        })();
      });
    },
    close() {
      wss.close();
    },
  };
}
