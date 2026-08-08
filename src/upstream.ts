import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveBrokerEndpoint } from "./auth.js";
import type { OAuthCredentialProvider } from "./auth.js";
import type { UpstreamConfig } from "./config.js";

export interface UpstreamHandle {
  config: UpstreamConfig;
  client: Client;
  tools: Tool[];
}

export type UpstreamState = "disabled" | "registered" | "starting" | "ready" | "unhealthy" | "stopped";

/** 診断用の provider 状態。config の `env` と `args` は秘密を含みうるので載せない。 */
export interface UpstreamStatus {
  name: string;
  state: UpstreamState;
  enabled: boolean;
  priority: number;
  capabilities: string[];
  toolCount?: number;
  failureCount: number;
  lastError?: string;
  lastErrorAt?: string;
}

interface UpstreamRecord {
  config: UpstreamConfig;
  state: UpstreamState;
  handle?: UpstreamHandle;
  starting?: Promise<UpstreamHandle>;
  failureCount: number;
  lastError?: string;
  lastErrorAt?: string;
}

export type UpstreamConnector = (config: UpstreamConfig) => Promise<UpstreamHandle>;

interface UpstreamDiagnosticError extends Error {
  mottainaiUpstreamDiagnostic?: string;
}

export function upstreamErrorMessage(error: unknown): string {
  const baseMessage = upstreamBaseErrorMessage(error);
  if (!(error instanceof Error)) return baseMessage;
  const diagnostic = (error as UpstreamDiagnosticError).mottainaiUpstreamDiagnostic;
  return diagnostic === undefined ? baseMessage : `${baseMessage}; ${upstreamDiagnosticSummary(diagnostic)}`;
}

export function upstreamBaseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function upstreamDiagnosticSummary(diagnostic: string): string {
  const provider = diagnostic.match(/(?:^| )provider=([^ ]+)/u)?.[1];
  const phase = diagnostic.match(/(?:^| )phase=([^ ]+)/u)?.[1];
  const timeout = diagnostic.match(/(?:^| )timeout_ms=([^ ]+)/u)?.[1];
  const fields = [
    provider === undefined ? undefined : `provider=${provider}`,
    phase === undefined ? undefined : `phase=${phase}`,
    timeout === undefined ? undefined : `timeout_ms=${timeout}`,
    diagnostic.includes("stderr_tail=") ? "stderr_tail=[redacted]" : undefined,
    diagnostic.includes("transcript=") ? "transcript=[redacted]" : undefined,
  ].filter((field): field is string => field !== undefined);
  return fields.length === 0 ? "upstream diagnostic available" : fields.join(" ");
}

export function hasUpstreamDiagnostic(error: unknown): boolean {
  return error instanceof Error
    && (error as UpstreamDiagnosticError).mottainaiUpstreamDiagnostic !== undefined;
}

export const UPSTREAM_STARTUP_TIMEOUT_MS = 2_000;
const UPSTREAM_CLOSE_TIMEOUT_MS = 1_000;
const UPSTREAM_STDERR_TAIL_BYTES = 16 * 1024;

class UpstreamTimeoutError extends Error {}

async function withDeadline<T>(operation: Promise<T>, config: UpstreamConfig, phase: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new UpstreamTimeoutError(
              `upstream=${config.name} phase=${phase} timeout_ms=${UPSTREAM_STARTUP_TIMEOUT_MS}`,
            ),
          );
        }, UPSTREAM_STARTUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeClient(client: Client): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, UPSTREAM_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return Buffer.from(value).subarray(-maxBytes).toString("utf8");
}

function appendTail(values: string[], value: string): void {
  values.push(value);
  let bytes = values.reduce((total, entry) => total + Buffer.byteLength(entry), 0);
  while (bytes > UPSTREAM_STDERR_TAIL_BYTES && values.length > 0) {
    bytes -= Buffer.byteLength(values.shift() ?? "");
  }
}

export const fetchWithoutRedirects: FetchLike = (url, init) => {
  return globalThis.fetch(url, { ...init, redirect: "error" });
};

