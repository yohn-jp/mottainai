import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { compactToBudget } from "./compress/budget.js";
import { compressText } from "./compress/index.js";
import { detectCodeLanguage } from "./compress/code.js";
import type { ResolvedGatewayConfig } from "./config.js";
import {
  DEFAULT_READ_GOVERNOR_POLICY,
  decideRead,
  READ_MODES,
  resolveReadGovernorPolicy,
} from "./context-runtime/read-policy.js";
import type { NormalizedReadRequest, ReadDecision } from "./context-runtime/read-policy.js";
import {
  inspectReadFile,
  readAuthorizedFile,
  readSemanticInspectionSource,
  verifyFileContentUnchanged,
} from "./context-runtime/read-adapter.js";
import {
  createIdentityHint,
  createReadProjectionKey,
  createStoredProjectionKey,
  isSensitiveReadPath,
  resolveFileContentIdentity,
} from "./context-runtime/identity.js";
import type { ArtifactIdentityMetadata, FileContentIdentity } from "./context-runtime/identity.js";
import { normalizeChecks, waitUntilChanged } from "./context-runtime/gh-checks.js";
import type { CheckSnapshot, RawCheck } from "./context-runtime/gh-checks.js";
import type { ProcessRegistry } from "./context-runtime/process-registry.js";
import { OUTPUT_SCHEMA, output } from "./envelope.js";
import type { ArtifactStore } from "./retrieve.js";
import { runChild, runProgram } from "./subprocess.js";
import type { RunResult } from "./subprocess.js";
import { compressionRatio, disabledTelemetrySnapshot, retrievalRate } from "./telemetry.js";
import type { TelemetrySink } from "./telemetry.js";
import {
  createRuntimeDiagnostic,
  normalizeDiagnosticPath,
  projectRuntimeUpstreams,
  withRuntimeUpstreams,
} from "./runtime-diagnostic.js";
import type { RuntimeDiagnostic } from "./runtime-diagnostic.js";
import type { UpstreamStatus } from "./upstream.js";
import { createWorkflowHookProvider } from "./workflow/hook-provider.js";
import type { HookEvent } from "./hooks/types.js";

const OMITTED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "target", ".cache", ".venv", "coverage"]);

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const localTools: Tool[] = [
  {
    name: "mottainai_exec",
    description: "Run a shell command in workspace and return compact diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1 },
        targetTokens: { type: "integer", minimum: 128, maximum: 10000 },
        compression: { type: "boolean" },
      },
      required: ["command"],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "mottainai_exec_start",
    description:
      "Start a shell command in workspace without waiting for it to finish; returns an opaque handle for mottainai_exec_await. Use this instead of mottainai_exec for long-running commands so you can await once instead of polling.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        maxOutputBytes: { type: "integer", minimum: 1 },
      },
      required: ["command"],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "mottainai_exec_await",
    description:
      "Block inside this call, up to a bounded runtime-enforced timeout, until a mottainai_exec_start handle reaches a terminal state. Returns terminal result, or an explicit timeout with last-known state — never repeats an unchanged snapshot silently.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1 },
        targetTokens: { type: "integer", minimum: 128, maximum: 10000 },
      },
      required: ["handle"],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "mottainai_read",
    description: "Read a workspace file by auto/outline/symbol view or an explicit bounded raw range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        ifChangedFrom: {
          type: "string",
          description: "Opaque result identity from a prior read; return unchanged when it still matches.",
        },
        mode: { type: "string", enum: ["raw", "outline", "symbols", "auto"], default: "auto" },
      },
      required: ["path"],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_search",
    description: "Search workspace files with literal or regular-expression query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        mode: { type: "string", enum: ["literal", "regex"] },
        contextLines: { type: "integer", minimum: 0, maximum: 20 },
        maxResults: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_list",
    description: "List a workspace directory, omitting generated and cache directories.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, depth: { type: "integer", minimum: 0, maximum: 12 } },
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_result_get",
    description: "Get a bounded section of a stored raw result.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        stream: { type: "string", enum: ["combined", "stdout", "stderr"] },
        query: { type: "string" },
        contextLines: { type: "integer", minimum: 0, maximum: 20 },
        startLine: { type: "integer", minimum: 0 },
        maxLines: { type: "integer", minimum: 1, maximum: 80 },
      },
      required: ["id"],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_result_search",
    description: "Search compact metadata and raw text from results in this MCP session.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, maxResults: { type: "integer", minimum: 1, maximum: 100 } },
      required: ["query"],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_runtime_status",
    description: "Report gateway runtime state and per-upstream provider health.",
    inputSchema: { type: "object", properties: { provider: { type: "string" } } },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_telemetry_summary",
    description:
      "Report aggregate local usage telemetry: call counts, compression ratio and artifact retrieval rate by provider and capability. Disabled unless MOTTAINAI_TELEMETRY=1.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
];

const issueViewTool: Tool = {
  name: "mottainai_issue_view",
  description: "Fetch one GitHub issue's number, title, state, labels, url, and body via gh CLI.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", minimum: 1 },
    },
    required: ["number"],
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
};

const ghChecksAwaitTool: Tool = {
  name: "mottainai_gh_checks_await",
  description:
    "Wait inside this call, up to a bounded runtime-enforced timeout, until a GitHub pull request's CI checks reach a terminal state or a meaningful state change. Returns a semantic delta (changed checks only), not a repeated full snapshot — replaces repeated gh pr checks polling with one call.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", minimum: 1 },
      timeoutMs: { type: "integer", minimum: 1 },
    },
    required: ["number"],
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
};

/** `worktree` 未設定のワークスペースでは GitHub 連携ツールを非公開にする。 */
export function localToolsFor(config: ResolvedGatewayConfig): Tool[] {
  return config.worktree === undefined ? localTools : [...localTools, issueViewTool, ghChecksAwaitTool];
}

/** risk annotation 参照専用。gatewayConfig を持たない箇所でも定義を引けるよう、条件付き公開ツールも含む全量。 */
export const allLocalTools: Tool[] = [...localTools, issueViewTool, ghChecksAwaitTool];

type Args = Record<string, unknown> | undefined;

/** `mottainai_runtime_status` が読む provider 状態。registry 実体への依存を型だけに留める。 */
export interface RuntimeStatusSource {
  status(): UpstreamStatus[];
}

export async function callLocalTool(
  name: string,
  args: Args,
  config: ResolvedGatewayConfig,
  store: ArtifactStore,
  runtime?: RuntimeStatusSource,
  telemetry?: TelemetrySink,
  processes?: ProcessRegistry,
  signal?: AbortSignal,
  runtimeDiagnostic?: RuntimeDiagnostic,
): Promise<CallToolResult> {
  switch (name) {
    case "mottainai_exec":
      return execTool(args, config, store);
    case "mottainai_exec_start":
      return execStartTool(args, config, requireProcesses(processes));
    case "mottainai_exec_await":
      return execAwaitTool(args, config, store, requireProcesses(processes), telemetry, signal);
    case "mottainai_read":
      return readTool(args, config, store, telemetry);
    case "mottainai_search":
      return searchTool(args, config, store);
    case "mottainai_list":
      return listTool(args, config, store);
    case "mottainai_result_get":
      return resultGetTool(args, store, telemetry);
    case "mottainai_result_search":
      return resultSearchTool(args, store, telemetry);
    case "mottainai_runtime_status":
      return runtimeStatusTool(args, config, runtime, runtimeDiagnostic);
    case "mottainai_telemetry_summary":
      return telemetrySummaryTool(telemetry);
    case "mottainai_issue_view":
      return issueViewToolImpl(args, config);
    case "mottainai_gh_checks_await":
      return ghChecksAwaitToolImpl(args, config, telemetry, signal);
    default:
      throw new Error(`Unknown local tool: ${name}`);
  }
}

