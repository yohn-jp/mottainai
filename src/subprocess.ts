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
