import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import packageMetadata from "../package.json" with { type: "json" };
import { loadConfigSnapshot } from "./config.js";
import { ManagerSessionService } from "./manager/service.js";
import { ZellijCliRuntime } from "./manager/zellij.js";
import { NawabariExecutionClient } from "./workflow/nawabari.js";
import { defaultWorkflowStore } from "./workflow/commands/mcp-tools.js";
import { callHarnessDelegationTool, harnessDelegationTools } from "./workflow/commands/mcp-delegation.js";
import { HarnessDelegationService } from "./workflow/domain/harness-delegation.js";

/**
 * Native harness-delegation MCP surface (Issue #548). This is a deliberately
 * narrow northbound boundary: it exposes only the four delegation tools plus
 * the capabilities tool, never the broad low-level local/workflow-command/
 * adaptive/broker/code-search catalog that `runServer` (src/server.ts) wires
 * up for the legacy `mottainai serve` gateway. Keep it that way - adding a
 * tool here means adding it to the public harness contract, not reusing the
 * legacy gateway's tool surface.
 */
export async function runHarnessDelegationServer(
  configPath?: string,
  cwd: string = process.cwd(),
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  const snapshot = loadConfigSnapshot(configPath, cwd);
  const server = new Server(
    { name: "mottainai-mcp", version: packageMetadata.version },
    { capabilities: { tools: {} } },
  );

  const nawabari = new NawabariExecutionClient();
  const managerServices = new Map<string, Promise<ManagerSessionService>>();
  const managerForWorkspace = async (
    workspaceRoot: string,
    store: Awaited<ReturnType<typeof defaultWorkflowStore>>,
  ): Promise<ManagerSessionService> => {
    const key = path.resolve(workspaceRoot);
    const existing = managerServices.get(key);
    if (existing !== undefined) return existing;
    const created = Promise.resolve(
      new ManagerSessionService({
        workspaceRoot: key,
        store,
        nawabari,
        runtime: new ZellijCliRuntime({
          cwd: key,
          environment,
          binary: environment?.MOTTAINAI_ZELLIJ_BINARY ?? "zellij",
        }),
      }),
    ).catch((error: unknown) => {
      managerServices.delete(key);
      throw error;
    });
    managerServices.set(key, created);
    return created;
  };
  const harnessDelegation = new HarnessDelegationService({
    defaultWorkspaceRoot: snapshot.gatewayConfig.workspaceRoot,
    store: defaultWorkflowStore,
    managerForWorkspace,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: harnessDelegationTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments as Record<string, unknown> | undefined;
    return callHarnessDelegationTool(request.params.name, args, harnessDelegation);
  });

  const transport = new StdioServerTransport();
  let closePromise: Promise<void> | undefined;
  const closeServer = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = server.close();
    return closePromise;
  };
  const onSignal = (): void => {
    void closeServer().catch((error: unknown) => console.error(error instanceof Error ? error.message : String(error)));
  };
  const onInputEnd = (): void => {
    void closeServer().catch((error: unknown) => console.error(error instanceof Error ? error.message : String(error)));
  };
  transport.onclose = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.stdin.off("end", onInputEnd);
    process.stdin.off("close", onInputEnd);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdin.once("end", onInputEnd);
  process.stdin.once("close", onInputEnd);
  await server.connect(transport);
}
