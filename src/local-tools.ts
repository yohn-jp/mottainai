import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { compactToBudget } from "./compress/budget.js";
import { compressText } from "./compress/index.js";
import { detectCodeLanguage } from "./compress/code.js";
import type { ResolvedGatewayConfig, ResolvedWorktreeConfig } from "./config.js";
import { OUTPUT_SCHEMA, output } from "./envelope.js";
import type { ArtifactStore } from "./retrieve.js";
import { compressionRatio, retrievalRate } from "./telemetry.js";
import type { TelemetrySink } from "./telemetry.js";
import type { UpstreamStatus } from "./upstream.js";

const OMITTED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "target", ".cache", ".venv", "coverage"]);
// timeout/output limit後に協調終了を待ち、無視する子プロセスだけ強制終了する。
const TERMINATION_GRACE_MS = 1_000;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const localTools: Tool[] = [
  {
    name: "mottainai_exec", description: "Run a shell command in workspace and return compact diagnostics.",
    inputSchema: { type: "object", properties: {
      command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 1 }, targetTokens: { type: "integer", minimum: 128, maximum: 10000 },
      compression: { type: "boolean" },
    }, required: ["command"] }, outputSchema: OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "mottainai_read", description: "Read a workspace file by line range or compact code view.",
    inputSchema: { type: "object", properties: {
      path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 },
      mode: { type: "string", enum: ["raw", "outline", "symbols", "auto"] },
    }, required: ["path"] }, outputSchema: OUTPUT_SCHEMA, annotations: readOnly,
  },
  {
    name: "mottainai_search", description: "Search workspace files with literal or regular-expression query.",
    inputSchema: { type: "object", properties: {
      query: { type: "string" }, path: { type: "string" }, mode: { type: "string", enum: ["literal", "regex"] },
      contextLines: { type: "integer", minimum: 0, maximum: 20 }, maxResults: { type: "integer", minimum: 1, maximum: 100 },
    }, required: ["query"] }, outputSchema: OUTPUT_SCHEMA, annotations: readOnly,
  },
  {
    name: "mottainai_list", description: "List a workspace directory, omitting generated and cache directories.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", minimum: 0, maximum: 12 } } },
    outputSchema: OUTPUT_SCHEMA, annotations: readOnly,
  },
  {
    name: "mottainai_result_get", description: "Get a bounded section of a stored raw result.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, stream: { type: "string", enum: ["combined", "stdout", "stderr"] }, query: { type: "string" },
      contextLines: { type: "integer", minimum: 0, maximum: 20 }, startLine: { type: "integer", minimum: 0 }, maxLines: { type: "integer", minimum: 1, maximum: 80 },
    }, required: ["id"] }, outputSchema: OUTPUT_SCHEMA, annotations: readOnly,
  },
  {
    name: "mottainai_result_search", description: "Search compact metadata and raw text from results in this MCP session.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "integer", minimum: 1, maximum: 100 } }, required: ["query"] },
    outputSchema: OUTPUT_SCHEMA, annotations: readOnly,
  },
  {
    name: "mottainai_runtime_status", description: "Report gateway runtime state and per-upstream provider health.",
    inputSchema: { type: "object", properties: { provider: { type: "string" } } },
    outputSchema: OUTPUT_SCHEMA, annotations: readOnly,
  },
  {
    name: "mottainai_telemetry_summary",
    description: "Report aggregate local usage telemetry: call counts, compression ratio and artifact retrieval rate by provider and capability. Disabled unless MOTTAINAI_TELEMETRY=1.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: OUTPUT_SCHEMA, annotations: readOnly,
  },
];

