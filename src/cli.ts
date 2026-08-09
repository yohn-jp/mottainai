import { execFileSync } from "node:child_process";
import path from "node:path";
import { collectDoctorReport, formatDoctorHuman } from "./commands/doctor.js";
import { loadMottainaiConfig, loadRawConfig, resolveConfigPath, saveRawConfig } from "./config.js";
import type { MottainaiConfig } from "./config.js";
import { openDashboardBrowser, parseDashboardOptions, startDashboard } from "./dashboard/command.js";
import { formatInitHuman, runInit } from "./init.js";
import { createRuntimeDiagnostic, formatRuntimeDiagnosticHuman } from "./runtime-diagnostic.js";
import { runServer } from "./server.js";
import { validateIssueRef, validateTaskSlug } from "./workflow/commands/validate.js";
import { startTask, getTaskStatusForWorkspace } from "./workflow/domain/task.js";
import { explainWorkflowPolicy } from "./workflow/policy/explain.js";
import { resolveEffectiveWorkflowPolicy } from "./workflow/policy/load.js";
import type { WorkflowStateStore } from "./workflow/state/store.js";

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
  mottainai task status [--workspace path]       active Git workflow task for the current worktree

add options:
  --transport streamableHttp  remote transport; inferred from --url
  --auth-profile name   resolve remote auth through the configured OAuth broker provider
  --args "a b"          command arguments, split on spaces
  --cwd path            working directory
  --priority n          routing priority, higher wins
  --capabilities "a,b"  declared evidence capabilities
  --profile name        profile this upstream belongs to
  --disabled            register without enabling

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
  --type type           explicit branch type for "task start" (required)
  --issue ref           issue reference for "task start" (required)
`;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** `--name` が渡された場合、値が欠落または別 flag に見える（`--` 始まり）なら fail する。
 * 素の `flag()` はそのまま返すため、`--workspace` 抜けが cwd への静かな fallback に、
 * `--workspace --issue 12` が `--issue` を workspace 値として誤読することにつながる
 * （`task start` は worktree/branch を作るため、誤った workspace への書き込みになる）。 */
function requireFlagValue(argv: string[], name: string): string | undefined {
  if (!hasFlag(argv, name)) return undefined;
  const value = flag(argv, name);
  if (value === undefined || value.startsWith("--")) fail(`missing value for --${name}`);
  return value;
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
async function openWorkflowStateStore(): Promise<WorkflowStateStore> {
  const { WorkflowSqliteStateStore } = await import("./workflow/state/sqlite-store.js");
  const store = new WorkflowSqliteStateStore();
  store.init();
  return store;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

class CliError extends Error {}

function fail(message: string): never { throw new CliError(message); }

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

export async function runCli(args: string[]): Promise<number> {
  try {
    const [command = "list", ...argv] = args;
    const configPath = flag(argv, "config");
    const runtimeOptions = {
      cwd: process.cwd(),
      environment: process.env,
      entryPoint: process.argv[1],
    };

    if (command === "init") {
      const summary = await runInit({ args: argv });
      if (hasFlag(argv, "json")) print(summary);
      else console.log(formatInitHuman(summary));
      return summary.ok ? 0 : 1;
    } else if (command === "dashboard") {
      const dashboardOptions = parseDashboardOptions(argv);
      const dashboard = await startDashboard({
        ...dashboardOptions,
        environment: process.env,
        browserOpener: dashboardOptions.noOpen
          ? undefined
          : (url) => openDashboardBrowser(url, process.platform),
      });
      console.log(`Mottainai dashboard listening at ${dashboard.url}`);
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
  const commandValue = flag(argv, "command");
  const urlValue = flag(argv, "url");
  const transport = flag(argv, "transport") ?? (urlValue === undefined ? "stdio" : "streamableHttp");
  if (transport !== "stdio" && transport !== "streamableHttp") fail(USAGE);
  if (name === undefined || name.startsWith("--") || (transport === "stdio" ? commandValue === undefined : urlValue === undefined)) {
    fail(USAGE);
  }
  const { filePath, raw } = loadRawConfig(configPath);
  const registry = servers(raw);
  if (registry[name] !== undefined) fail(`upstream already exists: ${name}`);
  const args = flag(argv, "args")?.split(" ").filter(Boolean);
  const capabilities = flag(argv, "capabilities")?.split(",").map((value) => value.trim()).filter(Boolean);
  const priority = flag(argv, "priority");
  const authProfile = flag(argv, "auth-profile");
  if (authProfile !== undefined && transport !== "streamableHttp") fail(USAGE);
  registry[name] = {
    ...(transport === "stdio" ? { command: commandValue } : { transport, url: urlValue }),
    ...(authProfile === undefined ? {} : { auth: { type: "oauth", profile: authProfile } }),
    ...(args !== undefined && args.length > 0 ? { args } : {}),
    ...(flag(argv, "cwd") !== undefined ? { cwd: flag(argv, "cwd") } : {}),
    ...(flag(argv, "profile") !== undefined ? { profile: flag(argv, "profile") } : {}),
    ...(priority !== undefined ? { priority: Number(priority) } : {}),
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
} else if (command === "policy" && argv[0] === "explain") {
  const workspace = resolveWorkflowWorkspace(argv);
  const result = explainWorkflowPolicy(workspace);
  if (!result.ok) {
    print({ ok: false, workspace, error: result.reason });
    return 1;
  }
  print({ ok: true, workspace, ...result.explained });
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
  const store = await openWorkflowStateStore();
  try {
    // `skipWorktree` を渡さない — task lifecycle は常に専用 worktree/branch を作る
    // （main を含む現在の branch がそのまま work branch になることはない）。
    const started = await startTask({ workspaceRoot: workspace, store, policy: policyResult.document, taskSlug, branchType, issueRef });
    if (!started.ok) {
      print({ ok: false, workspace, reason: started.reason, error: started.detail });
      return 1;
    }
    print({ ok: true, workspace, task: started.task, worktree: started.worktree, warnings: started.warnings });
  } finally {
    store.close();
  }
} else if (command === "task" && argv[0] === "status") {
  const workspace = resolveWorkflowWorkspace(argv);
  const store = await openWorkflowStateStore();
  try {
    const result = await getTaskStatusForWorkspace(workspace, store);
    if (!result.ok) {
      print({ ok: false, workspace, error: result.reason });
      return 1;
    }
    const { ok: _ok, ...rest } = result;
    print({ ok: true, workspace, ...rest });
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
    } else {
      console.error(args[0] === "doctor"
        ? `${message}\n\nRuntime diagnostic:\n${formatRuntimeDiagnosticHuman(createRuntimeDiagnostic({
          cwd: process.cwd(),
          environment: process.env,
          entryPoint: process.argv[1],
          configPath: flag(args, "config"),
        }))}`
        : message);
    }
    return 1;
  }
}
