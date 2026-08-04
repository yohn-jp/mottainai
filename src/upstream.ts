import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
        await handle.client.close().catch(() => {});
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
        record.lastError = errorMessage(error);
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
    record.lastError = errorMessage(error);
    record.lastErrorAt = new Date().toISOString();
    if (handle) {
      try {
        await handle.client.close();
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
            await handle.client.close();
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
    return new StreamableHTTPClientTransport(endpoint, headers === undefined ? undefined : {
      requestInit: { headers },
    });
  }
  if (config.command === undefined) throw new Error(`upstream command missing: ${config.name}`);
  return new StdioClientTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd });
}

export async function connectUpstream(
  config: UpstreamConfig,
  oauthCredentialProvider?: OAuthCredentialProvider,
  createClient: (config: UpstreamConfig) => Client = (c) => new Client({ name: `mottainai/${c.name}`, version: "0.1.0" }),
): Promise<UpstreamHandle> {
  const transport = await createUpstreamTransport(config, oauthCredentialProvider);
  const client = createClient(config);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return { config, client, tools };
  } catch (error) {
    // connect() の途中失敗（stdio なら child process が spawn 済みの場合がある）も
    // listTools() の失敗も、同じスコープで client を閉じる。close 自体の失敗で元のエラーを隠さない。
    await client.close().catch(() => {});
    throw error;
  }
}