const worktreeNewTool: Tool = {
  name: "mottainai_worktree_new",
  description: "Create a git worktree on a new branch, using the workspace's allowed branch prefixes.",
  inputSchema: { type: "object", properties: {
    prefix: { type: "string" }, task: { type: "string" },
  }, required: ["prefix", "task"] }, outputSchema: OUTPUT_SCHEMA,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

const issueViewTool: Tool = {
  name: "mottainai_issue_view",
  description: "Fetch one GitHub issue's number, title, state, labels, url, and body via gh CLI.",
  inputSchema: { type: "object", properties: {
    number: { type: "integer", minimum: 1 },
  }, required: ["number"] }, outputSchema: OUTPUT_SCHEMA, annotations: readOnly,
};

/** `worktree` 未設定のワークスペースでは `mottainai_worktree_new` を公開しない。 */
export function localToolsFor(config: ResolvedGatewayConfig): Tool[] {
  return config.worktree === undefined ? localTools : [...localTools, worktreeNewTool, issueViewTool];
}

/** risk annotation 参照専用。gatewayConfig を持たない箇所でも定義を引けるよう、条件付き公開ツールも含む全量。 */
export const allLocalTools: Tool[] = [...localTools, worktreeNewTool, issueViewTool];

type Args = Record<string, unknown> | undefined;

/** `mottainai_runtime_status` が読む provider 状態。registry 実体への依存を型だけに留める。 */
export interface RuntimeStatusSource {
  status(): UpstreamStatus[];
}

export async function callLocalTool(
  name: string, args: Args, config: ResolvedGatewayConfig, store: ArtifactStore, runtime?: RuntimeStatusSource,
  telemetry?: TelemetrySink,
): Promise<CallToolResult> {
  switch (name) {
    case "mottainai_exec": return execTool(args, config, store);
    case "mottainai_read": return readTool(args, config, store);
    case "mottainai_search": return searchTool(args, config, store);
    case "mottainai_list": return listTool(args, config, store);
    case "mottainai_result_get": return resultGetTool(args, store, telemetry);
    case "mottainai_result_search": return resultSearchTool(args, store, telemetry);
    case "mottainai_runtime_status": return runtimeStatusTool(args, config, runtime);
    case "mottainai_telemetry_summary": return telemetrySummaryTool(telemetry);
    case "mottainai_worktree_new": return worktreeNewToolImpl(args, config);
    case "mottainai_issue_view": return issueViewToolImpl(args, config);
    default: throw new Error(`Unknown local tool: ${name}`);
  }
}

function runtimeStatusTool(args: Args, config: ResolvedGatewayConfig, runtime?: RuntimeStatusSource): CallToolResult {
  const requested = stringArg(args, "provider");
  const all = runtime?.status() ?? [];
  if (requested !== undefined && !all.some((provider) => provider.name === requested)) {
    throw new Error(`unknown upstream: ${requested}`);
  }
  const providers = requested === undefined ? all : all.filter((provider) => provider.name === requested);
  const unhealthy = providers.filter((provider) => provider.state === "unhealthy");
  const diagnostics = unhealthy.map((provider) => ({
    severity: "error",
    message: `${provider.name} unhealthy: ${provider.lastError ?? "startup failed"}`,
  }));
  const counts = providers.reduce<Record<string, number>>((totals, provider) => {
    totals[provider.state] = (totals[provider.state] ?? 0) + 1;
    return totals;
  }, {});
  const status = unhealthy.length === 0 ? "success" : "partial";
  const summary = `providers=${providers.length} ${Object.entries(counts).map(([state, count]) => `${state}=${count}`).join(" ")}`.trimEnd();
  return output("runtime_status", status, summary, "", {
    facts: providers,
    diagnostics,
    metrics: {
      providers: providers.length,
      ready: counts.ready ?? 0,
      unhealthy: unhealthy.length,
      disabled: counts.disabled ?? 0,
    },
    workspace_root: config.workspaceRoot,
  });
}

function value(args: Args, key: string): unknown { return args?.[key]; }
function stringArg(args: Args, key: string, required = false): string | undefined {
  const candidate = value(args, key);
  if (candidate === undefined && !required) return undefined;
  if (typeof candidate !== "string" || (required && candidate.length === 0)) throw new Error(`${key} must be a non-empty string`);
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
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${path.sep}`)) throw new Error("path must stay inside workspaceRoot");
  const resolved = await fs.realpath(candidate);
  if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) throw new Error("path resolves outside workspaceRoot");
  return resolved;
}

async function execTool(args: Args, config: ResolvedGatewayConfig, store: ArtifactStore): Promise<CallToolResult> {
  const command = stringArg(args, "command", true)!;
  const cwd = await resolveInside(config.workspaceRoot, stringArg(args, "cwd"));
  const requestedTimeout = numberArg(args, "timeoutMs") ?? config.defaultTimeoutMs;
  if (requestedTimeout < 1) throw new Error("timeoutMs must be positive");
  const timeoutMs = Math.min(requestedTimeout, config.maxTimeoutMs);
  const started = performance.now();
  const run = await runShell(command, cwd, timeoutMs, config.maxOutputBytes);
  const durationMs = Math.round(performance.now() - started);
  const raw = [run.stdout, run.stderr].filter(Boolean).join(run.stdout && run.stderr ? "\n" : "");
  const targetTokens = numberArg(args, "targetTokens") ?? config.execTargetTokens;
  if (targetTokens < 128 || targetTokens > 10_000) throw new Error("targetTokens must be between 128 and 10000");
  const status = run.exitCode === 0 && !run.timedOut && !run.outputLimit ? "success" : "failed";
  const failure = status === "failed" ? await diagnoseExecFailure(run, raw, cwd, config.workspaceRoot) : undefined;
  // 競合markerはパッチ根拠。通常出力の圧縮対象にしない。
  const preserveRaw = value(args, "compression") === false || failure?.classification === "git_conflict";
  const compressed = preserveRaw ? raw : compactToBudget(compressText(raw, { cli: { command } }), targetTokens, Buffer.byteLength(raw));
  const summary = status === "success"
    ? `OK exit=0 duration=${durationMs}ms${run.outputLimit ? " output_limit" : ""}`
    : `FAIL ${failure?.classification ?? "command"}: ${failure?.firstCause ?? "command failed"} exit=${run.exitCode ?? "signal"} duration=${durationMs}ms${run.timedOut ? " timeout" : ""}${run.outputLimit ? " output_limit" : ""}`;
  const diagnostics = status === "failed" ? [{ severity: "error", message: failure?.firstCause ?? "command failed" }] : [];
  const resultId = store.putArtifact({ text: raw, stdout: run.stdout, stderr: run.stderr, metadata: { operation: "exec", command, cwd, summary, diagnostics } });
  const truncated = run.outputLimit || compressed !== raw;
  const testResults = tapTestResults(raw, resultId, truncated);
  return output("exec", status, summary, resultId, {
    facts: failure?.facts ?? [], failure_classification: failure?.classification,
    next_command: status === "failed" ? nextCommand(resultId, failure) : undefined,
    diagnostics, metrics: { duration_ms: durationMs, stdout_bytes: Buffer.byteLength(run.stdout), stderr_bytes: Buffer.byteLength(run.stderr), returned_bytes: Buffer.byteLength(compressed), target_tokens: targetTokens },
    exit_code: run.exitCode, signal: run.signal, timed_out: run.timedOut, output_limited: run.outputLimit, output: compressed,
    truncated,
    ...(testResults === undefined ? {} : { test_results: testResults }),
  }, status === "failed");
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

/** TAP footer と not ok block は機械的に読める。圧縮前の原文から最小失敗情報を残す。 */
function tapTestResults(raw: string, resultId: string, outputOmitted: boolean): TapTestResults | undefined {
  const lines = raw.split("\n");
  const counters: Partial<Record<"total" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>> = {};
  for (const line of lines) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line.trim());
    if (match === null) continue;
    const key = match[1] === "tests" ? "total" : match[1] as keyof typeof counters;
    counters[key] = Number(match[2]);
  }
  const failures: TapTestFailure[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^not ok \d+ - (.+?)(?: # .*)?$/.exec(lines[index].trim());
    if (match === null) continue;
    const block = lines.slice(index + 1).find((line) => /^\s*(?:error|message):\s*/.test(line));
    const diagnostic = block?.replace(/^\s*(?:error|message):\s*/, "").trim() ?? "test failed";
    failures.push({ name: match[1], diagnostic: diagnostic.replace(/^['"]|['"]$/g, "") });
  }
  if (Object.keys(counters).length === 0 && failures.length === 0) return undefined;
  return { format: "tap", ...counters, failures, output_omitted: outputOmitted, result_id: resultId };
}

interface ExecFailure {
  classification: "timeout" | "output_limit" | "git_conflict" | "missing_build_artifact" | "typescript" | "spawn" | "command";
  firstCause: string;
  facts: Array<Record<string, unknown>>;
  query?: string;
  recoveryCommands?: string[];
}

async function diagnoseExecFailure(run: RunResult, raw: string, cwd: string, workspaceRoot: string): Promise<ExecFailure> {
  if (run.timedOut) return { classification: "timeout", firstCause: "command timed out", facts: [], query: "timeout" };
  if (run.outputLimit) return { classification: "output_limit", firstCause: "output limit reached", facts: [], query: "mottainai omitted" };
  const conflict = gitConflictFacts(raw);
  if (conflict.length > 0) return { classification: "git_conflict", firstCause: firstLine(raw), facts: conflict, query: "<<<<<<<" };
  const missingArtifacts = await missingDistArtifacts(raw, cwd, workspaceRoot);
  if (missingArtifacts.length > 0) {
    const recoveryCommands = await buildRecoveryCommands(workspaceRoot);
    return {
      classification: "missing_build_artifact", firstCause: `missing ${missingArtifacts[0]}`,
      facts: [{ kind: "missing_build_artifacts", paths: missingArtifacts }, { kind: "recovery_commands", commands: recoveryCommands }],
      query: missingArtifacts[0], recoveryCommands,
    };
  }
  const typeScript = raw.split("\n").find((line) => /\berror TS\d+:/.test(line));
  if (typeScript) return { classification: "typescript", firstCause: typeScript, facts: [], query: "error TS" };
  if (run.spawnError) return { classification: "spawn", firstCause: run.spawnError, facts: [], query: run.spawnError };
  return { classification: "command", firstCause: firstLine(run.stderr || raw) || "command failed", facts: [], query: undefined };
}

function gitConflictFacts(raw: string): Array<Record<string, unknown>> {
  const paths = [...raw.matchAll(/(?:CONFLICT \([^)]*\): Merge conflict in |both modified:\s*)(.+)/g)].map((match) => match[1].trim());
  const markerCount = raw.split("\n").filter((line) => /^(?:<{7}|={7}|>{7})/.test(line)).length;
  if (paths.length === 0 && markerCount === 0) return [];
  return [
    ...(paths.length > 0 ? [{ kind: "unresolved_paths", paths: [...new Set(paths)] }] : []),
    ...(markerCount > 0 ? [{ kind: "conflict_markers", count: markerCount }] : []),
    { kind: "raw_artifact", retention: "full until output limit or artifact expiry" },
  ];
}

async function missingDistArtifacts(raw: string, cwd: string, workspaceRoot: string): Promise<string[]> {
  const candidates = [...raw.matchAll(/(?:Cannot find module|ERR_MODULE_NOT_FOUND|not found)[:\s]+['"]?((?:[^'"\s]*[\\/])?dist[\\/][^'"\s]+)/gi)]
    .map((match) => match[1].replace(/^file:\/\//, ""));
  const missing: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(cwd, candidate);
    if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) continue;
    try { await fs.access(resolved); } catch { missing.push(path.relative(workspaceRoot, resolved) || "."); }
  }
  return [...new Set(missing)];
}

async function buildRecoveryCommands(workspaceRoot: string): Promise<string[]> {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    if (!packageJson.scripts?.build) return [];
    const commands: string[] = [];
    try { await fs.access(path.join(workspaceRoot, "node_modules")); } catch { commands.push("pnpm install --frozen-lockfile"); }
    commands.push("pnpm run build");
    return commands;
  } catch { return []; }
}

function nextCommand(resultId: string, failure: ExecFailure | undefined): string {
  if (failure?.recoveryCommands?.length) return failure.recoveryCommands[0];
  const query = failure?.query;
  return query ? `mottainai_result_get id=${resultId} query=${JSON.stringify(query)}` : `mottainai_result_get id=${resultId}`;
}

async function readTool(args: Args, config: ResolvedGatewayConfig, store: ArtifactStore): Promise<CallToolResult> {
  const filePath = await resolveInside(config.workspaceRoot, stringArg(args, "path", true));
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("path must be a file");
  const raw = await fs.readFile(filePath, "utf8");
  const start = numberArg(args, "startLine") ?? 1;
  const end = numberArg(args, "endLine");
  if (start < 1 || (end !== undefined && end < start)) throw new Error("invalid line range");
  const selected = raw.split("\n").slice(start - 1, end).join("\n");
  const requestedMode = stringArg(args, "mode") ?? "auto";
  if (!new Set(["raw", "outline", "symbols", "auto"]).has(requestedMode)) throw new Error("invalid mode");
  const mode = requestedMode === "auto" ? (selected.length > 12_000 ? "outline" : "raw") : requestedMode;
  const text = mode === "raw" ? selected : codeView(selected, mode, filePath);
  const summary = `${path.relative(config.workspaceRoot, filePath)} lines=${selected.split("\n").length} mode=${mode}`;
  const resultId = store.putArtifact({ text: selected, metadata: { operation: "read", summary, cwd: filePath } });
  return output("read", "success", summary, resultId, { path: path.relative(config.workspaceRoot, filePath), mode, text, metrics: { raw_bytes: Buffer.byteLength(selected) } });
}

async function searchTool(args: Args, config: ResolvedGatewayConfig, store: ArtifactStore): Promise<CallToolResult> {
  const query = stringArg(args, "query", true)!;
  const searchPath = await resolveInside(config.workspaceRoot, stringArg(args, "path"));
  const mode = stringArg(args, "mode") ?? "literal";
  if (mode !== "literal" && mode !== "regex") throw new Error("mode must be literal or regex");
  const context = numberArg(args, "contextLines") ?? 0;
  const maxResults = numberArg(args, "maxResults") ?? 30;
  const rgArgs = ["--json", "--line-number", "--no-heading", "--max-count", String(maxResults)];
  if (mode === "literal") rgArgs.push("--fixed-strings");
  if (context > 0) rgArgs.push("--context", String(Math.min(context, 20)));
  rgArgs.push("--glob", "!.git", "--glob", "!node_modules", "--glob", "!dist", query, searchPath);
  const run = await runProgram("rg", rgArgs, config.workspaceRoot, config.maxTimeoutMs, config.maxOutputBytes);
  if (run.spawnError) throw new Error(`rg unavailable: ${run.spawnError}`);
  const { groups, omitted } = truncateGroups(parseRgJson(run.stdout, config.workspaceRoot), maxResults);
  const matchCount = groups.reduce((count, group) => count + group.matches.length, 0);
  const summary = `${matchCount} matches in ${groups.length} files${omitted > 0 ? ` (truncated, omitted=${omitted})` : ""}`;
  const resultId = store.putArtifact({ text: run.stdout, stderr: run.stderr, metadata: { operation: "search", command: query, cwd: searchPath, summary } });
  return output("search", run.exitCode === 0 || run.exitCode === 1 ? "success" : "failed", summary, resultId, { query, mode, groups, metrics: { raw_bytes: Buffer.byteLength(run.stdout), omitted_matches: omitted }, truncated: omitted > 0 }, run.exitCode !== 0 && run.exitCode !== 1);
}

// --max-countはファイル単位上限。ここでparse後にグローバル件数で打ち切る（issue #5）。
function truncateGroups(
  groups: Array<{ path: string; matches: Array<{ line: number; text: string }> }>,
  maxResults: number,
): { groups: Array<{ path: string; matches: Array<{ line: number; text: string }> }>; omitted: number } {
  const limited: Array<{ path: string; matches: Array<{ line: number; text: string }> }> = [];
  let used = 0;
  let omitted = 0;
  for (const group of groups) {
    const remaining = maxResults - used;
    if (remaining <= 0) { omitted += group.matches.length; continue; }
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
  const resultId = store.putArtifact({ text: entries.join("\n"), metadata: { operation: "list", cwd: directory, summary } });
  return output("list", "success", summary, resultId, { path: path.relative(config.workspaceRoot, directory) || ".", entries });
}

function resultGetTool(args: Args, store: ArtifactStore, telemetry?: TelemetrySink): CallToolResult {
  const id = stringArg(args, "id", true)!;
  const stream = stringArg(args, "stream") ?? "combined";
  if (stream !== "combined" && stream !== "stdout" && stream !== "stderr") throw new Error("invalid stream");
  const retrieved = store.retrieve(id, { query: stringArg(args, "query"), contextLines: numberArg(args, "contextLines"), startLine: numberArg(args, "startLine"), maxLines: numberArg(args, "maxLines"), stream });
  if (!retrieved) throw new Error(`Original result unavailable or expired: ${id}`);
  telemetry?.recordRetrieval();
  const summary = `result=${id} ${retrieved.returnedStartLine}-${retrieved.returnedEndLine}/${retrieved.totalLines}`;
  return output("result_get", "success", summary, id, { ...retrieved, truncated: retrieved.omittedLines > 0 });
}

function resultSearchTool(args: Args, store: ArtifactStore, telemetry?: TelemetrySink): CallToolResult {
  const query = stringArg(args, "query", true)!;
  const results = store.search(query, numberArg(args, "maxResults"));
  telemetry?.recordRetrieval();
  const summary = `${results.length} stored results match`;
  return output("result_search", "success", summary, "", { query, results });
}

function telemetrySummaryTool(telemetry?: TelemetrySink): CallToolResult {
  const snapshot = telemetry?.snapshot() ?? {
    enabled: false, generated_at: new Date().toISOString(),
    totals: { calls: 0, errors: 0, original_bytes: 0, compressed_bytes: 0, retrievals: 0 },
    by_provider: {}, by_capability: {},
  };
  if (!snapshot.enabled) {
    return output("telemetry_summary", "success", "telemetry disabled; set MOTTAINAI_TELEMETRY=1 to enable", "", {
      enabled: false,
    });
  }
  const ratio = compressionRatio(snapshot.totals);
  const rate = retrievalRate(snapshot.totals);
  const summary = `calls=${snapshot.totals.calls} errors=${snapshot.totals.errors}`
    + `${ratio !== undefined ? ` compression_ratio=${ratio.toFixed(3)}` : ""}`
    + `${rate !== undefined ? ` retrieval_rate=${rate.toFixed(3)}` : ""}`;
  return output("telemetry_summary", "success", summary, "", {
    enabled: true,
    facts: [
      ...Object.entries(snapshot.by_provider).map(([provider, counts]) => ({ kind: "provider", name: provider, ...counts, compression_ratio: compressionRatio(counts) })),
      ...Object.entries(snapshot.by_capability).map(([capability, counts]) => ({ kind: "capability", name: capability, ...counts, compression_ratio: compressionRatio(counts) })),
    ],
    totals: snapshot.totals,
    by_provider: snapshot.by_provider,
    by_capability: snapshot.by_capability,
    compression_ratio: ratio,
    retrieval_rate: rate,
    generated_at: snapshot.generated_at,
    metrics: { calls: snapshot.totals.calls, errors: snapshot.totals.errors, retrievals: snapshot.totals.retrievals },
  });
}

const TASK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

async function worktreeNewToolImpl(args: Args, config: ResolvedGatewayConfig): Promise<CallToolResult> {
  const worktree = config.worktree;
  if (worktree === undefined) throw new Error("worktree tool is not configured for this workspace");
  const prefix = stringArg(args, "prefix", true)!;
  const task = stringArg(args, "task", true)!;
  if (!worktree.allowedBranchPrefixes.includes(prefix)) {
    throw new Error(`prefix must be one of: ${worktree.allowedBranchPrefixes.join(", ")}`);
  }
  if (!TASK_SLUG_PATTERN.test(task)) {
    throw new Error(`invalid task slug: ${task} (use lowercase, digits, hyphens)`);
  }
  const branch = `${prefix}/${task}`;
  const relativeWorktreeDir = path.join(worktree.worktreeDir, `${prefix}-${task}`);
  const run = await runProgram(
    "git",
    ["worktree", "add", "-b", branch, relativeWorktreeDir, worktree.baseBranch],
    config.workspaceRoot, config.maxTimeoutMs, config.maxOutputBytes,
  );
  if (run.exitCode !== 0) {
    const summary = `FAIL git worktree add: ${firstLine(run.stderr || run.stdout) || "command failed"}`;
    return output("worktree_new", "failed", summary, "", { diagnostics: [{ severity: "error", message: summary }] }, true);
  }
  const verify = await runProgram(
    "git", ["-C", relativeWorktreeDir, "rev-parse", "--abbrev-ref", "HEAD"],
    config.workspaceRoot, config.maxTimeoutMs, config.maxOutputBytes,
  );
  const actualBranch = verify.stdout.trim();
  if (actualBranch !== branch) {
    const summary = `FAIL branch verification: expected ${branch}, got ${actualBranch || "unknown"}`;
    return output("worktree_new", "failed", summary, "", { diagnostics: [{ severity: "error", message: summary }] }, true);
  }
  const summary = `OK branch=${branch} worktree=${relativeWorktreeDir}`;
  return output("worktree_new", "success", summary, "", { branch, worktree_dir: relativeWorktreeDir });
}

async function issueViewToolImpl(args: Args, config: ResolvedGatewayConfig): Promise<CallToolResult> {
  const number = numberArg(args, "number");
  if (number === undefined || number < 1) throw new Error("number must be a positive integer");
  const run = await runProgram(
    "gh", ["issue", "view", String(number), "--json", "number,title,state,labels,body,url"],
    config.workspaceRoot, config.maxTimeoutMs, config.maxOutputBytes,
  );
  if (run.exitCode !== 0) {
    const summary = `FAIL gh issue view: ${firstLine(run.stderr || run.stdout) || "command failed"}`;
    return output("issue_view", "failed", summary, "", { diagnostics: [{ severity: "error", message: summary }] }, true);
  }
  const parsed = JSON.parse(run.stdout) as {
    number: number; title: string; state: string; labels: Array<{ name: string }>; body: string; url: string;
  };
  const issue = {
    number: parsed.number, title: parsed.title, state: parsed.state,
    labels: parsed.labels.map((label) => label.name), url: parsed.url, body: parsed.body,
  };
  const summary = `#${issue.number} ${issue.state} ${issue.title}`;
  return output("issue_view", "success", summary, "", { issue });
}

function codeView(source: string, mode: string, filePath: string): string {
  if (mode === "symbols") return source.split("\n").filter((line) => /\b(export\s+)?(async\s+)?(function|class|interface|type|enum|const)\b/.test(line)).join("\n");
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
    if (entry.isDirectory() && remaining > 0 && !entry.isSymbolicLink()) await walk(root, absolute, remaining - 1, outputEntries);
  }
}

