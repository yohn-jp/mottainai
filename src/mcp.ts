#!/usr/bin/env node
import { createRuntimeDiagnostic, formatRuntimeDiagnosticHuman } from "./runtime-diagnostic.js";
import { resolveConfigPath } from "./config.js";
import { runHarnessDelegationServer } from "./mcp-server.js";
import packageMetadata from "../package.json" with { type: "json" };

function configArgument(args: readonly string[]): { configPath?: string; help: boolean } {
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.error("usage: mottainai-mcp [--config <path>]");
      return { help: true };
    }
    if (argument !== "--config") throw new Error("usage: mottainai-mcp [--config <path>]");
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("missing value for --config");
    configPath = value;
    index += 1;
  }
  return { configPath, help: false };
}

const startupCwd = process.cwd();
const startupArgs = process.argv.slice(2);
if (startupArgs.length === 1 && startupArgs[0] === "--version") {
  console.log(`${packageMetadata.name} ${packageMetadata.version}`);
} else {
  let requestedConfigPath: string | undefined;
  try {
    const parsed = configArgument(startupArgs);
    requestedConfigPath = parsed.configPath;
    if (!parsed.help) {
      await runHarnessDelegationServer(requestedConfigPath, startupCwd, process.env);
    }
  } catch (error) {
    const configPath = resolveConfigPath(requestedConfigPath, startupCwd);
    console.error(
      `${error instanceof Error ? error.message : String(error)}\n\nRuntime diagnostic:\n${formatRuntimeDiagnosticHuman(
        createRuntimeDiagnostic({
          cwd: startupCwd,
          configPath,
          environment: process.env,
          entryPoint: process.argv[1],
        }),
      )}`,
    );
    process.exitCode = 1;
  }
}
