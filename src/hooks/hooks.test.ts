import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { claudeAdapter, codexAdapter } from "./adapters/index.js";
import { deriveTrustedHookContext } from "./context.js";
import {
  MANAGED_CAPABILITY_REGISTRATION_ID,
  MANAGED_CAPABILITY_REGISTRATION_MARKER,
  MANAGED_MCP_EXEC_TOOL_NAME,
  capabilityRegistryFromRuntime,
  createCapabilityRegistry,
} from "./capabilities.js";
import { verifyManagedCapabilityRegistration } from "./managed-registration.js";
import { decideHook, dispatchHook } from "./dispatcher.js";
import { dispatchClientHook, runManagedHooksCommand } from "./commands.js";
import { recordHookExplanation } from "./explain.js";
import { managedDescriptor } from "./install/lifecycle.js";
import { JsonHookConfigChangedError, readJsonHookConfigSnapshot, writeJsonHookConfig } from "./install/json-hooks.js";
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
  const capabilities = capabilityRegistryFromRuntime({
    dispatcherAvailable: true,
    exposedTools: new Set(["mottainai_exec"]),
  });
  const enforce = { policy: policy("enforce"), capabilities };
  assert.equal(decideHook(event("process.exec"), enforce).decision, "redirect");
  assert.equal(decideHook(event("source.write"), enforce).decision, "redirect");
  assert.equal(decideHook(event("source.write"), enforce).replacement, "mottainai_exec");
  assert.equal(decideHook(event("git.mutate"), enforce).decision, "redirect");
  assert.equal(decideHook(event("git.mutate"), enforce).replacement, "mottainai_exec");
  assert.equal(decideHook(event("process.exec"), { ...enforce, policy: policy("warn") }).decision, "warn");
  assert.equal(decideHook(event("process.exec"), { ...enforce, policy: policy("observe") }).decision, "allow");
  const unavailable = decideHook(event("source.write"), {
    policy: policy("enforce"),
    capabilities: capabilityRegistryFromRuntime({ dispatcherAvailable: true, exposedTools: new Set() }),
  });
  assert.equal(unavailable.decision, "deny");
  assert.equal(unavailable.reason, "managed_capability_unavailable");
  assert.equal(unavailable.diagnostic, "failure_mode=closed");
  const unavailableGit = decideHook(event("git.mutate"), {
    policy: policy("enforce"),
    capabilities: capabilityRegistryFromRuntime({ dispatcherAvailable: true, exposedTools: new Set() }),
  });
  assert.equal(unavailableGit.decision, "deny");
  assert.equal(unavailableGit.reason, "managed_capability_unavailable");
  const failOpen = decideHook(event("process.exec"), {
    policy: { ...policy("enforce"), failureModes: { ...policy("enforce").failureModes, "process.exec": "open" } },
    capabilities: capabilityRegistryFromRuntime({ dispatcherAvailable: true, exposedTools: new Set() }),
  });
  assert.equal(failOpen.decision, "allow");
  assert.equal(failOpen.diagnostic, "failure_mode=open");
});

test("unknown native tools stay on the governed process boundary with bounded diagnostics", () => {
  const root = workspace();
  const context = { workspaceRoot: root, ...deriveTrustedHookContext({ workspaceRoot: root }) };
  for (const tool of ["future_native_executor", "mcp__server__shell", "unmapped_".repeat(20)]) {
    const normalized = claudeAdapter.normalize(
      {
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: { command: "python -c 'write()'" },
      },
      context,
    );
    assert.equal(normalized.ok, true);
    if (normalized.ok) {
      assert.equal(normalized.event.operation, "process.exec");
      const diagnosticTool = normalized.event.metadata?.tool;
      assert.equal(typeof diagnosticTool, "string");
      if (typeof diagnosticTool === "string") assert.equal(diagnosticTool.length <= 80, true);
      assert.equal(
        decideHook(normalized.event, {
          policy: policy("enforce"),
          capabilities: capabilityRegistryFromRuntime({
            dispatcherAvailable: true,
            exposedTools: new Set(["mottainai_exec"]),
          }),
        }).decision,
        "redirect",
      );
    }
  }
});

