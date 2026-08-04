#!/usr/bin/env node
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadOAuthCredentialProvider } from "./auth.js";
import { loadConfigSnapshot } from "./config.js";
import { createLogger } from "./logging.js";
import { registerProxyHandlers } from "./proxy.js";
import { InMemoryArtifactStore } from "./retrieve.js";
import { UpstreamRegistry } from "./upstream.js";

const { configPath, config, gatewayConfig } = loadConfigSnapshot();
const oauthCredentialProvider = await loadOAuthCredentialProvider(
  gatewayConfig.oauthProviderModule,
  path.dirname(configPath),
);
const upstreams = new UpstreamRegistry(
  Object.entries(config.mcpServers).map(([name, upstream]) => ({ name, ...upstream })),
  undefined,
  oauthCredentialProvider,
);
const logger = createLogger();
const artifactStore = new InMemoryArtifactStore({
  ttlMs: gatewayConfig.resultTtlMs,
  maxEntries: gatewayConfig.resultMaxEntries,
});

const server = new Server(
  { name: "mottainai", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
const activeProfileName = config.gateway?.activeProfile;
const activeProfile = activeProfileName === undefined ? undefined : config.profiles?.[activeProfileName];
registerProxyHandlers(server, upstreams, logger, artifactStore, gatewayConfig, {}, activeProfile);

const transport = new StdioServerTransport();
await server.connect(transport);
