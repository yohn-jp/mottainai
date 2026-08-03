import fs from "node:fs";
import path from "node:path";
import { loadMottainaiConfig, loadRawConfig, resolveConfigPath, saveRawConfig } from "../src/config.js";
import type { MottainaiConfig } from "../src/config.js";

/**
 * upstream と profile の管理 CLI。
 *
 * クライアント側の設定ファイルを編集させず、mottainai の設定ファイルだけを唯一の
 * 設定先にするための入口。gateway プロセスを起動しないので、常駐中でも実行できる。
 */

const USAGE = `usage:
  pnpm run mcp list                              registered upstreams and profiles
  pnpm run mcp inspect <name>                    one upstream with defaults applied
  pnpm run mcp add <name> --command c [options]  register a stdio upstream
  pnpm run mcp add <name> --url u [options]      register a remote upstream
  pnpm run mcp remove <name>                     drop an upstream
  pnpm run mcp enable <name>                     set enabled true
  pnpm run mcp disable <name>                    set enabled false
  pnpm run mcp profile use <profile>             set gateway.activeProfile
  pnpm run mcp profile clear                     unset gateway.activeProfile
  pnpm run mcp doctor                            validate the config file

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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
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

/** PATH 上か、区切りを含むならファイルとして、実行可能かを見る。 */
function resolveCommand(command: string, cwd: string): string | undefined {
  if (command.includes(path.sep) || command.startsWith(".")) {
    const candidate = path.resolve(cwd, command);
    return isExecutable(candidate) ? candidate : undefined;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
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

const [command = "list", ...argv] = process.argv.slice(2);
const configPath = flag(argv, "config");

if (command === "list") {
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
  const filePath = resolveConfigPath(configPath);
  let config: MottainaiConfig;
  try {
    config = loadMottainaiConfig(configPath);
  } catch (error) {
    fail(`config invalid: ${error instanceof Error ? error.message : String(error)} (${filePath})`);
  }
  const cwd = path.dirname(filePath);
  const problems: Array<{ severity: string; upstream?: string; message: string }> = [];
  const enabled = Object.entries(config.mcpServers).filter(([, upstream]) => upstream.enabled !== false);
  if (enabled.length === 0) {
    problems.push({ severity: "warning", message: "no upstream is enabled; only local tools will be served" });
  }
  for (const [name, upstream] of enabled) {
    if (upstream.transport === "streamableHttp") {
      if (upstream.auth?.type === "oauth" && config.gateway?.oauthProviderModule === undefined) {
        problems.push({ severity: "error", upstream: name, message: "oauth provider module missing" });
      }
      for (const [header, environmentName] of Object.entries(upstream.headersFromEnv ?? {})) {
        if (process.env[environmentName] === undefined) {
          problems.push({ severity: "error", upstream: name, message: `header environment missing: ${header} <- ${environmentName}` });
        }
      }
    } else if (upstream.command === undefined || resolveCommand(upstream.command, cwd) === undefined) {
      problems.push({ severity: "error", upstream: name, message: `command not executable: ${upstream.command ?? ""}` });
    }
    if (upstream.cwd !== undefined && !fs.existsSync(path.resolve(cwd, upstream.cwd))) {
      problems.push({ severity: "error", upstream: name, message: `cwd does not exist: ${upstream.cwd}` });
    }
    if ((upstream.capabilities ?? []).length === 0) {
      problems.push({ severity: "warning", upstream: name, message: "no declared capabilities; routing falls back to unspecified" });
    }
  }
  const errors = problems.filter((problem) => problem.severity === "error");
  print({ config_file: filePath, version: config.version, checked: enabled.length, problems });
  if (errors.length > 0) process.exit(1);
} else {
  console.error(USAGE);
  process.exit(1);
}
