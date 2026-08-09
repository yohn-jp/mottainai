import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeAdapter, codexAdapter } from "./adapters/index.js";
import { deriveTrustedHookContext } from "./context.js";
import { capabilityRegistryFromRuntime, createCapabilityRegistry } from "./capabilities.js";
import { decideHook, dispatchHook } from "./dispatcher.js";
import { dispatchClientHook, runManagedHooksCommand } from "./commands.js";
import { managedDescriptor } from "./install/lifecycle.js";
import { loadHookPolicy } from "./policy.js";
import type { HookCommandContext } from "./commands.js";
import { boundHookText, serializeHookDecision } from "./types.js";
import type { HookDecision, HookEvent } from "./types.js";

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-hooks-"));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

function event(operation: HookEvent["operation"]): HookEvent {
  return {
    version: 1,
    client: "claude",
    clientEvent: "PreToolUse",
    operation,
    repository: { root: "/repo", identity: "repo_test" },
  };
}

function policy(mode: "observe" | "warn" | "enforce") {
  const loaded = loadHookPolicy("/definitely/missing/mottainai-hooks-test");
  if (!loaded.ok) throw new Error(loaded.reason);
  return { ...loaded.policy, mode };
}

test("transport-independent dispatcher is deterministic and capability-based", () => {
  const capabilities = capabilityRegistryFromRuntime({ dispatcherAvailable: true, exposedTools: new Set(["mottainai_exec"]) });
  const enforce = { policy: policy("enforce"), capabilities };
  assert.equal(decideHook(event("process.exec"), enforce).decision, "redirect");
  assert.equal(decideHook(event("source.write"), enforce).decision, "allow");
  assert.equal(decideHook(event("source.write"), enforce).reason, "managed_capability_unavailable");
  assert.equal(decideHook(event("process.exec"), { ...enforce, policy: policy("warn") }).decision, "warn");
  assert.equal(decideHook(event("process.exec"), { ...enforce, policy: policy("observe") }).decision, "allow");
  assert.equal(decideHook(event("process.exec"), {
    policy: policy("enforce"),
    capabilities: capabilityRegistryFromRuntime({ dispatcherAvailable: true, exposedTools: new Set() }),
  }).reason, "managed_capability_unavailable");
});

test("native process boundary does not inspect executable spellings", () => {
  const capabilities = capabilityRegistryFromRuntime({ dispatcherAvailable: true, exposedTools: new Set(["mottainai_exec"]) });
  const context = deriveTrustedHookContext({ workspaceRoot: workspace() });
  const make = (command: string): HookEvent => ({
    ...event("process.exec"),
    ...(context.repository === undefined ? {} : { repository: context.repository }),
    target: { kind: "command", value: command },
  });
  const first = decideHook(make("cat file"), { policy: policy("enforce"), capabilities });
  const second = decideHook(make("python -c 'open(\"file\").read()'"), { policy: policy("enforce"), capabilities });
  const third = decideHook(make("/bin/node -e readFileSync()"), { policy: policy("enforce"), capabilities });
  assert.equal(first.decision, "redirect");
  assert.equal(second.decision, first.decision);
  assert.equal(third.decision, first.decision);
});

test("event metadata cannot weaken configured mode or failure semantics", async () => {
  const capabilities = createCapabilityRegistry([{ operation: "process.exec", id: "process.exec", replacement: "mottainai_exec", available: true, source: "runtime" }]);
  const malicious: HookEvent = { ...event("process.exec"), metadata: { mode: "observe", failureMode: "open", boundary: "native-process" } };
  assert.equal(decideHook(malicious, { policy: policy("enforce"), capabilities }).decision, "redirect");
  const timedOut = await dispatchHook(malicious, {
    policy: { ...policy("enforce"), timeoutMs: 5 },
    capabilities,
    capabilityResolver: () => new Promise((resolve) => setTimeout(resolve, 30)),
  });
  assert.equal(timedOut.decision, "deny");
  assert.equal(timedOut.reason, "hook_timeout");
});

