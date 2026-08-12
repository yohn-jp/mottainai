import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { runProgram } from "../subprocess.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export type ZellijObservedState = "running" | "exited" | "absent";

export interface ZellijCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError?: string;
}

export type ZellijCommandRunner = (args: readonly string[], cwd: string) => Promise<ZellijCommandResult>;

export interface ZellijRuntime {
  checkAvailability(): Promise<{ version: string }>;
  inspect(sessionName: string, expectedCwd?: string): Promise<ZellijObservedState>;
  start(input: { sessionName: string; cwd: string; command: string; args: readonly string[] }): Promise<void>;
  attach(sessionName: string, cwd: string): Promise<void>;
  terminate(sessionName: string, cwd: string): Promise<void>;
}

export class ZellijRuntimeError extends Error {
  constructor(
    readonly code: "zellij_unavailable" | "zellij_launch_failed" | "zellij_session_missing" | "zellij_command_failed",
    message: string,
  ) {
    super(message);
    this.name = "ZellijRuntimeError";
  }
}

function assertSessionName(sessionName: string): void {
  if (!SESSION_NAME_PATTERN.test(sessionName))
    throw new ZellijRuntimeError("zellij_command_failed", "invalid Zellij session name");
}

function defaultRunner(binary: string, environment?: NodeJS.ProcessEnv): ZellijCommandRunner {
  return async (args, cwd) => {
    const result = await runProgram(binary, [...args], cwd, DEFAULT_TIMEOUT_MS, DEFAULT_OUTPUT_BYTES, environment);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ...(result.spawnError === undefined ? {} : { spawnError: result.spawnError }),
    };
  };
}

function sessionRow(stdout: string, sessionName: string): string | undefined {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line === sessionName || line.startsWith(`${sessionName} `));
}

function exitedPane(stdout: string, expectedCwd: string | undefined): boolean | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const panes = parsed.filter((pane): pane is Record<string, unknown> => typeof pane === "object" && pane !== null);
  const namedTarget = panes.find(
    (pane) => pane.pane_name === "mottainai-agent" || pane.name === "mottainai-agent" || pane.title === "mottainai-agent",
  );
  const target =
    namedTarget ??
    panes.find(
      (pane) => expectedCwd !== undefined && (pane.pane_cwd === expectedCwd || pane.cwd === expectedCwd),
    );
  if (target === undefined) return undefined;
  return target.exited === true || (target.exit_status !== null && target.exit_status !== undefined);
}

/** Thin argv-only adapter. Terminal transport and pane/session lifetime remain Zellij responsibilities. */
export class ZellijCliRuntime implements ZellijRuntime {
  private readonly run: ZellijCommandRunner;
  private readonly spawnImpl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  private availability: { version: string } | undefined;

  constructor(options: {
    binary?: string;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    run?: ZellijCommandRunner;
    spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  }) {
    const binary = options.binary ?? "zellij";
    this.run = options.run ?? defaultRunner(binary, options.environment);
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    this.binary = binary;
    this.defaultCwd = options.cwd;
  }

  private readonly binary: string;
  private readonly defaultCwd: string;

  async checkAvailability(): Promise<{ version: string }> {
    if (this.availability !== undefined) return this.availability;
    const result = await this.run(["--version"], this.defaultCwd);
    if (result.spawnError !== undefined || result.exitCode !== 0 || result.stdout.trim().length === 0) {
      throw new ZellijRuntimeError(
        "zellij_unavailable",
        `Zellij is required for mottainai manager but is unavailable; install Zellij and ensure "${this.binary}" is on PATH`,
      );
    }
    this.availability = { version: result.stdout.trim().split(/\r?\n/u)[0] ?? result.stdout.trim() };
    return this.availability;
  }

  async inspect(sessionName: string, expectedCwd?: string): Promise<ZellijObservedState> {
    assertSessionName(sessionName);
    const result = await this.run(["list-sessions"], this.defaultCwd);
    if (result.spawnError !== undefined) {
      throw new ZellijRuntimeError("zellij_unavailable", `Zellij session inspection failed: ${result.spawnError}`);
    }
    if (result.exitCode !== 0 && result.stdout.trim().length === 0) return "absent";
    const row = sessionRow(result.stdout, sessionName);
    if (row === undefined) return "absent";
    if (/\bEXITED\b/u.test(row)) return "exited";
    const panes = await this.run(["--session", sessionName, "action", "list-panes", "--json"], this.defaultCwd);
    if (panes.exitCode === 0) {
      const exited = exitedPane(panes.stdout, expectedCwd);
      if (exited === true) return "exited";
    }
    return "running";
  }

  async start(input: { sessionName: string; cwd: string; command: string; args: readonly string[] }): Promise<void> {
    assertSessionName(input.sessionName);
    const background = await this.run(["attach", "--create-background", input.sessionName], input.cwd);
    if (background.spawnError !== undefined || background.exitCode !== 0) {
      throw new ZellijRuntimeError(
        "zellij_launch_failed",
        `Zellij session creation failed for ${input.sessionName}: ${background.spawnError ?? (background.stderr.trim() || `exit ${background.exitCode}`)}`,
      );
    }
    const pane = await this.run(
      [
        "--session",
        input.sessionName,
        "action",
        "new-pane",
        "--cwd",
        input.cwd,
        "--name",
        "mottainai-agent",
        "--",
        input.command,
        ...input.args,
      ],
      input.cwd,
    );
    if (pane.spawnError !== undefined || pane.exitCode !== 0) {
      await this.terminate(input.sessionName, input.cwd).catch(() => undefined);
      throw new ZellijRuntimeError(
        "zellij_launch_failed",
        `Zellij agent pane launch failed for ${input.sessionName}: ${pane.spawnError ?? (pane.stderr.trim() || `exit ${pane.exitCode}`)}`,
      );
    }
  }

  attach(sessionName: string, cwd: string): Promise<void> {
    assertSessionName(sessionName);
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(this.binary, ["attach", sessionName], { cwd, shell: false, stdio: "inherit" });
      } catch (error) {
        reject(
          new ZellijRuntimeError(
            "zellij_command_failed",
            `could not open Zellij terminal: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      child.once("error", (error) =>
        reject(new ZellijRuntimeError("zellij_command_failed", `could not open Zellij terminal: ${error.message}`)),
      );
      child.once("spawn", () => resolve());
    });
  }

  async terminate(sessionName: string, cwd: string): Promise<void> {
    assertSessionName(sessionName);
    const result = await this.run(["kill-session", sessionName], cwd);
    if (
      result.spawnError !== undefined ||
      (result.exitCode !== 0 && !/no session|not found|does not exist/iu.test(result.stderr))
    ) {
      throw new ZellijRuntimeError(
        "zellij_command_failed",
        `Zellij session termination failed for ${sessionName}: ${result.spawnError ?? (result.stderr.trim() || `exit ${result.exitCode}`)}`,
      );
    }
  }
}

export function deriveZellijSessionName(sessionId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(sessionId)) throw new Error("invalid manager session id");
  return `mottainai-${sessionId.toLowerCase()}`;
}
