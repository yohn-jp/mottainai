import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_READ_GOVERNOR_POLICY } from "../../context-runtime/read-policy.js";
import { BUILTIN_PRESETS } from "../../workflow/policy/presets.js";
import { createWorkflowHookProvider } from "../../workflow/hook-provider.js";
import { NawabariExecutionClient } from "../../workflow/nawabari.js";
import type { RunResult } from "../../subprocess.js";
import { dispatchClientHook } from "../commands.js";
import { composeHookDecision } from "./composition.js";
import { createContextReadPolicyProvider } from "./context.js";
import type { HookEvent } from "../types.js";

function shellGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

function event(operation: HookEvent["operation"], target?: HookEvent["target"]): HookEvent {
  return {
    version: 1,
    client: "claude",
    clientEvent: "PreToolUse",
    operation,
    ...(target === undefined ? {} : { target }),
  };
}

function gitRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-hook-provider-git-"));
  shellGit(["init", "-b", "release/v1"], root);
  shellGit(["config", "user.email", "test@example.invalid"], root);
  shellGit(["config", "user.name", "Hook Test"], root);
  fs.writeFileSync(path.join(root, "tracked.txt"), "tracked\n");
  shellGit(["add", "tracked.txt"], root);
  shellGit(["commit", "-m", "initial"], root);
  fs.mkdirSync(path.join(root, ".mottainai"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".mottainai", "workflow.json"),
    JSON.stringify({
      ...BUILTIN_PRESETS.standard,
      protectedBranches: ["release/*"],
      protectedBranchRule: { ...BUILTIN_PRESETS.standard.protectedBranchRule, sourceWrite: "enforce" },
    }),
  );
  return root;
}

function nawabariDecisionClient(allowed: boolean, calls: string[][]): NawabariExecutionClient {
  const response = (value: unknown, exitCode = 0): RunResult => ({
    stdout: JSON.stringify(value),
    stderr: "",
    exitCode,
    signal: null,
    timedOut: false,
    outputLimit: false,
  });
  return new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities")
          return response({
            ok: true,
            command: "capabilities",
            schema_version: 1,
            contract_id: "nawabari.standalone-execution.v1",
            package_version: "0.5.0",
            capabilities: [
              {
                id: "resource-claims",
                commands: [
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
                ],
                claim_set_replacement: {
                  commands: ["session update", "resource update"],
                  atomic: true,
                  pairing: "adjacent-resource-mode",
                  idempotent_retry: true,
                  unchanged_on_rejection: true,
                },
              },
            ],
          });
        if (args[0] === "authorize")
          return response(
            {
              ok: allowed,
              command: "authorize",
              allowed,
              code: allowed ? "ALLOWED" : "MISSING_RESOURCE_CLAIM",
              message: allowed ? "allowed" : "claim denied",
            },
            allowed ? 0 : 3,
          );
        throw new Error(`unexpected Nawabari command: ${args.join(" ")}`);
      },
    },
  });
}

test("workflow provider consumes current #28 policy and repository state without a branch-name rule in hooks", async (t) => {
  const root = gitRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const provider = createWorkflowHookProvider({ workspaceRoot: root });
  const result = await provider.evaluate(event("source.write", { kind: "path", value: "tracked.txt" }));
  assert.equal(result.state, "authoritative");
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "workflow_protected_branch");
  assert.equal(result.rule, "protectedBranchRule.sourceWrite");

  const forcePush = await provider.evaluate(
    event("process.exec", { kind: "command", value: "git push origin HEAD:release/v1 --force" }),
  );
  assert.equal(forcePush.state, "authoritative");
  assert.equal(forcePush.action, "redirect");
  assert.equal(forcePush.reason, "workflow_typed_operation_required");
  assert.equal(forcePush.replacement, "mottainai_workflow_task_push");

  const currentBranchForcePush = await provider.evaluate(
    event("process.exec", { kind: "command", value: "git push origin HEAD --force" }),
  );
  assert.equal(currentBranchForcePush.state, "authoritative");
  assert.equal(currentBranchForcePush.action, "redirect");
  assert.equal(currentBranchForcePush.replacement, "mottainai_workflow_task_push");

  const worktreeManagement = await provider.evaluate(
    event("process.exec", { kind: "command", value: "git worktree list" }),
  );
  assert.equal(worktreeManagement.state, "authoritative");
  assert.equal(worktreeManagement.reason, "workflow_worktree");
});

