import { execFileSync } from "node:child_process";
import path from "node:path";
import { openDashboardBrowser } from "../dashboard/command.js";
import {
  configuredDashboardProvider,
  createDashboardQuery,
  parseDashboardProvider,
  type DashboardProvider,
} from "../dashboard/provider.js";
import { LOOPBACK_HOST, startDashboardServer, type DashboardServerHandle } from "../dashboard/http.js";
import type { ManagerAgentKind, WorkflowStateStore } from "../workflow/state/store.js";
import type { ManagerExecutionAuthority } from "../workflow/domain/manager-execution.js";
import { ManagerHttpApi } from "./http.js";
import { readManagerAssets, readManagerViewer } from "./assets.js";
import { ManagerSessionService } from "./service.js";
import { NawabariExecutionClient } from "../workflow/nawabari.js";
import { ZellijCliRuntime, type ZellijRuntime } from "./zellij.js";
import { createManagerTerminalBridge } from "./terminal-bridge.js";

export const DEFAULT_MANAGER_PORT = 4318;
const MANAGER_USAGE =
  "usage: mottainai manager [--no-open] [--port <port>] [--provider fixture|live] [--workspace <path>]";

export interface ManagerCommandOptions {
  noOpen: boolean;
  port: number;
  provider?: DashboardProvider;
  workspace?: string;
}

export interface ManagerStartOptions extends ManagerCommandOptions {
  environment?: NodeJS.ProcessEnv;
  viewerHtml?: string;
  browserOpener?: (url: string) => Promise<void>;
  runtime?: ZellijRuntime;
  store?: WorkflowStateStore;
  agentCommands?: Partial<Record<ManagerAgentKind, { command: string; baseArgs?: readonly string[] }>>;
  executionAuthority?: ManagerExecutionAuthority;
}

let activeManager: DashboardServerHandle | undefined;

export function parseManagerOptions(args: readonly string[]): ManagerCommandOptions {
  let noOpen = false;
  let port = DEFAULT_MANAGER_PORT;
  let provider: DashboardProvider | undefined;
  let workspace: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") {
      noOpen = true;
      continue;
    }
    if (argument === "--port" || argument === "--provider" || argument === "--workspace") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`missing value for ${argument}\n${MANAGER_USAGE}`);
      index += 1;
      if (argument === "--port") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535)
          throw new Error(`invalid manager port: ${value}`);
        port = parsed;
      } else if (argument === "--provider") {
        provider = parseDashboardProvider(value);
      } else {
        workspace = value;
      }
      continue;
    }
    throw new Error(`${MANAGER_USAGE}\nunknown manager option: ${argument}`);
  }
  return {
    noOpen,
    port,
    ...(provider === undefined ? {} : { provider }),
    ...(workspace === undefined ? {} : { workspace }),
  };
}

function repositoryRoot(cwd: string, explicit: string | undefined): string {
  const candidate = path.resolve(cwd, explicit ?? ".");
  try {
    return (
      execFileSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || candidate
    );
  } catch {
    return candidate;
  }
}

export async function startManager(options: ManagerStartOptions): Promise<DashboardServerHandle> {
  const environment = options.environment ?? process.env;
  const workspaceRoot = repositoryRoot(process.cwd(), options.workspace);
  let store: WorkflowStateStore;
  if (options.store !== undefined) {
    store = options.store;
  } else {
    const { WorkflowSqliteStateStore } = await import("../workflow/state/sqlite-store.js");
    store = new WorkflowSqliteStateStore({ env: environment });
  }
  store.init();
  const runtime =
    options.runtime ??
    new ZellijCliRuntime({
      cwd: workspaceRoot,
      environment,
      binary: environment.MOTTAINAI_ZELLIJ_BINARY ?? "zellij",
    });
  const service = new ManagerSessionService({
    workspaceRoot,
    store,
    runtime,
    nawabari: new NawabariExecutionClient(),
    agentCommands: options.agentCommands,
    executionAuthority: options.executionAuthority,
  });
  try {
    await service.initialize();
    const terminalBridge = createManagerTerminalBridge({ service, runtime });
    const handle = await startDashboardServer({
      host: LOOPBACK_HOST,
      port: options.port,
      serviceName: "manager",
      query: createDashboardQuery(options.provider ?? configuredDashboardProvider(environment), workspaceRoot),
      viewerHtml: options.viewerHtml ?? readManagerViewer(),
      staticAssets: readManagerAssets(),
      manager: new ManagerHttpApi(service, terminalBridge),
    });
    if (!options.noOpen && options.browserOpener !== undefined)
      void options.browserOpener(handle.url).catch(() => undefined);
    const close = handle.close;
    const wrappedHandle: DashboardServerHandle = {
      ...handle,
      close: async () => {
        await close();
        terminalBridge.close();
        if (activeManager === wrappedHandle) activeManager = undefined;
        if (options.store === undefined) store.close();
      },
    };
    activeManager = wrappedHandle;
    return wrappedHandle;
  } catch (error) {
    if (options.store === undefined) store.close();
    throw error;
  }
}

export function hasActiveManager(): boolean {
  return activeManager !== undefined;
}

export async function closeManager(): Promise<void> {
  const handle = activeManager;
  activeManager = undefined;
  if (handle !== undefined) await handle.close();
}

export { openDashboardBrowser };
