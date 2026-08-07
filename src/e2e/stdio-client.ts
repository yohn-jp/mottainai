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
  cwd: string;
  configPath: string;
  /** 省略時はSDKの既定allowlistだけ継承させ、host環境全体を子プロセスへ渡さないため。 */
  env?: Record<string, string>;
}

export interface GatewayConnection {
  client: Client;
  close(): Promise<void>;
}

/** dist成果物への依存を避けるため、tsx経由でsrc/index.tsを直接subprocess起動する。 */
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