function requireProcesses(processes: ProcessRegistry | undefined): ProcessRegistry {
  if (processes === undefined)
    throw new Error("mottainai_exec_start/await require a connection-scoped process registry");
  return processes;
}

function runtimeStatusTool(
  args: Args,
  config: ResolvedGatewayConfig,
  runtime?: RuntimeStatusSource,
  runtimeDiagnostic?: RuntimeDiagnostic,
): CallToolResult {
  const requested = stringArg(args, "provider");
  const all = runtime?.status() ?? [];
  if (requested !== undefined && !all.some((provider) => provider.name === requested)) {
    throw new Error(`unknown upstream: ${requested}`);
  }
  const providers = requested === undefined ? all : all.filter((provider) => provider.name === requested);
  const unhealthy = providers.filter((provider) => provider.state === "unhealthy");
  const projected = projectRuntimeUpstreams(providers);
  const diagnostics = projected
    .filter((provider) => provider.health === "unhealthy")
    .map((provider) => ({
      severity: "error",
      message: `${provider.name} unhealthy: ${provider.failure?.summary ?? "startup failed"}`,
    }));
  const counts = providers.reduce<Record<string, number>>((totals, provider) => {
    totals[provider.state] = (totals[provider.state] ?? 0) + 1;
    return totals;
  }, {});
  const status = unhealthy.length === 0 ? "success" : "partial";
  const summary = `providers=${providers.length} ${Object.entries(counts)
    .map(([state, count]) => `${state}=${count}`)
    .join(" ")}`.trimEnd();
  const identityBase = runtimeDiagnostic ?? {
    ...createRuntimeDiagnostic({ cwd: config.workspaceRoot, entryPoint: "unknown", environment: {} }),
    workspace_root: normalizeDiagnosticPath(config.workspaceRoot),
    state_directory: normalizeDiagnosticPath(path.join(config.workspaceRoot, ".mottainai")),
  };
  const identity = withRuntimeUpstreams(identityBase, providers);
  return output("runtime_status", status, summary, "", {
    facts: projected,
    diagnostics,
    metrics: {
      providers: providers.length,
      ready: counts.ready ?? 0,
      unhealthy: unhealthy.length,
      disabled: counts.disabled ?? 0,
    },
    workspace_root: identity.workspace_root ?? normalizeDiagnosticPath(config.workspaceRoot),
    identity,
  });
}

function value(args: Args, key: string): unknown {
  return args?.[key];
}
function stringArg(args: Args, key: string, required = false): string | undefined {
  const candidate = value(args, key);
  if (candidate === undefined && !required) return undefined;
  if (typeof candidate !== "string" || (required && candidate.length === 0))
    throw new Error(`${key} must be a non-empty string`);
  return candidate;
}
function numberArg(args: Args, key: string): number | undefined {
  const candidate = value(args, key);
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) throw new Error(`${key} must be an integer`);
  return candidate;
}

export async function resolveInside(root: string, requested?: string): Promise<string> {
  const rootReal = await fs.realpath(root);
  const candidate = path.resolve(rootReal, requested ?? ".");
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${path.sep}`))
    throw new Error("path must stay inside workspaceRoot");
  const resolved = await fs.realpath(candidate);
  if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`))
    throw new Error("path resolves outside workspaceRoot");
  return resolved;
}

async function execTool(args: Args, config: ResolvedGatewayConfig, store: ArtifactStore): Promise<CallToolResult> {
  const command = stringArg(args, "command", true)!;
  const cwd = await resolveInside(config.workspaceRoot, stringArg(args, "cwd"));
  const denied = await managedWriteGate(command, cwd, config);
  if (denied !== undefined) return denied;
  const requestedTimeout = numberArg(args, "timeoutMs") ?? config.defaultTimeoutMs;
  if (requestedTimeout < 1) throw new Error("timeoutMs must be positive");
  const timeoutMs = Math.min(requestedTimeout, config.maxTimeoutMs);
  const targetTokens = numberArg(args, "targetTokens") ?? config.execTargetTokens;
  if (targetTokens < 128 || targetTokens > 10_000) throw new Error("targetTokens must be between 128 and 10000");
  const started = performance.now();
  const run = await runShell(command, cwd, timeoutMs, config.maxOutputBytes);
  const durationMs = Math.round(performance.now() - started);
  const preserveRaw = value(args, "compression") === false;
  return buildExecOutput(run, command, cwd, config.workspaceRoot, durationMs, targetTokens, preserveRaw, store);
}

async function execStartTool(
  args: Args,
  config: ResolvedGatewayConfig,
  processes: ProcessRegistry,
): Promise<CallToolResult> {
  const command = stringArg(args, "command", true)!;
  const cwd = await resolveInside(config.workspaceRoot, stringArg(args, "cwd"));
  const denied = await managedWriteGate(command, cwd, config);
  if (denied !== undefined) return denied;
  const requestedMaxOutputBytes = numberArg(args, "maxOutputBytes");
  const maxOutputBytes =
    requestedMaxOutputBytes === undefined
      ? config.maxOutputBytes
      : Math.min(requestedMaxOutputBytes, config.maxOutputBytes);
  if (maxOutputBytes < 1) throw new Error("maxOutputBytes must be positive");
  const started = processes.start(command, cwd, maxOutputBytes, true);
  const summary = `started handle=${started.handle}${started.pid === undefined ? "" : ` pid=${started.pid}`}`;
  return output("exec_start", "success", summary, "", {
    handle: started.handle,
    ...(started.pid === undefined ? {} : { pid: started.pid }),
    next_command: `mottainai_exec_await handle=${started.handle}`,
  });
}

/**
 * `mottainai_exec` is the gateway's managed write-capable command surface.  The
 * workflow provider is consulted before spawning it; the provider, rather than
 * this adapter, owns repository identity, current worktree/branch, and policy
 * decisions.  Git commands get their operation-specific decision first; other
 * commands are treated as source writes because an arbitrary shell command can
 * edit files and cannot be safely classified here.
 */
async function managedWriteGate(
  command: string,
  cwd: string,
  config: ResolvedGatewayConfig,
): Promise<CallToolResult | undefined> {
  if (!config.workflowTasks) return undefined;
  const provider = createWorkflowHookProvider({ workspaceRoot: cwd });
  const event = (operation: HookEvent["operation"]): HookEvent => ({
    version: 1,
    client: "codex",
    clientEvent: "MottainaiExec",
    operation,
    target: { kind: "command", value: command },
  });
  const gitDecision = await provider.evaluate(event("git.mutate"));
  const decision =
    gitDecision.state === "not_applicable" ? await provider.evaluate(event("source.write")) : gitDecision;
  if (decision.state === "unavailable" || decision.state === "unsupported" || decision.state === "stale") {
    return output(
      "exec",
      "failed",
      `DENY exec: workflow authority unavailable (${decision.reason})`,
      "",
      {
        diagnostics: [{ severity: "error", message: decision.diagnostic ?? decision.reason }],
        policy_action: "deny",
        policy_rule: decision.rule,
      },
      true,
    );
  }
  if (decision.action === "deny") {
    return output(
      "exec",
      "failed",
      `DENY exec: workflow policy (${decision.reason})`,
      "",
      {
        diagnostics: [{ severity: "error", message: decision.diagnostic ?? decision.reason }],
        policy_action: decision.action,
        policy_rule: decision.rule,
      },
      true,
    );
  }
  return undefined;
}

