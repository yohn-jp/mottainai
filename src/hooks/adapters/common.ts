import type { HookAdapterContext, HookAdapterFailure, HookAdapterSuccess } from "./types.js";
import type { HookClient, HookEvent, HookOperation, HookTarget } from "../types.js";
import { HOOK_CONTRACT_VERSION } from "../types.js";

const MAX_VALUE_LENGTH = 160;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate only the structure Mottainai must edit; unknown top-level fields survive unchanged. */
export function supportsHookDocument(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.hooks === undefined) return true;
  if (!isRecord(value.hooks)) return false;
  return Object.values(value.hooks).every((groups) => {
    if (!Array.isArray(groups)) return false;
    return groups.every((group) => {
      // Preserve client-defined event entries that this adapter does not own.
      if (!isRecord(group)) return true;
      // Preserve unknown hook entries verbatim. Client upgrades may add
      // structured forms that this adapter does not own.
      return group.hooks === undefined || Array.isArray(group.hooks);
    });
  });
}

export function boundedValue(value: unknown, maximum = MAX_VALUE_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function eventName(raw: Record<string, unknown>): string | undefined {
  return boundedValue(raw.hook_event_name ?? raw.hookEventName ?? raw.event_name ?? raw.event);
}

function toolName(raw: Record<string, unknown>): string | undefined {
  return boundedValue(raw.tool_name ?? raw.toolName ?? raw.tool ?? raw.name, 80);
}

function toolInput(raw: Record<string, unknown>): Record<string, unknown> {
  const input = raw.tool_input ?? raw.toolInput ?? raw.input;
  return isRecord(input) ? input : {};
}

export function operationForTool(value: string | undefined): HookOperation {
  switch (value) {
    case "Read":
    case "read_file":
    case "read_file_tool":
    case "readFile":
      return "source.read";
    case "Glob":
    case "Grep":
    case "Search":
    case "grep":
    case "search":
    case "file_search":
      return "source.search";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "ApplyPatch":
    case "apply_patch":
    case "write_file":
      return "source.write";
    case "Bash":
    case "Shell":
    case "shell":
    case "shell_command":
    case "exec_command":
    case "run_command":
    case "run_shell_command":
    case "unified_exec":
    case "exec":
    case "terminal":
    case "Terminal":
    case "local_shell":
    case "command":
    case "execute":
      // Every native process boundary is governed together. No executable-name matching occurs here.
      return "process.exec";
    case "Git":
    case "git":
    case "git_operation":
    case "git_commit":
      return "git.mutate";
    default:
      // A client can add a native execution-capable tool without updating the
      // adapter first. Treat an unknown PreToolUse tool as the process
      // boundary; it must not silently become the fail-open `other` class.
      return value === undefined ? "other" : "process.exec";
  }
}

function targetFor(operation: HookOperation, input: Record<string, unknown>): HookTarget | undefined {
  if (operation === "process.exec") {
    const command = boundedValue(input.command ?? input.cmd ?? input.shell_command, 160);
    if (command !== undefined) return { kind: "command", value: command };
  }
  const file = boundedValue(input.file_path ?? input.filePath ?? input.path ?? input.filename, 160);
  if (file !== undefined) return { kind: "path", value: file };
  return undefined;
}

export function normalizeClientEvent(
  raw: unknown,
  client: HookClient,
  context: HookAdapterContext,
): HookAdapterSuccess | HookAdapterFailure {
  if (!isRecord(raw)) return { ok: false, reason: "malformed_client_event", detail: "event must be an object" };
  const clientEvent = eventName(raw);
  const tool = toolName(raw);
  if (clientEvent !== "PreToolUse" || tool === undefined) {
    return { ok: false, reason: "malformed_client_event", detail: "PreToolUse event and tool name are required" };
  }
  const operation = operationForTool(tool);
  const input = toolInput(raw);
  const metadata = {
    tool,
    boundary: operation === "process.exec" ? "native-process" : "native-tool",
  } as const;
  const event: HookEvent = {
    version: HOOK_CONTRACT_VERSION,
    client,
    clientEvent,
    operation,
    ...(context.repository === undefined ? {} : { repository: context.repository }),
    ...(context.worktree === undefined ? {} : { worktree: context.worktree }),
    ...(targetFor(operation, input) === undefined ? {} : { target: targetFor(operation, input) }),
    metadata,
  };
  return { ok: true, event };
}
