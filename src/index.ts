#!/usr/bin/env node
import { runCli } from "./cli.js";
import { runServer } from "./server.js";

const args = process.argv.slice(2);

if (args.length === 0) {
  await runServer();
} else if (args[0] === "serve") {
  const configIndex = args.indexOf("--config", 1);
  const configPath = configIndex === -1 ? undefined : args[configIndex + 1];
  if (configIndex !== -1 && configPath === undefined) {
    console.error("missing value for --config");
    process.exitCode = 1;
  } else {
    await runServer(configPath);
  }
} else {
  process.exitCode = await runCli(args);
}
