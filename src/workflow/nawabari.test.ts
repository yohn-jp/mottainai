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
  "session release",
  "session close",
  "authorize",
  "checkpoint",
  "commit",
  "push",
  "gc",
];

const CLOSE_FETCH_EXPLICIT_NETWORK = {
  default: false,
  operations: [
    {
      command: "session close",
      options: ["--integrated-revision", "--fetch-remote", "--fetch-branch"],
      requires: ["--integrated-revision", "--fetch-remote", "--fetch-branch"],
      scope: "one named remote branch into one disposable internal proof ref",
    },
  ],
};

function capabilitiesResult(
  overrides: {
    packageVersion?: string;
    commands?: readonly string[];
    claimSetReplacement?: Record<string, unknown> | null;
    explicitNetwork?: Record<string, unknown>;
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
    ...(overrides.explicitNetwork === undefined ? {} : { explicit_network: overrides.explicitNetwork }),
  };
}

function v2CapabilitiesResult(): unknown {
  const base = capabilitiesResult({ packageVersion: "0.7.1" }) as {
    capabilities: Record<string, unknown>[];
    [key: string]: unknown;
  };
  const resourceClaims = base.capabilities[0]!;
  return {
    ...base,
    capabilities: [
      {
        ...resourceClaims,
        contract_id: "nawabari.resource-claims.v2",
        contract_version: 2,
        claim_schema_version: 2,
        result_schemas: [
          {
            schema: "resource-claim.release.v2",
            required: ["session_id", "released", "remaining", "claim_set_generation"],
          },
        ],
        mutation: {
          claim_set_generation: { cas_option: "--if-generation", stale_failure: "STALE_CLAIM_SET" },
        },
        semantics: { release: { selectors: ["--resource", "--claim-id", "--all"] } },
      },
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

test("releaseClaims keeps the legacy session target contract for pre-v2 companions", async () => {
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities") return result(capabilitiesResult({ packageVersion: "0.6.1" }));
        if (args[0] === "session" && args[1] === "release")
          return result({ ok: true, command: "session release", session_id: "legacy-session" });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await client.releaseClaims({ cwd: "/repo", sessionId: "legacy-session" });
  assert.deepEqual(calls[1], ["session", "release", "--session", "legacy-session", "--json"]);
});

test("releaseClaims selects the v2 all-selector CAS path and never uses generic force", async () => {
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities") return result(v2CapabilitiesResult());
        if (args[0] === "session" && args[1] === "claims")
          return result({
            ok: true,
            command: "session claims",
            claims: [
              {
                schema_version: 2,
                session_id: "v2-session",
                resource: "src/app.ts",
                mode: "exclusive-write",
              },
            ],
            claim_set_generation: 7,
          });
        if (args[0] === "session" && args[1] === "release") {
          assert.deepEqual(args.slice(0, -1), [
            "session",
            "release",
            "--session",
            "v2-session",
            "--all",
            "--if-generation",
            "7",
          ]);
          assert.equal(args.includes("--force"), false);
          return result({
            ok: true,
            command: "session release",
            session_id: "v2-session",
            released: [{ resource: "src/app.ts", mode: "exclusive-write" }],
            remaining: [],
            claim_set_generation: 8,
          });
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await client.releaseClaims({ cwd: "/repo", sessionId: "v2-session" });
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "release").length, 1);
});

test("releaseClaims fails closed for ambiguous v2 evidence and stale generation", async () => {
  const ambiguous = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities") {
          const value = v2CapabilitiesResult() as { capabilities: Record<string, unknown>[] };
          const resource = value.capabilities[0]!;
          const mutation = resource.mutation as Record<string, unknown>;
          delete mutation.claim_set_generation;
          return result(value);
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    ambiguous.releaseClaims({ cwd: "/repo", sessionId: "foreign-session" }),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-incompatible",
  );

  const foreignCalls: string[][] = [];
  const foreign = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        foreignCalls.push([...args]);
        if (args[0] === "capabilities") return result(v2CapabilitiesResult());
        if (args[0] === "session" && args[1] === "claims")
          return result({
            ok: true,
            command: "session claims",
            claims: [{ session_id: "foreign-owner", resource: "src/foreign.ts", mode: "write" }],
            claim_set_generation: 2,
          });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    foreign.releaseClaims({ cwd: "/repo", sessionId: "requested-session" }),
    (error: unknown) =>
      error instanceof NawabariExecutionError && error.code === "nawabari-claim-authority-unrecognized",
  );
  assert.equal(
    foreignCalls.some((args) => args[0] === "session" && args[1] === "release"),
    false,
  );

  const calls: string[][] = [];
  const stale = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities") return result(v2CapabilitiesResult());
        if (args[0] === "session" && args[1] === "claims")
          return result({ ok: true, command: "session claims", claims: [], claim_set_generation: 4 });
        if (args[0] === "session" && args[1] === "release")
          return result(
            { ok: false, command: "session release", code: "STALE_CLAIM_SET", message: "generation changed" },
            3,
          );
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    stale.releaseClaims({ cwd: "/repo", sessionId: "owned-session" }),
    (error: unknown) =>
      error instanceof NawabariExecutionError &&
      error.code === "nawabari-rejected" &&
      error.nawabariCode === "STALE_CLAIM_SET",
  );
  const release = calls.find((args) => args[0] === "session" && args[1] === "release");
  assert.deepEqual(release?.slice(0, -1), [
    "session",
    "release",
    "--session",
    "owned-session",
    "--all",
    "--if-generation",
    "4",
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

function closeSessionRunner(sessionId: string): { calls: string[][]; run: (command: string, args: readonly string[]) => Promise<RunResult> } {
  const calls: string[][] = [];
  return {
    calls,
    async run(_command, args): Promise<RunResult> {
      calls.push([...args]);
      if (args[0] === "capabilities") return result(capabilitiesResult({ explicitNetwork: CLOSE_FETCH_EXPLICIT_NETWORK }));
      if (args[0] === "session" && args[1] === "close")
        return result({
          ok: true,
          command: "session close",
          session: {
            session_id: sessionId,
            repository: "repo",
            worktree: "/tmp/worktree",
            branch: "feat/example",
            state: "closed",
          },
          worktree_removed: true,
          branch_removed: true,
        });
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };
}

test("capabilities detects close-fetch support only from the exact #160/#161 explicit_network shape", async () => {
  const supported = new NawabariExecutionClient({
    runner: { run: async (_c, args) => result(capabilitiesResult({ explicitNetwork: CLOSE_FETCH_EXPLICIT_NETWORK })) },
  });
  assert.equal((await supported.capabilities("/repo")).supportsCloseFetch, true);

  const unsupported = new NawabariExecutionClient({
    runner: { run: async () => result(capabilitiesResult()) },
  });
  assert.equal((await unsupported.capabilities("/repo")).supportsCloseFetch, false);

  const partialOptions = new NawabariExecutionClient({
    runner: {
      run: async () =>
        result(
          capabilitiesResult({
            explicitNetwork: {
              default: false,
              operations: [
                {
                  command: "session close",
                  options: ["--integrated-revision", "--fetch-remote"],
                  requires: ["--integrated-revision", "--fetch-remote"],
                },
              ],
            },
          }),
        ),
    },
  });
  assert.equal((await partialOptions.capabilities("/repo")).supportsCloseFetch, false);
});

test("closeSession sends --fetch-remote/--fetch-branch only when the companion advertises close-fetch support", async () => {
  const { calls, run } = closeSessionRunner("session-1");
  const client = new NawabariExecutionClient({ runner: { run } });
  await client.closeSession({
    cwd: "/repo",
    sessionId: "session-1",
    integratedRevision: "a".repeat(40),
    fetchRemote: "upstream",
    fetchBranch: "release",
  });
  const closeArgs = calls.find((args) => args[0] === "session" && args[1] === "close")!;
  assert.ok(closeArgs.includes("--fetch-remote"));
  assert.equal(closeArgs[closeArgs.indexOf("--fetch-remote") + 1], "upstream");
  assert.ok(closeArgs.includes("--fetch-branch"));
  assert.equal(closeArgs[closeArgs.indexOf("--fetch-branch") + 1], "release");
});

test("closeSession fails closed before any fetch effect when the companion does not advertise close-fetch", async () => {
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities") return result(capabilitiesResult());
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    client.closeSession({
      cwd: "/repo",
      sessionId: "session-1",
      integratedRevision: "a".repeat(40),
      fetchRemote: "upstream",
      fetchBranch: "release",
    }),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-incompatible",
  );
  assert.equal(
    calls.some((args) => args[0] === "session" && args[1] === "close"),
    false,
  );
});

test("closeSession rejects fetchRemote/fetchBranch supplied without integratedRevision or as a partial pair", async () => {
  const { run } = closeSessionRunner("session-1");
  const client = new NawabariExecutionClient({ runner: { run } });
  await assert.rejects(
    client.closeSession({ cwd: "/repo", sessionId: "session-1", fetchRemote: "upstream", fetchBranch: "release" }),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-contract-invalid",
  );
  await assert.rejects(
    client.closeSession({
      cwd: "/repo",
      sessionId: "session-1",
      integratedRevision: "a".repeat(40),
      fetchRemote: "upstream",
    }),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-contract-invalid",
  );
});

test("closeSession omits fetch flags entirely for ordinary/non-fetch close", async () => {
  const { calls, run } = closeSessionRunner("session-1");
  const client = new NawabariExecutionClient({ runner: { run } });
  await client.closeSession({ cwd: "/repo", sessionId: "session-1", integratedRevision: "a".repeat(40) });
  const closeArgs = calls.find((args) => args[0] === "session" && args[1] === "close")!;
  assert.equal(closeArgs.includes("--fetch-remote"), false);
  assert.equal(closeArgs.includes("--fetch-branch"), false);
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

test("read-only claim evidence returns active owners and canonical claims without mutation", async () => {
  const calls: string[][] = [];
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "list")
          return result({
            ok: true,
            command: "session list",
            sessions: [
              {
                session_id: "session-b",
                repository: "/repo/.git",
                worktree: "/repo-b",
                branch: "feat/b",
                state: "active",
              },
              {
                session_id: "session-a",
                repository: "/repo/.git",
                worktree: "/repo-a",
                branch: "feat/a",
                state: "active",
              },
            ],
            total: 2,
            returned: 2,
            truncated: false,
            next_offset: null,
          });
        if (args[0] === "session" && args[1] === "claims")
          return result({
            ok: true,
            command: "session claims",
            claims: [
              {
                schema_version: 2,
                claim_id: "claim-b",
                session_id: "session-b",
                repository: "/repo/.git",
                worktree: "/repo-b",
                resource: "src/**",
                mode: "exclusive-write",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  const snapshot = await client.listClaimEvidence("/repo");
  assert.equal(snapshot.claims[0]?.sessionId, "session-b");
  assert.equal(snapshot.claims[0]?.resource, "src/**");
  // Claims are read before sessions: a session created between the two reads
  // must not manufacture a spurious STALE_REGISTRY result for an unrelated
  // concurrent start (see the race-condition regression test below).
  assert.deepEqual(
    calls.map((args) => args.slice(0, -1)),
    [["capabilities"], ["session", "claims"], ["session", "list"]],
  );
  assert.equal(
    calls.some((args) => args[0] === "session" && ["create", "claim", "update"].includes(args[1]!)),
    false,
  );
});

const ORPHAN_CLAIM = {
  schema_version: 2,
  claim_id: "claim-orphan",
  session_id: "missing-session",
  repository: "/repo/.git",
  worktree: "/missing",
  resource: "src/**",
  mode: "exclusive-write",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

test("read-only claim evidence fails closed for every registry ambiguity branch with the exact Nawabari code", async () => {
  const cases: {
    name: string;
    expectedCode: string;
    sessions: readonly Record<string, unknown>[];
    claims: readonly Record<string, unknown>[];
    sessionListOverrides?: Record<string, unknown>;
  }[] = [
    {
      name: "truncated session list",
      expectedCode: "STALE_REGISTRY",
      sessions: [],
      claims: [ORPHAN_CLAIM],
      sessionListOverrides: { total: 2, returned: 1, truncated: true, next_offset: 1 },
    },
    {
      name: "orphan claim owner absent from session list",
      expectedCode: "STALE_REGISTRY",
      sessions: [],
      claims: [ORPHAN_CLAIM],
    },
    {
      name: "present but non-active owner",
      expectedCode: "STALE_REGISTRY",
      sessions: [
        {
          session_id: "closing-session",
          repository: "/repo/.git",
          worktree: "/repo-closing",
          branch: "feat/closing",
          state: "closing",
        },
      ],
      claims: [{ ...ORPHAN_CLAIM, claim_id: "claim-closing", session_id: "closing-session", worktree: "/repo-closing" }],
    },
    {
      name: "duplicate claim id",
      expectedCode: "REGISTRY_CORRUPT",
      sessions: [
        {
          session_id: "session-dup",
          repository: "/repo/.git",
          worktree: "/repo-dup",
          branch: "feat/dup",
          state: "active",
        },
      ],
      claims: [
        { ...ORPHAN_CLAIM, claim_id: "claim-dup", session_id: "session-dup", worktree: "/repo-dup", resource: "src/a.ts" },
        { ...ORPHAN_CLAIM, claim_id: "claim-dup", session_id: "session-dup", worktree: "/repo-dup", resource: "src/b.ts" },
      ],
    },
    {
      name: "unsupported claim schema version",
      expectedCode: "UNSUPPORTED_CLAIM_SCHEMA_VERSION",
      sessions: [
        {
          session_id: "session-v3",
          repository: "/repo/.git",
          worktree: "/repo-v3",
          branch: "feat/v3",
          state: "active",
        },
      ],
      claims: [{ ...ORPHAN_CLAIM, schema_version: 3, claim_id: "claim-v3", session_id: "session-v3", worktree: "/repo-v3" }],
    },
  ];
  for (const testCase of cases) {
    const client = new NawabariExecutionClient({
      runner: {
        async run(_command, args): Promise<RunResult> {
          if (args[0] === "capabilities") return result(capabilitiesResult());
          if (args[0] === "session" && args[1] === "list")
            return result({
              ok: true,
              command: "session list",
              sessions: testCase.sessions,
              total: testCase.sessions.length,
              returned: testCase.sessions.length,
              truncated: false,
              next_offset: null,
              ...(testCase.sessionListOverrides ?? {}),
            });
          if (args[0] === "session" && args[1] === "claims")
            return result({ ok: true, command: "session claims", claims: testCase.claims });
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
      },
    });
    await assert.rejects(
      client.listClaimEvidence("/repo"),
      (error: unknown) =>
        error instanceof NawabariExecutionError &&
        error.code === "nawabari-evidence-ambiguous" &&
        error.nawabariCode === testCase.expectedCode,
      testCase.name,
    );
  }
});

test("read-only claim evidence fails closed when claim and owner identities disagree", async () => {
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "list")
          return result({
            ok: true,
            command: "session list",
            sessions: [
              {
                session_id: "session-owner",
                repository: "/repo/.git",
                worktree: "/repo-owner",
                branch: "feat/owner",
                state: "active",
              },
            ],
            total: 1,
            returned: 1,
            truncated: false,
            next_offset: null,
          });
        if (args[0] === "session" && args[1] === "claims")
          return result({
            ok: true,
            command: "session claims",
            claims: [
              {
                schema_version: 2,
                claim_id: "claim-mismatched-owner",
                session_id: "session-owner",
                repository: "/repo/.git",
                worktree: "/repo-other",
                resource: "src/**",
                mode: "exclusive-write",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    client.listClaimEvidence("/repo"),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-evidence-ambiguous",
  );
});

test("unsupported claim schema version is reported before ownership/identity is interpreted", async () => {
  // A claim that is simultaneously schema-unsupported AND would otherwise
  // read as an owner/identity mismatch must report
  // UNSUPPORTED_CLAIM_SCHEMA_VERSION, not STALE_REGISTRY or
  // CLAIM_SESSION_MISMATCH: schema version 2 is the only version whose
  // repository/worktree/session_id fields are guaranteed to mean what the
  // parser assumes, so a newer schema must never be interpreted first.
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "list")
          return result({
            ok: true,
            command: "session list",
            sessions: [],
            total: 0,
            returned: 0,
            truncated: false,
            next_offset: null,
          });
        if (args[0] === "session" && args[1] === "claims")
          return result({
            ok: true,
            command: "session claims",
            claims: [
              {
                schema_version: 3,
                claim_id: "claim-future-schema",
                session_id: "session-absent",
                repository: "/repo/.git",
                worktree: "/repo-mismatched",
                resource: "src/**",
                mode: "exclusive-write",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    client.listClaimEvidence("/repo"),
    (error: unknown) =>
      error instanceof NawabariExecutionError &&
      error.code === "nawabari-evidence-ambiguous" &&
      error.nawabariCode === "UNSUPPORTED_CLAIM_SCHEMA_VERSION",
  );
});

test("listClaimEvidence reading claims before sessions tolerates a session created between the two reads", async () => {
  // Regression for the snapshot race: if sessions were read first, a session
  // created between the two reads would own a claim absent from the earlier
  // session snapshot and manufacture a spurious STALE_REGISTRY result for an
  // unrelated concurrent start. Reading claims first means every observed
  // claim owner already existed at claim-read time, so the later session
  // list is guaranteed to still contain it (unless it genuinely closed).
  let sessionListCallCount = 0;
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "claims")
          return result({
            ok: true,
            command: "session claims",
            claims: [
              {
                schema_version: 2,
                claim_id: "claim-concurrent",
                session_id: "session-concurrent",
                repository: "/repo/.git",
                worktree: "/repo-concurrent",
                resource: "src/**",
                mode: "exclusive-write",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
        if (args[0] === "session" && args[1] === "list") {
          sessionListCallCount += 1;
          // Simulates a session concurrently created after the claims read:
          // by the time session list runs, the owner is already present.
          return result({
            ok: true,
            command: "session list",
            sessions: [
              {
                session_id: "session-concurrent",
                repository: "/repo/.git",
                worktree: "/repo-concurrent",
                branch: "feat/concurrent",
                state: "active",
              },
            ],
            total: 1,
            returned: 1,
            truncated: false,
            next_offset: null,
          });
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  const snapshot = await client.listClaimEvidence("/repo");
  assert.equal(sessionListCallCount, 1);
  assert.equal(snapshot.claims.length, 1);
  assert.equal(snapshot.claims[0]?.sessionId, "session-concurrent");
});

test("listClaimEvidence fails closed rather than truncating when session claims output exceeds the bounded transport limit", async () => {
  // Unlike `session list` (bounded to 64 records with truncation fields),
  // real Nawabari's `session claims` (no --session filter) has no logical
  // page limit of its own: it returns the complete claims registry. The only
  // boundedness Manager can rely on is the subprocess output cap
  // (`COMMAND_MAX_OUTPUT_BYTES`), which must fail closed instead of handing
  // back truncated, unparseable JSON that could otherwise be misread.
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "claims")
          return {
            stdout: "",
            stderr: "",
            exitCode: null,
            signal: null,
            timedOut: false,
            outputLimit: true,
          };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    client.listClaimEvidence("/repo"),
    (error: unknown) => error instanceof NawabariExecutionError && error.code === "nawabari-command-failed",
  );
});

test("listClaimEvidence still fails closed when a claim owner genuinely closes between the two reads", async () => {
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities") return result(capabilitiesResult());
        if (args[0] === "session" && args[1] === "claims")
          return result({
            ok: true,
            command: "session claims",
            claims: [
              {
                schema_version: 2,
                claim_id: "claim-closed-mid-read",
                session_id: "session-closed-mid-read",
                repository: "/repo/.git",
                worktree: "/repo-closed",
                resource: "src/**",
                mode: "exclusive-write",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
        if (args[0] === "session" && args[1] === "list")
          // Simulates the owner closing between the claims read and the
          // session-list read: it is genuinely absent from the later read.
          return result({
            ok: true,
            command: "session list",
            sessions: [],
            total: 0,
            returned: 0,
            truncated: false,
            next_offset: null,
          });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(
    client.listClaimEvidence("/repo"),
    (error: unknown) =>
      error instanceof NawabariExecutionError &&
      error.code === "nawabari-evidence-ambiguous" &&
      error.nawabariCode === "STALE_REGISTRY",
  );
});
