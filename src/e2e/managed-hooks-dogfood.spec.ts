import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_READ_GOVERNOR_POLICY } from "../context-runtime/read-policy.js";
import { DEFAULT_HOOK_POLICY } from "../hooks/policy.js";
import { composeHookDecision } from "../hooks/providers/composition.js";
import { createSemanticPolicyProvider } from "../hooks/providers/semantic.js";
import { BUILTIN_PRESETS } from "../workflow/policy/presets.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceEntry = path.join(repoRoot, "src", "index.ts");
const HOOK_MARKER = "mottainai-managed-hook-v1";
const AGENTS_BASELINE_BYTES = Buffer.byteLength(fs.readFileSync(path.join(repoRoot, "AGENTS.md")));

type Client = "claude" | "codex";
type Mode = "observe" | "warn" | "enforce";

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-hooks-dogfood-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "dogfood@example.invalid"]);
  git(root, ["config", "user.name", "Managed Hooks Dogfood"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "tracked\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "dogfood fixture"]);
  fs.mkdirSync(path.join(root, ".mottainai"), { recursive: true });
  writeJson(path.join(root, ".mottainai", "hooks.json"), {
    version: 1,
    mode: "observe",
    operationModes: {},
    failureModes: { ...BUILTIN_HOOK_FAILURE_MODES },
    timeoutMs: 1_000,
    maxOutputBytes: 512,
  });
  writeJson(path.join(root, "mottainai.config.json"), {
    version: 2,
    mcpServers: {},
    gateway: {
      workspaceRoot: ".",
      readGovernor: DEFAULT_READ_GOVERNOR_POLICY,
    },
  });
  return root;
}

const BUILTIN_HOOK_FAILURE_MODES = DEFAULT_HOOK_POLICY.failureModes;

function writeHookPolicy(
  root: string,
  mode: Mode,
  failureModes: Record<string, "open" | "closed"> = BUILTIN_HOOK_FAILURE_MODES,
): void {
  writeJson(path.join(root, ".mottainai", "hooks.json"), {
    version: 1,
    mode,
    operationModes: {},
    failureModes,
    timeoutMs: 1_000,
    maxOutputBytes: 512,
  });
}

function runHook(
  root: string,
  client: Client,
  payload: unknown,
  configPath = path.join(root, "mottainai.config.json"),
): HookRun {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      sourceEntry,
      "hooks",
      "dispatch",
      "--client",
      client,
      "--workspace",
      root,
      "--config",
      configPath,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: root, USERPROFILE: root, MOTTAINAI_TELEMETRY: "0" },
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    elapsedMs: performance.now() - started,
  };
}

function runCli(
  root: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      sourceEntry,
      ...args,
      "--workspace",
      root,
      "--config",
      path.join(root, "mottainai.config.json"),
    ],
    { cwd: repoRoot, env: { ...environment, HOME: root, USERPROFILE: root }, encoding: "utf8", timeout: 10_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function payload(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input };
}

function allOutput(result: HookRun): string {
  return `${result.stdout}${result.stderr}`;
}

function assertDecision(result: HookRun, client: Client, reason: string, expected: "allow" | "warn" | "block"): void {
  const output = allOutput(result);
  assert.equal(result.status, expected === "block" && client === "claude" ? 2 : 0, output);
  if (expected === "allow") assert.equal(output, "");
  if (expected !== "allow") assert.match(output, new RegExp(reason));
  assert.ok(Buffer.byteLength(output, "utf8") <= 512, `${client} response exceeded bound: ${output}`);
}

function fakeClient(bin: string, client: Client, version = "1.0.0"): void {
  const filePath = path.join(bin, client);
  fs.writeFileSync(filePath, `#!/bin/sh\nprintf '%s\\n' '${client} ${version}'\n`);
  fs.chmodSync(filePath, 0o755);
}

function strictWorkflow(): unknown {
  return {
    ...BUILTIN_PRESETS.standard,
    protectedBranchRule: BUILTIN_PRESETS["strict-worktree"].protectedBranchRule,
  };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);
}

