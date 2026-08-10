import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_READ_GOVERNOR_POLICY } from "../../context-runtime/read-policy.js";
import { BUILTIN_PRESETS } from "../../workflow/policy/presets.js";
import { createWorkflowHookProvider } from "../../workflow/hook-provider.js";
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
    JSON.stringify({ ...BUILTIN_PRESETS.standard, protectedBranches: ["release/*"], protectedBranchRule: { ...BUILTIN_PRESETS.standard.protectedBranchRule, sourceWrite: "enforce" } }),
  );
  return root;
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

  const forcePush = await provider.evaluate(event("process.exec", { kind: "command", value: "git push origin HEAD:release/v1 --force" }));
  assert.equal(forcePush.state, "authoritative");
  assert.equal(forcePush.action, "deny");
  assert.equal(forcePush.rule, "protectedBranchRule.forcePush");

  const currentBranchForcePush = await provider.evaluate(event("process.exec", { kind: "command", value: "git push origin HEAD --force" }));
  assert.equal(currentBranchForcePush.state, "authoritative");
  assert.equal(currentBranchForcePush.action, "deny");
  assert.equal(currentBranchForcePush.rule, "protectedBranchRule.forcePush");

  const worktreeManagement = await provider.evaluate(event("process.exec", { kind: "command", value: "git worktree list" }));
  assert.equal(worktreeManagement.state, "authoritative");
  assert.equal(worktreeManagement.reason, "workflow_worktree");
});

test("context provider reuses #70 read-governor thresholds for broad and bounded reads", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-hook-provider-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "large.txt"), `${"line\n".repeat(50)}`);
  const readPolicy = { ...DEFAULT_READ_GOVERNOR_POLICY, mode: "enforce" as const, preferAuto: false, maxRawLines: 10, maxRawBytes: 256, allowWholeFileBelowLines: 2 };
  const provider = createContextReadPolicyProvider({ workspaceRoot: root, readPolicy });

  const broad = await provider.evaluate({ ...event("source.read", { kind: "path", value: "large.txt" }), metadata: { mode: "raw" } });
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
    { provider: "workflow", state: "authoritative", action: "deny", reason: "workflow_protected_branch", rule: "protectedBranchRule.sourceWrite" },
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
    [{ provider: "workflow", state: "authoritative", action: "deny", reason: "workflow_protected_branch", rule: "protectedBranchRule.commit" }],
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

  const workflow = await dispatchClientHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "tracked.txt" },
  }, context(workflowRoot));
  assert.equal(workflow.exitCode, 2);
  assert.equal(workflow.decision.reason, "workflow_protected_branch");

  const read = await dispatchClientHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "large.txt", mode: "raw" },
  }, {
    ...context(readRoot),
    readPolicy: { ...DEFAULT_READ_GOVERNOR_POLICY, mode: "enforce", preferAuto: false, maxRawLines: 10, maxRawBytes: 256, allowWholeFileBelowLines: 2 },
  });
  assert.equal(read.exitCode, 2);
  assert.equal(read.decision.reason, "context_read_governor");
});
