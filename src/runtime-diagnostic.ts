import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };
import type { ConfigSnapshot } from "./config.js";
import type { UpstreamState, UpstreamStatus } from "./upstream.js";

export const RUNTIME_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const RUNTIME_BUILD_METADATA_FILE = "runtime-build-metadata.json";

export type DiagnosticSource = "cli" | "environment" | "config" | "default" | "build" | "runtime";
export type DistributionKind = "development/source" | "packed/npm" | "unknown/repackaged";
export type RuntimeUpstreamTransport = "stdio" | "streamableHttp";
export type RuntimeUpstreamHealth = "healthy" | "unhealthy" | "pending" | "disabled" | "unknown";
export type UpstreamFailureCategory =
  | "auth"
  | "configuration"
  | "network"
  | "protocol"
  | "spawn"
  | "timeout"
  | "unknown";

export interface RuntimeBuildMetadata {
  schema_version: typeof RUNTIME_DIAGNOSTIC_SCHEMA_VERSION;
  package_name: string;
  package_version: string;
  build_id: string;
  git_sha?: string;
  source_state?: "clean" | "dirty" | "unavailable";
  artifact: "npm";
}

export interface RuntimeUpstreamFailure {
  category: UpstreamFailureCategory;
  summary: string;
}

export interface RuntimeUpstreamDiagnostic {
  name: string;
  transport: RuntimeUpstreamTransport;
  enabled: boolean;
  state: UpstreamState;
  health: RuntimeUpstreamHealth;
  tool_count?: number;
  failure_count: number;
  failure?: RuntimeUpstreamFailure;
}

export interface RuntimeDiagnosticProvenance {
  package_name: DiagnosticSource;
  package_version: DiagnosticSource;
  build_id: DiagnosticSource;
  node_version: DiagnosticSource;
  platform: DiagnosticSource;
  architecture: DiagnosticSource;
  entry_point: DiagnosticSource;
  distribution_kind: DiagnosticSource;
  startup_timestamp: DiagnosticSource;
  startup_cwd: DiagnosticSource;
  config_path: DiagnosticSource;
  git_sha?: DiagnosticSource;
  workspace_root?: DiagnosticSource;
  state_directory?: DiagnosticSource;
  active_profile?: DiagnosticSource;
}

/**
 * Canonical, bounded runtime evidence. Public projections must be derived from
 * this allowlist-shaped object; process/config/upstream objects are never put
 * into it wholesale.
 */
export interface RuntimeDiagnostic {
  schema_version: typeof RUNTIME_DIAGNOSTIC_SCHEMA_VERSION;
  package_name: string;
  package_version: string;
  build_id: string;
  git_sha?: string;
  node_version: string;
  platform: string;
  architecture: string;
  entry_point: string;
  distribution_kind: DistributionKind;
  startup_timestamp: string;
  startup_cwd: string;
  config_path: string;
  workspace_root?: string;
  state_directory?: string;
  active_profile?: string;
  provenance: RuntimeDiagnosticProvenance;
  upstreams: RuntimeUpstreamDiagnostic[];
}

export interface RuntimeDiagnosticOptions {
  cwd?: string;
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  entryPoint?: string;
  startupTimestamp?: string;
  homeDirectory?: string;
  buildMetadata?: RuntimeBuildMetadata | null;
  gitSha?: string | null;
}

interface ConfiguredUpstream {
  transport?: RuntimeUpstreamTransport;
  enabled?: boolean;
}

const MAX_ERROR_SUMMARY_BYTES = 240;
const MAX_PATH_BYTES = 1_024;
const MAX_UPSTREAMS = 100;
const MAX_UPSTREAM_NAME_BYTES = 128;
const PACKAGE_NAME = packageMetadata.name;
const PACKAGE_VERSION = packageMetadata.version;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

function boundedDiagnosticPath(candidate: string, homeDirectory: string): string {
  return boundedText(normalizeDiagnosticPath(candidate, homeDirectory), MAX_PATH_BYTES);
}

function boundedUpstreamName(name: string): string {
  return boundedText(name.replace(/[\u0000-\u001f\u007f]/gu, " ").trim(), MAX_UPSTREAM_NAME_BYTES);
}

function normalizeHome(homeDirectory: string): string {
  return path.normalize(path.resolve(homeDirectory));
}

