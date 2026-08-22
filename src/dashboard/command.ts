import { spawn } from "node:child_process";
import { readDashboardAssets, readDashboardViewer } from "./assets.js";
import {
  configuredDashboardProvider,
  createDashboardQuery,
  parseDashboardProvider,
  type DashboardProvider,
} from "./provider.js";
import {
  DEFAULT_DASHBOARD_PORT,
  LOOPBACK_HOST,
  startDashboardServer,
  type DashboardServerHandle,
} from "./http.js";

const DASHBOARD_USAGE = "usage: mottainai dashboard [--no-open] [--port <port>] [--provider fixture|live]";

export interface DashboardCommandOptions {
  noOpen: boolean;
  port: number;
  provider?: DashboardProvider;
}

export type BrowserOpener = (url: string) => Promise<void>;

export interface DashboardStartOptions extends DashboardCommandOptions {
  viewerHtml?: string;
  browserOpener?: BrowserOpener;
  environment?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
}

let activeDashboard: DashboardServerHandle | undefined;

export function parseDashboardOptions(args: readonly string[]): DashboardCommandOptions {
  let noOpen = false;
  let port = DEFAULT_DASHBOARD_PORT;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") {
      noOpen = true;
      continue;
    }
    if (argument === "--port") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --port\n${DASHBOARD_USAGE}`);
      index += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
        throw new Error(`invalid dashboard port: ${value}`);
      }
      port = parsed;
      continue;
    }
    if (argument === "--provider") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --provider\n${DASHBOARD_USAGE}`);
      index += 1;
      const provider = parseDashboardProvider(value);
      return {
        ...parseDashboardOptions([...args.slice(0, index - 1), ...args.slice(index + 1)]),
        provider,
      };
    }
    throw new Error(`${DASHBOARD_USAGE}\nunknown dashboard option: ${argument}`);
  }
  return { noOpen, port };
}

export function openDashboardBrowser(url: string, platform: NodeJS.Platform): Promise<void> {
  const command = platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve) => {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function startDashboard(options: DashboardStartOptions): Promise<DashboardServerHandle> {
  const provider = options.provider ?? configuredDashboardProvider(options.environment);
  const handle = await startDashboardServer({
    host: LOOPBACK_HOST,
    port: options.port,
    query: createDashboardQuery(provider, options.workspaceRoot ?? process.cwd()),
    viewerHtml: options.viewerHtml ?? readDashboardViewer(),
    staticAssets: readDashboardAssets(),
  });
  activeDashboard = handle;
  if (!options.noOpen && options.browserOpener !== undefined) {
    void options.browserOpener(handle.url).catch(() => undefined);
  }
  return handle;
}

export function hasActiveDashboard(): boolean {
  return activeDashboard !== undefined;
}

export async function closeDashboard(): Promise<void> {
  const handle = activeDashboard;
  activeDashboard = undefined;
  if (handle !== undefined) await handle.close();
}
