import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import packageMetadata from "../package.json" with { type: "json" };
import { addSecondaryDiagnostic, DIRECT_BOUNDARIES } from "./boundary.js";
import type { BoundaryOperations } from "./boundary.js";
import { collectDoctorReport, formatDoctorHuman } from "./commands/doctor.js";
import { resolveConfigPath, saveRawConfig } from "./config.js";
import type { DoctorReport } from "./commands/doctor.js";
import type { LocalRuntimeEnsureOptions, LocalRuntimeEnsureResult } from "./local-runtime/types.js";

export interface LocalRuntimeEnsurer {
  ensure(options?: LocalRuntimeEnsureOptions): Promise<LocalRuntimeEnsureResult>;
}

export type InitScope = "personal" | "project";
export type InitClient = "claude" | "codex" | "none";
export type InitImportSource = InitClient;

export interface InitRunOptions {
  args: string[];
  cwd?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  /** Internal fault-test seam; runtime configuration never supplies this. */
  boundaries?: BoundaryOperations;
  /**
   * CLI supplies the canonical local Runtime provisioner only when the user
   * opts in with `--runtime`, so MCP-only setup keeps working on hosts
   * without a hardware accelerator; tests can inject a hermetic fake.
   */
  localRuntime?: LocalRuntimeEnsurer;
  localRuntimeOptions?: LocalRuntimeEnsureOptions;
}

export interface InitClientResult {
  name: InitClient;
  available: boolean;
  registrationCommand: string;
  status: "not-requested" | "registered" | "already-registered" | "unavailable" | "list-failed" | "failed";
  timed_out?: boolean;
}

export interface InitHandshakeResult {
  ok: boolean;
  tools?: number;
  skipped?: boolean;
  timed_out?: boolean;
  reason?: string;
}

export interface InitSummary {
  ok: boolean;
  workspace: string;
  configuration: string;
  scope: InitScope;
  dry_run: boolean;
  config_written: boolean;
  config_preview: Record<string, unknown>;
  backup?: string;
  detected_clients: InitClient[];
  detected_commands: string[];
  imported_upstreams: string[];
  clients: InitClientResult[];
  doctor?: DoctorReport;
  handshake?: InitHandshakeResult;
  warnings: string[];
  runtime?: LocalRuntimeEnsureResult;
}

interface InitArguments {
  workspace?: string;
  config?: string;
  scope?: InitScope;
  client?: InitClient;
  importSource?: InitImportSource;
  yes: boolean;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  noRegister: boolean;
  noDoctor: boolean;
  latest: boolean;
  upstreamMode?: "none" | "import" | "detect" | "manual";
  selectedCommands: string[];
  manualUpstreams: ImportedServer[];
}

interface ImportedServer {
  name: string;
  config: Record<string, unknown>;
}

interface ImportedRegistrationResult {
  server?: ImportedServer;
  warnings: string[];
}

interface SanitizedArguments {
  args: string[];
  rejected: boolean;
}

interface ClientListResult {
  output: string;
  commandAvailable: boolean;
  successful: boolean;
  timedOut: boolean;
}

const KNOWN_COMMANDS = ["codegraph", "fff-mcp", "rg"] as const;
const INIT_OPERATION_TIMEOUT_MS = 10_000;