/** Replace only the user's home prefix; unrelated absolute paths remain useful locally. */
export function normalizeDiagnosticPath(candidate: string, homeDirectory = os.homedir()): string {
  const absolute = path.normalize(path.isAbsolute(candidate) ? candidate : path.resolve(candidate));
  const home = normalizeHome(homeDirectory);
  if (absolute === home) return "~";
  const relative = path.relative(home, absolute);
  if (relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
    return `~${path.sep}${relative}`;
  }
  return absolute;
}

function metadataIsValid(value: unknown): value is RuntimeBuildMetadata {
  return (
    isRecord(value) &&
    value.schema_version === RUNTIME_DIAGNOSTIC_SCHEMA_VERSION &&
    value.package_name === PACKAGE_NAME &&
    value.package_version === PACKAGE_VERSION &&
    typeof value.build_id === "string" &&
    value.build_id.length > 0 &&
    value.artifact === "npm" &&
    (value.git_sha === undefined || typeof value.git_sha === "string") &&
    (value.source_state === undefined ||
      value.source_state === "clean" ||
      value.source_state === "dirty" ||
      value.source_state === "unavailable")
  );
}

function metadataCandidates(entryPoint: string): string[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    entryPoint === "unknown" ? undefined : path.join(path.dirname(entryPoint), RUNTIME_BUILD_METADATA_FILE),
    path.join(moduleDirectory, RUNTIME_BUILD_METADATA_FILE),
  ];
  return [...new Set(candidates.filter((candidate): candidate is string => candidate !== undefined))];
}

/** Read generated metadata when the runtime is built; source execution falls back safely. */
export function readRuntimeBuildMetadata(entryPoint: string): RuntimeBuildMetadata | undefined {
  for (const candidate of metadataCandidates(entryPoint)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (metadataIsValid(parsed)) return parsed;
    } catch {
      // Missing or malformed generated metadata is an explicit unknown/repackaged signal.
    }
  }
  return undefined;
}

function findPackageRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (let depth = 0; depth < 20; depth += 1) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function hasGitMarker(directory: string | undefined): boolean {
  return directory !== undefined && fs.existsSync(path.join(directory, ".git"));
}

function isSourceEntry(entryPoint: string): boolean {
  const extension = path.extname(entryPoint);
  return (
    (extension === ".ts" || extension === ".mts" || extension === ".cts") &&
    path.basename(path.dirname(entryPoint)) === "src"
  );
}

function isGitSha(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{7,64}$/iu.test(value);
}

