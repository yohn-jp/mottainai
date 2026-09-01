import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collectDoctorReport, formatDoctorHuman } from "./commands/doctor.js";
import { loadConfigSnapshot, loadMottainaiConfig, loadRawConfig, resolveConfigPath, saveRawConfig } from "./config.js";
import type { MottainaiConfig } from "./config.js";
import { openDashboardBrowser, parseDashboardOptions, startDashboard } from "./dashboard/command.js";
import { openDashboardBrowser as openManagerBrowser, parseManagerOptions, startManager } from "./manager/command.js";
import { ManagerSessionService } from "./manager/service.js";
import { defaultTaskRunInstruction, runManagedTask } from "./workflow/domain/managed-task-run.js";
import { ZellijCliRuntime } from "./manager/zellij.js";
import { localTools } from "./local-tools.js";
import { dispatchClientHook, runManagedHooksCommand } from "./hooks/commands.js";
import type { HookCommandContext } from "./hooks/commands.js";
import { verifyManagedCapabilityRegistration } from "./hooks/managed-registration.js";
import { formatInitHuman, runInit } from "./init.js";
import { createRuntimeDiagnostic, formatRuntimeDiagnosticHuman } from "./runtime-diagnostic.js";
import { runServer } from "./server.js";
import {
  applySemanticTransaction,
  configuredSemanticEnforcementMode,
  evaluateSemanticEnforcement,
  parseSemanticEnforcementMode,
  proposeSemanticDebt,
} from "./semantics/enforcement/index.js";
import { compileRepositoryModel } from "./semantics/model/compiler.js";
import { loadSemanticSource } from "./semantics/source/index.js";
import { validateSnapshot } from "./semantics/ir/schema.js";
import type { SemanticEnforcementMode } from "./semantics/enforcement/index.js";
import type { SemanticMutationRequest } from "./semantics/mutations/types.js";
import type { RepositorySemanticSnapshot } from "./semantics/ir/types.js";
import type { LogicalId } from "./semantics/ir/ids.js";
import { validateIssueRef, validateTaskSlug } from "./workflow/commands/validate.js";
import { collectWorkflowDoctorReport } from "./workflow/commands/doctor.js";
import { migrateLegacyWorkflowTask } from "./workflow/domain/legacy-migration.js";
import {
  getTaskStatus,
  getTaskStatusById,
  getTaskStatusForWorkspace,
  listTaskDiscoverySnapshot,
} from "./workflow/domain/task.js";
import { startNawabariTask } from "./workflow/domain/nawabari-task.js";
import { NawabariExecutionClient } from "./workflow/nawabari.js";
import { explainWorkflowPolicy } from "./workflow/policy/explain.js";
import { resolveEffectiveWorkflowPolicy } from "./workflow/policy/load.js";
import { createWorkflowHookProvider } from "./workflow/hook-provider.js";
import type { TaskId, WorkflowStateStore } from "./workflow/state/store.js";
import { resolveStateDbPath } from "./state/paths.js";
import {
  abandonWorkflowTask,
  cleanupWorkflowTask,
  commitWorkflowTask,
  finishWorkflowTask,
  openWorkflowTaskPullRequest,
  pushWorkflowTask,
} from "./workflow/commands/write.js";
import type { CleanupPlan } from "./workflow/domain/cleanup-plan.js";

/**
 * upstream と profile の管理 CLI。
 *
 * クライアント側の設定ファイルを編集させず、mottainai の設定ファイルだけを唯一の
 * 設定先にするための入口。gateway プロセスを起動しないので、常駐中でも実行できる。
 */

