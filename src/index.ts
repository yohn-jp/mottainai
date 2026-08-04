#!/usr/bin/env node
import { runCli } from "./cli.js";
import { runServer } from "./server.js";

const args = process.argv.slice(2);

if (args.length === 0) {
  try {
    await runServer();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  process.exitCode = await runCli(args);
}
