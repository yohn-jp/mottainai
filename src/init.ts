import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import packageMetadata from "../package.json" with { type: "json" };
import { collectDoctorReport, formatDoctorHuman } from "./commands/doctor.js";
import { saveRawConfig } from "./config.js";
import type { DoctorReport } from "./commands/doctor.js";

export type InitScope = "personal" | "project";
export type InitClient = "claude" | "codex" | "none";
export type InitImportSource = InitClient;

export interface InitRunOptions {
  args: string[];
  cwd?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

export interface InitClientResult {
  name: InitClient;
  available: boolean;
  registrationCommand: string;
  status: "not-requested" | "registered" | "already-registered" | "unavailable" | "failed";
}

export interface InitSummary {
  ok: boolean;
  workspace: string;
  configuration: string;
  scope: InitScope;
  dry_run: boolean;
  config_written: boolean;
  backup?: string;
  detected_clients: InitClient[];
  detected_commands: string[];
  imported_upstreams: string[];
  clients: InitClientResult[];
  doctor?: DoctorReport;
  warnings: string[];
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
  redacted: boolean;
}

const KNOWN_COMMANDS = ["codegraph", "fff-mcp", "rg"] as const;

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
  };
}

function commandPath(command: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const directory of (environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      if (fs.statSync(candidate).isFile() && (process.platform === "win32" || (fs.statSync(candidate).mode & 0o111) !== 0)) {
        return candidate;
      }
    } catch {
      // PATH entries are user input and can disappear while initialization runs.
    }
  }
  return undefined;
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
  return path.resolve(cwd, explicit ?? path.join(workspace, "mottainai.config.json"));
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

function sanitizeArguments(value: unknown): SanitizedArguments | undefined {
  const original = stringArray(value);
  if (original === undefined) return undefined;
  const args: string[] = [];
  let redacted = false;
  for (let index = 0; index < original.length; index += 1) {
    const argument = original[index];
    if (!sensitiveArgument(argument) && !/^Bearer\s+/i.test(argument) && !/^(?:token|secret|password)=/i.test(argument)) {
      args.push(argument);
      continue;
    }
    redacted = true;
    if (/^--?[a-z0-9_-]+$/.test(argument) && original[index + 1] !== undefined && !original[index + 1].startsWith("-")) index += 1;
  }
  return { args, redacted };
}

function safeRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "") return false;
    for (const key of parsed.searchParams.keys()) {
      if (sensitiveArgument(key)) return false;
    }
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
    return { warnings: [`${name} was not imported because its URL contains credentials`] };
  }

  const sanitizedArguments = sanitizeArguments(value.args);
  const warnings: string[] = [];
  if (sanitizedArguments?.redacted === true) warnings.push(`${name} argument secrets were not copied`);

  const imported: Record<string, unknown> = url === undefined
    ? {
      command,
      ...(sanitizedArguments === undefined || sanitizedArguments.args.length === 0 ? {} : { args: sanitizedArguments.args }),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    }
    : {
      transport: "streamableHttp",
      url,
      ...(isRecord(value.auth) && value.auth.type === "oauth" && typeof value.auth.profile === "string"
        ? { auth: { type: "oauth", profile: value.auth.profile } }
        : {}),
    };
  const capabilities = stringArray(value.capabilities);
  if (capabilities !== undefined) imported.capabilities = capabilities;
  if (typeof value.enabled === "boolean") imported.enabled = value.enabled;

  if (url !== undefined && isRecord(value.headersFromEnv)) {
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

  if (isRecord(value.env) && Object.keys(value.env).length > 0) warnings.push(`${name} environment values were not copied`);
  return { server: { name, config: imported }, warnings };
}

function extractRegistrations(value: unknown): { servers: ImportedServer[]; warnings: string[] } {
  if (!isRecord(value)) return { servers: [], warnings: [] };
  const candidates = isRecord(value.mcpServers)
    ? value.mcpServers
    : isRecord(value.servers)
      ? value.servers
      : value;
  const servers: ImportedServer[] = [];
  const warnings: string[] = [];
  for (const [name, registration] of Object.entries(candidates)) {
    const imported = importedRegistration(name, registration);
    if (imported.server !== undefined) servers.push(imported.server);
    warnings.push(...imported.warnings);
  }
  return { servers, warnings };
}

