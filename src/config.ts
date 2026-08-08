import fs from "node:fs";
import path from "node:path";
import { DEFAULT_READ_GOVERNOR_POLICY, READ_GOVERNOR_MODES } from "./context-runtime/read-policy.js";
import { resolveResponseBudget } from "./context-runtime/budget.js";
import type { ProjectionBudget, ProjectionBudgetConfig } from "./context-runtime/types.js";
import type { ReadGovernorMode, ReadGovernorPolicy } from "./context-runtime/read-policy.js";
import { normalizeToolMetadataOverride, RISK_VALUES } from "./adaptive/metadata.js";
import type { ToolMetadataOverride } from "./adaptive/metadata.js";

export interface OAuthAuthConfig {
  type: "oauth";
  profile: string;
}

export interface UpstreamConfig {
  /** ツール名の接頭辞 (`<name>__<toolName>`) と、ログ上の識別に使う。 */
  name: string;
  /** 省略時は既存互換の stdio。 */
  transport?: "stdio" | "streamableHttp";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  /** 値ではなく環境変数名を持つ。認証情報を設定ファイルへ書かないための参照。 */
  headersFromEnv?: Record<string, string>;
  /** tokenを受け取らず、host側brokerのMCP endpointを解決する。 */
  auth?: OAuthAuthConfig;
  enabled?: boolean;
  profile?: string;
  priority?: number;
  capabilities?: string[];
  /** ranking でこの provider を最優先するタスク分類。値は task category。 */
  preferredFor?: string[];
  /** ranking でこの provider を fallback 専用として末尾へ回すタスク分類。 */
  fallbackFor?: string[];
  /** この upstream の全 tool に既定として適用する risk/cost/latency 等。tool 単位が優先する。 */
  metadata?: ToolMetadataOverride;
}

export interface MottainaiConfig {
  /** 記録のみ。normalizeConfig はこの値でバリデーション分岐しない。全フィールドは version 不問で読める。 */
  version?: 1 | 2;
  mcpServers: Record<string, Omit<UpstreamConfig, "name">>;
  profiles?: Record<string, ProfileConfig>;
  gateway?: GatewayConfig;
}

export interface ProfileConfig {
  includeCapabilities?: string[];
  denyRisk?: string[];
  /**
   * raw tool escape hatch（#26）。既定 `undefined`（= `open`）は今までどおり
   * `mottainai_tool_search` / `_describe` / `_call` を profile に関わらず常に到達可能にする。
   * `"restricted"` を明示したときだけ、この3本にも `includeCapabilities` / `denyRisk` を適用する。
   */
  rawToolAccess?: "open" | "restricted";
}

/** success/failure 別の圧縮予算。片方だけの指定も許す。 */
export interface TokenBudgetEntry {
  success?: number;
  failure?: number;
}

/** raw config での指定形。数値 1 個は success/failure 両方に適用する省略形。 */
export type TokenBudgetInput = number | TokenBudgetEntry;

export interface TokenBudgetsConfig {
  /** キーは `<upstream>__<tool>` または upstream 名。tool 単位が最優先。 */
  tools?: Record<string, TokenBudgetInput>;
  capabilities?: Record<string, TokenBudgetInput>;
  /** キーは profile 名。 */
  profiles?: Record<string, TokenBudgetInput>;
  default?: TokenBudgetInput;
}

export interface ResolvedTokenBudgets {
  tools: Record<string, TokenBudgetEntry>;
  capabilities: Record<string, TokenBudgetEntry>;
  profiles: Record<string, TokenBudgetEntry>;
  default?: TokenBudgetEntry;
}

/** `mottainai_worktree_new` が受け付けるブランチ prefix と worktree の配置規則。省略時はツール自体を無効化する。 */
export interface WorktreeConfig {
  /** 許可するブランチ prefix（`<prefix>/<task>` の prefix 部分）。 */
  allowedBranchPrefixes: string[];
  /** worktree を作る起点ブランチ。既定 `main`。 */
  baseBranch?: string;
  /** `workspaceRoot` からの相対ディレクトリ。既定 `.worktrees`。 */
  worktreeDir?: string;
}

export interface ResolvedWorktreeConfig {
  allowedBranchPrefixes: string[];
  baseBranch: string;
  worktreeDir: string;
}

