import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveTsxLoaderUrl } from "../test-support/tsx-loader.js";

function resolveCliEntryPoint(): string {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
  return path.join(repoRoot, "src", "index.ts");
}

export interface StartGatewayOptions {
  /** black-boxワークスペースのcwd。gatewayの mcp_exec/read/list 等はここを起点に動く。 */
  cwd: string;
  /** 起動する mottainai.config.json への絶対パス。 */
  configPath: string;
  /** 省略時はSDKの既定allowlist（HOME/PATH等の安全なサブセット）だけを子プロセスへ渡す。 */
  env?: Record<string, string>;
}

export interface GatewayConnection {
  client: Client;
  close(): Promise<void>;
}

/**
 * distビルドに依存せず、tsx経由でsrc/index.tsをstdio subprocessとして起動しMCP clientで
 * 接続する。#22のblack-box MCPテスト（実プロセス起動→実プロトコル→実レスポンス検証）の
 * 接続点。ビルド成果物や特定のcwdを前提にしないので、任意の一時workspaceから黒箱テストできる。
 */
export async function startGatewayViaStdio(options: StartGatewayOptions): Promise<GatewayConnection> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", resolveTsxLoaderUrl(), resolveCliEntryPoint(), "serve", "--config", options.configPath],
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const client = new Client({ name: "mottainai-e2e-test-client", version: "0.0.0-test" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}
