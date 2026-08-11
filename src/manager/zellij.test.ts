import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveZellijSessionName, ZellijCliRuntime, ZellijRuntimeError } from "./zellij.js";

test("Zellij session names are deterministic, safe, and independent of prompt text", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  assert.equal(deriveZellijSessionName(id), deriveZellijSessionName(id));
  assert.match(deriveZellijSessionName(id), /^mottainai-[a-z0-9-]+$/u);
  assert.throws(() => deriveZellijSessionName("not-a-session"), /invalid manager session id/);
});

test("Zellij adapter builds argv-safe background, pane, inspect, and terminate commands", async () => {
  const calls: string[][] = [];
  const runtime = new ZellijCliRuntime({
    binary: "/fake/zellij",
    cwd: "/repo",
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "--version") return { stdout: "zellij 0.40.0\n", stderr: "", exitCode: 0 };
      if (args[0] === "list-sessions")
        return { stdout: "mottainai-12345678-1234-4234-8234-123456789abc [Created]\n", stderr: "", exitCode: 0 };
      if (args[0] === "--session") return { stdout: "[]", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  assert.equal((await runtime.checkAvailability()).version, "zellij 0.40.0");
  assert.equal(await runtime.inspect("mottainai-12345678-1234-4234-8234-123456789abc"), "running");
  await runtime.start({
    sessionName: "mottainai-12345678-1234-4234-8234-123456789abc",
    cwd: "/repo/.mottainai/worktrees/fix-1-task with spaces",
    command: "codex",
    args: ["instruction with; shell syntax", "$(not executed)"],
  });
  await runtime.terminate("mottainai-12345678-1234-4234-8234-123456789abc", "/repo");
  assert.deepEqual(calls[0], ["--version"]);
  assert.deepEqual(calls[1], ["list-sessions"]);
  assert.deepEqual(calls[2], [
    "--session",
    "mottainai-12345678-1234-4234-8234-123456789abc",
    "action",
    "list-panes",
    "--json",
  ]);
  assert.deepEqual(calls[3], ["attach", "--create-background", "mottainai-12345678-1234-4234-8234-123456789abc"]);
  assert.deepEqual(calls[4], [
    "--session",
    "mottainai-12345678-1234-4234-8234-123456789abc",
    "action",
    "new-pane",
    "--cwd",
    "/repo/.mottainai/worktrees/fix-1-task with spaces",
    "--name",
    "mottainai-agent",
    "--",
    "codex",
    "instruction with; shell syntax",
    "$(not executed)",
  ]);
  assert.deepEqual(calls[5], ["kill-sessions", "mottainai-12345678-1234-4234-8234-123456789abc"]);
});

test("Zellij availability failure has a stable actionable diagnostic", async () => {
  const runtime = new ZellijCliRuntime({
    cwd: "/repo",
    run: async () => ({ stdout: "", stderr: "ENOENT", exitCode: null, spawnError: "spawn zellij ENOENT" }),
  });
  await assert.rejects(runtime.checkAvailability(), (error: unknown) => {
    assert.ok(error instanceof ZellijRuntimeError);
    assert.equal(error.code, "zellij_unavailable");
    assert.match(error.message, /install Zellij/);
    return true;
  });
});

test("Zellij inspection prefers the named agent pane over the session shell", async () => {
  const runtime = new ZellijCliRuntime({
    cwd: "/repo",
    run: async (args) => {
      if (args[0] === "list-sessions")
        return { stdout: "mottainai-12345678-1234-4234-8234-123456789abc\n", stderr: "", exitCode: 0 };
      return {
        stdout: JSON.stringify([
          { title: "bash", pane_cwd: "/repo/.mottainai/worktrees/task", exited: false, exit_status: null },
          { title: "mottainai-agent", pane_cwd: "/repo/.mottainai/worktrees/task", exited: true, exit_status: 1 },
        ]),
        stderr: "",
        exitCode: 0,
      };
    },
  });
  assert.equal(
    await runtime.inspect("mottainai-12345678-1234-4234-8234-123456789abc", "/repo/.mottainai/worktrees/task"),
    "exited",
  );
});