export interface GatewayConfig {
  /** 直接操作ツールがアクセスできる唯一のルート。既定はMCP起動時のcwd。 */
  workspaceRoot?: string;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  /** tool-local compression hint; `responseBudget` remains the final agent-visible boundary. */
  execTargetTokens?: number;
  resultTtlMs?: number;
  resultMaxEntries?: number;
  /** `profiles` のどれを現在の profile として使うか。公開 tool の絞り込みは #17 で実装済み。 */
  activeProfile?: string;
  /** OAuth credential provider module。値はtokenではなくhost側broker endpointを返す。 */
  oauthProviderModule?: string;
  /** tool 名または upstream 名から証拠 capability への写像。routing policy の provider 解決に使う。 */
  capabilityMap?: Record<string, string[]>;
  /** tool 名（`<upstream>__<tool>`）から risk/cost/latency 等への写像。upstream 単位の `metadata` より優先する。 */
  toolMetadata?: Record<string, ToolMetadataOverride>;
  /**
   * tool / capability / profile 単位の圧縮予算（opt-in）。**既定は無制限**——何も書かなければ
   * upstream 結果の圧縮は今までどおり行数・JSON 深さの上限だけで動く。書いた対象にだけ
   * トークン上限がかかる。解決順は tool > capability > profile > `default`。
   */
  tokenBudgets?: TokenBudgetsConfig;
  /** 最終MCP応答の投影予算。`tokenBudgets` はtool-local hintとして別管理する。 */
  responseBudget?: ProjectionBudgetConfig;
  /** `mottainai_read` の段階的source disclosure policy。 */
  readGovernor?: Partial<ReadGovernorPolicy>;
  /** `mottainai_worktree_new` の許可 prefix・起点ブランチ設定。省略時はツールを非公開にする。 */
  worktree?: WorktreeConfig;
  /** `mottainai_task_start`/`mottainai_task_status`（Git workflow task lifecycle）の公開可否。
   * worktree 作成等の副作用を持つため、`worktree` 同様に既定 false（非公開）。 */
  workflowTasks?: boolean;
}

export interface ResolvedGatewayConfig {
  workspaceRoot: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  execTargetTokens: number;
  resultTtlMs: number;
  resultMaxEntries: number;
  capabilityMap: Record<string, string[]>;
  toolMetadata: Record<string, ToolMetadataOverride>;
  /** `gateway.activeProfile` の名前。`profiles` の中身ではなく名前だけをここに持ち回る。 */
  activeProfile?: string;
  oauthProviderModule?: string;
  tokenBudgets: ResolvedTokenBudgets;
  /** 設定省略時は安全な既定値。手書きfixture互換のためoptional型。 */
  responseBudget?: ProjectionBudget;
  /** 設定省略時は progressive disclosure を enforce する。手書きfixture互換のためoptional型。 */
  readGovernor?: ReadGovernorPolicy;
  worktree?: ResolvedWorktreeConfig;
  workflowTasks: boolean;
}

/** 起動時に一度だけ解決した設定。以後の各層は同じ絶対パス基準を共有する。 */
export interface ConfigSnapshot {
  configPath: string;
  config: MottainaiConfig;
  gatewayConfig: ResolvedGatewayConfig;
}

const DEFAULT_GATEWAY_CONFIG: Omit<ResolvedGatewayConfig, "workspaceRoot"> = {
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 300_000,
  maxOutputBytes: 100 * 1024 * 1024,
  execTargetTokens: 1_000,
  resultTtlMs: 15 * 60 * 1000,
  resultMaxEntries: 200,
  capabilityMap: {},
  toolMetadata: {},
  tokenBudgets: { tools: {}, capabilities: {}, profiles: {} },
  responseBudget: { softTokens: 1_500, hardTokens: 3_000, hardBytes: 12_000 },
  readGovernor: { ...DEFAULT_READ_GOVERNOR_POLICY },
  workflowTasks: false,
};

export function loadMottainaiConfig(configPath?: string): MottainaiConfig {
  return loadMottainaiConfigPath(resolveConfigPath(configPath));
}