function runClientList(client: InitClient): { output: string; commandAvailable: boolean } {
  if (client === "none") return { output: "", commandAvailable: false };
  const executable = commandPath(client);
  if (executable === undefined) return { output: "", commandAvailable: false };
  for (const args of [["mcp", "list", "--json"], ["mcp", "list"]]) {
    const result = spawnSync(executable, args, { encoding: "utf8" });
    if (result.status === 0) return { output: result.stdout, commandAvailable: true };
  }
  return { output: "", commandAvailable: true };
}

function importClientServers(source: InitImportSource): { servers: ImportedServer[]; warnings: string[] } {
  if (source === "none") return { servers: [], warnings: [] };
  const listed = runClientList(source);
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
    const result = execFileSync("git", ["-C", workspace, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
    if (result === "") return undefined;
    return path.resolve(workspace, result);
  } catch {
    return undefined;
  }
}

function personalExcludeEntries(configPath: string, workspace: string): string[] {
  const relativeConfig = path.relative(workspace, configPath).split(path.sep).join("/");
  const entries = [".mottainai/"];
  if (relativeConfig !== "" && !relativeConfig.startsWith("../") && relativeConfig !== "..") entries.unshift(relativeConfig);
  return entries;
}

function updateGitExclude(configPath: string, workspace: string, write: boolean): { changed: boolean; path?: string; warning?: string } {
  const excludePath = gitExcludePath(workspace);
  if (excludePath === undefined) return { changed: false, warning: "personal scope requested, but this workspace is not a Git repository" };
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const missing = personalExcludeEntries(configPath, workspace).filter((entry) => {
    return !existing.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === `/${entry}`);
  });
  if (missing.length === 0) return { changed: false, path: excludePath };
  if (!write) return { changed: true, path: excludePath };
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludePath, `${prefix}# mottainai personal configuration\n${missing.join("\n")}\n`);
  return { changed: true, path: excludePath };
}

function atomicWrite(filePath: string, config: Record<string, unknown>): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryDirectory = fs.mkdtempSync(path.join(directory, ".mottainai-init-"));
  const temporaryPath = path.join(temporaryDirectory, path.basename(filePath));
  try {
    saveRawConfig(temporaryPath, config);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function backupPath(filePath: string): string {
  const basic = `${filePath}.bak`;
  if (!fs.existsSync(basic)) return basic;
  return `${filePath}.${Date.now()}.bak`;
}

function registrationCommand(client: InitClient, packageReference: string): string {
  if (client === "claude") return `claude mcp add -s user mottainai -- npx -y ${packageReference}`;
  if (client === "codex") return `codex mcp add mottainai -- npx -y ${packageReference}`;
  return "";
}

function registrationArguments(client: InitClient, packageReference: string): string[] {
  if (client === "claude") return ["mcp", "add", "-s", "user", "mottainai", "--", "npx", "-y", packageReference];
  if (client === "codex") return ["mcp", "add", "mottainai", "--", "npx", "-y", packageReference];
  return [];
}

function clientAlreadyHasMottainai(client: InitClient): boolean {
  const listed = runClientList(client);
  return listed.output.split(/\r?\n/).some((line) => /\bmottainai\b/.test(line));
}

function registerClient(client: InitClient, packageReference: string, noRegister: boolean): InitClientResult {
  const command = registrationCommand(client, packageReference);
  const available = client !== "none" && commandPath(client) !== undefined;
  if (client === "none") return { name: client, available: false, registrationCommand: "", status: "not-requested" };
  if (noRegister) return { name: client, available, registrationCommand: command, status: "not-requested" };
  if (!available) return { name: client, available: false, registrationCommand: command, status: "unavailable" };
  if (clientAlreadyHasMottainai(client)) return { name: client, available: true, registrationCommand: command, status: "already-registered" };
  const result = spawnSync(client, registrationArguments(client, packageReference), { encoding: "utf8" });
  return { name: client, available: true, registrationCommand: command, status: result.status === 0 ? "registered" : "failed" };
}

async function chooseInteractive(argumentsValue: InitArguments, clients: InitClient[], inputTTY: boolean, outputTTY: boolean): Promise<void> {
  if (!inputTTY || !outputTTY || argumentsValue.yes || argumentsValue.json) return;
  const prompts = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (argumentsValue.scope === undefined) {
      const answer = (await prompts.question("How should this configuration be used? [personal/project] (personal): ")).trim();
      argumentsValue.scope = answer === "project" ? "project" : "personal";
    }
    if (argumentsValue.client === undefined) {
      const available = clients.length === 0 ? "none" : clients.join(", ");
      const answer = (await prompts.question(`MCP client [${available}/none] (none): `)).trim();
      argumentsValue.client = answer === "claude" || answer === "codex" ? answer : "none";
    }
    if (argumentsValue.importSource === undefined) argumentsValue.importSource = "none";
  } finally {
    prompts.close();
  }
}

