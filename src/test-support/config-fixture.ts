import fs from "node:fs";
import path from "node:path";
import type { MottainaiConfig } from "../config.js";

export interface BuildTestConfigOptions {
  mcpServers?: MottainaiConfig["mcpServers"];
  gateway?: MottainaiConfig["gateway"];
  profiles?: MottainaiConfig["profiles"];
}

// 外部processやnetworkに依存しない決定論的な設定境界を検証するため。
export function buildTestConfig(options: BuildTestConfigOptions = {}): MottainaiConfig {
  const config: MottainaiConfig = {
    version: 2,
    mcpServers: options.mcpServers ?? {},
    gateway: options.gateway ?? { workspaceRoot: "." },
  };
  if (options.profiles !== undefined) config.profiles = options.profiles;
  return config;
}

export function writeTestConfig(
  directory: string,
  options: BuildTestConfigOptions = {},
  fileName = "mottainai.config.json",
): string {
  const configPath = path.join(directory, fileName);
  fs.writeFileSync(configPath, JSON.stringify(buildTestConfig(options), null, 2));
  return configPath;
}