async function execAwaitTool(
  args: Args,
  config: ResolvedGatewayConfig,
  store: ArtifactStore,
  processes: ProcessRegistry,
  telemetry?: TelemetrySink,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const handle = stringArg(args, "handle", true)!;
  const requestedTimeout = numberArg(args, "timeoutMs");
  if (requestedTimeout !== undefined && requestedTimeout < 1) throw new Error("timeoutMs must be positive");
  const timeoutMs = Math.min(requestedTimeout ?? config.await.maxAwaitMs, config.await.maxAwaitMs);
  const targetTokens = numberArg(args, "targetTokens") ?? config.execTargetTokens;
  if (targetTokens < 128 || targetTokens > 10_000) throw new Error("targetTokens must be between 128 and 10000");

  const describe = processes.describe(handle);
  if (describe === undefined) throw new Error(`invalid or unknown exec handle: ${handle}`);

  const started = performance.now();
  const outcome = await processes.awaitHandle(handle, timeoutMs, signal);
  const elapsedMs = Math.round(performance.now() - started);
  if (outcome === undefined) throw new Error(`invalid or unknown exec handle: ${handle}`);

  telemetry?.recordAwait({
    pollCount: 0,
    elapsedMs,
    stateChanges: outcome.kind === "terminal" ? 1 : 0,
    avoidedResponses: 0,
    outcome: outcome.kind,
  });

  if (outcome.kind === "terminal") {
    processes.release(handle);
    return buildExecOutput(
      outcome.result,
      describe.command,
      describe.cwd,
      config.workspaceRoot,
      elapsedMs,
      targetTokens,
      false,
      store,
    );
  }

  const summary =
    outcome.kind === "timeout"
      ? `TIMEOUT handle=${handle} elapsed=${outcome.elapsedMs}ms still running`
      : `CANCELLED handle=${handle} elapsed=${outcome.elapsedMs}ms`;
  return output("exec_await", "partial", summary, "", {
    handle,
    elapsed_ms: outcome.elapsedMs,
    timeout_ms: timeoutMs,
    state: outcome.kind === "timeout" ? "running" : "cancelled",
    next_command: outcome.kind === "timeout" ? `mottainai_exec_await handle=${handle}` : undefined,
    truncated: false,
  });
}

/** `runShell`/`ManagedProcess` の `RunResult` を exec envelope へ変換する。同期 exec と await 経路が共有する。 */
async function buildExecOutput(
  run: RunResult,
  command: string,
  cwd: string,
  workspaceRoot: string,
  durationMs: number,
  targetTokens: number,
  preserveRawArg: boolean,
  store: ArtifactStore,
): Promise<CallToolResult> {
  const raw = [run.stdout, run.stderr].filter(Boolean).join(run.stdout && run.stderr ? "\n" : "");
  const status = run.exitCode === 0 && !run.timedOut && !run.outputLimit ? "success" : "failed";
  const failure = status === "failed" ? await diagnoseExecFailure(run, raw, cwd, workspaceRoot) : undefined;
  const failureClassification = failure?.classification ?? "command";
  const firstCause = failure?.firstCause ?? (firstLine(run.stderr || raw) || "command failed");
  // 競合markerはパッチ根拠。通常出力の圧縮対象にしない。
  const preserveRaw = preserveRawArg || failureClassification === "git_conflict";
  const compressed = preserveRaw
    ? raw
    : compactToBudget(compressText(raw, { cli: { command } }), targetTokens, Buffer.byteLength(raw));
  const summary =
    status === "success"
      ? `OK exit=0 duration=${durationMs}ms${run.outputLimit ? " output_limit" : ""}`
      : `FAIL ${failureClassification}: ${firstCause} exit=${run.exitCode ?? "signal"} duration=${durationMs}ms${run.timedOut ? " timeout" : ""}${run.outputLimit ? " output_limit" : ""}`;
  const diagnostics = status === "failed" ? [{ severity: "error", message: firstCause }] : [];
  const resultId = store.putArtifact({
    text: raw,
    stdout: run.stdout,
    stderr: run.stderr,
    metadata: { operation: "exec", command, cwd, summary, diagnostics },
  });
  const truncated = run.outputLimit || compressed !== raw;
  const testResults = tapTestResults(raw, resultId, truncated);
  return output(
    "exec",
    status,
    summary,
    resultId,
    {
      facts: failure?.facts ?? [],
      failure_classification: status === "failed" ? failureClassification : undefined,
      next_command:
        status === "failed"
          ? nextCommand(resultId, failure ?? { classification: "command", firstCause, facts: [] })
          : undefined,
      diagnostics,
      metrics: {
        duration_ms: durationMs,
        stdout_bytes: Buffer.byteLength(run.stdout),
        stderr_bytes: Buffer.byteLength(run.stderr),
        returned_bytes: Buffer.byteLength(compressed),
        target_tokens: targetTokens,
      },
      exit_code: run.exitCode,
      signal: run.signal,
      timed_out: run.timedOut,
      output_limited: run.outputLimit,
      output: compressed,
      truncated,
      ...(testResults === undefined ? {} : { test_results: testResults }),
    },
    status === "failed",
  );
}

interface TapTestFailure {
  name: string;
  diagnostic: string;
}

interface TapTestResults {
  format: "tap";
  total?: number;
  pass?: number;
  fail?: number;
  cancelled?: number;
  skipped?: number;
  todo?: number;
  failures: TapTestFailure[];
  output_omitted: boolean;
  result_id: string;
}

/** TAP の result line（`ok N ...` / `not ok N ...`）。次のfailureのblockとの境界を判定するのに使う。 */
const TAP_RESULT_LINE = /^(?:not )?ok \d+\b/;

