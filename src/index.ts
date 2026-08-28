#!/usr/bin/env node
import fs from "node:fs";
import { runCli } from "./cli.js";
import { resolveConfigPath } from "./config.js";
import { closeDashboard, hasActiveDashboard } from "./dashboard/command.js";
import { closeManager, hasActiveManager } from "./manager/command.js";
import { createRuntimeDiagnostic, formatRuntimeDiagnosticHuman } from "./runtime-diagnostic.js";
import { runServer } from "./server.js";
import { projectTaskLaunchHelp, resolveSkillCli } from "./skill.js";

const args = process.argv.slice(2);
const startupCwd = process.cwd();

if (args.length === 0) {
  const runtimeDiagnostic = createRuntimeDiagnostic({
    cwd: startupCwd,
    environment: process.env,
    entryPoint: process.argv[1],
  });
  try {
    await runServer(
      undefined,
      startupCwd,
      runtimeDiagnostic,
      process.env.HOME ?? process.env.USERPROFILE,
      process.env,
    );
  } catch (error) {
    const configPath = resolveConfigPath();
    const missingConfig =
      error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(configPath);
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
      console.error(`${message}\n\nRuntime diagnostic:\n${formatRuntimeDiagnosticHuman(runtimeDiagnostic)}`);
    } else {
      console.error(
        `${error instanceof Error ? error.message : String(error)}\n\nRuntime diagnostic:\n${formatRuntimeDiagnosticHuman(runtimeDiagnostic)}`,
      );
    }
    process.exitCode = 1;
  }
} else if (args[0] === "skill") {
  const result = resolveSkillCli(args.slice(1));
  if (result.stream === "stdout") console.log(result.output);
  else console.error(result.output);
  process.exitCode = result.exitCode;
} else if (
  args[0] === "task" &&
  (args[1] === "start" || args[1] === "run") &&
  (args.includes("--help") || args.includes("-h"))
) {
  console.log(projectTaskLaunchHelp(args[1]));
  process.exitCode = 0;
} else {
  process.exitCode = await runCli(args);
  if ((args[0] === "dashboard" && hasActiveDashboard()) || (args[0] === "manager" && hasActiveManager())) {
    const shutdown = (): void => {
      const close = args[0] === "manager" ? closeManager : closeDashboard;
      void close()
        .catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