function readGitSha(cwd: string): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    return isGitSha(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

function classifyDistribution(
  entryPoint: string,
  packageRoot: string | undefined,
  metadata: RuntimeBuildMetadata | undefined,
): DistributionKind {
  if (isSourceEntry(entryPoint) || hasGitMarker(packageRoot)) return "development/source";
  if (metadata !== undefined) return "packed/npm";
  return "unknown/repackaged";
}

function configPathEvidence(
  configPath: string | undefined,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): { path: string; source: DiagnosticSource } {
  const source =
    configPath !== undefined ? "cli" : environment.MOTTAINAI_CONFIG !== undefined ? "environment" : "default";
  return {
    path: path.resolve(cwd, configPath ?? environment.MOTTAINAI_CONFIG ?? "mottainai.config.json"),
    source,
  };
}

function safeEntryPoint(entryPoint: string | undefined, cwd: string): string {
  if (entryPoint === undefined || entryPoint.length === 0) return "unknown";
  return path.isAbsolute(entryPoint) ? path.normalize(entryPoint) : path.resolve(cwd, entryPoint);
}

function sourceForBuild(metadata: RuntimeBuildMetadata | undefined, gitSha: string | undefined): DiagnosticSource {
  if (metadata !== undefined) return "build";
  return gitSha === undefined ? "runtime" : "runtime";
}

export function createRuntimeDiagnostic(options: RuntimeDiagnosticOptions = {}): RuntimeDiagnostic {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? {};
  const rawEntryPoint = safeEntryPoint(options.entryPoint, cwd);
  const homeDirectory = options.homeDirectory ?? environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const config = configPathEvidence(options.configPath, cwd, environment);
  const suppliedMetadata = options.buildMetadata;
  const metadata =
    suppliedMetadata === null
      ? undefined
      : suppliedMetadata === undefined
        ? readRuntimeBuildMetadata(rawEntryPoint)
        : metadataIsValid(suppliedMetadata)
          ? suppliedMetadata
          : undefined;
  const packageRoot = findPackageRoot(rawEntryPoint) ?? findPackageRoot(cwd);
  const distributionKind = classifyDistribution(rawEntryPoint, packageRoot, metadata);
  const developmentSha =
    distributionKind === "development/source"
      ? options.gitSha === null
        ? undefined
        : (options.gitSha ?? (metadata?.source_state === "dirty" ? undefined : (metadata?.git_sha ?? readGitSha(cwd))))
      : metadata?.git_sha;
  const buildId =
    metadata?.build_id ??
    `development:${PACKAGE_NAME}@${PACKAGE_VERSION}${developmentSha === undefined ? "+no-git" : `+git.${developmentSha}`}`;
  const buildSource = sourceForBuild(metadata, developmentSha);
  const provenance: RuntimeDiagnosticProvenance = {
    package_name: "build",
    package_version: "build",
    build_id: buildSource,
    ...(developmentSha === undefined ? {} : { git_sha: metadata === undefined ? "runtime" : "build" }),
    node_version: "runtime",
    platform: "runtime",
    architecture: "runtime",
    entry_point: "runtime",
    distribution_kind: "runtime",
    startup_timestamp: "runtime",
    startup_cwd: "runtime",
    config_path: config.source,
  };
  return {
    schema_version: RUNTIME_DIAGNOSTIC_SCHEMA_VERSION,
    package_name: PACKAGE_NAME,
    package_version: PACKAGE_VERSION,
    build_id: buildId,
    ...(developmentSha === undefined ? {} : { git_sha: developmentSha }),
    node_version: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    entry_point: boundedDiagnosticPath(rawEntryPoint, homeDirectory),
    distribution_kind: distributionKind,
    startup_timestamp: options.startupTimestamp ?? new Date().toISOString(),
    startup_cwd: boundedDiagnosticPath(cwd, homeDirectory),
    config_path: boundedDiagnosticPath(config.path, homeDirectory),
    provenance,
    upstreams: [],
  };
}

/** Add config-derived resolution evidence after the baseline identity exists. */
export function enrichRuntimeDiagnostic(
  diagnostic: RuntimeDiagnostic,
  snapshot: ConfigSnapshot,
  homeDirectory?: string,
): RuntimeDiagnostic {
  const home = homeDirectory ?? os.homedir();
  const workspaceRoot = snapshot.gatewayConfig.workspaceRoot;
  const stateDirectory = path.join(workspaceRoot, ".mottainai");
  const activeProfile = snapshot.config.gateway?.activeProfile;
  const workspaceSource: DiagnosticSource = snapshot.config.gateway?.workspaceRoot === undefined ? "default" : "config";
  return {
    ...diagnostic,
    config_path: boundedDiagnosticPath(snapshot.configPath, home),
    workspace_root: boundedDiagnosticPath(workspaceRoot, home),
    state_directory: boundedDiagnosticPath(stateDirectory, home),
    ...(activeProfile === undefined ? {} : { active_profile: boundedText(activeProfile, MAX_UPSTREAM_NAME_BYTES) }),
    provenance: {
      ...diagnostic.provenance,
      workspace_root: workspaceSource,
      state_directory: "default",
      ...(activeProfile === undefined ? {} : { active_profile: "config" }),
    },
    upstreams: projectConfiguredUpstreams(snapshot.config.mcpServers),
  };
}

export function projectConfiguredUpstreams(config: Record<string, ConfiguredUpstream>): RuntimeUpstreamDiagnostic[] {
  return Object.entries(config)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_UPSTREAMS)
    .map(([name, upstream]) => ({
      name: boundedUpstreamName(name),
      transport: upstream.transport ?? "stdio",
      enabled: upstream.enabled !== false,
      state: upstream.enabled === false ? "disabled" : "registered",
      health: upstream.enabled === false ? "disabled" : "unknown",
      failure_count: 0,
    }));
}

function upstreamHealth(state: UpstreamState): RuntimeUpstreamHealth {
  if (state === "ready") return "healthy";
  if (state === "unhealthy") return "unhealthy";
  if (state === "disabled" || state === "stopped") return "disabled";
  if (state === "registered" || state === "starting") return "pending";
  return "unknown";
}