/** TAP footer と not ok block は機械的に読める。圧縮前の原文から最小失敗情報を残す。 */
function tapTestResults(raw: string, resultId: string, outputOmitted: boolean): TapTestResults | undefined {
  const lines = raw.split("\n");
  const counters: Partial<Record<"total" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>> = {};
  for (const line of lines) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line.trim());
    if (match === null) continue;
    const key = match[1] === "tests" ? "total" : (match[1] as keyof typeof counters);
    counters[key] = Number(match[2]);
  }
  const failures: TapTestFailure[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^not ok \d+ - (.+?)(?: # .*)?$/.exec(lines[index].trim());
    if (match === null) continue;
    // 自分のblock（次の ok/not ok result lineの手前まで）だけを診断情報の探索範囲にする。
    // 診断の無いfailureが後続failureの診断を誤って引き継がないように。
    let diagnostic = "test failed";
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (TAP_RESULT_LINE.test(lines[cursor].trim())) break;
      const diagnosticMatch = /^\s*(?:error|message):\s*(.*)$/.exec(lines[cursor]);
      if (diagnosticMatch !== null) {
        diagnostic = diagnosticMatch[1].trim();
        break;
      }
    }
    failures.push({ name: match[1], diagnostic: diagnostic.replace(/^['"]|['"]$/g, "") });
  }
  if (Object.keys(counters).length === 0 && failures.length === 0) return undefined;
  return { format: "tap", ...counters, failures, output_omitted: outputOmitted, result_id: resultId };
}

interface ExecFailure {
  classification:
    | "timeout"
    | "output_limit"
    | "git_conflict"
    | "missing_build_artifact"
    | "typescript"
    | "spawn"
    | "command";
  firstCause: string;
  facts: Array<Record<string, unknown>>;
  query?: string;
  recoveryCommands?: string[];
}

async function diagnoseExecFailure(
  run: RunResult,
  raw: string,
  cwd: string,
  workspaceRoot: string,
): Promise<ExecFailure> {
  if (run.timedOut) return { classification: "timeout", firstCause: "command timed out", facts: [], query: "timeout" };
  if (run.outputLimit)
    return {
      classification: "output_limit",
      firstCause: "output limit reached",
      facts: [],
      query: "mottainai omitted",
    };
  const conflict = gitConflictFacts(raw);
  if (conflict.length > 0)
    return { classification: "git_conflict", firstCause: firstLine(raw), facts: conflict, query: "<<<<<<<" };
  const missingArtifacts = await missingDistArtifacts(raw, cwd, workspaceRoot);
  if (missingArtifacts.length > 0) {
    const recoveryCommands = await buildRecoveryCommands(workspaceRoot);
    return {
      classification: "missing_build_artifact",
      firstCause: `missing ${missingArtifacts[0]}`,
      facts: [
        { kind: "missing_build_artifacts", paths: missingArtifacts },
        { kind: "recovery_commands", commands: recoveryCommands },
      ],
      query: missingArtifacts[0],
      recoveryCommands,
    };
  }
  const typeScript = raw.split("\n").find((line) => /\berror TS\d+:/.test(line));
  if (typeScript) return { classification: "typescript", firstCause: typeScript, facts: [], query: "error TS" };
  if (run.spawnError) return { classification: "spawn", firstCause: run.spawnError, facts: [], query: run.spawnError };
  return { classification: "command", firstCause: firstFailureCause(run.stderr || raw), facts: [], query: undefined };
}

function gitConflictFacts(raw: string): Array<Record<string, unknown>> {
  const paths = [...raw.matchAll(/(?:CONFLICT \([^)]*\): Merge conflict in |both modified:\s*)(.+)/g)].map((match) =>
    match[1].trim(),
  );
  const markerCount = raw.split("\n").filter((line) => /^(?:<{7}|={7}|>{7})/.test(line)).length;
  if (paths.length === 0 && markerCount === 0) return [];
  return [
    ...(paths.length > 0 ? [{ kind: "unresolved_paths", paths: [...new Set(paths)] }] : []),
    ...(markerCount > 0 ? [{ kind: "conflict_markers", count: markerCount }] : []),
    { kind: "raw_artifact", retention: "full until output limit or artifact expiry" },
  ];
}

async function missingDistArtifacts(raw: string, cwd: string, workspaceRoot: string): Promise<string[]> {
  const candidates = [
    ...raw.matchAll(
      /(?:Cannot find module|ERR_MODULE_NOT_FOUND|not found)[:\s]+['"]?((?:[^'"\s]*[\\/])?dist[\\/][^'"\s]+)/gi,
    ),
  ].map((match) => match[1].replace(/^file:\/\//, ""));
  const missing: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(cwd, candidate);
    if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) continue;
    try {
      await fs.access(resolved);
    } catch {
      missing.push(path.relative(workspaceRoot, resolved) || ".");
    }
  }
  return [...new Set(missing)];
}

async function buildRecoveryCommands(workspaceRoot: string): Promise<string[]> {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (!packageJson.scripts?.build) return [];
    const commands: string[] = [];
    try {
      await fs.access(path.join(workspaceRoot, "node_modules"));
    } catch {
      commands.push("pnpm install --frozen-lockfile");
    }
    commands.push("pnpm run build");
    return commands;
  } catch {
    return [];
  }
}

function nextCommand(resultId: string, failure: ExecFailure | undefined): string {
  if (failure?.recoveryCommands?.length) return failure.recoveryCommands[0];
  const query = failure?.query;
  return query
    ? `mottainai_result_get id=${resultId} query=${JSON.stringify(query)}`
    : `mottainai_result_get id=${resultId}`;
}

function boundedReadMessage(decision: ReadDecision): string {
  return decision.reason.length > 256 ? `${decision.reason.slice(0, 253)}...` : decision.reason;
}

const SEMANTIC_OMISSION_MARKER = "… semantic projection omitted …";

function isSemanticMode(mode: NormalizedReadRequest["mode"]): boolean {
  return mode === "outline" || mode === "symbols";
}

/** semantic factsの先頭・末尾を残し、後段の#71 budget前にも公開量をboundedにする。 */
function boundedSemanticView(text: string, maxLines: number, maxBytes: number): string {
  const byteLimit = Math.max(1, maxBytes);
  const lines = text.split("\n");
  const lineLimit = Math.min(Math.max(1, maxLines), lines.length);
  if (lines.length <= lineLimit && Buffer.byteLength(text, "utf8") <= byteLimit) return text;

  let head = Math.floor((lineLimit - 1) / 2);
  let tail = Math.ceil((lineLimit - 1) / 2);
  while (head > 0 || tail > 0) {
    const tailStart = Math.max(head, lines.length - tail);
    const candidate = [...lines.slice(0, head), SEMANTIC_OMISSION_MARKER, ...lines.slice(tailStart)].join("\n");
    if (Buffer.byteLength(candidate, "utf8") <= byteLimit) return candidate;
    if (head >= tail && head > 0) head -= 1;
    else if (tail > 0) tail -= 1;
  }

  return trimIncompleteUtf8(Buffer.from(SEMANTIC_OMISSION_MARKER).subarray(0, byteLimit)).toString("utf8");
}

function readReasonCategory(decision: ReadDecision, extractionFailure = false): string {
  if (extractionFailure) return "extraction_failure";
  if (decision.policyRule === "NONE") return "within_policy";
  if (decision.policyRule === "AUTO_BOUNDED_REPRESENTATION") return "semantic_projection";
  if (decision.policyRule === "BOUNDED_RANGE") return "bounded_range";
  if (decision.policyRule.includes("BYTE")) return "byte_limit";
  if (decision.policyRule.includes("LINE")) return "line_limit";
  if (
    decision.policyRule.includes("BOUNDARY") ||
    decision.policyRule.includes("RANGE") ||
    decision.policyRule === "INVALID_FILE_METADATA"
  )
    return "boundary";
  return "policy";
}