/** upstream は必要な時だけ接続し、失敗を他 upstream から分離する。 */
export class UpstreamRegistry {
  private readonly records = new Map<string, UpstreamRecord>();
  private readonly connector: UpstreamConnector;
  /** shutdown 開始後は in-flight start が ready handle を復活させられないようにする。 */
  private closing = false;
  private closingPromise?: Promise<void>;

  constructor(
    configs: UpstreamConfig[],
    connector?: UpstreamConnector,
    oauthCredentialProvider?: OAuthCredentialProvider,
  ) {
    this.connector = connector ?? ((config) => connectUpstream(config, oauthCredentialProvider));
    for (const config of configs) {
      this.records.set(config.name, {
        config,
        state: config.enabled === false ? "disabled" : "registered",
        failureCount: 0,
      });
    }
  }

  state(name: string): UpstreamState | undefined { return this.records.get(name)?.state; }
  configs(): UpstreamConfig[] { return [...this.records.values()].map((record) => record.config); }
  readyHandles(): UpstreamHandle[] { return [...this.records.values()].flatMap((record) => record.handle ? [record.handle] : []); }
  enabledNames(): string[] {
    return [...this.records.values()]
      .filter((record) => record.state !== "disabled")
      .map((record) => record.config.name);
  }

  /** provider 単位の状態と最後の失敗理由。診断出力に秘密を混ぜないため config を丸ごと返さない。 */
  status(): UpstreamStatus[] {
    return [...this.records.values()].map((record) => ({
      name: record.config.name,
      state: record.state,
      enabled: record.config.enabled !== false,
      priority: record.config.priority ?? 0,
      capabilities: record.config.capabilities ?? [],
      toolCount: record.handle?.tools.length,
      failureCount: record.failureCount,
      lastError: record.lastError,
      lastErrorAt: record.lastErrorAt,
    }));
  }

  async start(name: string): Promise<UpstreamHandle> {
    const record = this.records.get(name);
    if (!record) throw new Error(`unknown upstream: ${name}`);
    if (this.closing) throw new Error(`upstream registry is shutting down: ${name}`);
    if (record.state === "disabled") throw new Error(`upstream disabled: ${name}`);
    if (record.handle) return record.handle;
    if (record.starting) return record.starting;
    record.state = "starting";
    record.starting = this.connector(record.config).then(async (handle) => {
      if (this.closing) {
        // shutdown が start と競合した。ready へ昇格させず、handle 自体を閉じてリークを防ぐ。
        await closeClient(handle.client);
        record.state = record.state === "disabled" ? "disabled" : "stopped";
        throw new Error(`upstream registry closed while starting: ${name}`);
      }
      record.handle = handle;
      record.state = "ready";
      return handle;
    }).catch((error: unknown) => {
      if (!this.closing) {
        // 次の実行要求で無条件に再試行するため、失敗回数は診断のためだけに持つ。
        record.state = "unhealthy";
        record.failureCount += 1;
        record.lastError = upstreamBaseErrorMessage(error);
        record.lastErrorAt = new Date().toISOString();
      }
      throw error;
    }).finally(() => { record.starting = undefined; });
    return record.starting;
  }

  /** 実行中の接続断を次回 start の再接続へつなげる。古い client は再利用しない。 */
  async invalidate(name: string, error: unknown): Promise<void> {
    const record = this.records.get(name);
    if (!record || record.state === "disabled") return;
    const handle = record.handle;
    record.handle = undefined;
    record.state = "unhealthy";
    record.failureCount += 1;
    record.lastError = upstreamBaseErrorMessage(error);
    record.lastErrorAt = new Date().toISOString();
    if (handle) {
      try {
        await closeClient(handle.client);
      } catch {
        // 元の実行エラーを status に残し、close の二次エラーで原因を隠さない。
      }
    }
  }

