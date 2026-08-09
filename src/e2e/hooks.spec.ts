import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceEntry = path.join(repoRoot, "src", "index.ts");

function runHook(workspace: string, client: "claude" | "codex", payload: unknown) {
  return spawnSync(process.execPath, ["--import", "tsx", sourceEntry, "hooks", "dispatch", "--client", client, "--workspace", workspace], {
    cwd: repoRoot,
    env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
  });
}

function writeFakeClient(bin: string, client: "claude" | "codex"): void {
  const filePath = path.join(bin, client);
  fs.writeFileSync(filePath, `#!/bin/sh\nprintf '%s\\n' '${client} 1.0.0'\n`);
  fs.chmodSync(filePath, 0o755);
}

test("black-box Claude and Codex hook commands enforce the same process boundary", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-hooks-e2e-"));
  fs.mkdirSync(path.join(workspace, ".git"));
  fs.mkdirSync(path.join(workspace, ".mottainai"));
  // A valid gateway configuration is part of the capability contract. The
  // hook must not claim a replacement merely because the source tool exists.
  fs.writeFileSync(path.join(workspace, "mottainai.config.json"), JSON.stringify({ version: 2, mcpServers: {} }));
  fs.writeFileSync(path.join(workspace, ".mottainai", "hooks.json"), JSON.stringify({
    version: 1,
    mode: "enforce",
    operationModes: {},
    failureModes: { other: "open" },
    timeoutMs: 1000,
    maxOutputBytes: 512,
  }));
  const payloads = ["cat file", "python -c 'open(\"file\").read()'", "/bin/node -e readFileSync()"];
  for (const client of ["claude", "codex"] as const) {
    for (const command of payloads) {
      const result = runHook(workspace, client, {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      });
      assert.equal(result.status, client === "claude" ? 2 : 0, `${client} ${command}: ${result.stderr}`);
      assert.equal(result.error, undefined);
      assert.match(`${result.stdout}${result.stderr}`, /managed_capability_available/);
      assert.ok(Buffer.byteLength(`${result.stdout}${result.stderr}`, "utf8") <= 512);
    }
  }
});

test("black-box dispatch does not claim a replacement when the gateway is unavailable", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-hooks-unavailable-"));
  fs.mkdirSync(path.join(workspace, ".git"));
  fs.mkdirSync(path.join(workspace, ".mottainai"));
  fs.writeFileSync(path.join(workspace, ".mottainai", "hooks.json"), JSON.stringify({
    version: 1,
    mode: "enforce",
    operationModes: {},
    failureModes: { other: "open" },
    timeoutMs: 1000,
    maxOutputBytes: 512,
  }));
  const result = runHook(workspace, "codex", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "python -c 'open(\"file\").read()'" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("black-box installed client configuration reaches the shared dispatcher", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-hooks-installed-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-hooks-client-bin-"));
  fs.mkdirSync(path.join(workspace, ".git"));
  fs.mkdirSync(path.join(workspace, ".mottainai"));
  // The generated development dispatcher uses `node --import tsx`; make that
  // package resolvable from the hook's real cwd, just as an installed project
  // would resolve its production `.js` entry point without this fixture aid.
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(workspace, "node_modules"), "junction");
  fs.writeFileSync(path.join(workspace, "mottainai.config.json"), JSON.stringify({ version: 2, mcpServers: {} }));
  fs.writeFileSync(path.join(workspace, ".mottainai", "hooks.json"), JSON.stringify({
    version: 1,
    mode: "enforce",
    operationModes: {},
    failureModes: {},
    timeoutMs: 1000,
    maxOutputBytes: 512,
  }));
  writeFakeClient(bin, "claude");
  writeFakeClient(bin, "codex");
  const environment = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: workspace, USERPROFILE: workspace };
  const installed = spawnSync(
    process.execPath,
    ["--import", "tsx", sourceEntry, "hooks", "install", "--client", "all", "--workspace", workspace],
    { cwd: repoRoot, env: environment, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);

  for (const client of ["claude", "codex"] as const) {
    const configPath = path.join(workspace, client === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command?: string; statusMessage?: string }> }> };
    };
    const managed = config.hooks.PreToolUse.flatMap((group) => group.hooks)
      .find((hook) => hook.statusMessage === "mottainai-managed-hook-v1");
    assert.ok(managed?.command, `${client} managed command missing`);
    const dispatched = spawnSync("/bin/sh", ["-c", managed!.command!], {
      cwd: workspace,
      env: environment,
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat file" } }),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(dispatched.status, client === "claude" ? 2 : 0, `${client}: ${dispatched.stdout}${dispatched.stderr}`);
    assert.match(`${dispatched.stdout}${dispatched.stderr}`, /managed_capability_available/u);
  }
});
