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

const REQUIRED_COMMANDS = [
  "session create",
  "session id",
  "session show",
  "session list",
  "session inspect",
  "session claim",
  "session update",
  "session claims",
  "session close",
  "authorize",
  "checkpoint",
  "commit",
  "push",
  "gc",
];

function capabilitiesResult(
  overrides: {
    packageVersion?: string;
    commands?: readonly string[];
    claimSetReplacement?: Record<string, unknown> | null;
  } = {},
): unknown {
  const claimSetReplacement =
    overrides.claimSetReplacement === null
      ? {}
      : {
          claim_set_replacement: {
            commands: ["session update", "resource update"],
            atomic: true,
            pairing: "adjacent-resource-mode",
            idempotent_retry: true,
            unchanged_on_rejection: true,
            ...overrides.claimSetReplacement,
          },
        };
  return {
    ok: true,
    command: "capabilities",
    schema_version: 1,
    contract_id: "nawabari.standalone-execution.v1",
    package_version: overrides.packageVersion ?? "0.5.0",
    capabilities: [
      { id: "resource-claims", commands: overrides.commands ?? REQUIRED_COMMANDS, ...claimSetReplacement },
    ],
  };
}

test("adapter discovers the versioned contract and sends only concrete declaration fields", async () => {
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities") return result(capabilitiesResult());
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

test("Nawabari projection preserves explicit mixed modes across multiple bounded resources", async () => {
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "create")
          return result({
            ok: true,
            command: "session create",
            session_id: "session-mixed",
            repository: "repo",
            worktree: "/tmp/worktree",
            branch: "feat/mixed",
            state: "active",
          });
        if (args[0] === "session" && args[1] === "claim")
          return result({ ok: true, command: "session claim", session_id: "session-mixed" });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  const plan = createSemanticExecutionPlan({
    claims: [
      { resource: "src/read.ts", mode: "read" },
      { resource: "src/write.ts", mode: "write" },
      { resource: "src/exclusive.ts", mode: "exclusive-write" },
    ],
  });
  const started = await startNawabariExecution({ client, cwd: "/repo", branch: "feat/mixed", plan });
  assert.deepEqual(started.declaration.claims, plan.claims);
  const claimCalls = calls.filter((args) => args[0] === "session" && args[1] === "claim");
  assert.equal(claimCalls.length, 3);
  assert.deepEqual(
    claimCalls.map((args) => ({
      resource: args[args.indexOf("--resource") + 1],
      mode: args[args.indexOf("--mode") + 1],
    })),
    plan.claims,
  );
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
        if (args[0] === "capabilities") return result(capabilitiesResult());
        return result(
          {
            ok: false,
            command: "authorize",
            code: "RESOURCE_CLAIM_CONFLICT",
            message: "Operation denied",
            allowed: false,
          },
          3,
        );
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
        if (args[0] === "capabilities") return result(capabilitiesResult());
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

test("push results require the stable remote-generation evidence contract", async () => {
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities") return result(capabilitiesResult());
        return result({
          ok: true,
          command: "push",
          remote: "origin",
          branch: "fix/example",
          target: "origin/fix/example",
          relation: "up-to-date",
        });
      },
    },
  });
  await assert.rejects(
    client.push({
      cwd: "/repo",
      sessionId: "session-1",
      remote: "origin",
      branch: "fix/example",
      resources: ["src/app.ts"],
    }),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-contract-invalid",
  );
});