test("dogfood observes, warns, then enforces one decision path for both clients", (t) => {
  const root = createWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const latencies: number[] = [];
  const counts = { allow: 0, warn: 0, redirect: 0 };
  let hookVisibleBytes = 0;

  for (const mode of ["observe", "warn", "enforce"] as const) {
    writeHookPolicy(root, mode);
    for (const client of ["claude", "codex"] as const) {
      const result = runHook(root, client, payload("Bash", { command: "python -c 'open(\"tracked.txt\").read()'" }));
      latencies.push(result.elapsedMs);
      hookVisibleBytes += Buffer.byteLength(allOutput(result), "utf8");
      if (mode === "observe") {
        assertDecision(result, client, "", "allow");
        counts.allow += 1;
      } else if (mode === "warn") {
        assertDecision(result, client, "managed_capability_available", "warn");
        counts.warn += 1;
      } else {
        assertDecision(result, client, "managed_capability_available", "block");
        counts.redirect += 1;
      }
    }
  }

  // The sample includes a fresh Node/tsx process for the black-box boundary;
  // the dispatcher itself remains bounded by hooks.json timeoutMs.
  assert.ok(latencies.every((value) => Number.isFinite(value) && value < 10_000));
  const guidanceBytes = Buffer.byteLength(fs.readFileSync(path.join(repoRoot, "AGENTS.md")));
  assert.equal(AGENTS_BASELINE_BYTES - guidanceBytes, 0);
  console.log(
    `[managed-hooks-dogfood] mode counts=${JSON.stringify(counts)} hook_visible_bytes=${hookVisibleBytes} hook_visible_tokens_est=${Math.ceil(hookVisibleBytes / 4)} guidance_bytes={before:${AGENTS_BASELINE_BYTES},after:${guidanceBytes},removed:${AGENTS_BASELINE_BYTES - guidanceBytes}} latency_ms={p50:${percentile(latencies, 0.5)},p95:${percentile(latencies, 0.95)},max:${Math.round(Math.max(...latencies))}}`,
  );
});

test("dogfood catches interpreter, search, Git, and broad-read bypass variants", (t) => {
  const root = createWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeHookPolicy(root, "enforce");
  writeJson(path.join(root, ".mottainai", "workflow.json"), strictWorkflow());

  const nativeVariants = [
    "cat tracked.txt",
    "/bin/cat tracked.txt",
    "python -c 'open(\"tracked.txt\").read()'",
    'node -e \'require("fs").readFileSync("tracked.txt")\'',
    "rg tracked.txt .",
    "future-native-executor tracked.txt",
  ];
  const bypassCounts = { allow: 0, warn: 0, deny: 0, redirect: 0 };
  for (const client of ["claude", "codex"] as const) {
    for (const command of nativeVariants) {
      const result = runHook(root, client, payload("Bash", { command }));
      assertDecision(result, client, "managed_capability_available", "block");
      bypassCounts.redirect += 1;
    }

    for (const command of ["git commit -am bypass", "env GIT_OPTIONAL_LOCKS=0 git push origin HEAD:main"]) {
      const result = runHook(root, client, payload("Bash", { command }));
      assertDecision(result, client, "workflow_protected_branch", "block");
      bypassCounts.deny += 1;
    }
  }

  fs.writeFileSync(path.join(root, "large.ts"), `${"const line = 1;\n".repeat(60)}`);
  writeHookPolicy(root, "observe");
  writeJson(path.join(root, "mottainai.config.json"), {
    version: 2,
    mcpServers: {},
    gateway: {
      workspaceRoot: ".",
      readGovernor: {
        ...DEFAULT_READ_GOVERNOR_POLICY,
        mode: "enforce",
        preferAuto: false,
        maxRawLines: 10,
        maxRawBytes: 256,
        allowWholeFileBelowLines: 2,
      },
    },
  });
  for (const client of ["claude", "codex"] as const) {
    const broad = runHook(root, client, payload("Read", { file_path: "large.ts", mode: "raw" }));
    assertDecision(broad, client, "context_read_governor", "block");
    assert.match(allOutput(broad), /mottainai_read/u);
    bypassCounts.deny += 1;

    const bounded = runHook(
      root,
      client,
      payload("Read", { file_path: "large.ts", mode: "raw", startLine: 1, endLine: 2 }),
    );
    assertDecision(bounded, client, "", "allow");
    bypassCounts.allow += 1;
  }
  console.log(
    `[managed-hooks-dogfood] bypass decision counts=${JSON.stringify(bypassCounts)} caught=${bypassCounts.deny + bypassCounts.redirect} missed=0`,
  );
});

