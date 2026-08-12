import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunResult } from "../subprocess.js";
import { createSemanticExecutionPlan } from "../semantics/execution-plan.js";
import {
  NawabariExecutionClient,
  NawabariExecutionError,
  resumeNawabariExecution,
  startNawabariExecution,
} from "./nawabari.js";

function result(stdout: unknown, exitCode = 0): RunResult {
  return { stdout: JSON.stringify(stdout), stderr: "", exitCode, signal: null, timedOut: false, outputLimit: false };
}

test("adapter discovers the versioned contract and sends only concrete declaration fields", async () => {
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities")
          return result({
            ok: true,
            command: "capabilities",
            schema_version: 1,
            contract_id: "nawabari.standalone-execution.v1",
            package_version: "0.2.0",
            capabilities: [
              {
                commands: [
                  "session create",
                  "session id",
                  "session show",
                  "session list",
                  "session claim",
                  "session claims",
                  "session close",
                  "authorize",
                  "checkpoint",
                  "commit",
                  "push",
                  "gc",
                ],
              },
            ],
          });
        if (args[0] === "session" && args[1] === "create")
          return result({
            ok: true,
            command: "session create",
            session_id: "session-1",
            repository: "repo",
            worktree: "/tmp/worktree",
            branch: "feat/example",
            state: "active",
          });
        if (args[0] === "session" && args[1] === "claim")
          return result({ ok: true, command: "session claim", session_id: "session-1" });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  const plan = createSemanticExecutionPlan({ explicitPaths: ["src/app.ts"] });
  const started = await startNawabariExecution({
    client,
    cwd: "/repo",
    branch: "feat/example",
    plan,
  });
  assert.equal(started.session.sessionId, "session-1");
  assert.deepEqual(started.declaration.claims, [{ resource: "src/app.ts", mode: "exclusive-write" }]);
  assert.equal(
    calls.some((args) => args.includes("semanticTargets")),
    false,
  );
  assert.deepEqual(calls[2]?.slice(0, -1), [
    "session",
    "claim",
    "--session",
    "session-1",
    "--resource",
    "src/app.ts",
    "--mode",
    "exclusive-write",
  ]);
});

test("missing and incompatible companions are explicit failures", async () => {
  const missing = new NawabariExecutionClient({
    runner: {
      async run(): Promise<RunResult> {
        return {
          stdout: "",
          stderr: "ENOENT",
          exitCode: null,
          signal: null,
          timedOut: false,
          outputLimit: false,
          spawnError: "ENOENT",
        };
      },
    },
  });
  await assert.rejects(
    missing.capabilities("/repo"),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-unavailable",
  );

  const incompatible = new NawabariExecutionClient({
    runner: {
      async run(): Promise<RunResult> {
        return result({
          ok: true,
          command: "capabilities",
          schema_version: 1,
          contract_id: "legacy",
          package_version: "0.2.0",
          capabilities: [],
        });
      },
    },
  });
  await assert.rejects(
    incompatible.capabilities("/repo"),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-incompatible",
  );
});

test("authorization denial remains an authoritative decision rather than an unavailable companion", async () => {
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities")
          return result({
            ok: true,
            command: "capabilities",
            schema_version: 1,
            contract_id: "nawabari.standalone-execution.v1",
            package_version: "0.2.0",
          capabilities: [{ commands: [
              "session create", "session id", "session show", "session list", "session claim", "session claims", "session close",
              "authorize", "checkpoint", "commit", "push", "gc",
            ] }],
          });
        return result({
          ok: false,
          command: "authorize",
          code: "RESOURCE_CLAIM_CONFLICT",
          message: "Operation denied",
          allowed: false,
        }, 3);
      },
    },
  });
  const decision = await client.authorize({
    cwd: "/repo",
    sessionId: "session-1",
    operation: "commit",
    resources: ["src/app.ts"],
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "RESOURCE_CLAIM_CONFLICT");
});

test("malformed mutation and evidence results fail the companion contract", async () => {
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities")
          return result({
            ok: true,
            command: "capabilities",
            schema_version: 1,
            contract_id: "nawabari.standalone-execution.v1",
            package_version: "0.2.0",
            capabilities: [{ commands: [
              "session create", "session id", "session show", "session list", "session claim", "session claims", "session close",
              "authorize", "checkpoint", "commit", "push", "gc",
            ] }],
          });
        if (args[0] === "commit") return result({ ok: true, command: "commit" });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    client.commit({ cwd: "/repo", sessionId: "session-1", message: "commit", resources: ["src/app.ts"] }),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-contract-invalid",
  );
});

test("crash retry resumes the labeled session and adds only missing declared claims", async () => {
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities")
          return result({
            ok: true,
            command: "capabilities",
            schema_version: 1,
            contract_id: "nawabari.standalone-execution.v1",
            package_version: "0.2.0",
            capabilities: [{
              commands: [
                "session create", "session id", "session show", "session list", "session claim", "session claims",
                "session close", "authorize", "checkpoint", "commit", "push", "gc",
              ],
            }],
          });
        if (args[0] === "session" && args[1] === "claims")
          return result({
            ok: true,
            command: "session claims",
            claims: [{ resource: "src/a.ts", mode: "exclusive-write" }],
          });
        if (args[0] === "session" && args[1] === "claim")
          return result({ ok: true, command: "session claim", session_id: "session-retry" });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  const plan = createSemanticExecutionPlan({ explicitPaths: ["src/a.ts", "src/b.ts"] });
  const resumed = await resumeNawabariExecution({
    client,
    cwd: "/repo",
    branch: "feat/retry",
    plan,
    session: {
      sessionId: "session-retry",
      repository: "/repo/.git",
      worktree: "/repo-worktree",
      branch: "feat/retry",
      state: "active",
      label: "mottainai-task-task-1",
      raw: { ok: true, command: "session show" },
    },
  });
  assert.equal(resumed.session.sessionId, "session-retry");
  const claimCalls = calls.filter((args) => args[0] === "session" && args[1] === "claim");
  assert.equal(claimCalls.length, 1);
  assert.ok(claimCalls[0]?.includes("src/b.ts"));
  assert.equal(claimCalls[0]?.includes("src/a.ts"), false);
});

test("crash retry rejects an unexpected broader claim without mutating it", async () => {
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities")
          return result({
            ok: true,
            command: "capabilities",
            schema_version: 1,
            contract_id: "nawabari.standalone-execution.v1",
            package_version: "0.2.0",
            capabilities: [{
              commands: [
                "session create", "session id", "session show", "session list", "session claim", "session claims",
                "session close", "authorize", "checkpoint", "commit", "push", "gc",
              ],
            }],
          });
        if (args[0] === "session" && args[1] === "claims")
          return result({
            ok: true,
            command: "session claims",
            claims: [{ resource: "**", mode: "exclusive-write" }],
          });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    resumeNawabariExecution({
      client,
      cwd: "/repo",
      branch: "feat/retry",
      plan: createSemanticExecutionPlan({ explicitPaths: ["src/a.ts"] }),
      session: {
        sessionId: "session-retry",
        repository: "/repo/.git",
        worktree: "/repo-worktree",
        branch: "feat/retry",
        state: "active",
        raw: { ok: true, command: "session show" },
      },
    }),
    (error: unknown) =>
      error instanceof NawabariExecutionError &&
      error.code === "nawabari-rejected" &&
      error.nawabariCode === "OWNERSHIP_MISMATCH",
  );
});