export async function runInit(options: InitRunOptions): Promise<InitSummary> {
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseArguments(options.args);
  const inputTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const outputTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  const interactive = inputTTY && outputTTY && !parsed.yes && !parsed.json;
  if (!interactive && !parsed.yes && !parsed.json) {
    throw new Error('Interactive input is unavailable. Use "mottainai init --yes" or provide explicit options.');
  }

  const workspace = resolveWorkspace(parsed.workspace, cwd);
  const configuration = resolveConfiguration(parsed.config, workspace, cwd);
  const clients = detectClients();
  await chooseInteractive(parsed, clients, inputTTY, outputTTY);
  const scope = parsed.scope ?? "personal";
  const client = parsed.client ?? "none";
  const importSource = parsed.importSource ?? "none";
  const warnings: string[] = [];
  const config = baseConfig(configuration, workspace);
  const registry = config.mcpServers as Record<string, Record<string, unknown>>;
  const imported = importClientServers(importSource);
  warnings.push(...imported.warnings);
  for (const server of imported.servers) {
    if (registry[server.name] === undefined) registry[server.name] = server.config;
  }
  const importedUpstreams = Object.keys(registry);
  const existing = fs.existsSync(configuration);
  if (existing && !parsed.force) throw new Error(`configuration already exists: ${configuration}; use --force to replace it`);

  let backup: string | undefined;
  if (existing && parsed.force) {
    backup = backupPath(configuration);
    if (!parsed.dryRun) fs.copyFileSync(configuration, backup);
  }

  const detectedCommands = detectCommands();
  const exclude = scope === "personal" ? updateGitExclude(configuration, workspace, !parsed.dryRun) : { changed: false };
  if (exclude.warning !== undefined) warnings.push(exclude.warning);
  if (parsed.dryRun && exclude.changed) {
    warnings.push(`dry-run would update ${exclude.path ?? ".git/info/exclude"}`);
  }
  if (!parsed.dryRun) atomicWrite(configuration, config);

  const packageReference = parsed.latest ? "mottainai" : `mottainai@${packageMetadata.version}`;
  const clientResults = client === "none"
    ? []
    : [registerClient(client, packageReference, parsed.noRegister || parsed.dryRun)];
  if (clientResults.some((result) => result.status === "unavailable")) warnings.push(`${client} command was not found; registration was not run`);
  if (clientResults.some((result) => result.status === "failed")) warnings.push(`${client} registration command failed`);
  if (clientResults.some((result) => result.status === "already-registered")) warnings.push(`${client} already has a mottainai registration; it was not replaced`);

  let doctor: DoctorReport | undefined;
  if (!parsed.noDoctor && !parsed.dryRun) {
    doctor = collectDoctorReport({ configPath: configuration, cwd: workspace });
    if (!doctor.ok) warnings.push("doctor found errors; initialization is incomplete");
    else if (doctor.warnings > 0) warnings.push("doctor completed with warnings");
  }

  return {
    ok: doctor?.ok ?? true,
    workspace,
    configuration,
    scope,
    dry_run: parsed.dryRun,
    config_written: !parsed.dryRun,
    ...(backup === undefined ? {} : { backup }),
    detected_clients: clients,
    detected_commands: detectedCommands,
    imported_upstreams: importedUpstreams,
    clients: clientResults,
    ...(doctor === undefined ? {} : { doctor }),
    warnings,
  };
}

export function formatInitHuman(summary: InitSummary): string {
  const lines = [
    summary.dry_run ? "Mottainai initialization preview" : summary.ok ? "Mottainai is ready" : "Mottainai setup incomplete",
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
  if (summary.clients.length > 0) {
    lines.push("", "MCP clients", ...summary.clients.map((client) => `  ${client.status}: ${client.name}`));
  }
  if (summary.doctor !== undefined) lines.push("", formatDoctorHuman(summary.doctor));
  if (summary.warnings.length > 0) lines.push("", "Warnings", ...summary.warnings.map((warning) => `  ⚠ ${warning}`));
  if (summary.clients.some((client) => client.registrationCommand !== "")) {
    lines.push("", "Registration commands", ...summary.clients.map((client) => `  ${client.registrationCommand}`));
  }
  if (!summary.dry_run) lines.push("", `Next step\n  npx -y mottainai@${packageMetadata.version} doctor`);
  return lines.join("\n");
}