test("dogfood doctor and lifecycle preserve unrelated hooks across missing, drift, duplicate, and repair states", (t) => {
  const root = createWorkspace();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-hooks-client-bin-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  writeJson(path.join(root, ".claude", "settings.json"), {
    permissions: { allow: ["Read"] },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo unrelated" }] }] },
  });
  writeJson(path.join(root, ".codex", "hooks.json"), {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo unrelated-codex" }] }] },
  });
  fakeClient(bin, "claude");
  fakeClient(bin, "codex");
  const environment = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };

  const installed = runCli(root, ["hooks", "install", "--client", "all", "--mode", "enforce"], environment);
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  const firstClaude = fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8");
  const firstCodex = fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8");

  const duplicate = runCli(root, ["hooks", "install", "--client", "all"], environment);
  assert.equal(duplicate.status, 0, `${duplicate.stdout}${duplicate.stderr}`);
  assert.equal(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"), firstClaude);
  assert.equal(fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"), firstCodex);

  const claudePath = path.join(root, ".claude", "settings.json");
  const drifted = JSON.parse(firstClaude) as {
    hooks: { PreToolUse: Array<{ hooks: Array<Record<string, unknown>> }> };
  };
  const managed = drifted.hooks.PreToolUse.flatMap((group) => group.hooks).find(
    (hook) => hook.statusMessage === HOOK_MARKER,
  );
  assert.ok(managed);
  managed!.command = "mottainai hooks dispatch --client claude --drifted";
  writeJson(claudePath, drifted);
  const doctor = runCli(root, ["hooks", "doctor"], environment);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /managed entry drifted/u);

  const repaired = runCli(root, ["hooks", "repair", "--client", "claude"], environment);
  assert.equal(repaired.status, 0, `${repaired.stdout}${repaired.stderr}`);
  const healthy = runCli(root, ["hooks", "status"], environment);
  assert.equal(healthy.status, 0, `${healthy.stdout}${healthy.stderr}`);
  assert.match(healthy.stdout, /"managedEntry": "healthy"/u);

  const uninstalled = runCli(root, ["hooks", "uninstall", "--client", "all"], environment);
  assert.equal(uninstalled.status, 0, `${uninstalled.stdout}${uninstalled.stderr}`);
  const remainingClaude = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8")) as {
    permissions: { allow: string[] };
    hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
  };
  assert.deepEqual(remainingClaude.permissions, { allow: ["Read"] });
  assert.equal(remainingClaude.hooks.SessionStart[0]?.hooks[0]?.command, "echo unrelated");
  const remainingCodex = JSON.parse(fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8")) as {
    hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
  };
  assert.equal(remainingCodex.hooks.SessionStart[0]?.hooks[0]?.command, "echo unrelated-codex");
  const missing = runCli(root, ["hooks", "doctor"], environment);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /managed entry missing/u);
});

test("dogfood records unavailable replacement and semantic freshness instead of fabricating enforcement", async (t) => {
  const root = createWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeHookPolicy(root, "enforce", { ...BUILTIN_HOOK_FAILURE_MODES, "process.exec": "open" });
  fs.rmSync(path.join(root, "mottainai.config.json"));
  const unavailable = runHook(root, "codex", payload("Bash", { command: "cat tracked.txt" }));
  assert.equal(unavailable.status, 0);
  assert.equal(allOutput(unavailable), "");

  const semantic = createSemanticPolicyProvider();
  const semanticResult = await semantic.evaluate({
    version: 1,
    client: "claude",
    clientEvent: "PreToolUse",
    operation: "source.write",
  });
  assert.equal(semanticResult.state, "unavailable");
  assert.equal(semanticResult.reason, "semantic_authority_unavailable");

  const stale = composeHookDecision({ version: 1, decision: "allow", reason: "observe_only" }, [
    {
      provider: "semantic",
      state: "stale",
      reason: "semantic_stale",
      rule: "repository-semantics.fresh-pre-operation",
    },
  ]);
  assert.equal(stale.decision.provider, "semantic");
  assert.equal(stale.decision.providerState, "stale");
  assert.equal(stale.decision.decision, "allow");
  assert.doesNotMatch(allOutput(unavailable), /use=/u);
});