test("native process boundary does not inspect executable spellings", () => {
  const capabilities = capabilityRegistryFromRuntime({
    dispatcherAvailable: true,
    exposedTools: new Set(["mottainai_exec"]),
  });
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

test("the registered Mottainai exec MCP path is allowed without weakening unknown-tool enforcement", () => {
  const root = workspace();
  const configPath = path.join(root, "mottainai.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ version: 2, mcpServers: {} }));
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        mottainai: {
          command: "/bin/sh",
          cwd: root,
          env: {
            MOTTAINAI_CONFIG: configPath,
            MOTTAINAI_MANAGED_CAPABILITY: MANAGED_CAPABILITY_REGISTRATION_MARKER,
          },
        },
      },
    }),
  );
  const managedCapability = verifyManagedCapabilityRegistration({
    workspaceRoot: root,
    homeDirectory: root,
    configPath,
    dispatcherCommand: "/bin/sh",
  });
  assert.deepEqual(managedCapability, {
    client: "claude",
    registrationId: MANAGED_CAPABILITY_REGISTRATION_ID,
    capabilityId: "process.exec",
    toolName: MANAGED_MCP_EXEC_TOOL_NAME,
  });
  const context = {
    workspaceRoot: root,
    ...deriveTrustedHookContext({ workspaceRoot: root }),
    managedCapability,
  };
  const managed = claudeAdapter.normalize(
    {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__mottainai__mottainai_exec",
      tool_input: { command: "printf managed-hooks-real-client" },
    },
    context,
  );
  assert.equal(managed.ok, true);
  if (managed.ok) {
    assert.equal(managed.event.operation, "process.exec");
    assert.equal(managed.event.metadata?.boundary, "managed-capability");
    assert.equal(
      decideHook(managed.event, {
        policy: policy("enforce"),
        capabilities: capabilityRegistryFromRuntime({
          dispatcherAvailable: true,
          exposedTools: new Set(["mottainai_exec"]),
          managedCapability,
        }),
      }).reason,
      "managed_capability_path",
    );
    const unavailable = decideHook(managed.event, {
      policy: policy("enforce"),
      capabilities: capabilityRegistryFromRuntime({ dispatcherAvailable: false, exposedTools: new Set() }),
    });
    assert.equal(unavailable.decision, "deny");
    assert.equal(unavailable.reason, "managed_capability_unavailable");
    assert.equal(unavailable.diagnostic, "failure_mode=closed");
  }

  const foreignClient = codexAdapter.normalize(
    {
      hook_event_name: "PreToolUse",
      tool_name: MANAGED_MCP_EXEC_TOOL_NAME,
      tool_input: { command: "printf spoofed-client" },
    },
    context,
  );
  assert.equal(foreignClient.ok, true);
  if (foreignClient.ok) {
    assert.equal(foreignClient.event.metadata?.boundary, "native-process");
    assert.equal(
      decideHook(foreignClient.event, {
        policy: policy("enforce"),
        capabilities: capabilityRegistryFromRuntime({
          dispatcherAvailable: true,
          exposedTools: new Set(["mottainai_exec"]),
          managedCapability,
        }),
      }).decision,
      "redirect",
    );
  }

  const unknown = claudeAdapter.normalize(
    {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__other__exec",
      tool_input: { command: "printf bypass" },
    },
    context,
  );
  assert.equal(unknown.ok, true);
  if (unknown.ok) {
    assert.equal(unknown.event.operation, "process.exec");
    assert.equal(unknown.event.metadata?.boundary, "native-process");
    assert.equal(
      decideHook(unknown.event, {
        policy: policy("enforce"),
        capabilities: capabilityRegistryFromRuntime({
          dispatcherAvailable: true,
          exposedTools: new Set(["mottainai_exec"]),
        }),
      }).decision,
      "redirect",
    );
  }

  for (const tool of [MANAGED_MCP_EXEC_TOOL_NAME, "mottainai_exec"]) {
    const foreign = claudeAdapter.normalize(
      {
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: { command: "printf spoofed" },
      },
      { workspaceRoot: root, ...deriveTrustedHookContext({ workspaceRoot: root }) },
    );
    assert.equal(foreign.ok, true);
    if (foreign.ok) {
      assert.equal(foreign.event.metadata?.boundary, "native-process");
      assert.equal(
        decideHook(foreign.event, {
          policy: policy("enforce"),
          capabilities: capabilityRegistryFromRuntime({
            dispatcherAvailable: true,
            exposedTools: new Set(["mottainai_exec"]),
          }),
        }).decision,
        "redirect",
      );
    }
  }

  const forgedMetadata: HookEvent = {
    ...event("process.exec"),
    metadata: {
      tool: MANAGED_MCP_EXEC_TOOL_NAME,
      boundary: "managed-capability",
      managedPath: true,
      managedRegistrationId: MANAGED_CAPABILITY_REGISTRATION_ID,
      managedCapabilityId: "process.exec",
    },
  };
  assert.equal(
    decideHook(forgedMetadata, {
      policy: policy("enforce"),
      capabilities: capabilityRegistryFromRuntime({
        dispatcherAvailable: true,
        exposedTools: new Set(["mottainai_exec"]),
      }),
    }).decision,
    "redirect",
  );
});