export function resolveGatewayConfig(
  config: GatewayConfig | undefined,
  cwd: string = process.cwd(),
): ResolvedGatewayConfig {
  const workspaceRoot = path.resolve(cwd, config?.workspaceRoot ?? cwd);
  const maxTimeoutMs = positiveInteger(config?.maxTimeoutMs, DEFAULT_GATEWAY_CONFIG.maxTimeoutMs);
  const defaultTimeoutMs = Math.min(
    positiveInteger(config?.defaultTimeoutMs, DEFAULT_GATEWAY_CONFIG.defaultTimeoutMs),
    maxTimeoutMs,
  );
  return {
    workspaceRoot,
    defaultTimeoutMs,
    maxTimeoutMs,
    maxOutputBytes: positiveInteger(config?.maxOutputBytes, DEFAULT_GATEWAY_CONFIG.maxOutputBytes),
    execTargetTokens: positiveInteger(config?.execTargetTokens, DEFAULT_GATEWAY_CONFIG.execTargetTokens),
    resultTtlMs: positiveInteger(config?.resultTtlMs, DEFAULT_GATEWAY_CONFIG.resultTtlMs),
    resultMaxEntries: positiveInteger(config?.resultMaxEntries, DEFAULT_GATEWAY_CONFIG.resultMaxEntries),
    capabilityMap: config?.capabilityMap ?? {},
    toolMetadata: config?.toolMetadata ?? {},
    activeProfile: config?.activeProfile,
    tokenBudgets: resolveTokenBudgets(config?.tokenBudgets),
    responseBudget: resolveResponseBudget(config?.responseBudget),
    readGovernor: resolveReadGovernorPolicy(config?.readGovernor),
    worktree: resolveWorktreeConfig(config?.worktree),
    workflowTasks: config?.workflowTasks === true,
  };
}

function resolveReadGovernorPolicy(config: Partial<ReadGovernorPolicy> | undefined): ReadGovernorPolicy {
  return { ...DEFAULT_READ_GOVERNOR_POLICY, ...config };
}

function resolveWorktreeConfig(config: WorktreeConfig | undefined): ResolvedWorktreeConfig | undefined {
  if (config === undefined) return undefined;
  return {
    allowedBranchPrefixes: config.allowedBranchPrefixes,
    baseBranch: config.baseBranch ?? "main",
    worktreeDir: config.worktreeDir ?? ".worktrees",
  };
}

function resolveTokenBudgetEntry(value: TokenBudgetInput | undefined): TokenBudgetEntry | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? { success: value, failure: value } : value;
}

function resolveTokenBudgets(config: TokenBudgetsConfig | undefined): ResolvedTokenBudgets {
  const resolveMap = (map: Record<string, TokenBudgetInput> | undefined): Record<string, TokenBudgetEntry> =>
    Object.fromEntries(
      Object.entries(map ?? {}).flatMap(([key, value]) => {
        const entry = resolveTokenBudgetEntry(value);
        return entry === undefined ? [] : [[key, entry]];
      }),
    );
  return {
    tools: resolveMap(config?.tools),
    capabilities: resolveMap(config?.capabilities),
    profiles: resolveMap(config?.profiles),
    default: resolveTokenBudgetEntry(config?.default),
  };
}

export function loadGatewayConfig(configPath?: string): ResolvedGatewayConfig {
  return loadConfigSnapshot(configPath).gatewayConfig;
}

function loadMottainaiConfigPath(resolvedPath: string): MottainaiConfig {
  const parsed: unknown = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  return normalizeConfig(parsed);
}

export function resolveConfigPath(configPath?: string, cwd: string = process.cwd()): string {
  return path.resolve(cwd, configPath ?? process.env.MOTTAINAI_CONFIG ?? "mottainai.config.json");
}

/** config 相対値を起動 cwd に再解釈させないため、入口で絶対 snapshot へ固定する。 */
export function loadConfigSnapshot(configPath?: string, cwd: string = process.cwd()): ConfigSnapshot {
  const resolvedPath = resolveConfigPath(configPath, cwd);
  const configDirectory = path.dirname(resolvedPath);
  const loaded = loadMottainaiConfigPath(resolvedPath);
  const config: MottainaiConfig = {
    ...loaded,
    mcpServers: Object.fromEntries(Object.entries(loaded.mcpServers).map(([name, upstream]) => [name, {
      ...upstream,
      ...(upstream.cwd === undefined ? {} : { cwd: path.resolve(configDirectory, upstream.cwd) }),
    }])),
  };
  // workspaceRoot 省略時だけ起動 cwd。明示時は既存の config 相対解決を維持。
  const gatewayCwd = config.gateway?.workspaceRoot === undefined ? cwd : configDirectory;
  return {
    configPath: resolvedPath,
    config,
    gatewayConfig: resolveGatewayConfig(config.gateway, gatewayCwd),
  };
}

