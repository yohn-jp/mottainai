import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { runProgram } from "../subprocess.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
// `action list-panes --json`, used by inspect() for every running/detached
// session, was only added in Zellij 0.44.0; earlier versions pass this
// version gate but fail closed the first time a live session is inspected.
const MINIMUM_ZELLIJ_VERSION = [0, 44, 0] as const;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

export type ZellijObservedState = "running" | "detached" | "exited" | "absent" | "unresolved";

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
    readonly code:
      | "zellij_unavailable"
      | "zellij_incompatible"
      | "zellij_launch_failed"
      | "zellij_session_missing"
      | "zellij_command_failed",
    message: string,
  ) {
    super(message);
    this.name = "ZellijRuntimeError";
  }
}

function parseVersion(output: string): [number, number, number] | undefined {
  const match = /\b(\d+)\.(\d+)(?:\.(\d+))?\b/u.exec(output);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function isBeforeMinimum(version: readonly [number, number, number]): boolean {
  return (
    version[0] < MINIMUM_ZELLIJ_VERSION[0] ||
    (version[0] === MINIMUM_ZELLIJ_VERSION[0] && version[1] < MINIMUM_ZELLIJ_VERSION[1]) ||
    (version[0] === MINIMUM_ZELLIJ_VERSION[0] &&
      version[1] === MINIMUM_ZELLIJ_VERSION[1] &&
      version[2] < MINIMUM_ZELLIJ_VERSION[2])
  );
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
    .map((line) => line.replace(ANSI_ESCAPE_PATTERN, "").trim())
    .find((line) => line === sessionName || line.startsWith(`${sessionName} `));
}

function agentPaneName(sessionName: string): string {
  return `${sessionName}-agent`;
}

function resolvePane(
  stdout: string,
  expectedCwd: string | undefined,
  expectedPaneName: string,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const panes = parsed.filter((pane): pane is Record<string, unknown> => typeof pane === "object" && pane !== null);
  const namedTarget = panes.find(
    (pane) => pane.pane_name === expectedPaneName || pane.name === expectedPaneName || pane.title === expectedPaneName,
  );
  return (
    namedTarget ??
    panes.find((pane) => expectedCwd !== undefined && (pane.pane_cwd === expectedCwd || pane.cwd === expectedCwd))
  );
}

function paneExited(pane: Record<string, unknown>): boolean {
  return pane.exited === true || (pane.exit_status !== null && pane.exit_status !== undefined);
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
    const version = parseVersion(result.stdout);
    if (version === undefined) {
      throw new ZellijRuntimeError(
        "zellij_incompatible",
        `Zellij version output is incompatible or unrecognized: ${result.stdout.trim().slice(0, 256)}`,
      );
    }
    if (isBeforeMinimum(version)) {
      throw new ZellijRuntimeError(
        "zellij_incompatible",
        `Zellij ${version.join(".")} is too old for Manager; install Zellij >= ${MINIMUM_ZELLIJ_VERSION.join(".")}`,
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
    if (result.exitCode !== 0) {
      if (/no active zellij sessions|no session|not found|does not exist/iu.test(result.stderr)) return "absent";
      throw new ZellijRuntimeError(
        "zellij_command_failed",
        `Zellij session inspection failed: ${result.spawnError ?? (result.stderr.trim() || `exit ${result.exitCode}`)}`,
      );
    }
    const row = sessionRow(result.stdout, sessionName);
    if (row === undefined) return "absent";
    // An exited session cannot answer `action list-panes`; trust the row
    // regardless of expectedCwd, or a cwd-scoped inspect of a dead session
    // throws zellij_command_failed instead of reporting "exited".
    if (/\bEXITED\b/iu.test(row)) return "exited";
    const panes = await this.run(["--session", sessionName, "action", "list-panes", "--json"], this.defaultCwd);
    if (panes.spawnError !== undefined) {
      throw new ZellijRuntimeError("zellij_command_failed", `Zellij pane inspection failed: ${panes.spawnError}`);
    }
    if (panes.exitCode === 0) {
      const expectedPaneName = agentPaneName(sessionName);
      const pane = resolvePane(panes.stdout, expectedCwd, expectedPaneName);
      if (pane === undefined) return "unresolved";
      if (expectedCwd !== undefined) {
        const paneCwd = pane.pane_cwd ?? pane.cwd;
        if (paneCwd !== expectedCwd) return "unresolved";
      }
      if (paneExited(pane)) return "exited";
      if (/\bDETACHED\b|\bATTACHABLE\b/iu.test(row)) return "detached";
    } else {
      throw new ZellijRuntimeError(
        "zellij_command_failed",
        `Zellij pane inspection failed: ${panes.stderr.trim() || `exit ${panes.exitCode}`}`,
      );
    }
    return "running";
  }

  async start(input: { sessionName: string; cwd: string; command: string; args: readonly string[] }): Promise<void> {
    assertSessionName(input.sessionName);
    const existing = await this.inspect(input.sessionName);
    if (existing !== "absent") {
      throw new ZellijRuntimeError(
        "zellij_launch_failed",
        `refusing to create Zellij session ${input.sessionName}: runtime identity is already ${existing}`,
      );
    }
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
        agentPaneName(input.sessionName),
        "--",
        input.command,
        ...input.args,
      ],
      input.cwd,
    );
    if (pane.spawnError !== undefined || pane.exitCode !== 0) {
      // The session was created by this invocation but has no managed pane yet,
      // so the normal identity-gated terminate path cannot safely recognize it.
      await this.killSessionCreatedByStart(input.sessionName, input.cwd).catch(() => undefined);
      throw new ZellijRuntimeError(
        "zellij_launch_failed",
        `Zellij agent pane launch failed for ${input.sessionName}: ${pane.spawnError ?? (pane.stderr.trim() || `exit ${pane.exitCode}`)}`,
      );
    }
  }

  private async killSessionCreatedByStart(sessionName: string, cwd: string): Promise<void> {
    const result = await this.run(["kill-session", sessionName], cwd);
    if (
      result.spawnError !== undefined ||
      (result.exitCode !== 0 && !/no session|not found|does not exist/iu.test(result.stderr))
    ) {
      throw new ZellijRuntimeError(
        "zellij_command_failed",
        `Zellij session cleanup failed for ${sessionName}: ${result.spawnError ?? (result.stderr.trim() || `exit ${result.exitCode}`)}`,
      );
    }
  }

  async attach(sessionName: string, cwd: string): Promise<void> {
    assertSessionName(sessionName);
    const observed = await this.inspect(sessionName, cwd);
    if (observed !== "running" && observed !== "detached") {
      throw new ZellijRuntimeError(
        "zellij_session_missing",
        `refusing to attach Zellij session ${sessionName}: managed runtime identity is ${observed}`,
      );
    }
    await new Promise<void>((resolve, reject) => {
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
    const observed = await this.inspect(sessionName, cwd);
    if (observed !== "running" && observed !== "detached" && observed !== "exited") {
      throw new ZellijRuntimeError(
        "zellij_session_missing",
        `refusing to terminate Zellij session ${sessionName}: managed runtime identity is ${observed}`,
      );
    }
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