test("raw Git mutations redirect only supported commit/push operations and never authorize shell claims", async (t) => {
  const root = gitRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  shellGit(["checkout", "-b", "feature/typed-git"], root);
  const calls: string[][] = [];
  const provider = createWorkflowHookProvider({
    workspaceRoot: root,
    nawabari: nawabariDecisionClient(true, calls),
  });

  const commit = await provider.evaluate(
    event("git.mutate", { kind: "command", value: "git commit -m 'message that is not a resource'" }),
  );
  assert.equal(commit.state, "authoritative");
  assert.equal(commit.action, "redirect");
  assert.equal(commit.reason, "workflow_typed_operation_required");
  assert.equal(commit.replacement, "mottainai_workflow_task_commit");

  const push = await provider.evaluate(
    event("git.mutate", { kind: "command", value: "git push origin HEAD:release/guessed --force" }),
  );
  assert.equal(push.state, "authoritative");
  assert.equal(push.action, "redirect");
  assert.equal(push.replacement, "mottainai_workflow_task_push");

  for (const command of [
    "git add guessed/path.txt",
    "git reset --hard guessed-ref",
    "git branch -D guessed",
    "git worktree remove guessed",
    "git worktree list && git worktree remove guessed",
    "git worktree list && rm -rf guessed",
  ]) {
    const unsupported = await provider.evaluate(event("git.mutate", { kind: "command", value: command }));
    assert.equal(unsupported.state, "authoritative");
    assert.equal(unsupported.action, "deny");
    assert.equal(unsupported.reason, "workflow_git_mutation_unsupported");
    assert.equal(unsupported.diagnostic, "typed_resource_required");
  }
  assert.equal(
    calls.some((args) => args[0] === "authorize"),
    false,
  );
});

test("typed Git workflow events retain concrete Nawabari resources", async (t) => {
  const root = gitRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  shellGit(["checkout", "-b", "feature/typed-resource"], root);
  const calls: string[][] = [];
  const provider = createWorkflowHookProvider({
    workspaceRoot: root,
    nawabari: nawabariDecisionClient(true, calls),
  });

  const commit = await provider.evaluate({
    ...event("git.mutate"),
    metadata: { workflowOperation: "commit", resource: "tracked.txt" },
  });
  assert.equal(commit.action, "allow");
  assert.ok(calls.some((args) => args[0] === "authorize" && args.includes("commit") && args.includes("tracked.txt")));

  const push = await provider.evaluate({
    ...event("git.mutate"),
    metadata: { workflowOperation: "directPush", resource: "tracked.txt" },
  });
  assert.equal(push.action, "allow");
  assert.ok(calls.some((args) => args[0] === "authorize" && args.includes("push") && args.includes("tracked.txt")));
});

test("workflow hook obtains source-write authorization from Nawabari and fails closed when unavailable", async (t) => {
  const root = gitRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  shellGit(["checkout", "-b", "feat/hook-authorization"], root);

  const missing = await createWorkflowHookProvider({ workspaceRoot: root }).evaluate(
    event("source.write", { kind: "path", value: "tracked.txt" }),
  );
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.rule, "nawabari.contract");

  const allowedCalls: string[][] = [];
  const allowed = await createWorkflowHookProvider({
    workspaceRoot: root,
    nawabari: nawabariDecisionClient(true, allowedCalls),
  }).evaluate(event("source.write", { kind: "path", value: "tracked.txt" }));
  assert.equal(allowed.state, "authoritative");
  assert.equal(allowed.action, "allow");
  const authorization = allowedCalls.find((args) => args[0] === "authorize");
  assert.ok(authorization?.includes("source-write"));
  assert.ok(authorization?.includes("tracked.txt"));

  const denied = await createWorkflowHookProvider({
    workspaceRoot: root,
    nawabari: nawabariDecisionClient(false, []),
  }).evaluate(event("source.write", { kind: "path", value: "tracked.txt" }));
  assert.equal(denied.state, "authoritative");
  assert.equal(denied.action, "deny");
  assert.equal(denied.rule, "nawabari.authorize");
  assert.match(denied.diagnostic ?? "", /MISSING_RESOURCE_CLAIM/u);
});