/**
 * 正規化前の設定ファイル。管理 CLI が編集するときは、`normalizeConfig` が補う既定値
 * （`enabled` / `priority` / `capabilities`）を書き戻さないよう生の JSON を扱う。
 */
export function loadRawConfig(configPath?: string): { filePath: string; raw: Record<string, unknown> } {
  const filePath = resolveConfigPath(configPath);
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error("invalid mottainai config");
  return { filePath, raw: parsed };
}

/** 書き込み前に正規化で検証する。壊れた設定をディスクへ残さない。 */
export function saveRawConfig(filePath: string, raw: Record<string, unknown>): void {
  normalizeConfig(raw);
  fs.writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`);
}

function normalizeConfig(value: unknown): MottainaiConfig {
  if (!isRecord(value) || (value.version !== undefined && value.version !== 1 && value.version !== 2)) {
    throw new Error("invalid mottainai config");
  }
  if (!isRecord(value.mcpServers)) {
    throw new Error("invalid mcpServers config");
  }

  const mcpServers = Object.fromEntries(
    Object.entries(value.mcpServers).map(([name, config]) => [name, normalizeUpstream(name, config)]),
  );
  const profiles = value.profiles === undefined ? undefined : normalizeProfiles(value.profiles);
  for (const [name, upstream] of Object.entries(mcpServers)) {
    if (upstream.profile !== undefined && profiles?.[upstream.profile] === undefined) {
      throw new Error(`unknown upstream profile: ${upstream.profile} for ${name}`);
    }
  }
  const gateway = normalizeGateway(value.gateway);
  if (gateway?.activeProfile !== undefined && profiles?.[gateway.activeProfile] === undefined) {
    throw new Error(`unknown gateway activeProfile: ${gateway.activeProfile}`);
  }
  // version は表示用ラベル。v1 設定でも v2 由来フィールド（profiles 等）はそのまま通す。
  return { version: value.version === 2 ? 2 : 1, mcpServers, profiles, gateway };
}

function normalizeGateway(value: unknown): GatewayConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("invalid gateway config");
  const workspaceRoot = optionalString(value.workspaceRoot, "invalid gateway workspaceRoot");
  return {
    workspaceRoot,
    defaultTimeoutMs: positiveIntegerConfig(value.defaultTimeoutMs, "invalid gateway defaultTimeoutMs"),
    maxTimeoutMs: positiveIntegerConfig(value.maxTimeoutMs, "invalid gateway maxTimeoutMs"),
    maxOutputBytes: positiveIntegerConfig(value.maxOutputBytes, "invalid gateway maxOutputBytes"),
    execTargetTokens: positiveIntegerConfig(value.execTargetTokens, "invalid gateway execTargetTokens"),
    resultTtlMs: positiveIntegerConfig(value.resultTtlMs, "invalid gateway resultTtlMs"),
    resultMaxEntries: positiveIntegerConfig(value.resultMaxEntries, "invalid gateway resultMaxEntries"),
    activeProfile: optionalString(value.activeProfile, "invalid gateway activeProfile"),
    oauthProviderModule: optionalString(value.oauthProviderModule, "invalid gateway oauthProviderModule"),
    capabilityMap: stringArrayRecord(value.capabilityMap, "invalid gateway capabilityMap"),
    toolMetadata: toolMetadataRecord(value.toolMetadata, "invalid gateway toolMetadata"),
    tokenBudgets: tokenBudgetsConfig(value.tokenBudgets, "invalid gateway tokenBudgets"),
    responseBudget: responseBudgetConfig(value.responseBudget, "invalid gateway responseBudget"),
    readGovernor: readGovernorConfig(value.readGovernor, "invalid gateway readGovernor"),
    worktree: worktreeConfig(value.worktree, "invalid gateway worktree"),
    workflowTasks: optionalBoolean(value.workflowTasks, "invalid gateway workflowTasks"),
  };
}

function worktreeConfig(value: unknown, field: string): WorktreeConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(field);
  const allowedBranchPrefixes = stringArray(value.allowedBranchPrefixes, `${field}.allowedBranchPrefixes`);
  if (
    allowedBranchPrefixes === undefined
    || allowedBranchPrefixes.length === 0
    || allowedBranchPrefixes.some((prefix) => prefix.length === 0)
  ) {
    throw new Error(`${field}.allowedBranchPrefixes must be a non-empty string array of non-empty prefixes`);
  }
  return {
    allowedBranchPrefixes,
    baseBranch: optionalString(value.baseBranch, `${field}.baseBranch`),
    worktreeDir: optionalString(value.worktreeDir, `${field}.worktreeDir`),
  };
}

function toolMetadataRecord(value: unknown, field: string): Record<string, ToolMetadataOverride> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(field);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeToolMetadataOverride(entry, `${field}.${key}`)]),
  );
}

function tokenBudgetInput(value: unknown, field: string): TokenBudgetInput {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(field);
    return value;
  }
  if (!isRecord(value)) throw new Error(field);
  const success = positiveIntegerConfig(value.success, `${field}.success`);
  const failure = positiveIntegerConfig(value.failure, `${field}.failure`);
  return { success, failure };
}

function tokenBudgetInputRecord(value: unknown, field: string): Record<string, TokenBudgetInput> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(field);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, tokenBudgetInput(entry, `${field}.${key}`)]));
}

function tokenBudgetsConfig(value: unknown, field: string): TokenBudgetsConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(field);
  return {
    tools: tokenBudgetInputRecord(value.tools, `${field}.tools`),
    capabilities: tokenBudgetInputRecord(value.capabilities, `${field}.capabilities`),
    profiles: tokenBudgetInputRecord(value.profiles, `${field}.profiles`),
    default: value.default === undefined ? undefined : tokenBudgetInput(value.default, `${field}.default`),
  };
}

function responseBudgetConfig(value: unknown, field: string): ProjectionBudgetConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(field);
  const config = {
    softTokens: positiveIntegerConfig(value.softTokens, `${field}.softTokens`),
    hardTokens: positiveIntegerConfig(value.hardTokens, `${field}.hardTokens`),
    hardBytes: positiveIntegerConfig(value.hardBytes, `${field}.hardBytes`),
  };
  resolveResponseBudget(config);
  return config;
}

function readGovernorConfig(value: unknown, field: string): Partial<ReadGovernorPolicy> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(field);
  const mode = value.mode;
  if (mode !== undefined && !(READ_GOVERNOR_MODES as readonly unknown[]).includes(mode)) {
    throw new Error(`${field}.mode`);
  }
  const maxRawLines = positiveIntegerConfig(value.maxRawLines, `${field}.maxRawLines`);
  const maxRawBytes = positiveIntegerConfig(value.maxRawBytes, `${field}.maxRawBytes`);
  const allowWholeFileBelowLines = positiveIntegerConfig(
    value.allowWholeFileBelowLines,
    `${field}.allowWholeFileBelowLines`,
  );
  const preferAuto = optionalBoolean(value.preferAuto, `${field}.preferAuto`);
  return {
    ...(mode === undefined ? {} : { mode: mode as ReadGovernorMode }),
    ...(maxRawLines === undefined ? {} : { maxRawLines }),
    ...(maxRawBytes === undefined ? {} : { maxRawBytes }),
    ...(allowWholeFileBelowLines === undefined ? {} : { allowWholeFileBelowLines }),
    ...(preferAuto === undefined ? {} : { preferAuto }),
  };
}

function normalizeUpstream(name: string, value: unknown): Omit<UpstreamConfig, "name"> {
  if (!isRecord(value)) {
    throw new Error(`invalid upstream config: ${name}`);
  }
  const transport = value.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "streamableHttp") {
    throw new Error(`invalid upstream transport: ${name}`);
  }
  if (transport === "stdio" && typeof value.command !== "string") {
    throw new Error(`invalid upstream config: ${name}`);
  }
  if (transport === "streamableHttp" && !isHttpUrl(value.url)) {
    throw new Error(`invalid upstream url: ${name}`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`invalid upstream enabled: ${name}`);
  }
  if (value.profile !== undefined && typeof value.profile !== "string") {
    throw new Error(`invalid upstream profile: ${name}`);
  }
  if (value.priority !== undefined && (typeof value.priority !== "number" || !Number.isSafeInteger(value.priority) || value.priority < 0)) {
    throw new Error(`invalid upstream priority: ${name}`);
  }
  const common = {
    enabled: value.enabled ?? true,
    profile: optionalString(value.profile, `invalid upstream profile: ${name}`),
    priority: value.priority ?? 0,
    capabilities: stringArray(value.capabilities, `invalid upstream capabilities: ${name}`) ?? [],
    preferredFor: stringArray(value.preferredFor, `invalid upstream preferredFor: ${name}`) ?? [],
    fallbackFor: stringArray(value.fallbackFor, `invalid upstream fallbackFor: ${name}`) ?? [],
    metadata: value.metadata === undefined ? undefined : normalizeToolMetadataOverride(value.metadata, `${name}.metadata`),
  };
  if (transport === "streamableHttp") {
    const headersFromEnv = stringRecord(value.headersFromEnv, `invalid upstream headersFromEnv: ${name}`);
    const auth = normalizeUpstreamAuth(name, value.auth);
    if (auth !== undefined && headersFromEnv !== undefined) {
      throw new Error(`invalid upstream auth headers: ${name}`);
    }
    return {
      transport,
      url: value.url as string,
      headersFromEnv,
      ...(auth === undefined ? {} : { auth }),
      ...common,
    };
  }
  if (value.auth !== undefined || value.headersFromEnv !== undefined || value.url !== undefined) {
    throw new Error(`invalid stdio upstream auth: ${name}`);
  }
  return {
    ...(value.transport === undefined ? {} : { transport }),
    command: value.command as string,
    args: stringArray(value.args, `invalid upstream args: ${name}`),
    env: stringRecord(value.env, `invalid upstream env: ${name}`),
    cwd: optionalString(value.cwd, `invalid upstream cwd: ${name}`),
    ...common,
  };
}

function normalizeUpstreamAuth(name: string, value: unknown): OAuthAuthConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.type !== "oauth" || typeof value.profile !== "string" || value.profile.length === 0) {
    throw new Error(`invalid upstream auth: ${name}`);
  }
  return { type: "oauth", profile: value.profile };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeProfiles(value: unknown): Record<string, ProfileConfig> {
  if (!isRecord(value)) {
    throw new Error("invalid profiles config");
  }
  return Object.fromEntries(Object.entries(value).map(([name, profile]) => {
    if (!isRecord(profile)) {
      throw new Error(`invalid profile config: ${name}`);
    }
    return [name, {
      includeCapabilities: stringArray(profile.includeCapabilities, `invalid profile capabilities: ${name}`),
      denyRisk: denyRiskArray(profile.denyRisk, name),
      rawToolAccess: rawToolAccessValue(profile.rawToolAccess, `invalid profile rawToolAccess: ${name}`),
    }];
  }));
}

/** 各要素を共有の risk enum（`RISK_VALUES`）に照らして検証する。typo は deny を静かに無効化するため。 */
function denyRiskArray(value: unknown, profileName: string): string[] | undefined {
  const values = stringArray(value, `invalid profile denyRisk: ${profileName}`);
  if (values === undefined) return undefined;
  for (const risk of values) {
    if (!(RISK_VALUES as string[]).includes(risk)) {
      throw new Error(`invalid profile denyRisk value: ${risk} for ${profileName}`);
    }
  }
  return values;
}

function rawToolAccessValue(value: unknown, message: string): "open" | "restricted" | undefined {
  if (value === undefined) return undefined;
  if (value !== "open" && value !== "restricted") throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, message: string): string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}

function optionalBoolean(value: unknown, message: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(message);
  }
  return value;
}

function stringArray(value: unknown, message: string): string[] | undefined {
  if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
    throw new Error(message);
  }
  return value as string[] | undefined;
}

function stringRecord(value: unknown, message: string): Record<string, string> | undefined {
  if (value !== undefined && (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string"))) {
    throw new Error(message);
  }
  return value as Record<string, string> | undefined;
}

function stringArrayRecord(value: unknown, message: string): Record<string, string[]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((entry) => !Array.isArray(entry) || entry.some((item) => typeof item !== "string"))) {
    throw new Error(message);
  }
  return value as Record<string, string[]>;
}

function positiveIntegerConfig(value: unknown, message: string): number | undefined {
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(message);
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