const COMMAND_PRESETS: Record<string, Record<string, unknown>> = {
  codegraph: { command: "codegraph", args: ["serve", "--mcp", "--path", "."] },
  "fff-mcp": { command: "fff-mcp", args: ["."] },
};

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${name}`);
  return value;
}

function hasOption(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function parseArguments(args: string[]): InitArguments {
  const scopeValue = optionValue(args, "scope");
  if (scopeValue !== undefined && scopeValue !== "personal" && scopeValue !== "project") {
    throw new Error("invalid --scope; expected personal or project");
  }
  const clientValue = optionValue(args, "client");
  if (clientValue !== undefined && clientValue !== "claude" && clientValue !== "codex" && clientValue !== "none") {
    throw new Error("invalid --client; expected claude, codex or none");
  }
  const importValue = optionValue(args, "import");
  if (importValue !== undefined && importValue !== "claude" && importValue !== "codex" && importValue !== "none") {
    throw new Error("invalid --import; expected claude, codex or none");
  }
  return {
    workspace: optionValue(args, "workspace"),
    config: optionValue(args, "config"),
    scope: scopeValue as InitScope | undefined,
    client: clientValue as InitClient | undefined,
    importSource: importValue as InitImportSource | undefined,
    yes: hasOption(args, "yes"),
    force: hasOption(args, "force"),
    dryRun: hasOption(args, "dry-run"),
    json: hasOption(args, "json"),
    noRegister: hasOption(args, "no-register"),
    noDoctor: hasOption(args, "no-doctor"),
    latest: hasOption(args, "latest"),
    selectedCommands: [],
    manualUpstreams: [],
  };
}

function commandPath(command: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const directory of (environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) {
        return candidate;
      }
    } catch {
      // 初期化中にPATHエントリが消える場合がある。
    }
  }
  return undefined;
}

function spawnClientCommand(executable: string, args: string[]) {
  return spawnSync(executable, args, {
    encoding: "utf8",
    timeout: INIT_OPERATION_TIMEOUT_MS,
  });
}

function detectClients(): InitClient[] {
  return (["claude", "codex"] as const).filter((client) => commandPath(client) !== undefined);
}

function detectCommands(): string[] {
  return KNOWN_COMMANDS.filter((command) => commandPath(command) !== undefined);
}

function gitRoot(start: string): string | undefined {
  try {
    return execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveWorkspace(explicit: string | undefined, cwd: string): string {
  const workspace = path.resolve(cwd, explicit ?? gitRoot(cwd) ?? cwd);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`workspace does not exist: ${workspace}`);
  }
  return workspace;
}

function resolveConfiguration(explicit: string | undefined, workspace: string, cwd: string): string {
  const resolutionCwd = explicit === undefined && process.env.MOTTAINAI_CONFIG === undefined ? workspace : cwd;
  return resolveConfigPath(explicit, resolutionCwd);
}

function relativeWorkspace(configPath: string, workspace: string): string {
  const relative = path.relative(path.dirname(configPath), workspace);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function baseConfig(configPath: string, workspace: string): Record<string, unknown> {
  return {
    version: 2,
    mcpServers: {},
    gateway: { workspaceRoot: relativeWorkspace(configPath, workspace) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function safeEnvironmentName(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(value);
}

function sensitiveArgument(value: string): boolean {
  return /(?:token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i.test(value);
}

function containsSecret(argument: string): boolean {
  return sensitiveArgument(argument) || /^Bearer\s+/i.test(argument) || /^(?:token|secret|password)=/i.test(argument);
}

/** 1個でも秘密値らしきトークンがあれば、その登録全体を拒否する（一部だけ落として壊れた引数列を残さない）。 */
export function sanitizeArguments(value: unknown): SanitizedArguments | undefined {
  const original = stringArray(value);
  if (original === undefined) return undefined;
  const rejected = original.some((argument) => containsSecret(argument));
  return { args: rejected ? [] : original, rejected };
}

export function safeRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    if (parsed.hash !== "") return false;
    if (parsed.search !== "") return false;
    return true;
  } catch {
    return false;
  }
}

function importedRegistration(name: string, value: unknown): ImportedRegistrationResult {
  if (name === "mottainai" || !isRecord(value)) return { warnings: [] };
  const url = typeof value.url === "string" ? value.url : undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  if (url === undefined && command === undefined) return { warnings: [] };
  if (url !== undefined && !safeRemoteUrl(url)) {
    return {
      warnings: [
        `${name} was not imported because its URL is not a plain http(s) URL without credentials or query/fragment data`,
      ],
    };
  }

  const sanitizedArguments = sanitizeArguments(value.args);
  if (sanitizedArguments?.rejected === true) {
    return { warnings: [`${name} was not imported because its arguments contain credentials`] };
  }

  const warnings: string[] = [];
  const isHttps = url !== undefined && new URL(url).protocol === "https:";
  if (url !== undefined && !isHttps && (isRecord(value.auth) || isRecord(value.headersFromEnv))) {
    warnings.push(`${name} auth/header configuration was not copied because its URL is not https`);
  }

  const imported: Record<string, unknown> =
    url === undefined
      ? {
          command,
          ...(sanitizedArguments === undefined || sanitizedArguments.args.length === 0
            ? {}
            : { args: sanitizedArguments.args }),
          ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
        }
      : {
          transport: "streamableHttp",
          url,
          ...(isHttps && isRecord(value.auth) && value.auth.type === "oauth" && typeof value.auth.profile === "string"
            ? { auth: { type: "oauth", profile: value.auth.profile } }
            : {}),
        };
  const capabilities = stringArray(value.capabilities);
  if (capabilities !== undefined) imported.capabilities = capabilities;
  if (typeof value.enabled === "boolean") imported.enabled = value.enabled;

  if (isHttps && isRecord(value.headersFromEnv)) {
    const headersFromEnv: Record<string, string> = {};
    for (const [header, environmentName] of Object.entries(value.headersFromEnv)) {
      if (typeof environmentName === "string" && safeEnvironmentName(environmentName)) {
        headersFromEnv[header] = environmentName;
      } else {
        warnings.push(`${name} header secret was not copied`);
      }
    }
    if (Object.keys(headersFromEnv).length > 0) imported.headersFromEnv = headersFromEnv;
  }

  if (isRecord(value.env) && Object.keys(value.env).length > 0)
    warnings.push(`${name} environment values were not copied`);
  return { server: { name, config: imported }, warnings };
}

function extractRegistrations(value: unknown): { servers: ImportedServer[]; warnings: string[] } {
  if (!isRecord(value)) return { servers: [], warnings: [] };
  const candidates = isRecord(value.mcpServers) ? value.mcpServers : isRecord(value.servers) ? value.servers : value;
  const servers: ImportedServer[] = [];
  const warnings: string[] = [];
  for (const [name, registration] of Object.entries(candidates)) {
    const imported = importedRegistration(name, registration);
    if (imported.server !== undefined) servers.push(imported.server);
    warnings.push(...imported.warnings);
  }
  return { servers, warnings };
}

function runClientList(client: InitClient): ClientListResult {
  if (client === "none") return { output: "", commandAvailable: false, successful: false, timedOut: false };
  const executable = commandPath(client);
  if (executable === undefined) return { output: "", commandAvailable: false, successful: false, timedOut: false };
  for (const args of [
    ["mcp", "list", "--json"],
    ["mcp", "list"],
  ]) {
    const result = spawnClientCommand(executable, args);
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      return { output: "", commandAvailable: true, successful: false, timedOut: true };
    }
    if (result.status === 0)
      return { output: result.stdout, commandAvailable: true, successful: true, timedOut: false };
  }
  return { output: "", commandAvailable: true, successful: false, timedOut: false };
}

function importClientServers(source: InitImportSource): { servers: ImportedServer[]; warnings: string[] } {
  if (source === "none") return { servers: [], warnings: [] };
  const listed = runClientList(source);
  if (listed.timedOut) return { servers: [], warnings: [`${source} MCP list timed out`] };
  if (!listed.successful) return { servers: [], warnings: [`${source} MCP list failed; no registration copied`] };
  if (listed.output.trim() === "") {
    return { servers: [], warnings: [`${source} MCP registrations could not be read`] };
  }
  try {
    const parsed: unknown = JSON.parse(listed.output);
    const extracted = extractRegistrations(parsed);
    return {
      servers: extracted.servers,
      warnings: [
        ...extracted.warnings,
        ...(extracted.servers.length === 0 ? [`${source} registrations contained no importable definitions`] : []),
      ],
    };
  } catch {
    return {
      servers: [],
      warnings: [`${source} MCP list was not machine-readable; no registration copied`],
    };
  }
}

function gitExcludePath(workspace: string): string | undefined {
  try {
    const result = execFileSync("git", ["-C", workspace, "rev-parse", "--git-path", "info/exclude"], {
      encoding: "utf8",
    }).trim();
    if (result === "") return undefined;
    return path.resolve(workspace, result);
  } catch {
    return undefined;
  }
}

function personalExcludeEntries(configPath: string, workspace: string): string[] {
  const relativeConfig = path.relative(workspace, configPath).split(path.sep).join("/");
  const entries = [".mottainai/"];
  if (relativeConfig !== "" && !relativeConfig.startsWith("../") && relativeConfig !== "..")
    entries.unshift(relativeConfig);
  return entries;
}

function updateGitExclude(
  configPath: string,
  workspace: string,
  write: boolean,
  boundaries: BoundaryOperations,
): { changed: boolean; path?: string; warning?: string } {
  const excludePath = gitExcludePath(workspace);
  if (excludePath === undefined)
    return { changed: false, warning: "personal scope requested, but this workspace is not a Git repository" };
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const missing = personalExcludeEntries(configPath, workspace).filter((entry) => {
    return !existing.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === `/${entry}`);
  });
  if (missing.length === 0) return { changed: false, path: excludePath };
  if (!write) return { changed: true, path: excludePath };
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  boundaries.file("config.git-exclude.append", () => {
    fs.appendFileSync(excludePath, `${prefix}# mottainai personal configuration\n${missing.join("\n")}\n`);
  });
  return { changed: true, path: excludePath };
}