const USAGE = `usage:
  mottainai                                      start the MCP stdio server
  mottainai init [options]                       initialize a workspace configuration
  mottainai serve                                start the MCP stdio server explicitly
  mottainai dashboard [options]                  start the local semantic project viewer (fixture|live)
  mottainai manager [options]                    start the local Zellij-backed agent Manager
  mottainai semantic validate [options]          validate semantic integrity and managed-scope blockers
  mottainai semantic status [options]            show bounded semantic enforcement status
  mottainai semantic context --id <id> [options] bounded authoritative agent context
  mottainai semantic diff [options]              show bounded semantic delta/review summary
  mottainai semantic review [options]            show bounded L0-L3 review summary
  mottainai semantic doctor [options]            diagnose semantic source and managed adoption
  mottainai semantic transaction --request-file <path> [options]
                                                   apply declarations through the mutation service
  mottainai semantic migrate [options]           propose comment-to-debt migration (no implicit apply)
                                                   --base-ref <ref> selects the CI semantic baseline
  mottainai list                                 registered upstreams and profiles
  mottainai inspect <name>                       one upstream with defaults applied
  mottainai add <name> --command c [options]     register a stdio upstream
  mottainai add <name> --url u [options]         register a remote upstream
  mottainai remove <name>                        drop an upstream
  mottainai enable <name>                        set enabled true
  mottainai disable <name>                       set enabled false
  mottainai profile use <profile>                set gateway.activeProfile
  mottainai profile clear                        unset gateway.activeProfile
  mottainai doctor [--json]                      validate the local installation
  mottainai policy explain [--workspace path]    resolved Git workflow policy (Issue #34)
  mottainai task start <slug> [options]          start a Git workflow task (dedicated worktree/branch)
  mottainai task run <slug> [options]            start an Issue-bound task and launch its Manager agent
  mottainai task status [--workspace path]       active Git workflow task for the current worktree
  mottainai task status --task-id id [--json]    AUTHORITATIVE fresh resolve of one task id's worktree path
  mottainai task list [--json]                   discovery snapshot of candidate tasks (NOT a live/available guarantee;
                                                   re-resolve with task status --task-id before acting on any of them)
  mottainai task migrate-legacy [options]        explicitly complete or adopt one pre-cutover task
  mottainai task commit [options]                commit the current managed task
  mottainai task push [options]                  push the current managed task
  mottainai task open-pr [options]               create or reuse the task pull request
  mottainai task finish [options]                transition the task to merged
  mottainai task abandon [options]               abandon the task
  mottainai task cleanup [options]               plan and execute safe task cleanup
  mottainai workflow doctor [--workspace path]   read-only workflow reconciliation report
  mottainai hooks install [options]              install owned Claude/Codex pre-operation hooks
  mottainai hooks status                         report managed hook state
  mottainai hooks doctor                         diagnose managed hook state
  mottainai hooks repair [options]               repair only owned hook entries
  mottainai hooks uninstall [options]            remove only owned hook entries
  mottainai hooks explain <decision-id>          retrieve one detailed hook explanation
  mottainai hooks dispatch --client <name>       run the bounded client adapter entrypoint

add options:
  --transport streamableHttp  remote transport; inferred from --url
  --auth-profile name   resolve remote auth through the configured OAuth broker provider
  --args json            command arguments as a JSON array of strings
  --cwd path            working directory
  --priority n          routing priority, higher wins
  --capabilities "a,b"  declared evidence capabilities
  --profile name        profile this upstream belongs to
  --disabled            register without enabling
  use --option=value when a value itself begins with --

global:
  --config path         config file; defaults to MOTTAINAI_CONFIG or ./mottainai.config.json

init options:
  --workspace path      workspace root; defaults to Git root or current directory
  --scope personal|project
  --client claude|codex|none
  --import claude|codex|none
  --yes                  use non-interactive safe defaults
  --force                back up and replace an existing configuration
  --dry-run              preview changes without writing files
  --json                 emit one JSON document
  --no-register          do not change MCP client registrations
  --no-doctor            skip post-initialization diagnostics
  --latest               register the unpinned npm package

policy/task options:
  --workspace path      Git repository root; defaults to the current Git repository's top level
  --type type           explicit branch type for "task start/run" (required)
  --issue ref           issue reference for "task start/run" (required)
  --agent agent         Manager profile for "task run" (required)
  --model model         optional Manager model for "task run"
  --instruction text    optional agent instruction for "task run"
  --task-id id          explicit task id; omitted only when current worktree identity is unique
  --idempotency-key key retry key for create/cleanup operations
  --dry-run              validate and show the write plan without mutation

hooks options:
  --client claude|codex|all target one client (default: all)
  --mode observe|warn|enforce set the managed rollout mode for install/repair
`;

const RUNTIME_DEPRECATION_MESSAGE =
  "The npm CLI no longer provides `mottainai runtime ensure/status`; local Runtime lifecycle is owned by the standalone " +
  "`mottainai-init` artifact. Use `mottainai-init runtime ensure --spec PATH [--json]`. The command exits before reading " +
  "or writing legacy Runtime state.";

interface FlagValue {
  found: boolean;
  inline: boolean;
  value?: string;
}

function findFlag(argv: string[], name: string): FlagValue {
  const option = `--${name}`;
  const inlinePrefix = `${option}=`;
  const index = argv.findIndex((argument) => argument === option || argument.startsWith(inlinePrefix));
  if (index === -1) return { found: false, inline: false };
  const argument = argv[index];
  if (argument.startsWith(inlinePrefix))
    return { found: true, inline: true, value: argument.slice(inlinePrefix.length) };
  return { found: true, inline: false, value: argv[index + 1] };
}

function flag(argv: string[], name: string): string | undefined {
  return findFlag(argv, name).value;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** `--name` が渡された場合、値が欠落または別 flag に見える（`--` 始まり）なら fail する。
 * `--name=value` は option-looking な値を明示的に渡す transport として許可する。
 * 素の `flag()` はそのまま返すため、`--workspace` 抜けが cwd への静かな fallback に、
 * `--workspace --issue 12` が `--issue` を workspace 値として誤読することにつながる
 * （`task start` は worktree/branch を作るため、誤った workspace への書き込みになる）。 */
function requireFlagValue(argv: string[], name: string): string | undefined {
  const parsed = findFlag(argv, name);
  if (!parsed.found) return undefined;
  if (
    parsed.value === undefined ||
    (parsed.inline && parsed.value === "") ||
    (!parsed.inline && parsed.value.startsWith("--"))
  )
    fail(`missing value for --${name}`);
  return parsed.value;
}

const INVALID_ARGS_MESSAGE =
  'invalid --args: expected a JSON array of strings (for example, --args=\'["one","two"]\'); ' +
  "legacy whitespace-separated values are no longer accepted";

function parseCommandArgs(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(INVALID_ARGS_MESSAGE);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    fail(INVALID_ARGS_MESSAGE);
  }
  return parsed;
}

const INVALID_PRIORITY_MESSAGE = `invalid --priority: expected a finite non-negative safe integer between 0 and ${Number.MAX_SAFE_INTEGER}`;

