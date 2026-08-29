import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { DIRECT_BOUNDARIES } from "./boundary.js";
import type { BoundaryOperations } from "./boundary.js";

// timeout/output limit後に協調終了を待ち、無視する子プロセスだけ強制終了する。
const TERMINATION_GRACE_MS = 1_000;

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputLimit: boolean;
  spawnError?: string;
}

export interface OutputFilePaths {
  stdout: string;
  stderr: string;
}

const FILE_CAPTURE_HIGH_WATER_MARK = 16 * 1024;

interface FileCaptureState {
  bytes: number;
  limit: number;
  limitSignaled: boolean;
  onLimit: () => void;
}

/**
 * Writes at most the remaining shared output budget to one file. The Writable
 * boundary applies backpressure while the underlying file stream flushes, so
 * a fast producer cannot accumulate an unbounded write queue in memory.
 */
class BoundedFileWriter extends Writable {
  private readonly state: FileCaptureState;
  private readonly destination: ReturnType<typeof createWriteStream>;

  constructor(
    filePath: string,
    state: FileCaptureState,
    boundaries: BoundaryOperations,
    onError: (error: Error) => void,
  ) {
    super({ highWaterMark: FILE_CAPTURE_HIGH_WATER_MARK });
    this.state = state;
    this.destination = boundaries.file("process.output.open", () =>
      createWriteStream(filePath, { flags: "w", highWaterMark: FILE_CAPTURE_HIGH_WATER_MARK }),
    );
    this.destination.on("error", (error: Error) => this.destroy(error));
    this.on("error", onError);
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    const remaining = this.state.limit - this.state.bytes;
    if (remaining <= 0) {
      signalFileCaptureLimit(this.state);
      callback();
      return;
    }
    const part = buffer.subarray(0, remaining);
    this.state.bytes += part.length;
    if (part.length !== buffer.length) signalFileCaptureLimit(this.state);
    if (part.length === 0) {
      callback();
      return;
    }
    this.destination.write(part, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.destination.end(() => callback());
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.destination.destroy();
    callback(error);
  }
}

function signalFileCaptureLimit(state: FileCaptureState): void {
  if (state.limitSignaled) return;
  state.limitSignaled = true;
  state.onLimit();
}

class BoundedFileCapture {
  readonly stdout: Writable;
  readonly stderr: Writable;
  private readonly closed: Promise<void>;
  private closeRequested = false;