test("a same-named foreign registration cannot produce a verified managed identity", () => {
  const root = workspace();
  const configPath = path.join(root, "mottainai.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ version: 2, mcpServers: {} }));
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        mottainai: {
          command: "/bin/false",
          env: {
            MOTTAINAI_CONFIG: configPath,
            MOTTAINAI_MANAGED_CAPABILITY: MANAGED_CAPABILITY_REGISTRATION_MARKER,
          },
        },
      },
    }),
  );
  assert.equal(
    verifyManagedCapabilityRegistration({
      workspaceRoot: root,
      homeDirectory: root,
      configPath,
      dispatcherCommand: "/bin/sh",
    }),
    undefined,
  );
});

test("event metadata cannot weaken configured mode or failure semantics", async () => {
  const capabilities = createCapabilityRegistry([
    {
      operation: "process.exec",
      id: "process.exec",
      replacement: "mottainai_exec",
      available: true,
      source: "runtime",
    },
  ]);
  const malicious: HookEvent = {
    ...event("process.exec"),
    metadata: { mode: "observe", failureMode: "open", boundary: "native-process" },
  };
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
  fs.writeFileSync(
    path.join(root, ".mottainai", "hooks.json"),
    JSON.stringify({
      version: 1,
      mode: "enforce",
      operationModes: {},
      failureModes: {},
      timeoutMs: 1000,
      maxOutputBytes: 512,
    }),
  );
  const result = await dispatchClientHook(
    "claude",
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat file" },
    },
    context,
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.ok(result.decision.decisionId !== undefined);
  const explained = runManagedHooksCommand("explain", [result.decision.decisionId!], context);
  assert.equal(explained.ok, true);
  assert.equal((explained.explanation as { reason: string }).reason, "managed_capability_available");
});

test("invalid policy uses default operation failure modes and repair restores it", async () => {
  const root = workspace();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-client-bin-"));
  fakeClient(bin, "claude");
  const context: HookCommandContext = {
    ...lifecycleContext(root, bin),
    exposedTools: new Set(["mottainai_exec"]),
  };
  const policyPath = path.join(root, ".mottainai", "hooks.json");
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, "{ invalid policy");

  const read = await dispatchClientHook(
    "claude",
    {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "file.txt" },
    },
    context,
  );
  assert.equal(read.event?.operation, "source.read");
  assert.equal(read.decision.decision, "allow");
  assert.equal(read.decision.reason, "policy_invalid");
  assert.equal(read.decision.diagnostic, "failure_mode=open");

  const write = await dispatchClientHook(
    "claude",
    {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "file.txt" },
    },
    context,
  );
  assert.equal(write.event?.operation, "source.write");
  assert.equal(write.decision.decision, "deny");
  assert.equal(write.decision.diagnostic, "failure_mode=closed");

  const repaired = runManagedHooksCommand("repair", ["--client", "claude"], context);
  assert.equal(repaired.ok, true);
  const loaded = loadHookPolicy(root);
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.policy.mode, "observe");
    assert.equal(loaded.policy.failureModes["source.read"], "open");
    assert.equal(loaded.policy.failureModes["source.write"], "closed");
    assert.equal(loaded.policy.failureModes["process.exec"], "closed");
    assert.equal(loaded.policy.failureModes["git.mutate"], "closed");
  }
});

