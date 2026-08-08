import { spawn } from "node:child_process";
import { createFixtureQuery } from "./fixture.js";
import { readDashboardViewer } from "./assets.js";
import {
  DEFAULT_DASHBOARD_PORT,
  LOOPBACK_HOST,
  startDashboardServer,
  type DashboardServerHandle,
} from "./http.js";

const DASHBOARD_USAGE = "usage: mottainai dashboard [--no-open] [--port <port>]";

export interface DashboardCommandOptions {
  noOpen: boolean;
  port: number;
}

export type BrowserOpener = (url: string) => Promise<void>;

export interface DashboardStartOptions extends DashboardCommandOptions {
  viewerHtml?: string;
  browserOpener?: BrowserOpener;
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
    throw new Error(`${DASHBOARD_USAGE}\nunknown dashboard option: ${argument}`);
  }
  return { noOpen, port };
}

export function openDashboardBrowser(url: string, platform: NodeJS.Platform): Promise<void> {
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve());
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function startDashboard(options: DashboardStartOptions): Promise<DashboardServerHandle> {
  const handle = await startDashboardServer({
    host: LOOPBACK_HOST,
    port: options.port,
    query: createFixtureQuery(),
    viewerHtml: options.viewerHtml ?? readDashboardViewer(),
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
