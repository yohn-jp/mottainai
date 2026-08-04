import fs from "node:fs";
import path from "node:path";
import { loadConfigSnapshot } from "../config.js";

export type DoctorCheckStatus = "pass" | "warning" | "error";

export interface Check {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  upstream?: string;
}

export type DoctorCheck = Check;

export interface DoctorProblem {
  severity: "warning" | "error";
  upstream?: string;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  errors: number;
  warnings: number;
  checks: Check[];
  config_file: string;
  version: number;
  checked: number;
  problems: DoctorProblem[];
}

export interface DoctorDependencies {
  nodeVersion: string;
  environment: NodeJS.ProcessEnv;
  resolveCommand(command: string, cwd: string): string | undefined;
  pathKind(candidate: string): "directory" | "other" | "missing";
  isWritable(candidate: string): boolean;
}

export interface CollectDoctorReportOptions {
  configPath?: string;
  cwd?: string;
  dependencies?: Partial<DoctorDependencies>;
}

const MINIMUM_NODE_VERSION = [22, 13, 0] as const;

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveCommand(command: string, cwd: string, environment: NodeJS.ProcessEnv): string | undefined {
  if (command.includes(path.sep) || command.startsWith(".")) {
    const candidate = path.resolve(cwd, command);
    return isExecutable(candidate) ? candidate : undefined;
  }
  for (const directory of (environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function defaultDependencies(): DoctorDependencies {
  const environment = process.env;
  return {
    nodeVersion: process.versions.node,
    environment,
    resolveCommand: (command, cwd) => resolveCommand(command, cwd, environment),
    pathKind: (candidate) => {
      try {
        return fs.statSync(candidate).isDirectory() ? "directory" : "other";
      } catch {
        return "missing";
      }
    },
    isWritable: (candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function versionAtLeast(actual: string, minimum: readonly number[]): boolean {
  const parts = actual.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (parts[index] ?? 0) - minimum[index];
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function collectDoctorReport(options: CollectDoctorReportOptions = {}): DoctorReport {
  const cwd = options.cwd ?? process.cwd();
  const defaults = defaultDependencies();
  const dependencies: DoctorDependencies = { ...defaults, ...options.dependencies };
  const snapshot = loadConfigSnapshot(options.configPath, cwd);
  const { config, configPath, gatewayConfig } = snapshot;
  const configDirectory = path.dirname(configPath);
  const checks: Check[] = [];
  const add = (check: Check): void => { checks.push(check); };

  add(versionAtLeast(dependencies.nodeVersion, MINIMUM_NODE_VERSION)
    ? { name: "node", status: "pass", message: `Node.js ${dependencies.nodeVersion}` }
    : { name: "node", status: "error", message: `Node.js ${dependencies.nodeVersion}; requires >= 22.13.0` });
  add({ name: "config", status: "pass", message: `Config: ${configPath}` });

  const workspaceKind = dependencies.pathKind(gatewayConfig.workspaceRoot);
  add(workspaceKind === "directory"
    ? { name: "workspace", status: "pass", message: `Workspace: ${gatewayConfig.workspaceRoot}` }
    : { name: "workspace", status: "error", message: workspaceKind === "missing"
      ? `workspaceRoot does not exist: ${gatewayConfig.workspaceRoot}`
      : `workspaceRoot is not a directory: ${gatewayConfig.workspaceRoot}` });

  const ripgrep = dependencies.resolveCommand("rg", cwd);
  add(ripgrep === undefined
    ? { name: "ripgrep", status: "error", message: "rg command not executable" }
    : { name: "ripgrep", status: "pass", message: `ripgrep: ${ripgrep}` });

  if (workspaceKind === "directory") {
    const stateDirectory = path.join(gatewayConfig.workspaceRoot, ".mottainai");
    const stateKind = dependencies.pathKind(stateDirectory);
    if (stateKind === "other") {
      add({ name: "state-directory", status: "error", message: `.mottainai is not a directory: ${stateDirectory}` });
    } else {
      const writable = dependencies.isWritable(stateKind === "directory" ? stateDirectory : gatewayConfig.workspaceRoot);
      add(writable
        ? { name: "state-directory", status: "pass", message: `.mottainai writable: ${stateDirectory}` }
        : { name: "state-directory", status: "error", message: `.mottainai is not writable: ${stateDirectory}` });
    }
  }

  if (config.gateway?.activeProfile !== undefined) {
    add({ name: "active-profile", status: "pass", message: `Active profile: ${config.gateway.activeProfile}` });
  }

  const enabled = Object.entries(config.mcpServers).filter(([, upstream]) => upstream.enabled !== false);
  if (enabled.length === 0) {
    add({ name: "upstreams", status: "warning", message: "no upstream is enabled; only local tools will be served" });
  }
  for (const [name, upstream] of enabled) {
    if (upstream.transport === "streamableHttp") {
      if (upstream.auth?.type === "oauth" && config.gateway?.oauthProviderModule === undefined) {
        add({ name: "oauth", status: "error", upstream: name, message: "oauth provider module missing" });
      }
      for (const [header, environmentName] of Object.entries(upstream.headersFromEnv ?? {})) {
        if (dependencies.environment[environmentName] === undefined) {
          add({ name: "environment", status: "error", upstream: name, message: `header environment missing: ${header} <- ${environmentName}` });
        }
      }
    } else {
      const upstreamCwd = upstream.cwd === undefined ? configDirectory : path.resolve(configDirectory, upstream.cwd);
      const executable = upstream.command === undefined ? undefined : dependencies.resolveCommand(upstream.command, upstreamCwd);
      add(executable === undefined
        ? { name: "command", status: "error", upstream: name, message: `command not executable: ${upstream.command ?? ""}` }
        : { name: "command", status: "pass", upstream: name, message: `command executable: ${executable}` });
    }
    if (upstream.cwd !== undefined) {
      const upstreamCwd = path.resolve(configDirectory, upstream.cwd);
      add(dependencies.pathKind(upstreamCwd) === "directory"
        ? { name: "upstream-cwd", status: "pass", upstream: name, message: `cwd exists: ${upstreamCwd}` }
        : { name: "upstream-cwd", status: "error", upstream: name, message: `cwd does not exist: ${upstreamCwd}` });
    }
    if ((upstream.capabilities ?? []).length === 0) {
      add({ name: "capabilities", status: "warning", upstream: name, message: "no declared capabilities; routing falls back to unspecified" });
    }
  }

  const problems: DoctorProblem[] = checks.flatMap((check) => check.status === "pass" ? [] : [{
    severity: check.status,
    ...(check.upstream === undefined ? {} : { upstream: check.upstream }),
    message: check.message,
  }]);
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.length - errors;
  return { ok: errors === 0, errors, warnings, checks, config_file: configPath, version: config.version ?? 1, checked: enabled.length, problems };
}

export function formatDoctorHuman(report: DoctorReport): string {
  const symbol: Record<DoctorCheckStatus, string> = { pass: "✓", warning: "⚠", error: "✗" };
  const lines = ["Mottainai Doctor", "", ...report.checks.map((check) =>
    `${symbol[check.status]} ${check.upstream === undefined ? "" : `${check.upstream}: `}${check.message}`), "",
  `${report.errors} ${report.errors === 1 ? "error" : "errors"}, ${report.warnings} ${report.warnings === 1 ? "warning" : "warnings"}`];
  return lines.join("\n");
}
