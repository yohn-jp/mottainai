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
  const managedName = "mottainai-12345678-1234-4234-8234-123456789abc";
  const newName = "mottainai-12345678-1234-4234-8234-123456789abd";
  const calls: string[][] = [];
  const runtime = new ZellijCliRuntime({
    binary: "/fake/zellij",
    cwd: "/repo",
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "--version") return { stdout: "zellij 0.44.0\n", stderr: "", exitCode: 0 };
      if (args[0] === "list-sessions") return { stdout: `${managedName} [Created]\n`, stderr: "", exitCode: 0 };
      if (args[0] === "--session")
        return {
          stdout: JSON.stringify([
            { title: `${managedName}-agent`, pane_cwd: "/repo", exited: false, exit_status: null },
          ]),
          stderr: "",
          exitCode: 0,
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  assert.equal((await runtime.checkAvailability()).version, "zellij 0.44.0");
  assert.equal(await runtime.inspect(managedName), "running");
  await runtime.start({
    sessionName: newName,
    cwd: "/repo/.mottainai/worktrees/fix-1-task with spaces",
    command: "codex",
    args: ["instruction with; shell syntax", "$(not executed)"],
  });
  await runtime.terminate(managedName, "/repo");
  assert.deepEqual(calls[0], ["--version"]);
  assert.deepEqual(calls[1], ["list-sessions"]);
  assert.deepEqual(calls[2], [
    "--session",
    "mottainai-12345678-1234-4234-8234-123456789abc",
    "action",
    "list-panes",
    "--json",
  ]);
  assert.deepEqual(calls[3], ["list-sessions"]);
  assert.deepEqual(calls[4], ["attach", "--create-background", newName]);
  assert.deepEqual(calls[5], [
    "--session",
    newName,
    "action",
    "new-pane",
    "--cwd",
    "/repo/.mottainai/worktrees/fix-1-task with spaces",
    "--name",
    `${newName}-agent`,
    "--",
    "codex",
    "instruction with; shell syntax",
    "$(not executed)",
  ]);
  assert.deepEqual(calls[6], ["list-sessions"]);
  assert.deepEqual(calls[7], [
    "--session",
    "mottainai-12345678-1234-4234-8234-123456789abc",
    "action",
    "list-panes",
    "--json",
  ]);
  assert.deepEqual(calls[8], ["kill-session", managedName]);
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

test("Zellij availability rejects an incompatible version with an actionable diagnostic", async () => {
  const runtime = new ZellijCliRuntime({
    cwd: "/repo",
    run: async (args) =>
      args[0] === "--version"
        ? { stdout: "zellij 0.10.0\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 },
  });
  await assert.rejects(runtime.checkAvailability(), (error: unknown) => {
    assert.ok(error instanceof ZellijRuntimeError);
    assert.equal(error.code, "zellij_incompatible");
    assert.match(error.message, /Zellij >= 0\.44\.0/);
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
          {
            title: "mottainai-12345678-1234-4234-8234-123456789abc-agent",
            pane_cwd: "/repo/.mottainai/worktrees/task",
            exited: true,
            exit_status: 1,
          },
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

test("Zellij start removes the background session when managed pane creation fails", async () => {
  const name = "mottainai-12345678-1234-4234-8234-123456789abc";
  const calls: string[][] = [];
  const runtime = new ZellijCliRuntime({
    cwd: "/repo",
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "list-sessions") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "--session") return { stdout: "", stderr: "pane failed", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await assert.rejects(
    runtime.start({ sessionName: name, cwd: "/repo", command: "codex", args: ["--", "task"] }),
    /agent pane launch failed/,
  );
  assert.deepEqual(calls.at(-1), ["kill-session", name]);
});

test("Zellij start rejects a selected runtime-name collision before creating a pane", async () => {
  const name = "mottainai-12345678-1234-4234-8234-123456789abc";
  const calls: string[][] = [];
  const runtime = new ZellijCliRuntime({
    cwd: "/repo",
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "list-sessions") return { stdout: `${name}\n`, stderr: "", exitCode: 0 };
      return {
        stdout: JSON.stringify([{ title: `${name}-agent`, pane_cwd: "/repo", exited: false, exit_status: null }]),
        stderr: "",
        exitCode: 0,
      };
    },
  });
  await assert.rejects(
    runtime.start({ sessionName: name, cwd: "/repo", command: "codex", args: ["--", "task"] }),
    /runtime identity is already running/,
  );
  assert.equal(
    calls.some((args) => args[0] === "attach"),
    false,
  );
});

test("Zellij inspection classifies the real no-active-sessions diagnostic as absent", async () => {
  const runtime = new ZellijCliRuntime({
    cwd: "/repo",
    run: async () => ({
      stdout: "",
      stderr: "No active zellij sessions found.\n",
      exitCode: 1,
    }),
  });
  assert.equal(await runtime.inspect("mottainai-12345678-1234-4234-8234-123456789abc"), "absent");
});

test("Zellij inspection matches an ANSI-decorated managed session row", async () => {
  const managedName = "mottainai-12345678-1234-4234-8234-123456789abc";
  const runtime = new ZellijCliRuntime({
    cwd: "/repo",
    run: async (args) => {
      if (args[0] === "list-sessions")
        return { stdout: `[1m${managedName}[0m [32m[Created][0m\n`, stderr: "", exitCode: 0 };
      return {
        stdout: JSON.stringify([{ title: `${managedName}-agent`, pane_cwd: "/repo", exited: false, exit_status: null }]),
        stderr: "",
        exitCode: 0,
      };
    },
  });
  assert.equal(await runtime.inspect(managedName), "running");
});

test("Zellij inspection refuses to adopt a same-name session with no matching managed pane identity", async () => {
  const runtime = new ZellijCliRuntime({
    cwd: "/repo",
    run: async (args) => {
      if (args[0] === "list-sessions")
        return { stdout: "mottainai-12345678-1234-4234-8234-123456789abc\n", stderr: "", exitCode: 0 };
      return {
        stdout: JSON.stringify([
          { title: "unrelated-shell", pane_cwd: "/other/repository", exited: false, exit_status: null },
        ]),
        stderr: "",
        exitCode: 0,
      };
    },
  });
  assert.equal(
    await runtime.inspect("mottainai-12345678-1234-4234-8234-123456789abc", "/repo/.mottainai/worktrees/task"),
    "unresolved",
  );
});