test("ordinary hook results stay empty while detailed explanation is explicit", async () => {
  const root = workspace();
  const context: HookCommandContext = {
    workspaceRoot: root,
    homeDirectory: root,
    environment: { PATH: "/usr/bin:/bin" },
    dispatcherCommand: "/bin/sh",
    exposedTools: new Set(["mottainai_exec"]),
  };
  fs.mkdirSync(path.join(root, ".mottainai"), { recursive: true });
  fs.writeFileSync(path.join(root, ".mottainai", "hooks.json"), JSON.stringify({
    version: 1, mode: "enforce", operationModes: {}, failureModes: {}, timeoutMs: 1000, maxOutputBytes: 512,
  }));
  const result = await dispatchClientHook("claude", {
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat file" },
  }, context);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.ok(result.decision.decisionId !== undefined);
  const explained = runManagedHooksCommand("explain", [result.decision.decisionId!], context);
  assert.equal(explained.ok, true);
  assert.equal((explained.explanation as { reason: string }).reason, "managed_capability_available");
});

test("Claude and Codex adapters normalize to the same internal operation", () => {
  const root = workspace();
  const context = { workspaceRoot: root, ...deriveTrustedHookContext({ workspaceRoot: root }) };
  const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat file" }, mode: "observe" };
  const claude = claudeAdapter.normalize(payload, context);
  const codex = codexAdapter.normalize(payload, context);
  assert.equal(claude.ok, true);
  assert.equal(codex.ok, true);
  if (claude.ok && codex.ok) {
    assert.equal(claude.event.operation, "process.exec");
    assert.deepEqual(claude.event.metadata, codex.event.metadata);
    assert.equal(claude.event.version, 1);
  }
  const malformed = claudeAdapter.normalize({ tool_name: "Bash" }, context);
  assert.equal(malformed.ok, false);
});

test("client projections use each native hook protocol without duplicating policy", () => {
  const decision: HookDecision = {
    version: 1,
    decision: "redirect",
    reason: "managed_capability_available",
    replacement: "mottainai_exec",
    decisionId: "hd_0123456789abcdef",
  };
  const event = {
    version: 1 as const,
    client: "claude" as const,
    clientEvent: "PreToolUse",
    operation: "process.exec" as const,
  };
  const claude = claudeAdapter.project(decision, event);
  const codex = codexAdapter.project(decision, { ...event, client: "codex" });
  assert.equal(claude.exitCode, 2);
  assert.equal(claude.stdout, "");
  assert.match(claude.stderr, /^DENY managed_capability_available;use=mottainai_exec/u);
  assert.equal(codex.exitCode, 0);
  assert.equal(codex.stderr, "");
  const codexResponse = JSON.parse(codex.stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  assert.equal(codexResponse.hookSpecificOutput.permissionDecision, "deny");
  assert.match(codexResponse.hookSpecificOutput.permissionDecisionReason, /^managed_capability_available;use=mottainai_exec/u);

  const warn = codexAdapter.project({ ...decision, decision: "warn" }, { ...event, client: "codex" });
  assert.equal(warn.exitCode, 0);
  assert.equal(warn.stderr, "");
  assert.equal(JSON.parse(warn.stdout).systemMessage, "managed_capability_available;use=mottainai_exec;id=hd_0123456789abcdef");
});

test("managed entries invoke the shared dispatcher with the selected client", () => {
  assert.equal(
    managedDescriptor(claudeAdapter, "/opt/mottainai").command,
    "/opt/mottainai hooks dispatch --client claude",
  );
  assert.equal(
    managedDescriptor(codexAdapter, "/opt/mottainai").command,
    "/opt/mottainai hooks dispatch --client codex",
  );
});

test("bounded hook serialization respects byte limits including tiny limits", () => {
  const decision: HookDecision = {
    version: 1,
    decision: "deny",
    reason: "hook_error",
    diagnostic: "x".repeat(1_000),
  };
  for (const maximumBytes of [0, 1, 2, 32, 512]) {
    assert.ok(Buffer.byteLength(serializeHookDecision(decision, maximumBytes), "utf8") <= maximumBytes);
    assert.ok(Buffer.byteLength(boundHookText("あ".repeat(100), maximumBytes), "utf8") <= maximumBytes);
  }
});

function fakeClient(bin: string, name: string): void {
  const filePath = path.join(bin, name);
  fs.writeFileSync(filePath, `#!/bin/sh\nprintf '%s\\n' '${name} 1.0.0'\n`);
  fs.chmodSync(filePath, 0o755);
}

function lifecycleContext(root: string, bin: string): HookCommandContext {
  return {
    workspaceRoot: root,
    homeDirectory: path.join(root, "home"),
    environment: { PATH: bin, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home") },
    dispatcherCommand: "/bin/sh",
  };
}

test("install/repair/uninstall preserve unrelated structured hooks and are idempotent", () => {
  const root = workspace();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-client-bin-"));
  fakeClient(bin, "claude");
  fakeClient(bin, "codex");
  const context = lifecycleContext(root, bin);
  const settingsPath = path.join(root, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const unrelated = { type: "command", command: "echo unrelated" };
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Read"] }, hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [unrelated] }],
    SessionStart: [{ hooks: [{ type: "command", command: "echo session" }] }],
  } }, null, 2));

  const installed = runManagedHooksCommand("install", ["--client", "claude", "--mode", "enforce"], context);
  assert.equal(installed.ok, true);
  const once = fs.readFileSync(settingsPath, "utf8");
  const again = runManagedHooksCommand("install", ["--client", "claude"], context);
  assert.equal(again.ok, true);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), once);
  const parsed = JSON.parse(once) as { permissions: unknown; hooks: { PreToolUse: Array<{ hooks: unknown[] }> } };
  assert.deepEqual(parsed.permissions, { allow: ["Read"] });
  assert.equal(parsed.hooks.PreToolUse[0].hooks.length, 1);
  assert.equal(parsed.hooks.PreToolUse.filter((group) => group.hooks.some((hook) => JSON.stringify(hook).includes("mottainai-managed-hook-v1"))).length, 1);
  const status = runManagedHooksCommand("status", [], context);
  assert.equal(status.ok, true);
  const claude = (status.clients as Array<{ client: string; managedEntry: string }>).find((client) => client.client === "claude");
  assert.equal(claude?.managedEntry, "healthy");

  const repaired = runManagedHooksCommand("repair", ["--client", "claude"], context);
  assert.equal(repaired.ok, true);
  const uninstalled = runManagedHooksCommand("uninstall", ["--client", "claude"], context);
  assert.equal(uninstalled.ok, true);
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: { PreToolUse: Array<{ hooks: unknown[] }> } };
  assert.deepEqual(after.hooks.PreToolUse, [{ matcher: "Bash", hooks: [unrelated] }]);
});