test("context provider reuses #70 read-governor thresholds for broad and bounded reads", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-hook-provider-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "large.txt"), `${"line\n".repeat(50)}`);
  const readPolicy = {
    ...DEFAULT_READ_GOVERNOR_POLICY,
    mode: "enforce" as const,
    preferAuto: false,
    maxRawLines: 10,
    maxRawBytes: 256,
    allowWholeFileBelowLines: 2,
  };
  const provider = createContextReadPolicyProvider({ workspaceRoot: root, readPolicy });

  const broad = await provider.evaluate({
    ...event("source.read", { kind: "path", value: "large.txt" }),
    metadata: { mode: "raw" },
  });
  assert.equal(broad.state, "authoritative");
  assert.equal(broad.action, "deny");
  assert.equal(broad.reason, "context_read_governor");
  assert.equal(broad.rule, "WHOLE_FILE_RAW_LINE_LIMIT");
  assert.equal(broad.replacement, "mottainai_read");

  const bounded = await provider.evaluate({
    ...event("source.read", { kind: "path", value: "large.txt" }),
    metadata: { mode: "raw", startLine: 1, endLine: 2 },
  });
  assert.equal(bounded.state, "authoritative");
  assert.equal(bounded.action, "allow");
  assert.equal(bounded.rule, "NONE");
});

test("composition is deterministic, preserves a stronger deny, and surfaces non-authoritative state", () => {
  const generic = { version: 1 as const, decision: "allow" as const, reason: "observe_only" as const };
  const trace = composeHookDecision(generic, [
    { provider: "semantic", state: "unavailable", reason: "semantic_authority_unavailable", rule: "semantic.fresh" },
    { provider: "context", state: "authoritative", action: "allow", reason: "context_read_governor", rule: "NONE" },
    {
      provider: "workflow",
      state: "authoritative",
      action: "deny",
      reason: "workflow_protected_branch",
      rule: "protectedBranchRule.sourceWrite",
    },
  ]);
  assert.equal(trace.decision.decision, "deny");
  assert.equal(trace.decision.provider, "workflow");
  assert.equal(trace.decision.rule, "protectedBranchRule.sourceWrite");

  const unavailable = composeHookDecision(generic, [
    { provider: "semantic", state: "unavailable", reason: "semantic_authority_unavailable", rule: "semantic.fresh" },
  ]);
  assert.equal(unavailable.decision.decision, "allow");
  assert.equal(unavailable.decision.provider, "semantic");
  assert.equal(unavailable.decision.providerState, "unavailable");
});

test("a domain deny preserves a usable generic managed replacement", () => {
  const trace = composeHookDecision(
    { version: 1, decision: "redirect", reason: "managed_capability_available", replacement: "mottainai_exec" },
    [
      {
        provider: "workflow",
        state: "authoritative",
        action: "deny",
        reason: "workflow_protected_branch",
        rule: "protectedBranchRule.commit",
      },
    ],
  );
  assert.equal(trace.decision.decision, "deny");
  assert.equal(trace.decision.replacement, "mottainai_exec");
});

test("supported Claude hook adapter projects workflow denial and read-governor denial", async (t) => {
  const workflowRoot = gitRepository();
  const readRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-hook-blackbox-read-"));
  t.after(() => {
    fs.rmSync(workflowRoot, { recursive: true, force: true });
    fs.rmSync(readRoot, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(readRoot, "large.txt"), `${"line\n".repeat(50)}`);
  const context = (workspaceRoot: string) => ({
    workspaceRoot,
    homeDirectory: workspaceRoot,
    environment: { PATH: "/usr/bin:/bin" },
    dispatcherCommand: "/bin/sh",
    exposedTools: new Set(["mottainai_read", "mottainai_exec"]),
    workflowProvider: createWorkflowHookProvider({ workspaceRoot }),
  });

  const workflow = await dispatchClientHook(
    "claude",
    {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "tracked.txt" },
    },
    context(workflowRoot),
  );
  assert.equal(workflow.exitCode, 2);
  assert.equal(workflow.decision.reason, "workflow_protected_branch");

  const read = await dispatchClientHook(
    "claude",
    {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "large.txt", mode: "raw" },
    },
    {
      ...context(readRoot),
      readPolicy: {
        ...DEFAULT_READ_GOVERNOR_POLICY,
        mode: "enforce",
        preferAuto: false,
        maxRawLines: 10,
        maxRawBytes: 256,
        allowWholeFileBelowLines: 2,
      },
    },
  );
  assert.equal(read.exitCode, 2);
  assert.equal(read.decision.reason, "context_read_governor");
});