test("Claude and Codex adapters normalize to the same internal operation", () => {
  const root = workspace();
  const context = { workspaceRoot: root, ...deriveTrustedHookContext({ workspaceRoot: root }) };
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat file" },
    mode: "observe",
  };
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
  assert.match(
    codexResponse.hookSpecificOutput.permissionDecisionReason,
    /^managed_capability_available;use=mottainai_exec/u,
  );

  const warn = codexAdapter.project({ ...decision, decision: "warn" }, { ...event, client: "codex" });
  assert.equal(warn.exitCode, 0);
  assert.equal(warn.stderr, "");
  assert.equal(
    JSON.parse(warn.stdout).systemMessage,
    "managed_capability_available;use=mottainai_exec;id=hd_0123456789abcdef",
  );
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
  assert.equal(
    managedDescriptor(claudeAdapter, "/opt/mottainai", undefined, [
      "--workspace",
      "/repo with space",
      "--config",
      "/tmp/client.json",
    ]).command,
    "/opt/mottainai hooks dispatch --client claude --workspace '/repo with space' --config /tmp/client.json",
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

function explanationProcess(moduleUrl: string, root: string, decisionId: string): Promise<void> {
  const source = `
    import(${JSON.stringify(moduleUrl)}).then(({ recordHookExplanation }) => {
      recordHookExplanation(${JSON.stringify(root)}, {
        version: 1,
        client: "claude",
        clientEvent: "PreToolUse",
        operation: "process.exec",
        repository: { root: "/repo", identity: "worker" },
      }, {
        version: 1,
        decision: "deny",
        reason: "managed_capability_unavailable",
        decisionId: ${JSON.stringify(decisionId)},
      }, {
        version: 1,
        mode: "enforce",
        operationModes: {},
        failureModes: {
          "source.read": "open",
          "source.search": "open",
          "source.write": "closed",
          "process.exec": "closed",
          "git.mutate": "closed",
          other: "open",
        },
        timeoutMs: 1000,
        maxOutputBytes: 512,
      }, { resolve: () => undefined, all: () => [] });
    }).catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`explanation process failed: ${code ?? signal}`));
    });
  });
}

test("concurrent explanation writers retain complete records", async () => {
  const root = workspace();
  const firstId = "hd_1111111111111111";
  recordHookExplanation(
    root,
    event("process.exec"),
    {
      version: 1,
      decision: "deny",
      reason: "managed_capability_unavailable",
      decisionId: firstId,
    },
    policy("enforce"),
    createCapabilityRegistry([]),
  );
  const ids = Array.from({ length: 12 }, (_, index) => `hd_${(index + 2).toString(16).padStart(16, "0")}`);
  const moduleUrl = pathToFileURL(path.resolve("src/hooks/explain.ts")).href;
  await Promise.all(ids.map((decisionId) => explanationProcess(moduleUrl, root, decisionId)));

  const lines = fs
    .readFileSync(path.join(root, ".mottainai", "hook-explanations.jsonl"), "utf8")
    .trimEnd()
    .split(/\r?\n/u);
  assert.equal(lines.length, ids.length + 1);
  const recorded = new Set(lines.map((line) => (JSON.parse(line) as { decisionId: string }).decisionId));
  assert.deepEqual(recorded, new Set([firstId, ...ids]));
});

test("install/repair/uninstall preserve unrelated structured hooks and are idempotent", () => {
  const root = workspace();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-client-bin-"));
  fakeClient(bin, "claude");
  fakeClient(bin, "codex");
  const context = lifecycleContext(root, bin);
  const settingsPath = path.join(root, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const unrelated = { type: "command", command: "echo unrelated" };
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        permissions: { allow: ["Read"] },
        hooks: {
          PreToolUse: ["keep-event-value", { matcher: "Bash", hooks: [unrelated] }],
          SessionStart: [{ hooks: [{ type: "command", command: "echo session" }] }],
        },
      },
      null,
      2,
    ),
  );

  const installed = runManagedHooksCommand("install", ["--client", "claude", "--mode", "enforce"], context);
  assert.equal(installed.ok, true);
  const once = fs.readFileSync(settingsPath, "utf8");
  const again = runManagedHooksCommand("install", ["--client", "claude"], context);
  assert.equal(again.ok, true);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), once);
  const parsed = JSON.parse(once) as { permissions: unknown; hooks: { PreToolUse: unknown[] } };
  assert.deepEqual(parsed.permissions, { allow: ["Read"] });
  assert.equal(parsed.hooks.PreToolUse[0], "keep-event-value");
  assert.equal((parsed.hooks.PreToolUse[1] as { hooks: unknown[] }).hooks.length, 1);
  assert.equal(
    parsed.hooks.PreToolUse.filter(
      (group) =>
        typeof group === "object" &&
        group !== null &&
        "hooks" in group &&
        Array.isArray((group as { hooks?: unknown }).hooks) &&
        (group as { hooks: unknown[] }).hooks.some((hook) =>
          JSON.stringify(hook).includes("mottainai-managed-hook-v1"),
        ),
    ).length,
    1,
  );
  const status = runManagedHooksCommand("status", [], context);
  assert.equal(status.ok, true);
  const claude = (status.clients as Array<{ client: string; managedEntry: string }>).find(
    (client) => client.client === "claude",
  );
  assert.equal(claude?.managedEntry, "healthy");

  const repaired = runManagedHooksCommand("repair", ["--client", "claude"], context);
  assert.equal(repaired.ok, true);
  const uninstalled = runManagedHooksCommand("uninstall", ["--client", "claude"], context);
  assert.equal(uninstalled.ok, true);
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: { PreToolUse: unknown[] } };
  assert.deepEqual(after.hooks.PreToolUse, ["keep-event-value", { matcher: "Bash", hooks: [unrelated] }]);
});

test("lifecycle writes reject a stale client-config revision instead of losing external changes", () => {
  const root = workspace();
  const settingsPath = path.join(root, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Read"] } }));
  const snapshot = readJsonHookConfigSnapshot(settingsPath);
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Read", "Write"] }, external: true }));

  assert.throws(
    () => writeJsonHookConfig(settingsPath, { overwritten: true }, snapshot.revision),
    (error: unknown) => error instanceof JsonHookConfigChangedError,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {
    permissions: { allow: ["Read", "Write"] },
    external: true,
  });
});

test("install refuses to create a hook that cannot reach the configured dispatcher", () => {
  const root = workspace();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-client-bin-"));
  fakeClient(bin, "claude");
  const context = { ...lifecycleContext(root, bin), dispatcherCommand: "/does/not/exist" };
  const result = runManagedHooksCommand("install", ["--client", "claude"], context);
  assert.equal(result.ok, false);
  const claude = (result.clients as Array<{ error?: string; managedEntry: string }>)[0];
  assert.equal(claude.managedEntry, "missing");
  assert.equal(claude.error, "dispatcher command is not resolvable");
  assert.equal(fs.existsSync(path.join(root, ".claude", "settings.json")), false);
});

test("install rejects non-executable client and dispatcher candidates", () => {
  const root = workspace();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-client-bin-"));
  const client = path.join(bin, "claude");
  fs.writeFileSync(client, "#!/bin/sh\nprintf '%s\\n' 'claude 1.0.0'\n");
  fs.chmodSync(client, 0o644);
  const context = lifecycleContext(root, bin);
  const missingClient = runManagedHooksCommand("install", ["--client", "claude"], context);
  assert.equal(missingClient.ok, false);
  const missingReport = (missingClient.clients as Array<{ state: string; error?: string }>)[0];
  assert.equal(missingReport.state, "not-installed");
  assert.equal(missingReport.error, "client executable not found");

  fs.chmodSync(client, 0o755);
  const dispatcher = path.join(root, "dispatcher");
  fs.writeFileSync(dispatcher, "#!/bin/sh\n");
  fs.chmodSync(dispatcher, 0o644);
  const missingDispatcher = runManagedHooksCommand("install", ["--client", "claude"], {
    ...context,
    dispatcherCommand: dispatcher,
  });
  assert.equal(missingDispatcher.ok, false);
  assert.equal(
    (missingDispatcher.clients as Array<{ error?: string }>)[0].error,
    "dispatcher command is not resolvable",
  );
});

test("install fails for an unavailable client while uninstall removes stale managed entries", () => {
  const root = workspace();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-client-bin-"));
  const context = lifecycleContext(root, bin);
  const settingsPath = path.join(root, ".claude", "settings.json");
  const descriptor = managedDescriptor(claudeAdapter, context.dispatcherCommand!);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        [descriptor.eventName]: [
          {
            matcher: descriptor.matcher,
            hooks: [
              {
                type: "command",
                command: descriptor.command,
                statusMessage: descriptor.marker,
              },
            ],
          },
        ],
      },
    }),
  );

  const installed = runManagedHooksCommand("install", ["--client", "claude"], context);
  assert.equal(installed.ok, false);
  assert.equal((installed.clients as Array<{ error?: string }>)[0].error, "client executable not found");
  assert.match(fs.readFileSync(settingsPath, "utf8"), /mottainai-managed-hook-v1/u);

  const uninstalled = runManagedHooksCommand("uninstall", ["--client", "claude"], context);
  assert.equal(uninstalled.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {});
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
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: ".*", hooks: ["keep-this-value", managed] },
          { matcher: ".*", hooks: [{ ...managed }] },
        ],
      },
    }),
  );
  const status = runManagedHooksCommand("status", ["--client", "claude"], context);
  const claude = (status.clients as Array<{ managedEntry: string }>)[0];
  assert.equal(claude.managedEntry, "drifted");
  assert.equal(status.ok, false);
  const repaired = runManagedHooksCommand("repair", ["--client", "claude"], context);
  assert.equal(repaired.ok, true);
  assert.equal((repaired.clients as Array<{ managedEntry: string }>)[0].managedEntry, "healthy");
  const uninstalled = runManagedHooksCommand("uninstall", ["--client", "claude"], context);
  assert.equal(uninstalled.ok, true);
  const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ hooks: unknown[] }> };
  };
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