test("managed health detects duplicate entries and uninstall preserves non-object hook values", () => {
  const root = workspace();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-client-bin-"));
  fakeClient(bin, "claude");
  const settingsPath = path.join(root, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const context = lifecycleContext(root, bin);
  const command = context.dispatcherCommand!;
  const managed = { type: "command", command, statusMessage: "mottainai-managed-hook-v1" };
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {
    PreToolUse: [
      { matcher: ".*", hooks: ["keep-this-value", managed] },
      { matcher: ".*", hooks: [{ ...managed }] },
    ],
  } }));
  const status = runManagedHooksCommand("status", ["--client", "claude"], context);
  const claude = (status.clients as Array<{ managedEntry: string }>)[0];
  assert.equal(claude.managedEntry, "drifted");
  const uninstalled = runManagedHooksCommand("uninstall", ["--client", "claude"], context);
  assert.equal(uninstalled.ok, true);
  const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: { PreToolUse: Array<{ hooks: unknown[] }> } };
  assert.deepEqual(parsed.hooks.PreToolUse, [{ matcher: ".*", hooks: ["keep-this-value"] }]);
});

test("discovery and doctor distinguish incompatible, unsupported, missing, and unreachable states", () => {
  const root = workspace();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-client-bin-"));
  const claude = path.join(bin, "claude");
  fs.writeFileSync(claude, "#!/bin/sh\nprintf '%s\\n' 'claude 0.0.0'\n");
  fs.chmodSync(claude, 0o755);
  const codexPath = path.join(root, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(codexPath, "[]");
  const context = lifecycleContext(root, bin);
  const report = runManagedHooksCommand("doctor", [], { ...context, dispatcherCommand: "/does/not/exist" });
  assert.equal(report.ok, false);
  const clients = report.clients as Array<{ client: string; state: string }>;
  assert.equal(clients.find((client) => client.client === "claude")?.state, "incompatible");
  assert.equal(clients.find((client) => client.client === "codex")?.state, "unsupported");
  assert.ok((report.problems as string[]).some((problem) => problem.includes("dispatcher")));
});