test("crash retry resumes the labeled session and adds only missing declared claims", async () => {
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities") return result(capabilitiesResult());
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
        if (args[0] === "capabilities") return result(capabilitiesResult());
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

test("discovery requires the atomic claim_set_replacement boundary and the 0.5.0 floor", async () => {
  const missingBoundary = new NawabariExecutionClient({
    runner: {
      async run(): Promise<RunResult> {
        return result(capabilitiesResult({ claimSetReplacement: null }));
      },
    },
  });
  await assert.rejects(
    missingBoundary.capabilities("/repo"),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-incompatible",
  );

  const notAtomic = new NawabariExecutionClient({
    runner: {
      async run(): Promise<RunResult> {
        return result(capabilitiesResult({ claimSetReplacement: { atomic: false } }));
      },
    },
  });
  await assert.rejects(
    notAtomic.capabilities("/repo"),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-incompatible",
  );

  const tooOld = new NawabariExecutionClient({
    runner: {
      async run(): Promise<RunResult> {
        return result(capabilitiesResult({ packageVersion: "0.3.0" }));
      },
    },
  });
  await assert.rejects(
    tooOld.capabilities("/repo"),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-incompatible",
  );

  // Nawabari 0.4.1 predates the session-diagnostics capability (`session inspect`,
  // `session close --integrated-revision`) that close reconciliation depends on;
  // both the version floor and the required-commands gate must reject it.
  const belowInspectFloor = new NawabariExecutionClient({
    runner: {
      async run(): Promise<RunResult> {
        return result(capabilitiesResult({ packageVersion: "0.4.1" }));
      },
    },
  });
  await assert.rejects(
    belowInspectFloor.capabilities("/repo"),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-incompatible",
  );

  const missingInspectCommand = new NawabariExecutionClient({
    runner: {
      async run(): Promise<RunResult> {
        return result(
          capabilitiesResult({ commands: REQUIRED_COMMANDS.filter((command) => command !== "session inspect") }),
        );
      },
    },
  });
  await assert.rejects(
    missingInspectCommand.capabilities("/repo"),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-incompatible",
  );
});

test("inspectSession reads state from the nested session-diagnostic.v1 session record, not a top-level field", async () => {
  // Nawabari 0.5.0's real `session inspect --json` nests the session record
  // (including `state`) under a `session` object; unlike `session show`/
  // `create`/`close`, there is no top-level `state` field.
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "inspect")
          return result({
            ok: true,
            command: "session inspect",
            schema_version: 1,
            session_id: "session-1",
            repository: "/repo/.git",
            worktree: "/repo-worktree",
            branch: "feat/example",
            session: {
              schema_version: 1,
              session_id: "session-1",
              repository: "/repo/.git",
              worktree: "/repo-worktree",
              branch: "feat/example",
              state: "closing",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
            claims: [],
            physical_state: "healthy",
            close_readiness: "blocked",
            cleanup_readiness: "not_due",
            result_state: "complete",
            idempotent: false,
            blockers: [
              { code: "DIRTY_WORKTREE", message: "recoverable changes remain", details: {}, safe_actions: [] },
            ],
            safe_actions: [],
            integration_evidence: { supplied: false },
          });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  const inspected = await client.inspectSession({ cwd: "/repo", sessionId: "session-1" });
  assert.equal(inspected.state, "closing");
  assert.equal(inspected.sessionId, "session-1");
  assert.equal(inspected.worktree, "/repo-worktree");
  assert.equal(inspected.raw.close_readiness, "blocked");
  assert.deepEqual(inspected.raw.blockers, [
    { code: "DIRTY_WORKTREE", message: "recoverable changes remain", details: {}, safe_actions: [] },
  ]);

  const missingSessionRecord = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "inspect")
          return result({
            ok: true,
            command: "session inspect",
            session_id: "session-1",
            repository: "/repo/.git",
            worktree: "/repo-worktree",
            branch: "feat/example",
            // No nested `session` object: a companion advertising the
            // capability but returning a malformed diagnostic must fail
            // closed, never fall back to treating this as active/closed.
          });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    missingSessionRecord.inspectSession({ cwd: "/repo", sessionId: "session-1" }),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-contract-invalid",
  );
});

test("updateClaims sends one atomic session update with adjacent resource/mode pairs", async () => {
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "update")
          return result({
            ok: true,
            command: "session update",
            session_id: "session-1",
            claims: [
              { resource: "docs/**", mode: "read" },
              { resource: "src/app.ts", mode: "exclusive-write" },
            ],
          });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  const claims = await client.updateClaims({
    cwd: "/repo",
    sessionId: "session-1",
    claims: [
      { resource: "docs/**", mode: "read" },
      { resource: "src/app.ts", mode: "exclusive-write" },
    ],
  });
  assert.deepEqual(claims, [
    { resource: "docs/**", mode: "read" },
    { resource: "src/app.ts", mode: "exclusive-write" },
  ]);
  const updateCall = calls.find((args) => args[0] === "session" && args[1] === "update");
  assert.deepEqual(updateCall?.slice(0, -1), [
    "session",
    "update",
    "--session",
    "session-1",
    "--resource",
    "docs/**",
    "--mode",
    "read",
    "--resource",
    "src/app.ts",
    "--mode",
    "exclusive-write",
  ]);
});

test("updateClaims fails closed when the returned claim set does not match the request", async () => {
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "update")
          return result({
            ok: true,
            command: "session update",
            session_id: "session-1",
            claims: [{ resource: "src/app.ts", mode: "read" }],
          });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    client.updateClaims({
      cwd: "/repo",
      sessionId: "session-1",
      claims: [{ resource: "src/app.ts", mode: "exclusive-write" }],
    }),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-contract-invalid",
  );
});