async function readTool(
  args: Args,
  config: ResolvedGatewayConfig,
  store: ArtifactStore,
  telemetry?: TelemetrySink,
): Promise<CallToolResult> {
  const requestedPath = stringArg(args, "path", true)!;
  const filePath = await resolveInside(config.workspaceRoot, requestedPath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("path must be a file");

  const modeValue = stringArg(args, "mode");
  if (modeValue !== undefined && !(READ_MODES as readonly string[]).includes(modeValue))
    throw new Error("invalid mode");
  const ifChangedFrom = stringArg(args, "ifChangedFrom");
  if (ifChangedFrom !== undefined && (ifChangedFrom.length === 0 || ifChangedFrom.length > 512)) {
    throw new Error("ifChangedFrom must be a non-empty identity up to 512 characters");
  }
  const request = {
    path: path.relative(config.workspaceRoot, filePath),
    ...(modeValue === undefined ? {} : { mode: modeValue as (typeof READ_MODES)[number] }),
    ...(numberArg(args, "startLine") === undefined ? {} : { startLine: numberArg(args, "startLine") }),
    ...(numberArg(args, "endLine") === undefined ? {} : { endLine: numberArg(args, "endLine") }),
  };
  const metadata = await inspectReadFile(filePath);
  const readGovernor = resolveReadGovernorPolicy(config.readGovernor ?? DEFAULT_READ_GOVERNOR_POLICY);
  const decision = decideRead(request, metadata, readGovernor);
  const relativePath = request.path || ".";
  const normalized = decision.normalizedRequest;
  const identitySafe = !isSensitiveReadPath(relativePath);
  const contentIdentity = identitySafe
    ? await resolveFileContentIdentity(filePath, config.workspaceRoot, metadata.contentHash)
    : undefined;
  const artifactIdentity: FileContentIdentity | undefined =
    contentIdentity === undefined
      ? undefined
      : {
          version: contentIdentity.version,
          content_id: contentIdentity.id,
          adapter: "local_file_read_v1",
          source_key: `file:${relativePath}`,
        };

  if (!decision.allowed) {
    telemetry?.recordReadGovernor({
      action: decision.action,
      requestedMode: decision.requestedMode,
      rawLinesReturned: 0,
      rawBytesReturned: 0,
      policyRule: decision.policyRule,
      reasonCategory: readReasonCategory(decision),
    });
    const summary = `DENY ${relativePath} mode=${decision.requestedMode} rule=${decision.policyRule}`;
    return output("read", "partial", summary, "", {
      path: relativePath,
      mode: decision.requestedMode,
      requested_mode: decision.requestedMode,
      file_line_count: metadata.lineCount,
      file_bytes: metadata.byteSize,
      policy: decision.policy,
      policy_action: decision.action,
      policy_rule: decision.policyRule,
      policy_reason: boundedReadMessage(decision),
      next_actions: decision.suggestedNextActions,
      facts: [{ kind: "read_governor", action: decision.action, rule: decision.policyRule }],
      diagnostics: decision.diagnostics,
      metrics: {
        raw_lines_returned: 0,
        raw_bytes_returned: 0,
        file_lines: metadata.lineCount,
        file_bytes: metadata.byteSize,
      },
      truncated: true,
    });
  }

  const selected = await readAuthorizedFile(filePath, metadata, normalized);
  const semanticSource =
    isSemanticMode(normalized.mode) && normalized.bounded
      ? await readSemanticInspectionSource(filePath, normalized)
      : selected;
  // hash 計算 bytes と実際に返す bytes を束縛する TOCTOU 窓を閉じる: read 後に
  // content hash を再計算し、一致しなければ identity が古い hash に新しい bytes を
  // 紐付けてしまうので fail-closed に identity を破棄する（読み取り結果自体は
  // 正常に返す）。mtime/size/inode は same-size 上書き + mtime 巻き戻しですり抜け
  // 得るため使わない — content hash の再計算のみを correctness authority とする。
  const contentStillValid = await verifyFileContentUnchanged(filePath, { contentHash: metadata.contentHash });
  const verifiedArtifactIdentity = contentStillValid ? artifactIdentity : undefined;
  const rawLines =
    normalized.startLine === undefined || normalized.endLine === undefined
      ? metadata.lineCount
      : normalized.endLine - normalized.startLine + 1;
  const rawLinesReturned = normalized.mode === "raw" ? rawLines : 0;
  const rawBytesReturned = normalized.mode === "raw" ? Buffer.byteLength(selected) : 0;
  let text: string | undefined;
  let extractionFailure = false;
  let semanticProjectionTruncated = false;
  if (normalized.mode === "raw") {
    text = selected;
  } else {
    try {
      const extracted = codeView(semanticSource, normalized.mode, filePath);
      extractionFailure = semanticSource.length > 0 && extracted.trim().length === 0;
      if (!extractionFailure) {
        text = boundedSemanticView(extracted, readGovernor.maxRawLines, readGovernor.maxRawBytes);
        semanticProjectionTruncated = text !== extracted;
      }
    } catch {
      extractionFailure = true;
    }
  }

  const diagnostics = extractionFailure
    ? [
        ...decision.diagnostics,
        {
          severity: "warning" as const,
          code: "READ_VIEW_EXTRACTION_FAILED",
          message: `${normalized.mode} extraction failed; source was not returned`,
        },
      ]
    : decision.diagnostics;
  const readProjectionKey = createReadProjectionKey({
    mode: normalized.mode,
    ...(normalized.startLine === undefined ? {} : { startLine: normalized.startLine }),
    ...(normalized.endLine === undefined ? {} : { endLine: normalized.endLine }),
    policy: readGovernor,
    policyRule: decision.policyRule,
    policyReason: decision.reason,
    diagnostics,
    extractionFailure,
  });
  const storedArtifactIdentity: ArtifactIdentityMetadata | undefined =
    verifiedArtifactIdentity === undefined
      ? undefined
      : { ...verifiedArtifactIdentity, origin_projection_key: readProjectionKey };
  const sourceResultId = store.putArtifact({
    text: selected,
    metadata: {
      operation: "read",
      summary: relativePath,
      cwd: filePath,
      ...(storedArtifactIdentity === undefined ? {} : { identity: storedArtifactIdentity }),
    },
  });
  const truncated =
    extractionFailure ||
    semanticProjectionTruncated ||
    (normalized.startLine !== undefined && (normalized.startLine > 1 || normalized.endLine !== metadata.lineCount));
  const summary = `${relativePath} lines=${rawLines}/${metadata.lineCount} mode=${normalized.mode}`;
  const identity =
    verifiedArtifactIdentity === undefined
      ? undefined
      : createIdentityHint({
          content_id: verifiedArtifactIdentity.content_id,
          adapter: "local_file_read_v1",
          source_key: verifiedArtifactIdentity.source_key,
          projection_key: readProjectionKey,
          ...(ifChangedFrom === undefined ? {} : { if_changed_from: ifChangedFrom }),
        });
  telemetry?.recordReadGovernor({
    action: decision.action,
    requestedMode: decision.requestedMode,
    rawLinesReturned,
    rawBytesReturned,
    policyRule: decision.policyRule,
    reasonCategory: readReasonCategory(decision, extractionFailure),
  });
  return output("read", extractionFailure ? "partial" : "success", summary, sourceResultId, {
    path: relativePath,
    mode: normalized.mode,
    requested_mode: decision.requestedMode,
    ...(extractionFailure ? {} : { text }),
    file_line_count: metadata.lineCount,
    file_bytes: metadata.byteSize,
    policy: decision.policy,
    policy_action: decision.action,
    policy_rule: decision.policyRule,
    policy_reason: boundedReadMessage(decision),
    next_actions: decision.suggestedNextActions,
    facts: [{ kind: "read_governor", action: decision.action, rule: decision.policyRule }],
    diagnostics,
    metrics: {
      raw_lines_returned: rawLinesReturned,
      raw_bytes_returned: rawBytesReturned,
      file_lines: metadata.lineCount,
      file_bytes: metadata.byteSize,
    },
    truncated,
    ...(identity === undefined ? {} : { identity }),
  });
}

async function searchTool(args: Args, config: ResolvedGatewayConfig, store: ArtifactStore): Promise<CallToolResult> {
  const query = stringArg(args, "query", true)!;
  const searchPath = await resolveInside(config.workspaceRoot, stringArg(args, "path"));
  const mode = stringArg(args, "mode") ?? "literal";
  if (mode !== "literal" && mode !== "regex") throw new Error("mode must be literal or regex");
  const context = numberArg(args, "contextLines") ?? 0;
  const maxResults = numberArg(args, "maxResults") ?? 30;
  if (context < 0 || context > 20) throw new Error("contextLines must be between 0 and 20");
  if (maxResults < 1 || maxResults > 100) throw new Error("maxResults must be between 1 and 100");
  const rgArgs = ["--json", "--line-number", "--no-heading", "--max-count", String(maxResults)];
  if (mode === "literal") rgArgs.push("--fixed-strings");
  if (context > 0) rgArgs.push("--context", String(context));
  rgArgs.push("--glob", "!.git", "--glob", "!node_modules", "--glob", "!dist", query, searchPath);
  const run = await runProgram("rg", rgArgs, config.workspaceRoot, config.maxTimeoutMs, config.maxOutputBytes);
  if (run.spawnError) throw new Error(`rg unavailable: ${run.spawnError}`);
  const { groups, omitted } = truncateGroups(parseRgJson(run.stdout, config.workspaceRoot, context), maxResults);
  const matchCount = groups.reduce((count, group) => count + group.matches.length, 0);
  const summary = `${matchCount} matches in ${groups.length} files${omitted > 0 ? ` (truncated, omitted=${omitted})` : ""}`;
  const resultId = store.putArtifact({
    text: run.stdout,
    stderr: run.stderr,
    metadata: { operation: "search", command: query, cwd: searchPath, summary },
  });
  return output(
    "search",
    run.exitCode === 0 || run.exitCode === 1 ? "success" : "failed",
    summary,
    resultId,
    {
      query,
      mode,
      groups,
      metrics: { raw_bytes: Buffer.byteLength(run.stdout), omitted_matches: omitted },
      truncated: omitted > 0,
    },
    run.exitCode !== 0 && run.exitCode !== 1,
  );
}

// --max-countはファイル単位上限。ここでparse後にグローバル件数で打ち切る（issue #5）。
function truncateGroups(
  groups: Array<{ path: string; matches: RgMatch[] }>,
  maxResults: number,
): { groups: Array<{ path: string; matches: RgMatch[] }>; omitted: number } {
  const limited: Array<{ path: string; matches: RgMatch[] }> = [];
  let used = 0;
  let omitted = 0;
  for (const group of groups) {
    const remaining = maxResults - used;
    if (remaining <= 0) {
      omitted += group.matches.length;
      continue;
    }
    if (group.matches.length <= remaining) {
      limited.push(group);
      used += group.matches.length;
    } else {
      limited.push({ path: group.path, matches: group.matches.slice(0, remaining) });
      used += remaining;
      omitted += group.matches.length - remaining;
    }
  }
  return { groups: limited, omitted };
}

async function listTool(args: Args, config: ResolvedGatewayConfig, store: ArtifactStore): Promise<CallToolResult> {
  const directory = await resolveInside(config.workspaceRoot, stringArg(args, "path"));
  const depth = numberArg(args, "depth") ?? 3;
  if (depth < 0 || depth > 12) throw new Error("depth must be between 0 and 12");
  const entries: string[] = [];
  await walk(directory, directory, depth, entries);
  const summary = `${entries.length} entries depth=${depth}`;
  const resultId = store.putArtifact({
    text: entries.join("\n"),
    metadata: { operation: "list", cwd: directory, summary },
  });
  return output("list", "success", summary, resultId, {
    path: path.relative(config.workspaceRoot, directory) || ".",
    entries,
  });
}

function resultGetTool(args: Args, store: ArtifactStore, telemetry?: TelemetrySink): CallToolResult {
  const id = stringArg(args, "id", true)!;
  const stream = stringArg(args, "stream") ?? "combined";
  if (stream !== "combined" && stream !== "stdout" && stream !== "stderr") throw new Error("invalid stream");
  const retrieved = store.retrieve(id, {
    query: stringArg(args, "query"),
    contextLines: numberArg(args, "contextLines"),
    startLine: numberArg(args, "startLine"),
    maxLines: numberArg(args, "maxLines"),
    stream,
  });
  if (!retrieved) throw new Error(`Original result unavailable or expired: ${id}`);
  telemetry?.recordRetrieval();
  const expansionBytes = Buffer.byteLength(JSON.stringify(retrieved), "utf8");
  telemetry?.recordExpansion({ bytes: expansionBytes, estimatedTokens: Math.ceil(expansionBytes / 4) });
  const summary = `result=${id} ${retrieved.returnedStartLine}-${retrieved.returnedEndLine}/${retrieved.totalLines}`;
  const identity =
    retrieved.identity === undefined
      ? undefined
      : createIdentityHint({
          content_id: retrieved.identity.content_id,
          adapter: "stored_artifact_v1",
          source_key: retrieved.identity.source_key,
          projection_key: createStoredProjectionKey({
            stream,
            ...(stringArg(args, "query") === undefined ? {} : { query: stringArg(args, "query") }),
            ...(numberArg(args, "startLine") === undefined ? {} : { startLine: numberArg(args, "startLine") }),
            ...(numberArg(args, "maxLines") === undefined ? {} : { maxLines: numberArg(args, "maxLines") }),
            ...(numberArg(args, "contextLines") === undefined ? {} : { contextLines: numberArg(args, "contextLines") }),
            originProjectionKey: retrieved.identity.origin_projection_key,
          }),
        });
  return output("result_get", "success", summary, id, {
    ...retrieved,
    ...(identity === undefined ? {} : { identity }),
    truncated: retrieved.omittedLines > 0,
  });
}

function resultSearchTool(args: Args, store: ArtifactStore, telemetry?: TelemetrySink): CallToolResult {
  const query = stringArg(args, "query", true)!;
  const results = store.search(query, numberArg(args, "maxResults"));
  telemetry?.recordRetrieval();
  const summary = `${results.length} stored results match`;
  return output("result_search", "success", summary, "", { query, results });
}

function telemetrySummaryTool(telemetry?: TelemetrySink): CallToolResult {
  const snapshot = telemetry?.snapshot() ?? disabledTelemetrySnapshot();
  if (!snapshot.enabled) {
    return output("telemetry_summary", "success", "telemetry disabled; set MOTTAINAI_TELEMETRY=1 to enable", "", {
      enabled: false,
    });
  }
  const ratio = compressionRatio(snapshot.totals);
  const rate = retrievalRate(snapshot.totals);
  const summary =
    `calls=${snapshot.totals.calls} errors=${snapshot.totals.errors}` +
    `${ratio !== undefined ? ` compression_ratio=${ratio.toFixed(3)}` : ""}` +
    `${rate !== undefined ? ` retrieval_rate=${rate.toFixed(3)}` : ""}`;
  return output("telemetry_summary", "success", summary, "", {
    enabled: true,
    facts: [
      ...Object.entries(snapshot.by_provider).map(([provider, counts]) => ({
        kind: "provider",
        name: provider,
        ...counts,
        compression_ratio: compressionRatio(counts),
      })),
      ...Object.entries(snapshot.by_capability).map(([capability, counts]) => ({
        kind: "capability",
        name: capability,
        ...counts,
        compression_ratio: compressionRatio(counts),
      })),
    ],
    totals: snapshot.totals,
    by_provider: snapshot.by_provider,
    by_capability: snapshot.by_capability,
    projection: snapshot.projection,
    read_governor: snapshot.read_governor,
    hooks: snapshot.hooks,
    await: snapshot.await,
    burst: snapshot.burst,
    dedupe: snapshot.dedupe,
    expansion: snapshot.expansion,
    // `projection` is a reserved envelope metadata field; expose the
    // aggregate counter under an unambiguous non-reserved name as well.
    projection_totals: snapshot.projection,
    compression_ratio: ratio,
    retrieval_rate: rate,
    generated_at: snapshot.generated_at,
    metrics: {
      calls: snapshot.totals.calls,
      errors: snapshot.totals.errors,
      retrievals: snapshot.totals.retrievals,
      returned_bytes: snapshot.projection.returned_bytes,
      omitted_bytes: snapshot.projection.omitted_bytes,
      raw_bytes: snapshot.projection.raw_bytes,
      stored_bytes: snapshot.projection.stored_bytes,
      omitted_tokens: snapshot.projection.omitted_tokens,
      projected_tokens: snapshot.projection.projected_tokens,
      expansion_count: snapshot.expansion.count,
      expansion_rate: snapshot.totals.calls > 0 ? snapshot.expansion.count / snapshot.totals.calls : undefined,
      expansion_bytes: snapshot.expansion.bytes,
      expansion_tokens: snapshot.expansion.estimated_tokens,
      await_poll_count: snapshot.await.poll_count,
      await_avoided_responses: snapshot.await.avoided_responses,
      burst_responses_reduced: snapshot.burst.responses_reduced,
      burst_pressure_max: snapshot.burst.pressure_max,
      dedupe_hits: snapshot.dedupe?.hits ?? 0,
      dedupe_misses: snapshot.dedupe?.misses ?? 0,
      dedupe_bytes_avoided: snapshot.dedupe?.bytes_avoided ?? 0,
    },
  });
}

export interface ParsedIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  url: string;
  body: string;
}
export type ParsedIssueResult = { ok: true; issue: ParsedIssue } | { ok: false; reason: string };

