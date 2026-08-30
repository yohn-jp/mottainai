import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import * as pty from "node-pty";
import { ManagerError, type ManagerSessionService } from "./service.js";
import { MANAGER_API_PREFIX } from "../dashboard/http.js";
import type { ManagerSessionId } from "../workflow/state/store.js";
import { isCanonicalManagerSessionId, type ZellijRuntime } from "./zellij.js";

const TERMINAL_PATH_PATTERN = /^\/sessions\/([^/]+)\/terminal$/u;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 1000;
const MAX_CONTROL_MESSAGE_BYTES = 4 * 1024;
// Bound both count and size so empty messages cannot grow the queue without limit.
const MAX_PENDING_MESSAGES = 256;
const MAX_PENDING_INPUT_BYTES = 64 * 1024;

/** WebSocket close codes in the private-use range 4000-4999, per RFC 6455. */
export const TERMINAL_CLOSE_CODES = {
  ptyExited: 4000,
  attachRejected: 4001,
  spawnFailed: 4002,
  invalidSessionId: 4003,
  notFound: 4004,
  inputBufferOverflow: 4005,
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
  if (!isCanonicalManagerSessionId(decoded)) return undefined;
  return decoded as ManagerSessionId;
}

function closeWithDiagnostic(socket: WebSocket, code: number, reason: string): void {
  // WebSocket close reasons are capped at 123 UTF-8 bytes by RFC 6455.
  // Truncate by UTF-8 byte length, preserving code-point boundaries.
  let truncated = reason;
  while (Buffer.byteLength(truncated, "utf8") > 123) {
    truncated = truncated.slice(0, -1);
  }
  socket.close(code, truncated);
}

interface PendingTerminalMessage {
  text: string;
  isBinary: boolean;
}

interface TerminalBridgeController {
  attach(handle: pty.IPty): void;
  fail(code: number, reason: string): void;
}

function terminalMessageText(data: RawData): string {
  return Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
}

function forwardTerminalMessage(handle: pty.IPty, text: string, isBinary: boolean): void {
  if (isBinary) {
    handle.write(text);
    return;
  }
  const control = parseControlMessage(text);
  if (control !== undefined) {
    handle.resize(control.cols, control.rows);
    return;
  }
  handle.write(text);
}

/**
 * Installs the socket listener before asynchronous PTY preparation starts.
 * Messages are retained in arrival order until attach() flushes them.
 */
function createTerminalBridgeController(socket: WebSocket): TerminalBridgeController {
  let handle: pty.IPty | undefined;
  let closing = false;
  let pendingMessages: PendingTerminalMessage[] = [];
  let pendingBytes = 0;
  let dataSubscription: { dispose(): void } | undefined;
  let exitSubscription: { dispose(): void } | undefined;

  const clearPending = (): void => {
    pendingMessages = [];
    pendingBytes = 0;
  };

  const fail = (code: number, reason: string): void => {
    if (closing) return;
    closing = true;
    clearPending();
    closeWithDiagnostic(socket, code, reason);
  };

  socket.on("message", (data, isBinary) => {
    if (closing) return;
    const text = terminalMessageText(data);
    if (handle === undefined) {
      const bytes = Buffer.byteLength(text, "utf8");
      if (pendingMessages.length >= MAX_PENDING_MESSAGES || pendingBytes + bytes > MAX_PENDING_INPUT_BYTES) {
        fail(TERMINAL_CLOSE_CODES.inputBufferOverflow, "terminal input buffer is full while PTY attachment is pending");
        return;
      }
      pendingMessages.push({ text, isBinary });
      pendingBytes += bytes;
      return;
    }
    forwardTerminalMessage(handle, text, isBinary);
  });

  socket.on("close", () => {
    closing = true;
    clearPending();
    dataSubscription?.dispose();
    exitSubscription?.dispose();
    handle?.kill();
  });

  return {
    attach(nextHandle) {
      if (closing || socket.readyState === socket.CLOSING || socket.readyState === socket.CLOSED) {
        nextHandle.kill();
        return;
      }
      handle = nextHandle;
      dataSubscription = handle.onData((chunk) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk);
      });
      exitSubscription = handle.onExit(({ exitCode }) => {
        closing = true;
        clearPending();
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
          closeWithDiagnostic(socket, TERMINAL_CLOSE_CODES.ptyExited, `zellij attach exited with code ${exitCode}`);
        }
      });

      const messages = pendingMessages;
      clearPending();
      for (const message of messages) {
        if (closing) return;
        forwardTerminalMessage(handle, message.text, message.isBinary);
      }
    },
    fail,
  };
}

/**
 * Bridges one browser WebSocket connection to the Zellij PTY of a managed
 * session's runtime identity. Ownership of the session and its Zellij pane
 * stays with Nawabari/Zellij; this only relays terminal I/O and never
 * creates or replaces a session.
 */
export function attachTerminalBridge(socket: WebSocket, handle: pty.IPty): void {
  createTerminalBridgeController(socket).attach(handle);
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
        const bridge = createTerminalBridgeController(ws);
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
              bridge.fail(
                TERMINAL_CLOSE_CODES.spawnFailed,
                `PTY spawn failed: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`,
              );
              return;
            }
            bridge.attach(handle);
          } catch (error) {
            const code =
              error instanceof ManagerError && error.code === "session_not_found"
                ? TERMINAL_CLOSE_CODES.notFound
                : TERMINAL_CLOSE_CODES.attachRejected;
            bridge.fail(code, error instanceof Error ? error.message : String(error));
          }
        })();
      });
    },
    close() {
      wss.close();
    },
  };
}
