import { ManagedProcess } from "../subprocess.js";
import type { RunResult } from "../subprocess.js";
import { HandleRegistry } from "./handles.js";

export interface StartedProcess {
  handle: string;
  pid?: number;
}

export type AwaitOutcome =
  | { kind: "terminal"; result: RunResult; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number; state: "running" }
  | { kind: "cancelled"; elapsedMs: number };

interface ProcessEntry {
  managed: ManagedProcess;
  command: string;
  cwd: string;
}

/**
 * local process の start/await lifecycle（Issue #74）。
 *
 * - start: `ManagedProcess` を起動しすぐ opaque handle を返す（stdout/stderr を inline しない）。
 * - await: 該当 handle の完了を bounded timeout で待つ。timeout でも process は kill しない —
 *   「await timeout = process kill」を短絡させない。process 自身の生存期間は
 *   start 呼び出し（`runShell` 由来のコマンド timeout）とこの registry の cleanup だけが決める。
 * - cancel/dispose: connection/process shutdown 時に残存 process を強制終了して cleanup する。
 */
export class ProcessRegistry {
  private readonly handles = new HandleRegistry<ProcessEntry>();

  start(command: string, cwd: string, maxOutputBytes: number, shell: boolean, env?: NodeJS.ProcessEnv): StartedProcess {
    const managed = new ManagedProcess(command, cwd, maxOutputBytes, shell, env);
    const handle = this.handles.register({ managed, command, cwd }, (entry) => entry.managed.forceTerminate());
    return { handle, pid: managed.pid };
  }

  /** 未知 handle は `undefined`（invalid handle として呼び出し側が扱う）。 */
  has(handle: string): boolean {
    return this.handles.get(handle) !== undefined;
  }

  /** await envelope 組み立てに使う、start 時点の command/cwd。未知 handle は `undefined`。 */
  describe(handle: string): { command: string; cwd: string } | undefined {
    const entry = this.handles.get(handle);
    return entry === undefined ? undefined : { command: entry.command, cwd: entry.cwd };
  }

  async awaitHandle(handle: string, timeoutMs: number, signal?: AbortSignal): Promise<AwaitOutcome | undefined> {
    const entry = this.handles.get(handle);
    if (entry === undefined) return undefined;
    const startedAt = Date.now();

    if (signal?.aborted === true) return { kind: "cancelled", elapsedMs: 0 };

    return new Promise<AwaitOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: AwaitOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        finish({ kind: "timeout", elapsedMs: Date.now() - startedAt, state: "running" });
      }, timeoutMs);
      const onAbort = (): void => {
        finish({ kind: "cancelled", elapsedMs: Date.now() - startedAt });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void entry.managed.settled.then((result) => {
        finish({ kind: "terminal", result, elapsedMs: Date.now() - startedAt });
      });
    });
  }

  /** await 完了後、呼び出し側が handle を明示的に解放するときに使う。プロセス自体には触れない。 */
  release(handle: string): void {
    const entry = this.handles.get(handle);
    if (entry === undefined || entry.managed.state === "running") return;
    this.handles.delete(handle);
  }

  /** connection/process shutdown 用。残存 process を全て強制終了し handle を空にする。 */
  dispose(): void {
    this.handles.dispose();
  }

  get size(): number {
    return this.handles.size;
  }
}
