import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageMetadata from "../package.json" with { type: "json" };
import { loadOAuthCredentialProvider } from "./auth.js";
import { loadConfigSnapshot } from "./config.js";
import { createLogger } from "./logging.js";
import { registerProxyHandlers } from "./proxy.js";
import { InMemoryArtifactStore } from "./retrieve.js";
import { createRuntimeDiagnostic, enrichRuntimeDiagnostic } from "./runtime-diagnostic.js";
import type { RuntimeDiagnostic } from "./runtime-diagnostic.js";
import { UpstreamRegistry } from "./upstream.js";
import { ManagerSessionService } from "./manager/service.js";
import { ZellijCliRuntime } from "./manager/zellij.js";
import { NawabariExecutionClient } from "./workflow/nawabari.js";
import { defaultWorkflowStore } from "./workflow/commands/mcp-tools.js";
import { HarnessDelegationService } from "./workflow/domain/harness-delegation.js";

export async function runServer(
  configPath?: string,
  cwd: string = process.cwd(),
  runtimeDiagnostic: RuntimeDiagnostic = createRuntimeDiagnostic({
    configPath,
    cwd,
    entryPoint: "unknown",
    environment: {},
  }),
  homeDirectory?: string,
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  const snapshot = loadConfigSnapshot(configPath, cwd);
  const resolvedRuntimeDiagnostic = enrichRuntimeDiagnostic(runtimeDiagnostic, snapshot, homeDirectory);
  const oauthCredentialProvider = await loadOAuthCredentialProvider(
    snapshot.gatewayConfig.oauthProviderModule,
    path.dirname(snapshot.configPath),
  );
  const upstreams = new UpstreamRegistry(
    Object.entries(snapshot.config.mcpServers).map(([name, upstream]) => ({ name, ...upstream })),
    undefined,
    oauthCredentialProvider,
  );
  const logger = createLogger();
  const artifactStore = new InMemoryArtifactStore({
    ttlMs: snapshot.gatewayConfig.resultTtlMs,
    maxEntries: snapshot.gatewayConfig.resultMaxEntries,
  });

  const server = new Server({ name: "mottainai", version: packageMetadata.version }, { capabilities: { tools: {} } });
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
    nawabari,
    managerForWorkspace,
  });
  const activeProfileName = snapshot.config.gateway?.activeProfile;
  const activeProfile = activeProfileName === undefined
    ? undefined
    : snapshot.config.profiles?.[activeProfileName];
  const proxyHandlers = registerProxyHandlers(
    server,
    upstreams,
    logger,
    artifactStore,
    snapshot.gatewayConfig,
    {},
    activeProfile,
    undefined,
    resolvedRuntimeDiagnostic,
    harnessDelegation,
  );

  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    proxyHandlers.dispose();
    shutdownPromise = upstreams.close();
    return shutdownPromise;
  };
  let closePromise: Promise<void> | undefined;
  const closeServer = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = shutdown().then(() => server.close());
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
    void shutdown().catch(() => {});
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdin.once("end", onInputEnd);
  process.stdin.once("close", onInputEnd);
  await server.connect(transport);
}