export function parseRgJson(raw: string, root: string): Array<{ path: string; matches: Array<{ line: number; text: string }> }> {
  const grouped = new Map<string, Array<{ line: number; text: string }>>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const item = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
      if (item.type !== "match" || !item.data?.path?.text || item.data.line_number === undefined) continue;
      const key = path.relative(root, item.data.path.text);
      const matches = grouped.get(key) ?? [];
      matches.push({ line: item.data.line_number, text: (item.data.lines?.text ?? "").trimEnd() });
      grouped.set(key, matches);
    } catch { /* ignore malformed rg event */ }
  }
  return [...grouped.entries()].map(([filePath, matches]) => ({ path: filePath, matches }));
}

function firstLine(value: string): string { return value.split("\n").find(Boolean) ?? "command failed"; }

export interface RunResult { stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean; outputLimit: boolean; spawnError?: string; }

interface OutputFilePaths { stdout: string; stderr: string; }

async function runShell(command: string, cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<RunResult> {
  if (!isPackageManagerCommand(command)) return runChild(command, [], cwd, timeoutMs, maxOutputBytes, true);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-exec-"));
  const stdoutPath = path.join(temporaryDirectory, "stdout");
  const stderrPath = path.join(temporaryDirectory, "stderr");
  try {
    const result = await runChild(
      `(${command}) > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}`,
      [], cwd, timeoutMs, maxOutputBytes, true, { stdout: stdoutPath, stderr: stderrPath },
    );
    const stdout = await readLimited(stdoutPath, maxOutputBytes);
    const stderr = await readLimited(stderrPath, Math.max(0, maxOutputBytes - stdout.text.length));
    return { ...result, stdout: stdout.text, stderr: stderr.text, outputLimit: result.outputLimit || stdout.truncated || stderr.truncated };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function isPackageManagerCommand(command: string): boolean {
  return /^\s*(?:npm|pnpm|yarn|bun|npx)(?:\s|$)/.test(command);
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

async function readLimited(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  try {
    const content = await fs.readFile(filePath);
    return { text: content.subarray(0, maxBytes).toString("utf8"), truncated: content.length > maxBytes };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", truncated: false };
    throw error;
  }
}
export function runProgram(program: string, args: string[], cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<RunResult> {
  return runChild(program, args, cwd, timeoutMs, maxOutputBytes, false);
}
function runChild(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  shell: boolean,
  outputFiles?: OutputFilePaths,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd, shell, detached, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let bytes = 0; let timedOut = false; let outputLimit = false; let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let fileLimitTimer: NodeJS.Timeout | undefined;
    const finish = (result: RunResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (fileLimitTimer !== undefined) clearInterval(fileLimitTimer);
        resolve(result);
      }
    };
    const forceTerminate = (): void => {
      if (detached && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* child already ended */ }
      }
      child.kill("SIGKILL");
    };
    const terminate = (): void => {
      if (detached && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* child already ended */ }
      } else {
        child.kill("SIGTERM");
      }
      if (killTimer === undefined) killTimer = setTimeout(forceTerminate, TERMINATION_GRACE_MS);
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = maxOutputBytes - bytes;
      if (remaining <= 0) { outputLimit = true; terminate(); return; }
      const part = chunk.subarray(0, remaining); bytes += part.length;
      if (target === "stdout") stdout += part.toString("utf8"); else stderr += part.toString("utf8");
      if (part.length !== chunk.length) { outputLimit = true; terminate(); }
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish({ stdout, stderr, exitCode: null, signal: null, timedOut, outputLimit, spawnError: error.message }));
    child.on("close", (exitCode, signal) => finish({ stdout, stderr, exitCode, signal, timedOut, outputLimit }));
    if (outputFiles !== undefined) {
      fileLimitTimer = setInterval(() => {
        void Promise.all([fs.stat(outputFiles.stdout), fs.stat(outputFiles.stderr)]).then(([stdoutStat, stderrStat]) => {
          if (stdoutStat.size + stderrStat.size > maxOutputBytes) {
            outputLimit = true;
            terminate();
          }
        }).catch(() => {
          // 子プロセス終了と一時ファイル掃除の競合。close event が最終結果を確定する。
        });
      }, 50);
    }
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  });
}
