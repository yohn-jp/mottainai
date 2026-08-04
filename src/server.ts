import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageMetadata from "../package.json" with { type: "json" };
import { loadOAuthCredentialProvider } from "./auth.js";
import { loadConfigSnapshot } from "./config.js";
import { createLogger } from "./logging.js";
import { registerProxyHandlers } from "./proxy.js";
import { InMemoryArtifactStore } from "./retrieve.js";
import { UpstreamRegistry } from "./upstream.js";

export async function runServer(configPath?: string, cwd: string = process.cwd()): Promise<void> {
  const snapshot = loadConfigSnapshot(configPath, cwd);
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

  const server = new Server(
    { name: "mottainai", version: packageMetadata.version },
    { capabilities: { tools: {} } },
  );
  const activeProfileName = snapshot.config.gateway?.activeProfile;
  const activeProfile = activeProfileName === undefined
    ? undefined
    : snapshot.config.profiles?.[activeProfileName];
  registerProxyHandlers(
    server,
    upstreams,
    logger,
    artifactStore,
    snapshot.gatewayConfig,
    {},
    activeProfile,
  );

  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = upstreams.close();
    return shutdownPromise;
  };
  const onSignal = (): void => {
    void shutdown()
      .then(() => server.close())
      .catch((error: unknown) => console.error(error instanceof Error ? error.message : String(error)));
  };
  transport.onclose = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    void shutdown().catch(() => {});
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await server.connect(transport);
}
