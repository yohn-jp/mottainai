import { collectDoctorReport, formatDoctorHuman } from "./commands/doctor.js";
import { loadMottainaiConfig, loadRawConfig, resolveConfigPath, saveRawConfig } from "./config.js";
import type { MottainaiConfig } from "./config.js";
import { runServer } from "./server.js";

/**
 * upstream と profile の管理 CLI。
 *
 * クライアント側の設定ファイルを編集させず、mottainai の設定ファイルだけを唯一の
 * 設定先にするための入口。gateway プロセスを起動しないので、常駐中でも実行できる。
 */

const USAGE = `usage:
  mottainai                                      start the MCP stdio server
  mottainai serve                                start the MCP stdio server explicitly
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
`;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
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

if (command === "serve") {
  const configIndex = argv.indexOf("--config");
  if (configIndex !== -1 && argv[configIndex + 1] === undefined) fail("missing value for --config");
  await runServer(configPath);
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
  const report = collectDoctorReport({ configPath });
  if (hasFlag(argv, "json")) print(report);
  else console.log(formatDoctorHuman(report));
  return report.ok ? 0 : 1;
} else {
  fail(USAGE);
}
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args[0] === "doctor" && hasFlag(args, "json")) {
      const problem = { severity: "error", message: `config invalid: ${message}` } as const;
      print({
        ok: false,
        errors: 1,
        warnings: 0,
        checks: [{ name: "config", status: "error", message: problem.message }],
        config_file: resolveConfigPath(flag(args, "config")),
        version: 0,
        checked: 0,
        problems: [problem],
      });
    } else {
      console.error(message);
    }
    return 1;
  }
}
