import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveTsxLoaderUrl } from "../test-support/tsx-loader.js";

const CLOSE_TIMEOUT_MS = 5_000;
const FORCE_EXIT_TIMEOUT_MS = 1_000;
const PROCESS_POLL_MS = 25;

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function forceTerminate(processId: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let killer: ReturnType<typeof spawn> | undefined;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        try {
          killer?.kill();
        } catch {
          // teardown は best effort。元のテストエラーを隠さない。
        }
        killer?.unref();
        finish();
      }, FORCE_EXIT_TIMEOUT_MS);
      try {
        killer = spawn("taskkill", ["/pid", String(processId), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", finish);
        killer.once("close", finish);
      } catch {
        finish();
      }
    });
    return;
  }
  try {
    process.kill(processId, "SIGKILL");
  } catch {
    // teardown は best effort。元のテストエラーを隠さない。
  }
}

async function waitForProcessExit(processId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(processId)) return true;
    await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
  }
  return !processIsAlive(processId);
}

async function closeWithDeadline(client: Client, processId: number | null): Promise<void> {
  let closeFailure: unknown;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`gateway close timed out after ${CLOSE_TIMEOUT_MS}ms`)), CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    closeFailure = error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (processId !== null && processIsAlive(processId)) {
    await forceTerminate(processId);
    const exited = await waitForProcessExit(processId, FORCE_EXIT_TIMEOUT_MS);
    if (!exited) {
      throw new Error(
        `gateway process ${processId} remained alive after forced termination` +
          (closeFailure === undefined ? "" : `; close failure: ${String(closeFailure)}`),
      );
    }
  }
  if (closeFailure !== undefined) throw closeFailure;
}

function resolveCliEntryPoint(): string {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
  return path.join(repoRoot, "src", "index.ts");
}

export interface StartGatewayOptions {
  workingDirectory: string;
  configPath: string;
  /** 省略時はSDKの既定allowlistだけ継承させ、host環境全体を子プロセスへ渡さないため。 */
  environment?: Record<string, string>;
}

export interface GatewayConnection {
  client: Client;
  close(): Promise<void>;
}

// 公開distの状態に依存せず、sourceからstdio protocol境界を検証するため。
export async function startGatewayViaStdio(options: StartGatewayOptions): Promise<GatewayConnection> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", resolveTsxLoaderUrl(), resolveCliEntryPoint(), "serve", "--config", options.configPath],
    cwd: options.workingDirectory,
    ...(options.environment === undefined ? {} : { env: options.environment }),
  });
  const client = new Client({ name: "mottainai-e2e-test-client", version: "0.0.0-test" }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (error) {
    const processId = transport.pid;
    if (processId !== null) await forceTerminate(processId);
    throw error;
  }
  const processId = transport.pid;
  return {
    client,
    close: async () => {
      await closeWithDeadline(client, processId);
    },
  };
}
