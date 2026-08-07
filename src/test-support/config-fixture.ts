import fs from "node:fs";
import path from "node:path";
import type { MottainaiConfig } from "../config.js";

export interface BuildTestConfigOptions {
  mcpServers?: MottainaiConfig["mcpServers"];
  gateway?: MottainaiConfig["gateway"];
  profiles?: MottainaiConfig["profiles"];
}

/**
 * upstreamプロセス起動やnetworkに依存しない最小構成を返す。既定は空mcpServers、
 * workspaceRootは設定ファイル自身のディレクトリ（"."）に固定する決定論的な値。
 */
export function buildTestConfig(options: BuildTestConfigOptions = {}): MottainaiConfig {
  const config: MottainaiConfig = {
    version: 2,
    mcpServers: options.mcpServers ?? {},
    gateway: options.gateway ?? { workspaceRoot: "." },
  };
  if (options.profiles !== undefined) config.profiles = options.profiles;
  return config;
}

/** buildTestConfigの結果をディレクトリへ書き出し、解決済みパスを返す。 */
export function writeTestConfig(
  directory: string,
  options: BuildTestConfigOptions = {},
  fileName = "mottainai.config.json",
): string {
  const configPath = path.join(directory, fileName);
  fs.writeFileSync(configPath, JSON.stringify(buildTestConfig(options), null, 2));
  return configPath;
}
