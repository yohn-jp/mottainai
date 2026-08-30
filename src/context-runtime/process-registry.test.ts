import assert from "node:assert/strict";
import { test } from "node:test";
import { ManagedProcessResourceError, ProcessRegistry } from "./process-registry.js";
import { ManagedProcess } from "../subprocess.js";

const NODE = process.execPath;

function fakeClock(): {
  now: () => number;
  advance: (milliseconds: number) => void;
  schedule: (callback: () => void, delayMs: number) => { cancel(): void };
  pendingTimers: () => number;
} {
  let current = 0;
  const timers = new Set<{ callback: () => void; due: number; cancelled: boolean }>();
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
      for (const timer of [...timers]) {
        if (!timer.cancelled && timer.due <= current) {
          timers.delete(timer);
          timer.callback();
        }
      }
    },
    schedule: (callback, delayMs) => {
      const timer = { callback, due: current + delayMs, cancelled: false };
      timers.add(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
          timers.delete(timer);
        },
      };
    },
    pendingTimers: () => timers.size,
  };
}

test("start returns an opaque handle immediately and await resolves the terminal result", async () => {
  const registry = new ProcessRegistry();
  const started = registry.start(`${NODE} -e "console.log('hi')"`, process.cwd(), 1024 * 1024, true);
  assert.equal(typeof started.handle, "string");
  assert.ok(registry.has(started.handle));

  const outcome = await registry.awaitHandle(started.handle, 5_000);
  assert.ok(outcome !== undefined);
  assert.equal(outcome!.kind, "terminal");
  if (outcome!.kind === "terminal") {
    assert.equal(outcome!.result.exitCode, 0);
    assert.equal(outcome!.result.stdout.trim(), "hi");
  }
});

test("a process already exited during start remains reachable through terminal await", async (t) => {
  // Make the constructor's synchronous state check deterministic; the real
  // settled promise still supplies the process result below.
  t.mock.getter(ManagedProcess.prototype, "state", () => "exited");
  const registry = new ProcessRegistry({ policy: { maxRetainedHandles: 1 } });
  const started = registry.start(`${NODE} -e "process.exit(0)"`, process.cwd(), 1024 * 1024, true);

  assert.equal(registry.activeSize, 0);
  assert.equal(registry.has(started.handle), true);
  const controller = new AbortController();
  controller.abort();
  const outcome = await registry.awaitHandle(started.handle, 5_000, controller.signal);
  assert.equal(outcome?.kind, "terminal");
  registry.release(started.handle);
});

test("a process that exits immediately remains reachable through terminal await", async () => {
  const registry = new ProcessRegistry({ policy: { maxRetainedHandles: 1 } });
  const started = registry.start(`${NODE} -e "process.exit(0)"`, process.cwd(), 1024 * 1024, true);
  assert.equal(registry.has(started.handle), true);

  const outcome = await registry.awaitHandle(started.handle, 5_000);
  assert.equal(outcome?.kind, "terminal");
  assert.equal(registry.has(started.handle), true);
  registry.release(started.handle);
});

test("await reports command failure via non-zero exit code without throwing", async () => {
  const registry = new ProcessRegistry();
  const started = registry.start(`${NODE} -e "process.exit(3)"`, process.cwd(), 1024 * 1024, true);
  const outcome = await registry.awaitHandle(started.handle, 5_000);
  assert.equal(outcome!.kind, "terminal");
  if (outcome!.kind === "terminal") assert.equal(outcome!.result.exitCode, 3);
});

test("await returns a timeout outcome without killing the process (await timeout != process kill)", async () => {
  const registry = new ProcessRegistry();
  const started = registry.start(`${NODE} -e "setTimeout(() => {}, 2000)"`, process.cwd(), 1024 * 1024, true);
  const outcome = await registry.awaitHandle(started.handle, 50);
  assert.equal(outcome!.kind, "timeout");
  // process must still be tracked/running — timeout does not implicitly terminate it.
  assert.ok(registry.has(started.handle));
  registry.dispose();
});