/**
 * `gh issue view --json ...` の stdout を解釈する。exit 0 でも非JSONや必須field欠落がありうるので、
 * 例外を投げず構造化された失敗理由を返す（呼び出し側の envelope とそのまま合わせる）。
 */
export function parseIssueViewOutput(stdout: string): ParsedIssueResult {
  let parsed: { number?: unknown; title?: unknown; state?: unknown; labels?: unknown; body?: unknown; url?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return { ok: false, reason: "unparsable JSON output" };
  }
  if (
    typeof parsed.number !== "number" ||
    typeof parsed.title !== "string" ||
    typeof parsed.state !== "string" ||
    typeof parsed.url !== "string" ||
    typeof parsed.body !== "string"
  ) {
    return { ok: false, reason: "missing required fields in output" };
  }
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels
        .filter(
          (label): label is { name: string } =>
            typeof label === "object" && label !== null && typeof (label as { name?: unknown }).name === "string",
        )
        .map((label) => label.name)
    : [];
  return {
    ok: true,
    issue: {
      number: parsed.number,
      title: parsed.title,
      state: parsed.state,
      labels,
      url: parsed.url,
      body: parsed.body,
    },
  };
}

async function issueViewToolImpl(args: Args, config: ResolvedGatewayConfig): Promise<CallToolResult> {
  if (config.worktree === undefined) throw new Error("issue tool is not configured for this workspace");
  const number = numberArg(args, "number");
  if (number === undefined || number < 1) throw new Error("number must be a positive integer");
  const run = await runProgram(
    "gh",
    ["issue", "view", String(number), "--json", "number,title,state,labels,body,url"],
    config.workspaceRoot,
    config.maxTimeoutMs,
    config.maxOutputBytes,
  );
  if (run.exitCode !== 0) {
    const summary = `FAIL gh issue view: ${firstLine(run.stderr || run.stdout) || "command failed"}`;
    return output(
      "issue_view",
      "failed",
      summary,
      "",
      { diagnostics: [{ severity: "error", message: summary }] },
      true,
    );
  }
  const parsed = parseIssueViewOutput(run.stdout);
  if (!parsed.ok) {
    const summary = `FAIL gh issue view: ${parsed.reason}`;
    return output(
      "issue_view",
      "failed",
      summary,
      "",
      { diagnostics: [{ severity: "error", message: summary }] },
      true,
    );
  }
  const { issue } = parsed;
  const summary = `#${issue.number} ${issue.state} ${issue.title}`;
  return output("issue_view", "success", summary, "", { issue });
}

