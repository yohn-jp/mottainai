import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BUILTIN_PRESETS } from "./workflow/policy/presets.js";

const entryPoint = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

test("early public CLI failure includes bounded runtime identity without stdout output", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-runtime-"));
  const configPath = path.join(workspace, "missing.json");
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", entryPoint], {
      cwd: path.resolve(path.dirname(entryPoint), ".."),
      env: { ...process.env, HOME: workspace, USERPROFILE: workspace, MOTTAINAI_CONFIG: configPath },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Mottainai configuration was not found/);
    assert.match(result.stderr, /Runtime diagnostic:/);
    assert.match(result.stderr, /package: mottainai@/);
    assert.match(result.stderr, /distribution: development\/source/);
    assert.match(result.stderr, /config_path: .*missing\.json/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("hooks repair restores an invalid policy through the public CLI", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-hooks-repair-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-hooks-bin-"));
  const client = path.join(bin, "claude");
  try {
    fs.mkdirSync(path.join(workspace, ".git"));
    fs.mkdirSync(path.join(workspace, ".mottainai"));
    fs.writeFileSync(path.join(workspace, ".mottainai", "hooks.json"), "{ invalid policy");
    fs.writeFileSync(client, "#!/bin/sh\nprintf '%s\\n' 'claude 1.0.0'\n");
    fs.chmodSync(client, 0o755);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entryPoint, "hooks", "repair", "--client", "claude", "--workspace", workspace],
      {
        cwd: path.resolve(path.dirname(entryPoint), ".."),
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: workspace, USERPROFILE: workspace },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).ok, true);
    const repaired = JSON.parse(fs.readFileSync(path.join(workspace, ".mottainai", "hooks.json"), "utf8")) as {
      version: number;
      failureModes: { "source.write": string; "process.exec": string };
    };
    assert.equal(repaired.version, 1);
    assert.equal(repaired.failureModes["source.write"], "closed");
    assert.equal(repaired.failureModes["process.exec"], "closed");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("public CLI dispatch projects the workflow authority through a supported client adapter", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-hooks-workflow-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: ["ignore", "ignore", "pipe"] });
  try {
    git(["init", "-b", "release/v1"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Hook Test"]);
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "tracked\n");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "initial"]);
    fs.mkdirSync(path.join(workspace, ".mottainai"));
    fs.writeFileSync(
      path.join(workspace, ".mottainai", "workflow.json"),
      JSON.stringify({ ...BUILTIN_PRESETS.standard, protectedBranches: ["release/*"], protectedBranchRule: { ...BUILTIN_PRESETS.standard.protectedBranchRule, sourceWrite: "enforce" } }),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entryPoint, "hooks", "dispatch", "--client", "claude", "--workspace", workspace],
      {
        cwd: path.resolve(path.dirname(entryPoint), ".."),
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "tracked.txt" } }),
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^DENY workflow_protected_branch/u);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