test("await can be cancelled via AbortSignal without waiting for the process", async () => {
  const registry = new ProcessRegistry();
  const started = registry.start(
    `${NODE} -e "setTimeout(() => process.stdout.write('done'), 100)"`,
    process.cwd(),
    1024 * 1024,
    true,
  );
  const controller = new AbortController();
  const awaitPromise = registry.awaitHandle(started.handle, 5_000, controller.signal);
  controller.abort();
  const outcome = await awaitPromise;
  assert.equal(outcome!.kind, "await_cancelled");
  if (outcome?.kind === "await_cancelled") assert.equal(outcome.processState, "running");
  assert.equal(registry.has(started.handle), true);
  assert.equal(registry.activeSize, 1);

  const reawaited = await registry.awaitHandle(started.handle, 5_000);
  assert.equal(reawaited?.kind, "terminal");
  if (reawaited?.kind === "terminal") assert.equal(reawaited.result.stdout, "done");
  registry.release(started.handle);
});

test("terminal state wins when it is observed before an abort callback", async (t) => {
  let observedState: "running" | "exited" = "running";
  t.mock.getter(ManagedProcess.prototype, "state", () => observedState);

  const registry = new ProcessRegistry();
  const started = registry.start(
    `${NODE} -e "setTimeout(() => process.stdout.write('terminal'), 25)"`,
    process.cwd(),
    1024 * 1024,
    true,
  );
  const controller = new AbortController();
  const awaitPromise = registry.awaitHandle(started.handle, 5_000, controller.signal);

  // Model the close/abort race at the lifecycle boundary: terminal state is
  // visible before the abort callback is dispatched, while the settled
  // promise supplies the authoritative result shortly afterward.
  observedState = "exited";
  controller.abort();

  const outcome = await awaitPromise;
  assert.equal(outcome?.kind, "terminal");
  if (outcome?.kind === "terminal") {
    assert.equal(outcome.result.stdout, "terminal");
    assert.equal(outcome.result.exitCode, 0);
  }
  registry.release(started.handle);
});

test("awaitHandle on an unknown handle resolves to undefined (invalid handle)", async () => {
  const registry = new ProcessRegistry();
  const outcome = await registry.awaitHandle("mh_does-not-exist", 100);
  assert.equal(outcome, undefined);
});

test("a handle started in one registry is invisible to another (cross-connection rejection)", async () => {
  const a = new ProcessRegistry();
  const b = new ProcessRegistry();
  const started = a.start(`${NODE} -e "console.log('a')"`, process.cwd(), 1024 * 1024, true);
  assert.equal(b.has(started.handle), false);
  assert.equal(await b.awaitHandle(started.handle, 100), undefined);
  a.dispose();
});

test("dispose force-terminates every tracked process (connection/process shutdown cleanup)", async () => {
  const registry = new ProcessRegistry();
  const started = registry.start(`${NODE} -e "setTimeout(() => {}, 5000)"`, process.cwd(), 1024 * 1024, true);
  assert.equal(registry.size, 1);
  const controller = new AbortController();
  const awaitPromise = registry.awaitHandle(started.handle, 5_000, controller.signal);
  controller.abort();
  assert.equal((await awaitPromise)?.kind, "await_cancelled");
  assert.equal(registry.activeSize, 1);

  registry.dispose();
  assert.equal(registry.size, 0);
  // the underlying process should settle (killed) shortly after dispose.
  await new Promise((resolve) => setTimeout(resolve, 200));
});

test("output beyond maxOutputBytes is truncated and reported via outputLimit", async () => {
  const registry = new ProcessRegistry();
  const started = registry.start(`${NODE} -e "process.stdout.write('x'.repeat(1000))"`, process.cwd(), 16, true);
  const outcome = await registry.awaitHandle(started.handle, 5_000);
  assert.equal(outcome!.kind, "terminal");
  if (outcome!.kind === "terminal") {
    assert.equal(outcome!.result.outputLimit, true);
    assert.ok(outcome!.result.stdout.length <= 16);
  }
});