/** `gh pr view --json statusCheckRollup` の stdout を `RawCheck[]` へ解釈する。壊れた/非JSON出力は空配列扱い。 */
function parseStatusCheckRollup(stdout: string): RawCheck[] {
  try {
    const parsed = JSON.parse(stdout) as { statusCheckRollup?: unknown };
    return Array.isArray(parsed.statusCheckRollup) ? (parsed.statusCheckRollup as RawCheck[]) : [];
  } catch {
    return [];
  }
}

/**
 * provider/status の await primitive（Issue #74）。`gh pr view` を runtime 側で bounded polling し、
 * 変化の無い中間 snapshot は返さず、terminal 到達 または 意味のある変化のときだけ 1 回応答する。
 * agent は interval を指定できない — `config.await` が唯一の polling policy 制御点。
 */
async function ghChecksAwaitToolImpl(
  args: Args,
  config: ResolvedGatewayConfig,
  telemetry?: TelemetrySink,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  if (config.worktree === undefined) throw new Error("gh checks tool is not configured for this workspace");
  const number = numberArg(args, "number");
  if (number === undefined || number < 1) throw new Error("number must be a positive integer");
  const requestedTimeout = numberArg(args, "timeoutMs");
  if (requestedTimeout !== undefined && requestedTimeout < 1) throw new Error("timeoutMs must be positive");
  const timeoutMs = Math.min(requestedTimeout ?? config.await.maxAwaitMs, config.await.maxAwaitMs);

  let lastSpawnError: string | undefined;
  const fetchChecks = async (): Promise<CheckSnapshot[]> => {
    const run = await runProgram(
      "gh",
      ["pr", "view", String(number), "--json", "statusCheckRollup"],
      config.workspaceRoot,
      config.maxTimeoutMs,
      config.maxOutputBytes,
    );
    if (run.exitCode !== 0) {
      lastSpawnError = firstLine(run.stderr || run.stdout) || "gh pr view failed";
      return [];
    }
    lastSpawnError = undefined;
    return normalizeChecks(parseStatusCheckRollup(run.stdout));
  };

  if (signal?.aborted === true) {
    return output("gh_checks_await", "partial", `CANCELLED pr=${number}`, "", {
      pr: number,
      state: "cancelled",
      truncated: false,
    });
  }

  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<"cancelled">((resolve) =>
          signal.addEventListener("abort", () => resolve("cancelled"), { once: true }),
        );

  const waitPromise = waitUntilChanged({ fetchChecks, policy: config.await, timeoutMs });
  const result = abortPromise === undefined ? await waitPromise : await Promise.race([waitPromise, abortPromise]);

  if (result === "cancelled") {
    telemetry?.recordAwait({ pollCount: 0, elapsedMs: 0, stateChanges: 0, avoidedResponses: 0, outcome: "cancelled" });
    return output("gh_checks_await", "partial", `CANCELLED pr=${number}`, "", {
      pr: number,
      state: "cancelled",
      truncated: false,
    });
  }

  const avoidedResponses = Math.max(0, result.pollCount - 1);
  telemetry?.recordAwait({
    pollCount: result.pollCount,
    elapsedMs: result.elapsedMs,
    stateChanges: result.changed.length,
    avoidedResponses,
    outcome: result.timedOut === true ? "timeout" : "terminal",
  });

  if (result.timedOut === true) {
    const summary = `TIMEOUT pr=${number} elapsed=${result.elapsedMs}ms checks=${result.checks.length}${lastSpawnError ? ` last_error=${lastSpawnError}` : ""}`;
    return output("gh_checks_await", "partial", summary, "", {
      pr: number,
      elapsed_ms: result.elapsedMs,
      timeout_ms: timeoutMs,
      state: "timeout",
      last_known_checks: result.checks,
      retrieval_hint: `mottainai_gh_checks_await number=${number}`,
      truncated: false,
    });
  }

  const summary = `pr=${number} changed=${result.changed.length} terminal=${result.terminal}`;
  return output("gh_checks_await", "success", summary, "", {
    pr: number,
    changed: result.changed,
    terminal: result.terminal,
    checks: result.checks,
    metrics: { poll_count: result.pollCount, elapsed_ms: result.elapsedMs },
    truncated: false,
  });
}