  constructor(
    paths: OutputFilePaths,
    maxOutputBytes: number,
    onLimit: () => void,
    onError: (error: Error) => void,
    boundaries: BoundaryOperations,
  ) {
    const state: FileCaptureState = {
      bytes: 0,
      limit: maxOutputBytes,
      limitSignaled: false,
      onLimit,
    };
    this.stdout = new BoundedFileWriter(paths.stdout, state, boundaries, onError);
    try {
      this.stderr = new BoundedFileWriter(paths.stderr, state, boundaries, onError);
    } catch (error) {
      this.stdout.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    this.closed = Promise.all([finished(this.stdout), finished(this.stderr)]).then(() => undefined);
  }

  close(): Promise<void> {
    if (!this.closeRequested) {
      this.closeRequested = true;
      this.stdout.end();
      this.stderr.end();
    }
    return this.closed;
  }
}

function requestGracefulTermination(child: ReturnType<typeof spawn>, boundaries: BoundaryOperations): void {
  if (child.pid) {
    try {
      const sent = boundaries.process("process.group.sigterm", () => process.kill(-child.pid!, "SIGTERM"));
      if (sent) return;
    } catch {
      /* fall back to the child when process-group signaling is unavailable */
    }
  }
  try {
    boundaries.process("process.child.sigterm", () => child.kill("SIGTERM"));
  } catch {
    /* child already ended */
  }
}

export function runProgram(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  env?: NodeJS.ProcessEnv,
  boundaries: BoundaryOperations = DIRECT_BOUNDARIES,
): Promise<RunResult> {
  return runChild(program, args, cwd, timeoutMs, maxOutputBytes, false, undefined, env, boundaries);
}

/** `runProgram`と同じ境界で、有限のJSON stdinを子プロセスへ渡す。 */
export function runProgramWithInput(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  input: string,
  env?: NodeJS.ProcessEnv,
  boundaries: BoundaryOperations = DIRECT_BOUNDARIES,
): Promise<RunResult> {
  return runChild(program, args, cwd, timeoutMs, maxOutputBytes, false, undefined, env, boundaries, input);
}

export function runChild(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  shell: boolean,
  outputFiles?: OutputFilePaths,
  env?: NodeJS.ProcessEnv,
  boundaries: BoundaryOperations = DIRECT_BOUNDARIES,
  input?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd,
      shell,
      detached: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    };
    if (env !== undefined) spawnOptions.env = env;
    let child: ReturnType<typeof spawn>;
    try {
      child = boundaries.process("process.spawn", () => spawn(command, args, spawnOptions));
    } catch (error) {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        outputLimit: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let bytes = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimit = false;
    let settled = false;
    let terminationRequested = false;
    let killTimer: NodeJS.Timeout | undefined;
    let capture: BoundedFileCapture | undefined;
    let captureError: Error | undefined;
    const normalizeCaptureError = (error: unknown): Error =>
      error instanceof Error ? error : new Error(String(error));
    const failCapture = (error: unknown): void => {
      if (captureError === undefined) captureError = normalizeCaptureError(error);
      terminate();
    };
    const finish = (result: RunResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (capture === undefined) {
          if (captureError !== undefined) reject(captureError);
          else
            resolve({
              ...result,
              stdout: fitTextToByteLimit(result.stdout, stdoutBytes),
              stderr: fitTextToByteLimit(result.stderr, stderrBytes),
            });
          return;
        }
        try {
          void capture.close().then(
            () => {
              if (captureError !== undefined) reject(captureError);
              else resolve(result);
            },
            (error: unknown) => reject(captureError ?? normalizeCaptureError(error)),
          );
        } catch (error) {
          reject(captureError ?? normalizeCaptureError(error));
        }
      }
    };
    const forceTerminate = (): void => {
      if (child.pid) {
        try {
          boundaries.process("process.group.sigkill", () => process.kill(-child.pid!, "SIGKILL"));
        } catch {
          /* child already ended */
        }
      }
      try {
        boundaries.process("process.child.sigkill", () => child.kill("SIGKILL"));
      } catch {
        /* child already ended */
      }
    };
    const terminate = (): void => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      requestGracefulTermination(child, boundaries);
      if (killTimer === undefined) killTimer = setTimeout(forceTerminate, TERMINATION_GRACE_MS);
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = maxOutputBytes - bytes;
      if (remaining <= 0) {
        outputLimit = true;
        terminate();
        return;
      }
      const part = chunk.subarray(0, remaining);
      bytes += part.length;
      if (target === "stdout") {
        stdoutBytes += part.length;
        stdout += stdoutDecoder.write(part);
      } else {
        stderrBytes += part.length;
        stderr += stderrDecoder.write(part);
      }
      if (part.length !== chunk.length) {
        outputLimit = true;
        terminate();
      }
    };
    if (outputFiles === undefined) {
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    }
    child.on("error", (error) =>
      finish({ stdout, stderr, exitCode: null, signal: null, timedOut, outputLimit, spawnError: error.message }),
    );
    child.on("close", (exitCode, signal) => finish({ stdout, stderr, exitCode, signal, timedOut, outputLimit }));
    if (input !== undefined) child.stdin?.end(input);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    if (outputFiles !== undefined) {
      try {
        capture = new BoundedFileCapture(
          outputFiles,
          maxOutputBytes,
          () => {
            outputLimit = true;
            terminate();
          },
          failCapture,
          boundaries,
        );
        child.stdout?.pipe(capture.stdout, { end: false });
        child.stderr?.pipe(capture.stderr, { end: false });
      } catch (error) {
        failCapture(error);
      }
    }
  });
}

function fitTextToByteLimit(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && low < value.length && value.charCodeAt(low - 1) >= 0xd800 && value.charCodeAt(low - 1) <= 0xdbff) {
    low -= 1;
  }
  return value.slice(0, low);
}

export type ManagedProcessState = "running" | "exited";