test("release drops a settled handle but is a no-op while the process is still running", async () => {
  const registry = new ProcessRegistry();
  const started = registry.start(`${NODE} -e "setTimeout(() => {}, 2000)"`, process.cwd(), 1024 * 1024, true);
  registry.release(started.handle);
  assert.ok(registry.has(started.handle), "release must not drop a still-running handle");
  await registry.awaitHandle(started.handle, 5_000);
  registry.release(started.handle);
  assert.equal(registry.has(started.handle), false);
});

test("active managed-process capacity is rejected before a new child is spawned", () => {
  const registry = new ProcessRegistry({ policy: { maxActiveProcesses: 1 } });
  const started = registry.start(`${NODE} -e "setTimeout(() => {}, 5000)"`, process.cwd(), 1024 * 1024, true);
  assert.throws(
    () => registry.start(`${NODE} -e "process.stdout.write('must-not-start')"`, process.cwd(), 1024 * 1024, true),
    (error: unknown) =>
      error instanceof ManagedProcessResourceError &&
      error.code === "managed_process_active_capacity_exceeded" &&
      error.activeCount === 1 &&
      error.limit === 1 &&
      error.message === "managed process resource limit exceeded",
  );
  registry.dispose();
  assert.equal(registry.has(started.handle), false);
});

test("retention zero is rejected because a successful start needs one reachable terminal result", () => {
  assert.throws(
    () => new ProcessRegistry({ policy: { maxRetainedHandles: 0 } }),
    /invalid managed process policy maxRetainedHandles/,
  );
});

test("terminal state releases active capacity while retention stays bounded", async () => {
  const registry = new ProcessRegistry({
    policy: { maxActiveProcesses: 1, maxRetainedHandles: 1 },
  });
  const first = registry.start(`${NODE} -e "console.log('first')"`, process.cwd(), 1024 * 1024, true);
  const firstOutcome = await registry.awaitHandle(first.handle, 5_000);
  assert.equal(firstOutcome?.kind, "terminal");
  assert.equal(registry.activeSize, 0);

  const second = registry.start(`${NODE} -e "console.log('second')"`, process.cwd(), 1024 * 1024, true);
  const secondOutcome = await registry.awaitHandle(second.handle, 5_000);
  assert.equal(secondOutcome?.kind, "terminal");
  assert.equal(registry.activeSize, 0);
  assert.equal(registry.retainedSize, 1);
  assert.equal(registry.has(first.handle), false);
  assert.equal(registry.has(second.handle), true);
  registry.release(second.handle);
});

test("maximum lifetime expiration is deterministic and preserves timeout/output semantics", async () => {
  const clock = fakeClock();
  const registry = new ProcessRegistry({
    policy: { maxLifetimeMs: 100 },
    now: clock.now,
    schedule: clock.schedule,
  });
  const started = registry.start(`${NODE} -e "setTimeout(() => {}, 5000)"`, process.cwd(), 1024 * 1024, true);
  assert.equal(clock.pendingTimers(), 1);
  clock.advance(100);
  const outcome = await registry.awaitHandle(started.handle, 5_000);
  assert.equal(outcome?.kind, "terminal");
  if (outcome?.kind === "terminal") assert.equal(outcome.result.timedOut, true);
  assert.equal(registry.activeSize, 0);
  assert.equal(clock.pendingTimers(), 0);
  registry.release(started.handle);
});

test("dispose cancels lifetime timers and removes every retained handle", () => {
  const clock = fakeClock();
  const registry = new ProcessRegistry({
    policy: { maxLifetimeMs: 10_000 },
    now: clock.now,
    schedule: clock.schedule,
  });
  registry.start(`${NODE} -e "setTimeout(() => {}, 5000)"`, process.cwd(), 1024 * 1024, true);
  assert.equal(registry.size, 1);
  assert.equal(clock.pendingTimers(), 1);
  registry.dispose();
  assert.equal(registry.size, 0);
  assert.equal(registry.activeSize, 0);
  assert.equal(registry.retainedSize, 0);
  assert.equal(clock.pendingTimers(), 0);
});