function codeView(source: string, mode: string, filePath: string): string {
  if (mode === "symbols")
    return source
      .split("\n")
      .filter((line) => /\b(export\s+)?(async\s+)?(function|class|interface|type|enum|const)\b/.test(line))
      .join("\n");
  const language = detectCodeLanguage({ path: filePath });
  return compressText(source, { json: false, lines: false, code: language ? { language } : false });
}

async function walk(root: string, current: string, remaining: number, outputEntries: string[]): Promise<void> {
  if (remaining < 0) return;
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (entry.isDirectory() && OMITTED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute) || ".";
    outputEntries.push(`${relative}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory() && remaining > 0 && !entry.isSymbolicLink())
      await walk(root, absolute, remaining - 1, outputEntries);
  }
}

export interface RgContextLine {
  line: number;
  text: string;
}
export interface RgMatch {
  line: number;
  text: string;
  context?: RgContextLine[];
}

interface FileGroupState {
  path: string;
  matches: RgMatch[];
  /** まだどの match にも属さない、直前の match より前に出た context line。次の match の "before" context になる。 */
  pendingBefore: RgContextLine[];
}

/**
 * rg `--json` の event 列（`match` / `context`）を file ごとに group 化し、各 context line を
 * 正しい match group へ結び付ける。`context` の window 幅（`contextLines`）を使って、直前の
 * match の "after" context か次の match の "before" context かを行番号で判定する（離れた
 * match の context を誤って隣の match へ付けない）。
 */
export function parseRgJson(raw: string, root: string, contextLines = 0): Array<{ path: string; matches: RgMatch[] }> {
  const files = new Map<string, FileGroupState>();
  const order: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const item = JSON.parse(line) as {
        type?: string;
        data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
      };
      if (item.type !== "match" && item.type !== "context") continue;
      if (!item.data?.path?.text || item.data.line_number === undefined) continue;
      const key = path.relative(root, item.data.path.text);
      let state = files.get(key);
      if (state === undefined) {
        state = { path: key, matches: [], pendingBefore: [] };
        files.set(key, state);
        order.push(key);
      }
      const lineNumber = item.data.line_number;
      const text = (item.data.lines?.text ?? "").trimEnd();

      if (item.type === "match") {
        const match: RgMatch = { line: lineNumber, text };
        if (state.pendingBefore.length > 0) {
          match.context = state.pendingBefore;
          state.pendingBefore = [];
        }
        state.matches.push(match);
        continue;
      }

      const lastMatch = state.matches[state.matches.length - 1];
      const withinAfterWindow = lastMatch !== undefined && lineNumber <= lastMatch.line + contextLines;
      if (withinAfterWindow) {
        lastMatch.context = [...(lastMatch.context ?? []), { line: lineNumber, text }];
      } else {
        state.pendingBefore.push({ line: lineNumber, text });
      }
    } catch {
      /* ignore malformed rg event */
    }
  }

  return order.map((key) => {
    const state = files.get(key)!;
    return { path: state.path, matches: state.matches };
  });
}

function firstLine(value: string): string {
  return value.split("\n").find(Boolean) ?? "command failed";
}

/** Skip TAP framing so the first actionable failure line, rather than `TAP version`, is surfaced. */
function firstFailureCause(value: string): string {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnostic = lines.find((line) => /^(?:error|message):\s*/iu.test(line));
  if (diagnostic !== undefined) return diagnostic.replace(/^(?:error|message):\s*/iu, "");
  const meaningful = lines.find(
    (line) => !/^TAP version\b/iu.test(line) && !/^# /u.test(line) && !/^1\.\.\d+/u.test(line),
  );
  return meaningful ?? firstLine(value);
}

export type { RunResult };
export { runProgram };

async function runShell(command: string, cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<RunResult> {
  if (!isPackageManagerCommand(command)) return runChild(command, [], cwd, timeoutMs, maxOutputBytes, true);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-exec-"));
  const stdoutPath = path.join(temporaryDirectory, "stdout");
  const stderrPath = path.join(temporaryDirectory, "stderr");
  try {
    const result = await runChild(
      `(${command}) > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}`,
      [],
      cwd,
      timeoutMs,
      maxOutputBytes,
      true,
      { stdout: stdoutPath, stderr: stderrPath },
    );
    const stdout = await readLimited(stdoutPath, maxOutputBytes);
    const stderr = await readLimited(stderrPath, Math.max(0, maxOutputBytes - Buffer.byteLength(stdout.text, "utf8")));
    return {
      ...result,
      stdout: stdout.text,
      stderr: stderr.text,
      outputLimit: result.outputLimit || stdout.truncated || stderr.truncated,
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function isPackageManagerCommand(command: string): boolean {
  return /^\s*(?:npm|pnpm|yarn|bun|npx)(?:\s|$)/.test(command);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function readLimited(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  try {
    const content = await fs.readFile(filePath);
    const bounded = trimIncompleteUtf8(content.subarray(0, Math.max(0, maxBytes)));
    return { text: bounded.toString("utf8"), truncated: content.length > maxBytes };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", truncated: false };
    throw error;
  }
}

/**
 * byte数で切ったbufferが UTF-8 マルチbyte 文字の途中で終わっていると、`toString("utf8")` が
 * 不完全な末尾を U+FFFD 1個（3 byte）へ置き換え、再encode時のbyte長がmaxBytesを超えうる。
 * 末尾の不完全なsequenceをdecodeする前に切り落とし、`Buffer.byteLength(text,"utf8") <= maxBytes`
 * を常に保つ。
 */
function trimIncompleteUtf8(buffer: Buffer): Buffer {
  const maxSequenceLength = 4;
  let leadIndex = buffer.length;
  let scanned = 0;
  while (leadIndex > 0 && scanned < maxSequenceLength && (buffer[leadIndex - 1] & 0xc0) === 0x80) {
    leadIndex -= 1;
    scanned += 1;
  }
  if (leadIndex === 0) return buffer;
  const leadByte = buffer[leadIndex - 1];
  const sequenceLength = leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : leadByte >= 0xc0 ? 2 : 1;
  const availableBytes = buffer.length - (leadIndex - 1);
  if (sequenceLength > 1 && availableBytes < sequenceLength) return buffer.subarray(0, leadIndex - 1);
  return buffer;
}
