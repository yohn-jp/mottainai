#!/usr/bin/env node
import fs from "node:fs";
import { runCli } from "./cli.js";
import { resolveConfigPath } from "./config.js";
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
      if (process.stdin.isTTY === true && process.stdout.isTTY === true) console.log(message);
      else console.error(message);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
} else {
  process.exitCode = await runCli(args);
}
