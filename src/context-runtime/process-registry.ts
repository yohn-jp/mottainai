import { ManagedProcess } from "../subprocess.js";
import type { RunResult } from "../subprocess.js";
import { HandleRegistry } from "./handles.js";
import { DEFAULT_MANAGED_PROCESS_POLICY, resolveManagedProcessPolicy } from "./process-policy.js";
import type { ManagedProcessPolicy, ManagedProcessPolicyConfig } from "./process-policy.js";

export interface StartedProcess {
  handle: string;
  pid?: number;
}

export type AwaitOutcome =
  | { kind: "terminal"; result: RunResult; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number; state: "running" }
  | { kind: "await_cancelled"; elapsedMs: number; processState: "running" | "exited" };

export type ProcessResourceErrorCode = "managed_process_active_capacity_exceeded" | "managed_process_registry_disposed";

/** Stable, bounded error for a start rejected by the connection-local resource policy. */
export class ManagedProcessResourceError extends Error {
  readonly code: ProcessResourceErrorCode;
  readonly limit: number;
  readonly activeCount: number;
  readonly retainedCount: number;

  constructor(code: ProcessResourceErrorCode, limit: number, activeCount: number, retainedCount: number) {
    super(
      code === "managed_process_registry_disposed"
        ? "managed process registry is disposed"
        : "managed process resource limit exceeded",
    );
    this.name = "ManagedProcessResourceError";
    this.code = code;
    this.limit = limit;
    this.activeCount = activeCount;
    this.retainedCount = retainedCount;
  }
}

export interface ProcessRegistryTimer {
  cancel(): void;
}

export type ProcessRegistryScheduler = (callback: () => void, delayMs: number) => ProcessRegistryTimer;

export interface ProcessRegistryOptions {
  policy?: ManagedProcessPolicyConfig;
  now?: () => number;
  /** Injectable timer boundary keeps lifetime tests deterministic. */
  schedule?: ProcessRegistryScheduler;
}

interface ProcessEntry {
  managed: ManagedProcess;
  command: string;
  cwd: string;
  startedAt: number;
  state: "active" | "terminal";
  expired: boolean;
  lifetimeTimer?: ProcessRegistryTimer;
}

function scheduleTimeout(callback: () => void, delayMs: number): ProcessRegistryTimer {
  const timer = setTimeout(callback, delayMs);
  return { cancel: () => clearTimeout(timer) };
}

/**
 * Connection-local `exec_start`/`exec_await` lifecycle (Issue #74, #368).
 *
 * Start admission is checked before `ManagedProcess` is constructed. Live
 * processes are capped per connection, terminal entries are retained only up
 * to the policy count, and each live process has a finite lifetime timer. A
 * lifetime expiry force-terminates the child and marks its result as timed out;
 * the active slot is released only after the child reaches terminal state.
 * All state and timers are owned by this instance and are cleared on dispose.
 */
export class ProcessRegistry {
  private readonly handles = new HandleRegistry<ProcessEntry>();
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly terminalOrder: string[] = [];
  private readonly policy: ManagedProcessPolicy;
  private readonly now: () => number;
  private readonly schedule: ProcessRegistryScheduler;
  private activeCount = 0;
  private disposed = false;

  constructor(options: ProcessRegistryOptions = {}) {
    this.policy = resolveManagedProcessPolicy(options.policy ?? DEFAULT_MANAGED_PROCESS_POLICY);
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? scheduleTimeout;
  }

  start(command: string, cwd: string, maxOutputBytes: number, shell: boolean, env?: NodeJS.ProcessEnv): StartedProcess {
    if (this.disposed) {
      throw new ManagedProcessResourceError("managed_process_registry_disposed", 0, 0, 0);
    }

    // Reconcile close events that may have happened between tool calls, and
    // enforce a delayed timer through the same deterministic path.
    this.reap(this.now());
    if (this.activeCount >= this.policy.maxActiveProcesses) {
      throw new ManagedProcessResourceError(
        "managed_process_active_capacity_exceeded",
        this.policy.maxActiveProcesses,
        this.activeCount,
        this.retainedCount,
      );
    }

    const managed = new ManagedProcess(command, cwd, maxOutputBytes, shell, env);
    const entry: ProcessEntry = {
      managed,
      command,
      cwd,
      startedAt: this.now(),
      state: "active",
      expired: false,
    };
    const handle = this.handles.register(entry, (value) => value.managed.forceTerminate());
    this.entries.set(handle, entry);
    this.activeCount += 1;
    void managed.settled.then(() => this.markTerminal(handle, entry));

    if (managed.state === "exited") {
      this.markTerminal(handle, entry);
    } else {
      entry.lifetimeTimer = this.schedule(() => this.reap(this.now()), this.policy.maxLifetimeMs);
    }

    return { handle, pid: managed.pid };
  }

  /** 未知 handle は `undefined`（invalid handle として呼び出し側が扱う）。 */
  has(handle: string): boolean {
    this.reap(this.now());
    return this.entries.has(handle);
  }

