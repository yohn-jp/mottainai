import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { createTempGitRepo } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import { ManagerSessionService } from "../manager/service.js";
import type { ZellijObservedState, ZellijRuntime } from "../manager/zellij.js";

class HermeticZellijRuntime implements ZellijRuntime {
  readonly children = new Map<string, ChildProcess>();
  readonly completions = new Map<string, Promise<void>>();

  async checkAvailability(): Promise<{ version: string }> {
    return { version: "fake-zellij e2e" };
  }

  async inspect(name: string): Promise<ZellijObservedState> {
    const child = this.children.get(name);
    if (child === undefined) return "absent";
    return child.exitCode === null ? "running" : "exited";
  }

  async start(input: { sessionName: string; cwd: string; command: string; args: readonly string[] }): Promise<void> {
    const child = spawn(input.command, [...input.args], { cwd: input.cwd, shell: false, stdio: "ignore" });
    this.children.set(input.sessionName, child);
    this.completions.set(
      input.sessionName,
      new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.once("error", () => resolve());
      }),
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
  }

  async attach(name: string): Promise<void> {
    if ((await this.inspect(name)) !== "running") throw new Error("fake Zellij session is not running");
  }

  async terminate(name: string): Promise<void> {
    const child = this.children.get(name);
    if (child !== undefined && child.exitCode === null) child.kill("SIGTERM");
  }
}

test("Manager -> managed worktree -> hermetic Zellij runtime -> disposable CLI process lifecycle", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new HermeticZellijRuntime();
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime,
    // The production command remains Codex. This seam makes CI exercise the complete
    // process/cwd/lifecycle path without credentials or a network call.
    agentCommand: {
      command: process.execPath,
      baseArgs: [
        "-e",
        "require('node:fs').writeFileSync(require('node:path').join(process.cwd(),'manager-e2e-marker'),'ok')",
      ],
    },
  });
  await service.initialize();
  const session = await service.start({
    instruction: "disposable e2e process",
    taskSlug: "e2e-task",
    issueRef: "901",
    branchType: "fix",
  });
  const child = runtime.children.get(session.runtimeName);
  assert.ok(child !== undefined);
  await runtime.completions.get(session.runtimeName);
  const reconciled = await service.list();
  const restored = reconciled.find((candidate) => candidate.sessionId === session.sessionId);
  assert.equal(restored?.lifecycleState, "exited");
  assert.equal(restored?.runtimeState, "exited");
  assert.equal(restored?.worktreePath, session.worktreePath);
  assert.equal(fs.readFileSync(`${session.worktreePath}/manager-e2e-marker`, "utf8"), "ok");
});
