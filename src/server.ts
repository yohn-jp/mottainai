import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
    { name: "mottainai", version: "0.1.0" },
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
  await server.connect(transport);
}
