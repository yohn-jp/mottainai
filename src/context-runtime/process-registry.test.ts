import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessRegistry } from "./process-registry.js";

const NODE = process.execPath;

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
  const started = registry.start(`${NODE} -e "setTimeout(() => {}, 2000)"`, process.cwd(), 1024 * 1024, true);
  const controller = new AbortController();
  const awaitPromise = registry.awaitHandle(started.handle, 5_000, controller.signal);
  controller.abort();
  const outcome = await awaitPromise;
  assert.equal(outcome!.kind, "cancelled");
  registry.dispose();
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