  /** await envelope 組み立てに使う、start 時点の command/cwd。未知 handle は `undefined`。 */
  describe(handle: string): { command: string; cwd: string } | undefined {
    this.reap(this.now());
    const entry = this.entries.get(handle);
    return entry === undefined ? undefined : { command: entry.command, cwd: entry.cwd };
  }

  /**
   * Waits for one handle. AbortSignal cancels this wait only; it never
   * terminates, releases, or otherwise changes the managed child.
   */
  async awaitHandle(handle: string, timeoutMs: number, signal?: AbortSignal): Promise<AwaitOutcome | undefined> {
    this.reap(this.now());
    const entry = this.entries.get(handle);
    if (entry === undefined) return undefined;
    const startedAt = this.now();

    const terminalOutcome = (result: RunResult): AwaitOutcome => ({
      kind: "terminal",
      result,
      elapsedMs: this.now() - startedAt,
    });
    const awaitCancelledOutcome = (processState: "running" | "exited"): AwaitOutcome => ({
      kind: "await_cancelled",
      elapsedMs: this.now() - startedAt,
      processState,
    });

    // A terminal child is authoritative even when the signal was already
    // aborted. This prevents a settled result from being hidden by a late
    // request cancellation.
    const initialProcessState = entry.managed.state;
    if (initialProcessState === "exited") return entry.managed.settled.then(terminalOutcome);

    if (signal?.aborted === true) return awaitCancelledOutcome(initialProcessState);

    return new Promise<AwaitOutcome>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (outcome: AwaitOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      timer = setTimeout(() => {
        // The timer and abort callback are both wait-side events. If the
        // child has already reached terminal state, let its settled promise
        // win regardless of callback ordering so the result is not lost.
        if (entry.managed.state === "exited") return;
        finish({ kind: "timeout", elapsedMs: this.now() - startedAt, state: "running" });
      }, timeoutMs);
      const onAbort = (): void => {
        // Deterministic race rule: terminal state observed here wins; an
        // abort observed while running only cancels this wait operation.
        const processState = entry.managed.state;
        if (processState === "exited") return;
        finish(awaitCancelledOutcome(processState));
      };
      void entry.managed.settled.then((result) => {
        finish(terminalOutcome(result));
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
  }

  /** await 完了後、呼び出し側が handle を明示的に解放するときに使う。 */
  release(handle: string): void {
    this.reap(this.now());
    const entry = this.entries.get(handle);
    if (entry === undefined || entry.state === "active") return;
    this.forget(handle, entry);
  }

  /**
   * Explicit deterministic reap hook for lifecycle callers and tests. It also
   * reconciles terminal children whose close event preceded the settled
   * promise callback. The default lifetime timer calls this method as well.
   */
  reap(nowMs: number = this.now()): void {
    if (this.disposed) return;

    for (const [handle, entry] of this.entries) {
      if (entry.state === "terminal") continue;
      if (entry.managed.state === "exited") {
        this.markTerminal(handle, entry);
        continue;
      }
      if (!entry.expired && nowMs - entry.startedAt >= this.policy.maxLifetimeMs) {
        entry.expired = true;
        entry.managed.expire();
      }
    }
    this.trimTerminalHandles();
  }

  /** connection/process shutdown 用。残存 process・lifetime timer・handle を全て片付ける。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.lifetimeTimer?.cancel();
      entry.lifetimeTimer = undefined;
    }
    this.handles.dispose();
    this.entries.clear();
    this.terminalOrder.length = 0;
    this.activeCount = 0;
  }

  get size(): number {
    this.reap(this.now());
    return this.entries.size;
  }

  get activeSize(): number {
    this.reap(this.now());
    return this.activeCount;
  }

  get retainedSize(): number {
    this.reap(this.now());
    return this.retainedCount;
  }

  private get retainedCount(): number {
    return this.entries.size - this.activeCount;
  }

  private markTerminal(handle: string, entry: ProcessEntry): void {
    if (this.disposed || this.entries.get(handle) !== entry || entry.state === "terminal") return;
    entry.state = "terminal";
    entry.lifetimeTimer?.cancel();
    entry.lifetimeTimer = undefined;
    this.activeCount -= 1;
    this.terminalOrder.push(handle);
    this.trimTerminalHandles();
  }

  private trimTerminalHandles(): void {
    while (this.terminalOrder.length > this.policy.maxRetainedHandles) {
      const handle = this.terminalOrder.shift();
      if (handle === undefined) return;
      const entry = this.entries.get(handle);
      if (entry !== undefined && entry.state === "terminal") this.forget(handle, entry);
    }
  }

  private forget(handle: string, entry: ProcessEntry): void {
    entry.lifetimeTimer?.cancel();
    entry.lifetimeTimer = undefined;
    this.entries.delete(handle);
    const orderIndex = this.terminalOrder.indexOf(handle);
    if (orderIndex >= 0) this.terminalOrder.splice(orderIndex, 1);
    this.handles.delete(handle);
  }
}
