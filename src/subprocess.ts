import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";

// timeout/output limit後に協調終了を待ち、無視する子プロセスだけ強制終了する。
const TERMINATION_GRACE_MS = 1_000;

export interface RunResult { stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean; outputLimit: boolean; spawnError?: string; }

export interface OutputFilePaths { stdout: string; stderr: string; }

export function runProgram(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return runChild(program, args, cwd, timeoutMs, maxOutputBytes, false, undefined, env);
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
): Promise<RunResult> {
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const spawnOptions: SpawnOptions = { cwd, shell, detached, stdio: ["ignore", "pipe", "pipe"] };
    if (env !== undefined) spawnOptions.env = env;
    const child = spawn(command, args, spawnOptions);
    let stdout = ""; let stderr = ""; let bytes = 0; let timedOut = false; let outputLimit = false; let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let fileLimitTimer: NodeJS.Timeout | undefined;
    const finish = (result: RunResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (fileLimitTimer !== undefined) clearInterval(fileLimitTimer);
        resolve(result);
      }
    };
    const forceTerminate = (): void => {
      if (detached && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* child already ended */ }
      }
      child.kill("SIGKILL");
    };
    const terminate = (): void => {
      if (detached && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* child already ended */ }
      } else {
        child.kill("SIGTERM");
      }
      if (killTimer === undefined) killTimer = setTimeout(forceTerminate, TERMINATION_GRACE_MS);
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = maxOutputBytes - bytes;
      if (remaining <= 0) { outputLimit = true; terminate(); return; }
      const part = chunk.subarray(0, remaining); bytes += part.length;
      if (target === "stdout") stdout += part.toString("utf8"); else stderr += part.toString("utf8");
      if (part.length !== chunk.length) { outputLimit = true; terminate(); }
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish({ stdout, stderr, exitCode: null, signal: null, timedOut, outputLimit, spawnError: error.message }));
    child.on("close", (exitCode, signal) => finish({ stdout, stderr, exitCode, signal, timedOut, outputLimit }));
    if (outputFiles !== undefined) {
      fileLimitTimer = setInterval(() => {
        void Promise.all([fs.stat(outputFiles.stdout), fs.stat(outputFiles.stderr)]).then(([stdoutStat, stderrStat]) => {
          if (stdoutStat.size + stderrStat.size > maxOutputBytes) {
            outputLimit = true;
            terminate();
          }
        }).catch(() => {
          // 子プロセス終了と一時ファイル掃除の競合。close event が最終結果を確定する。
        });
      }, 50);
    }
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  });
}

export type ManagedProcessState = "running" | "exited";

/**
 * start と完了 await を分離するための child process ラッパー（Issue #74）。
 * `runChild` と違い、生成直後に呼び出し側へ制御を返す — 完了は `settled` promise で別途待てる。
 * output は `runChild` 同様 byte 上限で打ち切り、超過時は協調終了 → grace 後 SIGKILL する。
 */
export class ManagedProcess {
  private readonly child: ReturnType<typeof spawn>;
  private readonly detached: boolean;
  private stdout = "";
  private stderr = "";
  private bytes = 0;
  private timedOut = false;
  private outputLimit = false;
  private settledFlag = false;
  private killTimer: NodeJS.Timeout | undefined;
  private resolveSettled!: (result: RunResult) => void;
  readonly settled: Promise<RunResult>;
  readonly startedAt: number;

  constructor(command: string, cwd: string, maxOutputBytes: number, shell: boolean, env?: NodeJS.ProcessEnv) {
    this.startedAt = Date.now();
    this.detached = process.platform !== "win32";
    const spawnOptions: SpawnOptions = { cwd, shell, detached: this.detached, stdio: ["ignore", "pipe", "pipe"] };
    if (env !== undefined) spawnOptions.env = env;
    this.child = spawn(command, [], spawnOptions);
    this.settled = new Promise((resolve) => { this.resolveSettled = resolve; });

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = maxOutputBytes - this.bytes;
      if (remaining <= 0) { this.outputLimit = true; this.terminate(); return; }
      const part = chunk.subarray(0, remaining);
      this.bytes += part.length;
      if (target === "stdout") this.stdout += part.toString("utf8"); else this.stderr += part.toString("utf8");
      if (part.length !== chunk.length) { this.outputLimit = true; this.terminate(); }
    };
    this.child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    this.child.on("error", (error) => this.finish({
      stdout: this.stdout, stderr: this.stderr, exitCode: null, signal: null,
      timedOut: this.timedOut, outputLimit: this.outputLimit, spawnError: error.message,
    }));
    this.child.on("close", (exitCode, signal) => this.finish({
      stdout: this.stdout, stderr: this.stderr, exitCode, signal, timedOut: this.timedOut, outputLimit: this.outputLimit,
    }));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get state(): ManagedProcessState {
    return this.settledFlag ? "exited" : "running";
  }

  /** 猶予付き協調終了（SIGTERM → grace 経過後 SIGKILL）。 */
  terminate(): void {
    if (this.settledFlag) return;
    if (this.detached && this.child.pid) {
      try { process.kill(-this.child.pid, "SIGTERM"); } catch { /* child already ended */ }
    } else {
      this.child.kill("SIGTERM");
    }
    if (this.killTimer === undefined) this.killTimer = setTimeout(() => this.forceTerminate(), TERMINATION_GRACE_MS);
  }

  /** 即時 SIGKILL。connection/process shutdown や abandoned handle の cleanup で使う。 */
  forceTerminate(): void {
    if (this.settledFlag) return;
    if (this.detached && this.child.pid) {
      try { process.kill(-this.child.pid, "SIGKILL"); } catch { /* child already ended */ }
    }
    this.child.kill("SIGKILL");
  }

  markTimedOut(): void {
    this.timedOut = true;
    this.terminate();
  }

  private finish(result: RunResult): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    if (this.killTimer !== undefined) clearTimeout(this.killTimer);
    this.resolveSettled(result);
  }
}