/**
 * start と完了 await を分離するための child process ラッパー（Issue #74）。
 * `runChild` と違い、生成直後に呼び出し側へ制御を返す — 完了は `settled` promise で別途待てる。
 * output は `runChild` 同様 byte 上限で打ち切り、超過時は協調終了 → grace 後 SIGKILL する。
 */
export class ManagedProcess {
  private readonly child: ReturnType<typeof spawn> | undefined;
  private readonly boundaries: BoundaryOperations;
  private stdout = "";
  private stderr = "";
  private bytes = 0;
  private timedOut = false;
  private outputLimit = false;
  private settledFlag = false;
  private terminationRequested = false;
  private killTimer: NodeJS.Timeout | undefined;
  private resolveSettled!: (result: RunResult) => void;
  readonly settled: Promise<RunResult>;
  readonly startedAt: number;

  constructor(
    command: string,
    cwd: string,
    maxOutputBytes: number,
    shell: boolean,
    env?: NodeJS.ProcessEnv,
    boundaries: BoundaryOperations = DIRECT_BOUNDARIES,
  ) {
    this.startedAt = Date.now();
    const spawnOptions: SpawnOptions = { cwd, shell, detached: true, stdio: ["ignore", "pipe", "pipe"] };
    if (env !== undefined) spawnOptions.env = env;
    this.boundaries = boundaries;
    try {
      this.child = boundaries.process("process.spawn", () => spawn(command, [], spawnOptions));
    } catch (error) {
      this.child = undefined;
      this.settled = Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        outputLimit: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      this.settledFlag = true;
      return;
    }
    const child = this.child;
    this.settled = new Promise((resolve) => {
      this.resolveSettled = resolve;
    });

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = maxOutputBytes - this.bytes;
      if (remaining <= 0) {
        this.outputLimit = true;
        this.terminate();
        return;
      }
      const part = chunk.subarray(0, remaining);
      this.bytes += part.length;
      if (target === "stdout") this.stdout += part.toString("utf8");
      else this.stderr += part.toString("utf8");
      if (part.length !== chunk.length) {
        this.outputLimit = true;
        this.terminate();
      }
    };
    child?.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child?.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child?.on("error", (error) =>
      this.finish({
        stdout: this.stdout,
        stderr: this.stderr,
        exitCode: null,
        signal: null,
        timedOut: this.timedOut,
        outputLimit: this.outputLimit,
        spawnError: error.message,
      }),
    );
    child?.on("close", (exitCode, signal) =>
      this.finish({
        stdout: this.stdout,
        stderr: this.stderr,
        exitCode,
        signal,
        timedOut: this.timedOut,
        outputLimit: this.outputLimit,
      }),
    );
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get state(): ManagedProcessState {
    return this.settledFlag ? "exited" : "running";
  }

  /** 猶予付き協調終了（SIGTERM → grace 経過後 SIGKILL）。 */
  terminate(): void {
    if (this.settledFlag || this.terminationRequested || this.child === undefined) return;
    this.terminationRequested = true;
    requestGracefulTermination(this.child, this.boundaries);
    if (this.killTimer === undefined) this.killTimer = setTimeout(() => this.forceTerminate(), TERMINATION_GRACE_MS);
  }

  /** 即時 SIGKILL。connection/process shutdown や abandoned handle の cleanup で使う。 */
  forceTerminate(): void {
    if (this.settledFlag) return;
    if (this.child?.pid) {
      try {
        this.boundaries.process("process.group.sigkill", () => process.kill(-this.child!.pid!, "SIGKILL"));
      } catch {
        /* child already ended */
      }
    }
    try {
      this.boundaries.process("process.child.sigkill", () => this.child?.kill("SIGKILL"));
    } catch {
      /* child already ended */
    }
  }

  markTimedOut(): void {
    this.timedOut = true;
    this.terminate();
  }

  /** 最大 lifetime 到達時の即時終了。通常の await timeout の猶予付き終了とは分離する。 */
  expire(): void {
    if (this.settledFlag) return;
    this.timedOut = true;
    this.forceTerminate();
  }

  private finish(result: RunResult): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    if (this.killTimer !== undefined) clearTimeout(this.killTimer);
    this.resolveSettled(result);
  }
}