function failureCategory(message: string): UpstreamFailureCategory {
  if (/auth|authorization|credential|token|401|403/iu.test(message)) return "auth";
  if (/config|invalid|missing .*url|missing .*command/iu.test(message)) return "configuration";
  if (/timeout|timed out/iu.test(message)) return "timeout";
  if (/spawn|enoent|command not found/iu.test(message)) return "spawn";
  if (/protocol|mcp|json-rpc|listtools/iu.test(message)) return "protocol";
  if (/connect|fetch|network|econn|socket|dns/iu.test(message)) return "network";
  return "unknown";
}

/** Redact before truncating so secrets cannot survive in a bounded tail. */
export function sanitizeUpstreamError(error: unknown): RuntimeUpstreamFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const category = failureCategory(raw);
  const summary = boundedText(
    raw
      .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
      .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 [redacted]")
      .replace(
        /\b(?:authorization|token|secret|password|api[_-]?key|credential|cookie|raw|value|data)(?:\s*[:=]\s*|\s+)[^\s,;]+/giu,
        "[redacted]",
      )
      .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[redacted-token]")
      .replace(/\b(?:secret|token|key|password)_[A-Z0-9_-]+\b/giu, "[redacted]")
      .replace(/\b(?:[A-F0-9]{32,}|[A-Za-z0-9+/]{32,}={0,2})\b/gu, "[redacted]")
      .replace(/\s+/gu, " ")
      .trim(),
    MAX_ERROR_SUMMARY_BYTES,
  );
  return { category, summary: summary.length === 0 ? "upstream failure" : summary };
}

export function projectUpstreamStatus(status: UpstreamStatus): RuntimeUpstreamDiagnostic {
  const failure = status.lastError === undefined ? undefined : sanitizeUpstreamError(status.lastError);
  return {
    name: boundedUpstreamName(status.name),
    transport: status.transport ?? "stdio",
    enabled: status.enabled,
    state: status.state,
    health: upstreamHealth(status.state),
    ...(status.toolCount === undefined || !Number.isSafeInteger(status.toolCount) || status.toolCount < 0
      ? {}
      : { tool_count: status.toolCount }),
    failure_count: Number.isSafeInteger(status.failureCount) && status.failureCount >= 0 ? status.failureCount : 0,
    ...(failure === undefined ? {} : { failure }),
  };
}

export function projectRuntimeUpstreams(statuses: readonly UpstreamStatus[]): RuntimeUpstreamDiagnostic[] {
  return statuses
    .map(projectUpstreamStatus)
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_UPSTREAMS);
}

export function withRuntimeUpstreams(
  diagnostic: RuntimeDiagnostic,
  statuses: readonly UpstreamStatus[],
): RuntimeDiagnostic {
  return { ...diagnostic, upstreams: projectRuntimeUpstreams(statuses) };
}

export function formatRuntimeDiagnosticHuman(diagnostic: RuntimeDiagnostic): string {
  const lines = [
    `package: ${diagnostic.package_name}@${diagnostic.package_version}`,
    `build: ${diagnostic.build_id}`,
    ...(diagnostic.git_sha === undefined ? [] : [`git_sha: ${diagnostic.git_sha}`]),
    `node: ${diagnostic.node_version}`,
    `platform: ${diagnostic.platform}/${diagnostic.architecture}`,
    `distribution: ${diagnostic.distribution_kind}`,
    `entry_point: ${diagnostic.entry_point}`,
    `startup_cwd: ${diagnostic.startup_cwd}`,
    `config_path: ${diagnostic.config_path} (${diagnostic.provenance.config_path})`,
    ...(diagnostic.workspace_root === undefined
      ? []
      : [`workspace_root: ${diagnostic.workspace_root} (${diagnostic.provenance.workspace_root ?? "unknown"})`]),
    ...(diagnostic.state_directory === undefined
      ? []
      : [`state_directory: ${diagnostic.state_directory} (${diagnostic.provenance.state_directory ?? "unknown"})`]),
    ...(diagnostic.active_profile === undefined
      ? []
      : [`active_profile: ${diagnostic.active_profile} (${diagnostic.provenance.active_profile ?? "unknown"})`]),
    `upstreams: ${diagnostic.upstreams.length}`,
  ];
  return lines.join("\n");
}