function parsePriority(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") fail(INVALID_PRIORITY_MESSAGE);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed < 0) {
    fail(INVALID_PRIORITY_MESSAGE);
  }
  return parsed;
}

function jsonFlag(argv: string[], name: string): unknown {
  const raw = requireFlagValue(argv, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    fail(`invalid JSON for --${name}`);
  }
}

function csvFlag(argv: string[], name: string): string[] | undefined {
  const raw = requireFlagValue(argv, name);
  if (raw === undefined) return undefined;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) fail(`--${name} must contain at least one value`);
  return values;
}

function gitTopLevel(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** `--workspace` 明示時はそれを、無ければ現在の Git リポジトリの top level を、
 * どちらも無ければ cwd をそのまま使う（`init` の `--workspace` 既定と同じ考え方）。 */
function resolveWorkflowWorkspace(argv: string[]): string {
  const explicit = requireFlagValue(argv, "workspace");
  if (explicit !== undefined) return path.resolve(process.cwd(), explicit);
  return gitTopLevel(process.cwd()) ?? process.cwd();
}

/**
 * `task start`/`task status` が使う `WorkflowStateStore`。MCP 面（`mottainai_workflow_task_*`）
 * と同じ既定 DB ファイルを開く（`src/workflow/state/sqlite-store.ts` の
 * `resolveStateDbPath` 共有）ため、CLI から始めた task を MCP 経由でも見える。
 * `node:sqlite` の import は `ExperimentalWarning` を stderr に出す副作用があるため、
 * `policy`/`list`/`init` 等このコマンドを使わない CLI 呼び出しに static import で
 * 持ち込まない — 実際に `task` サブコマンドが呼ばれたときだけ dynamic import する。
 */
async function openWorkflowStateStore(dbPath?: string, readOnly = false): Promise<WorkflowStateStore> {
  const { WorkflowSqliteStateStore } = await import("./workflow/state/sqlite-store.js");
  const resolvedDbPath = dbPath ?? resolveStateDbPath();
  let storeOptions: { dbPath?: string; readOnly?: boolean };
  if (readOnly) {
    if (fs.existsSync(resolvedDbPath)) {
      storeOptions = { dbPath: resolvedDbPath, readOnly: true };
    } else {
      storeOptions = { dbPath: ":memory:" };
    }
  } else if (dbPath === undefined) {
    storeOptions = {};
  } else {
    storeOptions = { dbPath };
  }
  const store = new WorkflowSqliteStateStore(storeOptions);
  store.init();
  return store;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("");
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/u.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function dispatcherCommand(entryPoint: string | undefined): string {
  if (entryPoint === undefined) return "mottainai";
  const resolvedEntryPoint = path.isAbsolute(entryPoint) ? entryPoint : path.resolve(process.cwd(), entryPoint);
  if (resolvedEntryPoint.endsWith(".js")) return `${shellWord(process.execPath)} ${shellWord(resolvedEntryPoint)}`;
  if (resolvedEntryPoint.endsWith(".ts"))
    return `${shellWord(process.execPath)} --import tsx ${shellWord(resolvedEntryPoint)}`;
  return "mottainai";
}

/**
 * Local replacements are only considered usable when the gateway can load the
 * configuration for this repository. The source-level tool list alone is not a
 * capability claim: an unavailable/invalid runtime must fail open for native
 * operations rather than redirecting the client into a dead end.
 */
function exposedHookTools(workspaceRoot: string, configPath?: string): ReadonlySet<string> {
  try {
    loadConfigSnapshot(configPath, workspaceRoot);
    return new Set(localTools.map((tool) => tool.name));
  } catch {
    return new Set();
  }
}

function hookContext(
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv,
  entryPoint?: string,
  configPath?: string,
): HookCommandContext {
  const resolvedConfigPath = configPath === undefined ? undefined : path.resolve(process.cwd(), configPath);
  const effectiveConfigPath = resolvedConfigPath ?? path.join(path.resolve(workspaceRoot), "mottainai.config.json");
  const dispatcher = dispatcherCommand(entryPoint);
  const dispatcherArguments = [
    "--workspace",
    workspaceRoot,
    ...(resolvedConfigPath === undefined ? [] : ["--config", resolvedConfigPath]),
  ];
  return {
    workspaceRoot,
    homeDirectory: environment.HOME ?? environment.USERPROFILE ?? workspaceRoot,
    environment,
    dispatcherCommand: dispatcher,
    dispatcherArguments,
    exposedTools: exposedHookTools(workspaceRoot, resolvedConfigPath),
    managedCapability: verifyManagedCapabilityRegistration({
      workspaceRoot,
      homeDirectory: environment.HOME ?? environment.USERPROFILE ?? workspaceRoot,
      configPath: effectiveConfigPath,
      dispatcherCommand: dispatcher,
    }),
    configPath: resolvedConfigPath,
    workflowProvider: createWorkflowHookProvider({ workspaceRoot, nawabari: new NawabariExecutionClient() }),
  };
}

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

/** 検証エラーは CLI のエラー形式で返す。設定ファイルは不正なら書き換わっていない。 */
function persist(filePath: string, raw: Record<string, unknown>): void {
  try {
    saveRawConfig(filePath, raw);
  } catch (error) {
    fail(`config would be invalid, nothing written: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function servers(raw: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const existing = raw.mcpServers;
  if (existing === undefined) {
    const created: Record<string, Record<string, unknown>> = {};
    raw.mcpServers = created;
    return created;
  }
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    fail("invalid mcpServers config");
  }
  return existing as Record<string, Record<string, unknown>>;
}

function gateway(raw: Record<string, unknown>): Record<string, unknown> {
  const existing = raw.gateway;
  if (existing === undefined) {
    const created: Record<string, unknown> = {};
    raw.gateway = created;
    return created;
  }
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    fail("invalid gateway config");
  }
  return existing as Record<string, unknown>;
}

function upstreamOrFail(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  const upstream = servers(raw)[name];
  if (upstream === undefined) fail(`unknown upstream: ${name}`);
  return upstream;
}

function summarize(config: MottainaiConfig, filePath: string): unknown {
  return {
    config_file: filePath,
    version: config.version,
    active_profile: config.gateway?.activeProfile,
    profiles: Object.keys(config.profiles ?? {}),
    upstreams: Object.entries(config.mcpServers).map(([name, upstream]) => ({
      name,
      transport: upstream.transport ?? "stdio",
      ...(upstream.command === undefined ? {} : { command: upstream.command }),
      ...(upstream.url === undefined ? {} : { url: upstream.url }),
      ...(upstream.auth === undefined ? {} : { auth: upstream.auth }),
      enabled: upstream.enabled !== false,
      priority: upstream.priority ?? 0,
      profile: upstream.profile,
      capabilities: upstream.capabilities ?? [],
    })),
  };
}

function semanticMode(argv: string[]): SemanticEnforcementMode | undefined {
  const value = requireFlagValue(argv, "mode");
  return value === undefined ? undefined : parseSemanticEnforcementMode(value);
}

function readSemanticSnapshot(argv: string[], name: string): RepositorySemanticSnapshot | undefined {
  const file = requireFlagValue(argv, name);
  if (file === undefined) return undefined;
  const serialized = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
  const parsed = JSON.parse(serialized) as unknown;
  const validation = validateSnapshot(parsed);
  if (!validation.ok)
    fail(`${name} is not a valid semantic snapshot: ${validation.diagnostics.map((item) => item.code).join(",")}`);
  return validation.snapshot;
}

function semanticPaths(argv: string[]): string[] | undefined {
  return csvFlag(argv, "managed-paths") ?? csvFlag(argv, "managed-path");
}

async function runSemanticCommand(action: string | undefined, argv: string[]): Promise<number> {
  if (action === undefined) fail(USAGE);
  const workspace = resolveWorkflowWorkspace(argv);
  const mode = semanticMode(argv) ?? configuredSemanticEnforcementMode(process.env);
  const baselineRef = requireFlagValue(argv, "base-ref") ?? process.env.GITHUB_BASE_REF;
  const managedPaths = semanticPaths(argv);
  const managedSymbolIds = csvFlag(argv, "managed-symbol-ids") ?? csvFlag(argv, "managed-symbol-id");
  const baseSnapshot = readSemanticSnapshot(argv, "base-snapshot");
  if (action === "transaction") {
    const requestFile = requireFlagValue(argv, "request-file");
    if (requestFile === undefined) fail("semantic transaction requires --request-file");
    const request = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), requestFile), "utf8"),
    ) as SemanticMutationRequest;
    const result = await applySemanticTransaction(workspace, request);
    print({
      ok: result.ok,
      ...(result.ok
        ? {
            transaction: result.transaction,
            affectedEntities: result.affectedEntities,
            protectedChanges: result.protectedChanges,
            writes: result.writes.map((write) => ({ path: write.path, operation: write.operation })),
          }
        : { diagnostics: result.diagnostics }),
    });
    return result.ok ? 0 : 1;
  }
  const report = await evaluateSemanticEnforcement({
    rootDir: workspace,
    ...(baselineRef === undefined ? {} : { baselineRef }),
    ...(mode === undefined ? {} : { mode }),
    ...(baseSnapshot === undefined ? {} : { baseSnapshot }),
    ...(managedPaths === undefined ? {} : { managedPaths }),
    ...(managedSymbolIds === undefined ? {} : { managedSymbolIds: managedSymbolIds as LogicalId[] }),
    commentZero: action === "migrate" || !hasFlag(argv, "no-comment-zero"),
  });
  if (action === "context") {
    const id = requireFlagValue(argv, "id");
    if (id === undefined) fail("semantic context requires --id");
    if (!report.authoritative) {
      print({ ok: false, error: "semantic context is not authoritative", report });
      return 1;
    }
    const loaded = await loadSemanticSource(workspace);
    const compiled = compileRepositoryModel({
      rootDir: workspace,
      ...(loaded.ok ? { declarations: loaded.snapshot.declarations } : {}),
    });
    if (compiled.snapshot === undefined) {
      print({ ok: false, error: "live semantic query unavailable", diagnostics: compiled.diagnostics });
      return 1;
    }
    const context = compiled.query.getAgentContext(id);
    print({
      ok: true,
      report: {
        decision: report.decision,
        authoritative: report.authoritative,
        integrity: report.integrity,
        review: report.review,
      },
      context,
    });
    return 0;
  }
  if (action === "migrate") {
    print({
      ok: report.blockers.length === 0,
      proposalOnly: true,
      message:
        "Migration proposes structured semantic debt; apply an explicit mutation transaction, review, then remove comments through a separate source change.",
      debtProposals: proposeSemanticDebt(report.comments),
      report,
    });
    return report.mode === "enforce" && report.blockers.length > 0 ? 1 : 0;
  }
  if (action === "diff") {
    print({
      apiVersion: report.apiVersion,
      mode: report.mode,
      decision: report.decision,
      authoritative: report.authoritative,
      diff: report.diff,
      transaction: report.transaction,
      blockers: report.blockers,
      warnings: report.warnings,
    });
    return report.mode === "enforce" && report.decision === "block" ? 1 : 0;
  }
  if (action === "review") {
    print({
      apiVersion: report.apiVersion,
      mode: report.mode,
      decision: report.decision,
      authoritative: report.authoritative,
      review: report.review,
      diff: report.diff,
      verification: report.verification,
      effects: report.effects,
      blockers: report.blockers,
      warnings: report.warnings,
    });
    return report.mode === "enforce" && report.decision === "block" ? 1 : 0;
  }
  print(report);
  return report.mode === "enforce" && report.decision === "block" ? 1 : 0;
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const [command = "list", ...argv] = args;
    const configPath = requireFlagValue(argv, "config");
    const runtimeOptions = {
      cwd: process.cwd(),
      environment: process.env,
      entryPoint: process.argv[1],
    };

    if (command === "init") {
      const summary = await runInit({
        args: argv,
      });
      if (hasFlag(argv, "json")) print(summary);
      else console.log(formatInitHuman(summary));
      return summary.ok ? 0 : 1;
    } else if (command === "runtime") {
      if (hasFlag(argv, "help")) {
        console.log(RUNTIME_DEPRECATION_MESSAGE);
        return 0;
      }
      fail(RUNTIME_DEPRECATION_MESSAGE);
    } else if (command === "semantic") {
      return runSemanticCommand(argv[0], argv.slice(1));
    } else if (command === "dashboard") {
      const dashboardOptions = parseDashboardOptions(argv);
      const dashboard = await startDashboard({
        ...dashboardOptions,
        environment: process.env,
        browserOpener: dashboardOptions.noOpen ? undefined : (url) => openDashboardBrowser(url, process.platform),
      });
      console.log(`Mottainai dashboard listening at ${dashboard.url}`);
      return 0;
    } else if (command === "manager") {
      const managerOptions = parseManagerOptions(argv);
      const manager = await startManager({
        ...managerOptions,
        environment: process.env,
        browserOpener: managerOptions.noOpen ? undefined : (url) => openManagerBrowser(url, process.platform),
      });
      console.log(`Mottainai manager listening at ${manager.url}`);
      return 0;
    } else if (command === "serve") {
      const configIndex = argv.indexOf("--config");
      if (configIndex !== -1 && argv[configIndex + 1] === undefined) fail("missing value for --config");
      await runServer(
        configPath,
        runtimeOptions.cwd,
        createRuntimeDiagnostic({ ...runtimeOptions, configPath }),
        runtimeOptions.environment.HOME ?? runtimeOptions.environment.USERPROFILE,
      );
    } else if (command === "list") {
      const filePath = resolveConfigPath(configPath);
      print(summarize(loadMottainaiConfig(configPath), filePath));
    } else if (command === "inspect") {
      const name = argv[0];
      if (name === undefined) fail(USAGE);
      const config = loadMottainaiConfig(configPath);
      const upstream = config.mcpServers[name];
      if (upstream === undefined) fail(`unknown upstream: ${name}`);
      print({ name, ...upstream });
    } else if (command === "add") {
      const name = argv[0];
      const commandValue = requireFlagValue(argv, "command");
      const urlValue = requireFlagValue(argv, "url");
      const transportValue = requireFlagValue(argv, "transport");
      const argsValue = requireFlagValue(argv, "args");
      const cwd = requireFlagValue(argv, "cwd");
      const priority = parsePriority(requireFlagValue(argv, "priority"));
      const capabilitiesValue = requireFlagValue(argv, "capabilities");
      const profile = requireFlagValue(argv, "profile");
      const authProfile = requireFlagValue(argv, "auth-profile");
      const transport = transportValue ?? (urlValue === undefined ? "stdio" : "streamableHttp");
      if (transport !== "stdio" && transport !== "streamableHttp") fail(USAGE);
      if (
        name === undefined ||
        name.startsWith("--") ||
        (transport === "stdio" ? commandValue === undefined : urlValue === undefined)
      ) {
        fail(USAGE);
      }
      const commandArgs = parseCommandArgs(argsValue);
      const capabilities = capabilitiesValue
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (authProfile !== undefined && transport !== "streamableHttp") fail(USAGE);
      const { filePath, raw } = loadRawConfig(configPath);
      const registry = servers(raw);
      if (registry[name] !== undefined) fail(`upstream already exists: ${name}`);
      registry[name] = {
        ...(transport === "stdio" ? { command: commandValue } : { transport, url: urlValue }),
        ...(authProfile === undefined ? {} : { auth: { type: "oauth", profile: authProfile } }),
        ...(commandArgs === undefined ? {} : { args: commandArgs }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(profile === undefined ? {} : { profile }),
        ...(priority !== undefined ? { priority } : {}),
        ...(capabilities !== undefined && capabilities.length > 0 ? { capabilities } : {}),
        ...(hasFlag(argv, "disabled") ? { enabled: false } : {}),
      };
      persist(filePath, raw);
      print({ added: name, config_file: filePath, upstream: registry[name] });
    } else if (command === "remove") {
      const name = argv[0];
      if (name === undefined) fail(USAGE);
      const { filePath, raw } = loadRawConfig(configPath);
      upstreamOrFail(raw, name);
      delete servers(raw)[name];
      persist(filePath, raw);
      print({ removed: name, config_file: filePath });
    } else if (command === "enable" || command === "disable") {
      const name = argv[0];
      if (name === undefined) fail(USAGE);
      const { filePath, raw } = loadRawConfig(configPath);
      const upstream = upstreamOrFail(raw, name);
      upstream.enabled = command === "enable";
      persist(filePath, raw);
      print({ [command === "enable" ? "enabled" : "disabled"]: name, config_file: filePath });
    } else if (command === "profile") {
      const action = argv[0];
      const { filePath, raw } = loadRawConfig(configPath);
      if (action === "use") {
        const profile = argv[1];
        if (profile === undefined) fail(USAGE);
        gateway(raw).activeProfile = profile;
      } else if (action === "clear") {
        delete gateway(raw).activeProfile;
      } else {
        fail(USAGE);
      }
      persist(filePath, raw);
      print({ active_profile: gateway(raw).activeProfile ?? null, config_file: filePath });
    } else if (command === "doctor") {
      const report = collectDoctorReport({ configPath, runtime: runtimeOptions });
      if (hasFlag(argv, "json")) print(report);
      else console.log(formatDoctorHuman(report));
      return report.ok ? 0 : 1;
    } else if (command === "workflow" && argv[0] === "doctor") {
      const workspace = resolveWorkflowWorkspace(argv);
      const store = await openWorkflowStateStore();
      try {
        const report = await collectWorkflowDoctorReport({
          workspaceRoot: workspace,
          store,
          reconcileClosures: hasFlag(argv, "reconcile-closures"),
        });
        print({ workspace, ...report });
        return report.ok ? 0 : 1;
      } finally {
        store.close();
      }
    } else if (command === "hooks") {
      const action = argv[0];
      if (action === "dispatch") {
        const client = flag(argv, "client");
        if (client !== "claude" && client !== "codex") fail("hooks dispatch requires --client claude or codex");
        const workspace = resolveWorkflowWorkspace(argv);
        let payload: unknown;
        try {
          payload = JSON.parse(await readStdin());
        } catch {
          payload = undefined;
        }
        const result = await dispatchClientHook(
          client,
          payload,
          hookContext(workspace, runtimeOptions.environment, runtimeOptions.entryPoint, configPath),
        );
        if (result.stdout.length > 0) process.stdout.write(result.stdout);
        if (result.stderr.length > 0) process.stderr.write(result.stderr);
        return result.exitCode;
      }
      if (action === undefined) fail(USAGE);
      const workspace = resolveWorkflowWorkspace(argv);
      const result = runManagedHooksCommand(
        action,
        argv.slice(1),
        hookContext(workspace, runtimeOptions.environment, runtimeOptions.entryPoint, configPath),
      );
      print(result);
      return result.ok ? 0 : 1;
    } else if (command === "policy" && argv[0] === "explain") {
      const workspace = resolveWorkflowWorkspace(argv);
      const result = explainWorkflowPolicy(workspace);
      if (!result.ok) {
        print({ ok: false, workspace, error: result.reason });
        return 1;
      }
      print({ ok: true, workspace, ...result.explained });
    } else if (command === "task" && argv[0] === "run") {
      const taskSlug = argv[1];
      if (taskSlug === undefined || taskSlug.startsWith("--")) fail(USAGE);
      validateTaskSlug(taskSlug);
      const workspace = resolveWorkflowWorkspace(argv);
      const branchType = requireFlagValue(argv, "type");
      if (branchType === undefined) fail("missing value for --type");
      const issueRef = requireFlagValue(argv, "issue");
      if (issueRef === undefined) fail("missing value for --issue");
      validateIssueRef(issueRef);
      const agentKind = requireFlagValue(argv, "agent");
      if (agentKind === undefined) fail("missing value for --agent");
      const instruction = requireFlagValue(argv, "instruction") ?? defaultTaskRunInstruction(issueRef);
      const provider = requireFlagValue(argv, "provider");
      const model = requireFlagValue(argv, "model");
      const idempotencyKey = requireFlagValue(argv, "idempotency-key");
      const store = await openWorkflowStateStore();
      const nawabari = new NawabariExecutionClient();
      const manager = new ManagerSessionService({
        workspaceRoot: workspace,
        store,
        nawabari,
        runtime: new ZellijCliRuntime({
          cwd: workspace,
          environment: process.env,
          binary: process.env.MOTTAINAI_ZELLIJ_BINARY ?? "zellij",
        }),
      });
      try {
        const result = await runManagedTask({
          workspaceRoot: workspace,
          store,
          nawabari,
          manager,
          taskSlug,
          issueRef,
          branchType,
          agentKind,
          ...(provider === undefined ? {} : { provider }),
          ...(model === undefined ? {} : { model }),
          instruction,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
        print({ workspace, ...result });
        return result.ok ? 0 : 1;
      } finally {
        store.close();
      }
    } else if (command === "task" && argv[0] === "start") {
      const taskSlug = argv[1];
      if (taskSlug === undefined || taskSlug.startsWith("--")) fail(USAGE);
      validateTaskSlug(taskSlug);
      const workspace = resolveWorkflowWorkspace(argv);
      const branchType = requireFlagValue(argv, "type");
      if (branchType === undefined) fail("missing value for --type");
      const issueRef = requireFlagValue(argv, "issue");
      if (issueRef === undefined) fail("missing value for --issue");
      validateIssueRef(issueRef);
      const policyResult = resolveEffectiveWorkflowPolicy(workspace);
      if (!policyResult.ok) {
        print({ ok: false, workspace, error: policyResult.reason });
        return 1;
      }
      const dryRun = hasFlag(argv, "dry-run");
      // A preview reads an existing persistent database through a read-only
      // connection; when no database exists, openWorkflowStateStore falls back
      // to an ephemeral store without creating one.
      const store = await openWorkflowStateStore(undefined, dryRun);
      try {
        const started = await startNawabariTask({
          workspaceRoot: workspace,
          store,
          policy: policyResult.document,
          taskSlug,
          branchType,
          issueRef,
          idempotencyKey: flag(argv, "idempotency-key"),
          dryRun,
          nawabari: new NawabariExecutionClient(),
        });
        if (!started.ok) {
          print({ ok: false, workspace, reason: started.reason, error: started.detail });
          return 1;
        }
        if (started.dryRun === true) {
          print({
            ok: true,
            workspace,
            dryRun: true,
            plan: started.plan,
            semanticExecutionPlan: started.semanticPlan,
            warnings: started.warnings,
          });
          return 0;
        }
        const status = getTaskStatus(store, started.task.taskId);
        print({
          ok: true,
          workspace,
          task: started.task,
          execution: started.execution,
          semanticExecutionPlan: started.semanticPlan,
          warnings: started.warnings,
          pullRequests: status?.pullRequests ?? [],
          currentState: status?.currentState ?? started.task.lifecycleState,
          allowedNextTransitions: status?.allowedNextTransitions ?? [],
          invalidTransitions: status?.invalidTransitions ?? [],
        });
      } finally {
        store.close();
      }
    } else if (command === "task" && argv[0] === "list") {
      const store = await openWorkflowStateStore();
      try {
        print(listTaskDiscoverySnapshot(store));
        return 0;
      } finally {
        store.close();
      }
    } else if (command === "task" && argv[0] === "status") {
      const explicitTaskId = requireFlagValue(argv, "task-id");
      const store = await openWorkflowStateStore();
      try {
        if (explicitTaskId !== undefined) {
          // taskId だけを鍵にした cwd 非依存の fresh 解決（Issue #539）。既存の
          // `--workspace` 経路（下）とは独立し、その挙動には一切触れない。
          const result = await getTaskStatusById(store, explicitTaskId as TaskId, new NawabariExecutionClient());
          print(result);
          return result.ok ? 0 : 1;
        }
        const workspace = resolveWorkflowWorkspace(argv);
        const nawabari = new NawabariExecutionClient();
        try {
          const sessionId = await nawabari.currentSessionId(workspace);
          const externalTask = store.listTasks().find((task) => task.nawabariSessionId === sessionId);
          if (externalTask !== undefined) {
            const session = await nawabari.showSession({ cwd: workspace, sessionId });
            const status = getTaskStatus(store, externalTask.taskId);
            print({
              ok: true,
              workspace,
              task: externalTask,
              execution: {
                sessionId: session.sessionId,
                worktree: session.worktree,
                branch: session.branch,
                state: session.state,
              },
              pullRequests: status?.pullRequests ?? [],
              currentState: status?.currentState ?? externalTask.lifecycleState,
              allowedNextTransitions: status?.allowedNextTransitions ?? [],
              invalidTransitions: status?.invalidTransitions ?? [],
            });
            return 0;
          }
        } catch {
          // A non-Nawabari worktree has no external session; the read-only
          // Mottainai status projection remains useful in that case.
        }
        const result = await getTaskStatusForWorkspace(workspace, store);
        if (!result.ok) {
          print({ ok: false, workspace, error: result.reason });
          return 1;
        }
        const { ok: _ok, ...rest } = result;
        const statusDetails = result.active
          ? {
              task: result.status.task,
              worktrees: result.status.worktrees,
              pullRequests: result.status.pullRequests,
              currentState: result.status.currentState,
              allowedNextTransitions: result.status.allowedNextTransitions,
              invalidTransitions: result.status.invalidTransitions,
            }
          : {};
        print({ ok: true, workspace, ...rest, ...statusDetails });
      } finally {
        store.close();
      }
    } else if (command === "task" && argv[0] === "migrate-legacy") {
      const workspace = resolveWorkflowWorkspace(argv);
      const taskId = requireFlagValue(argv, "task-id");
      if (taskId === undefined) fail("task migrate-legacy requires --task-id");
      const mode = requireFlagValue(argv, "mode");
      if (mode !== "complete" && mode !== "adopt") fail("task migrate-legacy requires --mode complete or --mode adopt");
      const store = await openWorkflowStateStore();
      try {
        const result = await migrateLegacyWorkflowTask({
          workspaceRoot: workspace,
          store,
          taskId: taskId as never,
          mode,
          sessionId: flag(argv, "session-id"),
          nawabari: new NawabariExecutionClient(),
          dryRun: hasFlag(argv, "dry-run"),
        });
        print({ workspace, ...result });
        return result.ok ? 0 : 1;
      } finally {
        store.close();
      }
    } else if (
      command === "task" &&
      ["commit", "push", "open-pr", "finish", "abandon", "cleanup"].includes(argv[0] ?? "")
    ) {
      const action = argv[0]!;
      const workspace = resolveWorkflowWorkspace(argv);
      const policyResult = resolveEffectiveWorkflowPolicy(workspace);
      if (!policyResult.ok) {
        print({ ok: false, workspace, error: policyResult.reason });
        return 1;
      }
      const store = await openWorkflowStateStore();
      const taskId = requireFlagValue(argv, "task-id");
      const nawabari = new NawabariExecutionClient();
      const selector = { workspaceRoot: workspace, store, nawabari, ...(taskId === undefined ? {} : { taskId }) };
      const dryRun = hasFlag(argv, "dry-run");
      try {
        if (action === "commit") {
          const subject = requireFlagValue(argv, "message");
          if (subject === undefined) fail("missing value for --message");
          const result = await commitWorkflowTask({
            ...selector,
            policy: policyResult.document,
            message: {
              subject,
              type: flag(argv, "commit-type"),
              scope: flag(argv, "scope"),
              body: flag(argv, "message-body"),
              footer: flag(argv, "message-footer"),
              breaking: hasFlag(argv, "breaking"),
            },
            includePaths: csvFlag(argv, "include"),
            dryRun,
          });
          print({ workspace, ...result });
          return result.ok ? 0 : 1;
        }
        if (action === "push") {
          const result = await pushWorkflowTask({
            ...selector,
            policy: policyResult.document,
            remote: flag(argv, "remote"),
            remoteBranch: flag(argv, "remote-branch"),
            force: hasFlag(argv, "force"),
            createUpstream: hasFlag(argv, "create-upstream"),
            allowRemoteBehind: hasFlag(argv, "allow-remote-behind"),
            allowDiverged: hasFlag(argv, "allow-diverged"),
            dryRun,
          });
          print({ workspace, ...result });
          return result.ok ? 0 : 1;
        }
        if (action === "open-pr") {
          const title = requireFlagValue(argv, "title");
          if (title === undefined) fail("missing value for --title");
          const sectionsValue = jsonFlag(argv, "sections-json");
          if (
            sectionsValue !== undefined &&
            (typeof sectionsValue !== "object" || sectionsValue === null || Array.isArray(sectionsValue))
          ) {
            fail("--sections-json must be a JSON object");
          }
          const result = await openWorkflowTaskPullRequest({
            ...selector,
            policy: policyResult.document,
            title,
            repository: flag(argv, "repo"),
            issueReference: flag(argv, "issue-reference"),
            sections: sectionsValue as Record<string, string | readonly string[]> | undefined,
            acceptanceCriteria: csvFlag(argv, "acceptance-criteria"),
            providerDraft: hasFlag(argv, "provider-draft"),
            dryRun,
          });
          print({ workspace, ...result });
          return result.ok ? 0 : 1;
        }
        if (action === "finish") {
          const result = await finishWorkflowTask({ ...selector, policy: policyResult.document, dryRun });
          print({ workspace, ...result });
          return result.ok ? 0 : 1;
        }
        if (action === "abandon") {
          const result = await abandonWorkflowTask({ ...selector, policy: policyResult.document, dryRun });
          print({ workspace, ...result });
          return result.ok ? 0 : 1;
        }

        const planPath = requireFlagValue(argv, "plan-file");
        const plan =
          planPath === undefined
            ? undefined
            : (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), planPath), "utf8")) as CleanupPlan);
        const result = await cleanupWorkflowTask({
          ...selector,
          policy: policyResult.document,
          dryRun,
          idempotencyKey: flag(argv, "idempotency-key"),
          plan,
        });
        print({ workspace, ...result });
        return result.ok ? 0 : 1;
      } finally {
        store.close();
      }
    } else {
      fail(USAGE);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args[0] === "doctor" && hasFlag(args, "json")) {
      const problem = { severity: "error", message: `config invalid: ${message}` } as const;
      const identity = createRuntimeDiagnostic({
        cwd: process.cwd(),
        environment: process.env,
        entryPoint: process.argv[1],
        configPath: flag(args, "config"),
      });
      print({
        ok: false,
        errors: 1,
        warnings: 0,
        checks: [{ name: "config", status: "error", message: problem.message }],
        config_file: resolveConfigPath(flag(args, "config")),
        version: 0,
        checked: 0,
        problems: [problem],
        identity,
      });
    } else if (args[0] === "init" && hasFlag(args, "json")) {
      print({ ok: false, error: message });
    } else if (args[0] === "runtime" && hasFlag(args, "json")) {
      const code =
        typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;
      print({ ok: false, ...(code === undefined ? {} : { code }), error: message });
    } else {
      console.error(
        args[0] === "doctor"
          ? `${message}\n\nRuntime diagnostic:\n${formatRuntimeDiagnosticHuman(
              createRuntimeDiagnostic({
                cwd: process.cwd(),
                environment: process.env,
                entryPoint: process.argv[1],
                configPath: flag(args, "config"),
              }),
            )}`
          : message,
      );
    }
    return 1;
  }
}
