#!/usr/bin/env node
import fs from "node:fs";
import { runCli } from "./cli.js";
import { resolveConfigPath } from "./config.js";
import { closeDashboard, hasActiveDashboard } from "./dashboard/command.js";
import { runServer } from "./server.js";

const args = process.argv.slice(2);

if (args.length === 0) {
  try {
    await runServer();
  } catch (error) {
    const configPath = resolveConfigPath();
    const missingConfig = error instanceof Error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
      && !fs.existsSync(configPath);
    if (missingConfig) {
      const message = [
        "Mottainai configuration was not found:",
        `  ${configPath}`,
        "",
        "Initialize this workspace with:",
        "  npx -y mottainai init",
        "",
        "ENOENT: no such file or directory",
      ].join("\n");
      console.error(message);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
} else {
  process.exitCode = await runCli(args);
  if (args[0] === "dashboard" && hasActiveDashboard()) {
    const shutdown = (): void => {
      void closeDashboard().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