  /**
   * shutdown は冪等（複数回呼んでも同じ Promise を返す）。
   * in-flight start は待たない — connector が固まっていると無期限に待つことになるため。
   * その代わり closing フラグにより、start が後から解決しても ready へは昇格させず自ら閉じる。
   */
  async close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    this.closingPromise = (async () => {
      await Promise.all([...this.records.values()].map(async (record) => {
        const handle = record.handle;
        record.handle = undefined;
        record.state = record.state === "disabled" ? "disabled" : "stopped";
        if (handle) {
          try {
            await closeClient(handle.client);
          } catch {
            // 1 つの upstream の close 失敗で他 upstream の停止を止めない。
          }
        }
      }));
    })();
    return this.closingPromise;
  }
}

export async function createUpstreamTransport(
  config: UpstreamConfig,
  oauthCredentialProvider?: OAuthCredentialProvider,
): Promise<Transport> {
  if (config.transport === "streamableHttp") {
    if (config.url === undefined) throw new Error(`upstream url missing: ${config.name}`);
    const targetUrl = new URL(config.url);
    let endpoint = targetUrl;
    if (config.auth?.type === "oauth") {
      if (oauthCredentialProvider === undefined) {
        throw new Error(`oauth credential provider unavailable: ${config.auth.profile}`);
      }
      endpoint = await resolveBrokerEndpoint(oauthCredentialProvider, targetUrl, config.auth.profile);
    }
    const headers = config.headersFromEnv === undefined
      ? undefined
      : Object.fromEntries(Object.entries(config.headersFromEnv).map(([header, environmentName]) => {
        const value = process.env[environmentName];
        if (value === undefined) throw new Error(`upstream header environment missing: ${environmentName}`);
        return [header, value];
      }));
    if (headers !== undefined && endpoint.protocol !== "https:") {
      throw new Error(`credentialed upstream requires https: ${config.name}`);
    }
    return new StreamableHTTPClientTransport(endpoint, {
      fetch: fetchWithoutRedirects,
      ...(headers === undefined ? {} : { requestInit: { headers } }),
    });
  }
  if (config.command === undefined) throw new Error(`upstream command missing: ${config.name}`);
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    stderr: "pipe",
  });
}

export async function connectUpstream(
  config: UpstreamConfig,
  oauthCredentialProvider?: OAuthCredentialProvider,
  createClient: (config: UpstreamConfig) => Client = (c) => new Client({ name: `mottainai/${c.name}`, version: "0.1.0" }),
): Promise<UpstreamHandle> {
  let client: Client | undefined;
  let phase = "transport";
  const transcript: string[] = ["phase=transport started"];
  const stderrTail: string[] = [];
  try {
    const transport = await withDeadline(createUpstreamTransport(config, oauthCredentialProvider), config, phase);
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        appendTail(stderrTail, boundedText(text, UPSTREAM_STDERR_TAIL_BYTES));
        process.stderr.write(text);
      });
    }
    client = createClient(config);
    phase = "initialize";
    transcript.push("phase=initialize started");
    await withDeadline(client.connect(transport), config, phase);
    transcript.push("phase=initialize completed");
    phase = "listTools";
    transcript.push("phase=listTools started");
    const { tools } = await withDeadline(client.listTools(), config, phase);
    transcript.push("phase=listTools completed");
    return { config, client, tools };
  } catch (error) {
    // connect() の途中失敗（stdio なら child process が spawn 済みの場合がある）も
    // listTools() の失敗も、同じスコープで client を閉じる。close 自体の失敗で元のエラーを隠さない。
    if (client !== undefined) await closeClient(client);
    const details = `provider=${config.name} phase=${phase} stderr_tail=${JSON.stringify(stderrTail.join(""))}`
      + ` transcript=${JSON.stringify(transcript)}`;
    if (error instanceof Error) {
      Object.defineProperty(error, "mottainaiUpstreamDiagnostic", {
        configurable: true,
        value: details,
      });
      throw error;
    }
    const normalized = new Error(upstreamBaseErrorMessage(error));
    Object.defineProperty(normalized, "mottainaiUpstreamDiagnostic", {
      configurable: true,
      value: details,
    });
    throw normalized;
  }
}