function cleanupTemporaryDirectory(
  temporaryDirectory: string,
  boundaries: BoundaryOperations,
  primary?: unknown,
): Error | undefined {
  try {
    boundaries.file("config.temp.cleanup", () => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
    return undefined;
  } catch {
    try {
      boundaries.file("config.temp.cleanup.retry", () =>
        fs.rmSync(temporaryDirectory, { recursive: true, force: true }),
      );
      return undefined;
    } catch (retryError) {
      // Fault injection fails before invoking the action. A direct final attempt
      // keeps a test seam failure from leaving an otherwise removable directory
      // behind while the injected failure remains secondary evidence.
      try {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      } catch (fallbackError) {
        retryError = fallbackError;
      }
      if (primary === undefined) {
        return retryError instanceof Error ? retryError : new Error(String(retryError));
      }
      return addSecondaryDiagnostic(primary, "config.temp.cleanup", retryError);
    }
  }
}

function atomicWrite(filePath: string, config: Record<string, unknown>, boundaries: BoundaryOperations): void {
  const directory = path.dirname(filePath);
  boundaries.file("config.directory.create", () => fs.mkdirSync(directory, { recursive: true }));
  const temporaryDirectory = boundaries.file("config.temp.create", () =>
    fs.mkdtempSync(path.join(directory, ".mottainai-init-")),
  );
  const temporaryPath = path.join(temporaryDirectory, path.basename(filePath));
  let primary: unknown;
  try {
    saveRawConfig(temporaryPath, config, boundaries, "config.temp.write");
    // writeFileSync owns the OS handle; this named checkpoint makes its close phase
    // deterministic and injectable without replacing Node's filesystem globally.
    boundaries.file("config.temp.close", () => undefined);
    boundaries.file("config.temp.permission", () => fs.chmodSync(temporaryPath, 0o600));
    boundaries.file("config.rename", () => fs.renameSync(temporaryPath, filePath));
  } catch (error) {
    primary = error;
    const cleanupError = cleanupTemporaryDirectory(temporaryDirectory, boundaries, primary);
    if (cleanupError !== undefined) throw cleanupError;
    throw error;
  }
  const cleanupError = cleanupTemporaryDirectory(temporaryDirectory, boundaries);
  if (cleanupError !== undefined) {
    // A successful replacement must not be turned into a protocol-breaking failure
    // merely because best-effort cleanup failed. The diagnostic is intentionally generic.
    console.error("mottainai: temporary configuration cleanup failed; replacement completed");
  }
}

const COPYFILE_EXCL = 1;

function backupCandidate(filePath: string, index: number): string {
  return index === 0 ? `${filePath}.bak` : `${filePath}.${index}.bak`;
}

function createBackup(filePath: string, boundaries: BoundaryOperations): string {
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = backupCandidate(filePath, index);
    if (boundaries.file("config.backup.exists", () => fs.existsSync(candidate))) continue;
    try {
      boundaries.file("config.backup.copy", () => fs.copyFileSync(filePath, candidate, COPYFILE_EXCL));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`unable to allocate a configuration backup name: ${filePath}`);
}

/** シェルへコピー&ペーストされる表示用コマンドなので、POSIX シングルクォート
 * 規則で丸ごとエスケープする（シングルクォート内は ' 自身以外すべてリテラル
 * になるため、$()・バッククォート・;・&・*・バックスラッシュ等を無害化できる）。
 * 実際に spawn される registrationArguments は配列渡しのため対象外。 */
function quoteForDisplay(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** 登録先クライアントの cwd は init 実行時の workspace と一致する保証がないため、
 * 起動コマンドへ絶対パスの --config を明示し、cwd 依存の設定解決に頼らない。 */
function registrationCommand(client: InitClient, packageReference: string, configuration: string): string {
  const quotedConfiguration = quoteForDisplay(configuration);
  if (client === "claude")
    return `claude mcp add -s user mottainai -- npx -y ${packageReference} serve --config ${quotedConfiguration}`;
  if (client === "codex")
    return `codex mcp add mottainai -- npx -y ${packageReference} serve --config ${quotedConfiguration}`;
  return "";
}

function registrationArguments(client: InitClient, packageReference: string, configuration: string): string[] {
  if (client === "claude")
    return [
      "mcp",
      "add",
      "-s",
      "user",
      "mottainai",
      "--",
      "npx",
      "-y",
      packageReference,
      "serve",
      "--config",
      configuration,
    ];
  if (client === "codex")
    return ["mcp", "add", "mottainai", "--", "npx", "-y", packageReference, "serve", "--config", configuration];
  return [];
}

function clientAlreadyHasMottainai(client: InitClient): {
  alreadyRegistered: boolean;
  successful: boolean;
  timedOut: boolean;
} {
  const listed = runClientList(client);
  return {
    alreadyRegistered: listed.successful && listed.output.split(/\r?\n/).some((line) => /\bmottainai\b/.test(line)),
    successful: listed.successful,
    timedOut: listed.timedOut,
  };
}

function registerClient(
  client: InitClient,
  packageReference: string,
  configuration: string,
  noRegister: boolean,
): InitClientResult {
  const command = registrationCommand(client, packageReference, configuration);
  const executable = client === "none" ? undefined : commandPath(client);
  const available = executable !== undefined;
  if (client === "none") return { name: client, available: false, registrationCommand: "", status: "not-requested" };
  if (noRegister) return { name: client, available, registrationCommand: command, status: "not-requested" };
  if (executable === undefined)
    return { name: client, available: false, registrationCommand: command, status: "unavailable" };
  const listed = clientAlreadyHasMottainai(client);
  if (!listed.successful) {
    return {
      name: client,
      available: true,
      registrationCommand: command,
      status: "list-failed",
      ...(listed.timedOut ? { timed_out: true } : {}),
    };
  }
  if (listed.alreadyRegistered) {
    return {
      name: client,
      available: true,
      registrationCommand: command,
      status: "already-registered",
      ...(listed.timedOut ? { timed_out: true } : {}),
    };
  }
  const result = spawnClientCommand(executable, registrationArguments(client, packageReference, configuration));
  const timedOut = listed.timedOut || (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    name: client,
    available: true,
    registrationCommand: command,
    status: result.status === 0 ? "registered" : "failed",
    ...(timedOut ? { timed_out: true } : {}),
  };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function chooseInteractive(
  argumentsValue: InitArguments,
  clients: InitClient[],
  commands: string[],
  inputTTY: boolean,
  outputTTY: boolean,
): Promise<void> {
  if (!inputTTY || !outputTTY || argumentsValue.yes || argumentsValue.json) return;
  const prompts = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (argumentsValue.scope === undefined) {
      const answer = (
        await prompts.question("How should this configuration be used? [personal/project] (personal): ")
      ).trim();
      argumentsValue.scope = answer === "project" ? "project" : "personal";
    }
    if (argumentsValue.client === undefined) {
      const available = clients.length === 0 ? "none" : clients.join(", ");
      const answer = (await prompts.question(`MCP client [${available}/none] (none): `)).trim();
      argumentsValue.client = answer === "claude" || answer === "codex" ? answer : "none";
    }
    if (argumentsValue.upstreamMode === undefined) {
      const answer = (await prompts.question("Upstream setup [none/import/detect/manual] (none): ")).trim();
      argumentsValue.upstreamMode = answer === "import" || answer === "detect" || answer === "manual" ? answer : "none";
    }
    if (argumentsValue.upstreamMode === "import" && argumentsValue.importSource === undefined) {
      const answer = (
        await prompts.question(`Import from [${clients.length === 0 ? "none" : clients.join(", ")}] (none): `)
      ).trim();
      argumentsValue.importSource = answer === "claude" || answer === "codex" ? answer : "none";
    }
    if (argumentsValue.upstreamMode === "detect") {
      const answer = (await prompts.question(`Detected commands [${commands.join(", ") || "none"}] (none): `)).trim();
      argumentsValue.selectedCommands = answer
        .split(",")
        .map((value) => value.trim())
        .filter((value) => commands.includes(value));
    }
    if (argumentsValue.upstreamMode === "manual") {
      const name = (await prompts.question("Upstream name (blank to skip): ")).trim();
      if (name !== "") {
        const command = (await prompts.question("Command: ")).trim();
        if (command === "") throw new Error("manual upstream command is required");
        const args = (await prompts.question("Arguments (space-separated, blank for none): "))
          .trim()
          .split(" ")
          .filter(Boolean);
        argumentsValue.manualUpstreams = [{ name, config: { command, ...(args.length === 0 ? {} : { args }) } }];
      }
    }
  } finally {
    prompts.close();
  }
}

async function runMcpHandshake(configPath: string, workspace: string): Promise<InitHandshakeResult> {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  if (!fs.existsSync(entry)) {
    return { ok: true, skipped: true, reason: "source checkout has no built server entry" };
  }
  const client = new Client({ name: "mottainai-init-check", version: packageMetadata.version }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: workspace,
    env: { ...process.env, MOTTAINAI_CONFIG: configPath },
  });
  try {
    const tools = await withTimeout(
      (async () => {
        await client.connect(transport);
        return client.listTools();
      })(),
      INIT_OPERATION_TIMEOUT_MS,
      "MCP handshake timed out",
    );
    return { ok: true, tools: tools.tools.length };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, ...(reason === "MCP handshake timed out" ? { timed_out: true } : {}), reason };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runInit(options: InitRunOptions): Promise<InitSummary> {
  const cwd = options.cwd ?? process.cwd();
  const boundaries = options.boundaries ?? DIRECT_BOUNDARIES;
  const parsed = parseArguments(options.args);
  const inputTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const outputTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  const interactive = inputTTY && outputTTY && !parsed.yes && !parsed.json;
  if (!interactive && !parsed.yes && !parsed.json) {
    throw new Error('interactive input is unavailable. Use "mottainai init --yes" or provide explicit options.');
  }

  const workspace = resolveWorkspace(parsed.workspace, cwd);
  const configuration = resolveConfiguration(parsed.config, workspace, cwd);
  const clients = detectClients();
  const detectedCommands = detectCommands();
  await chooseInteractive(parsed, clients, detectedCommands, inputTTY, outputTTY);
  const scope = parsed.scope ?? "personal";
  const client = parsed.client ?? "none";
  const importSource = parsed.importSource ?? "none";
  const warnings: string[] = [];
  let runtime: LocalRuntimeEnsureResult | undefined;
  if (!parsed.dryRun && options.localRuntime !== undefined) {
    runtime = await options.localRuntime.ensure(options.localRuntimeOptions);
  }
  const config = baseConfig(configuration, workspace);
  const registry = config.mcpServers as Record<string, Record<string, unknown>>;
  const imported = importClientServers(importSource);
  warnings.push(...imported.warnings);
  for (const server of imported.servers) {
    if (registry[server.name] === undefined) registry[server.name] = server.config;
  }
  for (const server of parsed.manualUpstreams) {
    if (registry[server.name] === undefined) registry[server.name] = server.config;
  }
  for (const command of parsed.selectedCommands) {
    const preset = COMMAND_PRESETS[command];
    if (preset === undefined) warnings.push(`${command} was detected but has no safe MCP preset`);
    else if (registry[command] === undefined) registry[command] = preset;
  }
  const importedUpstreams = Object.keys(registry);
  const existing = fs.existsSync(configuration);
  if (existing && !parsed.force)
    throw new Error(`configuration already exists: ${configuration}; use --force to replace it`);

  let backup: string | undefined;
  if (existing && parsed.force) {
    if (!parsed.dryRun) backup = createBackup(configuration, boundaries);
    else backup = backupCandidate(configuration, 0);
  }

  const exclude =
    scope === "personal" ? updateGitExclude(configuration, workspace, !parsed.dryRun, boundaries) : { changed: false };
  if (exclude.warning !== undefined) warnings.push(exclude.warning);
  if (parsed.dryRun && exclude.changed) {
    warnings.push(`dry-run would update ${exclude.path ?? ".git/info/exclude"}`);
  }
  if (!parsed.dryRun) atomicWrite(configuration, config, boundaries);

  const packageReference = parsed.latest ? "mottainai" : `mottainai@${packageMetadata.version}`;
  const clientResults =
    client === "none"
      ? []
      : [registerClient(client, packageReference, configuration, parsed.noRegister || parsed.dryRun)];
  if (clientResults.some((result) => result.status === "unavailable"))
    warnings.push(`${client} command was not found; registration was not run`);
  if (clientResults.some((result) => result.status === "list-failed")) {
    const timedOut = clientResults.some((result) => result.status === "list-failed" && result.timed_out === true);
    warnings.push(`${client} MCP list ${timedOut ? "timed out" : "failed"}; registration was not run`);
  }
  if (clientResults.some((result) => result.status === "failed"))
    warnings.push(`${client} registration command failed`);
  if (clientResults.some((result) => result.status === "already-registered"))
    warnings.push(`${client} already has a mottainai registration; it was not replaced`);
  if (clientResults.some((result) => result.status !== "list-failed" && result.timed_out === true))
    warnings.push(`${client} command timed out; registration may be incomplete`);
  const clientRegistrationFailed = clientResults.some(
    (result) => result.status === "unavailable" || result.status === "list-failed" || result.status === "failed",
  );

  let doctor: DoctorReport | undefined;
  let handshake: InitHandshakeResult | undefined;
  if (!parsed.noDoctor && !parsed.dryRun) {
    doctor = collectDoctorReport({ configPath: configuration, cwd: workspace });
    if (!doctor.ok) warnings.push("doctor found errors; initialization is incomplete");
    else if (doctor.warnings > 0) warnings.push("doctor completed with warnings");
    handshake = await runMcpHandshake(configuration, workspace);
    if (!handshake.ok) warnings.push(`MCP handshake failed: ${handshake.reason ?? "unknown error"}`);
    else if (handshake.skipped === true) warnings.push(`MCP handshake skipped: ${handshake.reason ?? "unavailable"}`);
  }

  return {
    ok: (doctor?.ok ?? true) && (handshake?.ok ?? true) && !clientRegistrationFailed,
    workspace,
    configuration,
    scope,
    dry_run: parsed.dryRun,
    config_written: !parsed.dryRun,
    config_preview: config,
    ...(backup === undefined ? {} : { backup }),
    detected_clients: clients,
    detected_commands: detectedCommands,
    imported_upstreams: importedUpstreams,
    clients: clientResults,
    ...(doctor === undefined ? {} : { doctor }),
    ...(handshake === undefined ? {} : { handshake }),
    ...(runtime === undefined ? {} : { runtime }),
    warnings,
  };
}

export function formatInitHuman(summary: InitSummary): string {
  const lines = [
    summary.dry_run
      ? "Mottainai initialization preview"
      : summary.ok
        ? "Mottainai is ready"
        : "Mottainai setup incomplete",
    "",
    "Workspace",
    `  ${summary.workspace}`,
    "",
    "Configuration",
    `  ${summary.configuration}`,
    `  ${summary.config_written ? "created" : "not changed"}`,
  ];
  if (summary.backup !== undefined) lines.push(`  backup: ${summary.backup}`);
  if (summary.imported_upstreams.length > 0) {
    lines.push("", "Upstreams", ...summary.imported_upstreams.map((name) => `  ✓ ${name}`));
  }
  if (summary.detected_commands.length > 0) {
    lines.push("", "Detected commands", ...summary.detected_commands.map((command) => `  ✓ ${command}`));
  }
  if (summary.dry_run) {
    lines.push("", "Configuration preview", JSON.stringify(summary.config_preview, null, 2));
  }
  if (summary.clients.length > 0) {
    lines.push("", "MCP clients", ...summary.clients.map((client) => `  ${client.status}: ${client.name}`));
  }
  if (summary.doctor !== undefined) lines.push("", formatDoctorHuman(summary.doctor));
  if (summary.handshake !== undefined) {
    const handshake = summary.handshake;
    lines.push(
      "",
      `MCP handshake: ${handshake.skipped === true ? "skipped" : handshake.ok ? `ok (${handshake.tools ?? 0} tools)` : "failed"}`,
    );
  }
  if (summary.runtime !== undefined) {
    lines.push(
      "",
      "Local Runtime",
      `  ${summary.runtime.lifecycle}: ${summary.runtime.machineId}`,
      `  ${summary.runtime.host}/${summary.runtime.accelerator}`,
      `  ${summary.runtime.reused ? "reused" : "created or restarted"}`,
    );
  }
  if (summary.warnings.length > 0) lines.push("", "Warnings", ...summary.warnings.map((warning) => `  ⚠ ${warning}`));
  if (summary.clients.some((client) => client.registrationCommand !== "")) {
    lines.push("", "Registration commands", ...summary.clients.map((client) => `  ${client.registrationCommand}`));
  }
  if (!summary.dry_run)
    lines.push(
      "",
      `Next step\n  npx -y mottainai@${packageMetadata.version} doctor --config ${JSON.stringify(summary.configuration)}`,
    );
  return lines.join("\n");
}
