import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BUILTIN_PRESETS } from "./workflow/policy/presets.js";
import { MANAGED_CAPABILITY_REGISTRATION_MARKER } from "./hooks/capabilities.js";
import { DEFAULT_HOOK_POLICY } from "./hooks/policy.js";

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

test("--version and -v print the package version and exit 0", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(path.resolve(path.dirname(entryPoint), ".."), "package.json"), "utf8"),
  ) as { version: string };
  for (const flag of ["--version", "-v"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", entryPoint, flag], {
      cwd: path.resolve(path.dirname(entryPoint), ".."),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(result.stdout.trim(), packageJson.version);
  }
});

test("--help and -h print CLI usage and exit 0", () => {
  for (const flag of ["--help", "-h"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", entryPoint, flag], {
      cwd: path.resolve(path.dirname(entryPoint), ".."),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^usage:/);
  }
});

test("public Runtime commands fail closed before entering the retired artifact path", () => {
  for (const action of ["ensure", "status"]) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `mottainai-cli-runtime-${action}-`));
    const stateDirectory = path.join(workspace, "runtime-state");
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", entryPoint, "runtime", action, "--json", "--state-directory", stateDirectory],
        {
          cwd: path.resolve(path.dirname(entryPoint), ".."),
          env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      const error = JSON.parse(result.stdout) as { ok?: boolean; error?: string };
      assert.equal(error.ok, false);
      assert.match(error.error ?? "", /mottainai-init runtime ensure --spec PATH/);
      assert.doesNotMatch(error.error ?? "", /managed QEMU|not-built|QMP/iu);
      assert.equal(fs.existsSync(stateDirectory), false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("top-level init rejects the removed Runtime provisioning option before writing anything", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-init-runtime-"));
  const configPath = path.join(workspace, "mottainai.config.json");
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        entryPoint,
        "init",
        "--yes",
        "--workspace",
        workspace,
        "--config",
        configPath,
        "--scope",
        "project",
        "--client",
        "none",
        "--no-doctor",
        "--runtime",
      ],
      {
        cwd: path.resolve(path.dirname(entryPoint), ".."),
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /use `mottainai-init runtime ensure --spec PATH`/);
    assert.equal(fs.existsSync(configPath), false);
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
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          HOME: workspace,
          USERPROFILE: workspace,
        },
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
      JSON.stringify({
        ...BUILTIN_PRESETS.standard,
        protectedBranches: ["release/*"],
        protectedBranchRule: { ...BUILTIN_PRESETS.standard.protectedBranchRule, sourceWrite: "enforce" },
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entryPoint, "hooks", "dispatch", "--client", "claude", "--workspace", workspace],
      {
        cwd: path.resolve(path.dirname(entryPoint), ".."),
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: { file_path: "tracked.txt" },
        }),
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

test("public CLI binds the managed MCP allow path to the verified registration identity", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-managed-identity-"));
  const configPath = path.join(workspace, "mottainai.config.json");
  const mcpConfigPath = path.join(workspace, ".mcp.json");
  const hookPolicyPath = path.join(workspace, ".mottainai", "hooks.json");
  const runDispatch = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        entryPoint,
        "hooks",
        "dispatch",
        "--client",
        "claude",
        "--workspace",
        workspace,
        "--config",
        configPath,
      ],
      {
        cwd: path.resolve(path.dirname(entryPoint), ".."),
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__mottainai__mottainai_exec",
          tool_input: { command: "printf managed-identity" },
        }),
        encoding: "utf8",
      },
    );

  try {
    fs.writeFileSync(configPath, JSON.stringify({ version: 2, mcpServers: {} }));
    fs.mkdirSync(path.dirname(hookPolicyPath), { recursive: true });
    fs.writeFileSync(hookPolicyPath, JSON.stringify({ ...DEFAULT_HOOK_POLICY, mode: "enforce" }));

    const registrationEnvironment = {
      MOTTAINAI_CONFIG: configPath,
      MOTTAINAI_MANAGED_CAPABILITY: MANAGED_CAPABILITY_REGISTRATION_MARKER,
    };
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          mottainai: { command: "/bin/false", env: registrationEnvironment },
        },
      }),
    );
    const foreign = runDispatch();
    assert.equal(foreign.status, 2, `${foreign.stdout}${foreign.stderr}`);
    assert.equal(foreign.stdout, "");
    assert.match(foreign.stderr, /^DENY managed_capability_available;use=mottainai_exec;id=hd_[a-f0-9]{16}\n$/u);

    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          mottainai: {
            command: process.execPath,
            args: ["--import", "tsx", entryPoint],
            cwd: workspace,
            env: registrationEnvironment,
          },
        },
      }),
    );
    const managed = runDispatch();
    assert.equal(managed.status, 0, `${managed.stdout}${managed.stderr}`);
    assert.equal(managed.stdout, "");
    assert.equal(managed.stderr, "");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("semantic status and review expose bounded non-authoritative blockers through the public CLI", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-semantic-status-"));
  const run = (action: string) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", entryPoint, "semantic", action, "--mode", "observe", "--workspace", workspace],
      {
        cwd: path.resolve(path.dirname(entryPoint), ".."),
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
        encoding: "utf8",
      },
    );
  try {
    const status = run("status");
    assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
    const statusReport = JSON.parse(status.stdout) as {
      integrity: { status: string };
      authoritative: boolean;
      blockers: readonly { code: string }[];
    };
    assert.equal(statusReport.integrity.status, "invalid");
    assert.equal(statusReport.authoritative, false);
    assert.ok(statusReport.blockers.some((item) => item.code === "semantic_integrity_invalid"));

    const review = run("review");
    assert.equal(review.status, 0, `${review.stdout}${review.stderr}`);
    const reviewReport = JSON.parse(review.stdout) as {
      review: { level: string };
      blockers: readonly { code: string }[];
    };
    assert.equal(reviewReport.review.level, "L3");
    assert.ok(reviewReport.blockers.some((item) => item.code === "semantic_integrity_invalid"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("public CLI skill subcommand writes its index projection to stdout", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", entryPoint, "skill"], {
    cwd: path.resolve(path.dirname(entryPoint), ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Mottainai skill scenarios/u);
  assert.match(result.stdout, /Run `mottainai skill choose-task-launch` for the full playbook\./u);
});

test("public CLI task list enumerates managed tasks with an explicit schema version, independent of cwd/--workspace (Issue #539)", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-task-list-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", entryPoint, "task", "list"], {
      cwd: path.resolve(path.dirname(entryPoint), ".."),
      env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as { schemaVersion: number; generatedAt: number; tasks: readonly unknown[] };
    assert.equal(parsed.schemaVersion, 1);
    // generatedAt is the explicit, checkable evidence that this is a point-in-time
    // discovery snapshot, not a live/authoritative availability signal.
    assert.equal(typeof parsed.generatedAt, "number");
    assert.deepEqual(parsed.tasks, []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("public CLI task status --task-id fails closed for an unknown task id with no cwd/--workspace fallback (Issue #539)", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-task-status-by-id-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entryPoint, "task", "status", "--task-id", "not-a-real-task-id"],
      {
        cwd: path.resolve(path.dirname(entryPoint), ".."),
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; reason: string };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "task-not-found");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("public CLI skill subcommand reports an unknown scenario to stderr with a non-zero exit", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", entryPoint, "skill", "not-a-real-scenario"], {
    cwd: path.resolve(path.dirname(entryPoint), ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown skill scenario: not-a-real-scenario/u);
});

test("mottainai add rejects invalid priority at the CLI boundary without writing config", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-priority-invalid-"));
  const configPath = path.join(workspace, "mottainai.config.json");
  const initialConfig = `${JSON.stringify({ version: 2, mcpServers: {} }, null, 2)}\n`;
  const runAdd = (priority: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        entryPoint,
        "add",
        "example",
        "--command",
        "node",
        "--priority",
        priority,
        "--config",
        configPath,
      ],
      {
        cwd: path.resolve(path.dirname(entryPoint), ".."),
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
        encoding: "utf8",
      },
    );

  try {
    fs.writeFileSync(configPath, initialConfig);
    for (const priority of ["not-a-number", "NaN", "Infinity", " ", "1.5", "-1", String(Number.MAX_SAFE_INTEGER + 1)]) {
      const result = runAdd(priority);
      assert.equal(result.status, 1, `${priority}: ${result.stdout}${result.stderr}`);
      assert.equal(result.stdout, "", priority);
      assert.match(
        result.stderr,
        /invalid --priority: expected a finite non-negative safe integer between 0 and 9007199254740991/u,
        priority,
      );
      assert.equal(fs.readFileSync(configPath, "utf8"), initialConfig, priority);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("mottainai add preserves the default and documented priority boundaries", () => {
  const cases: ReadonlyArray<{ name: string; value?: string; rawValue?: number; normalizedValue: number }> = [
    { name: "default", normalizedValue: 0 },
    { name: "zero", value: "0", rawValue: 0, normalizedValue: 0 },
    {
      name: "maximum",
      value: String(Number.MAX_SAFE_INTEGER),
      rawValue: Number.MAX_SAFE_INTEGER,
      normalizedValue: Number.MAX_SAFE_INTEGER,
    },
  ];

  for (const entry of cases) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-priority-valid-"));
    const configPath = path.join(workspace, "mottainai.config.json");
    try {
      fs.writeFileSync(configPath, `${JSON.stringify({ version: 2, mcpServers: {} }, null, 2)}\n`);
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          entryPoint,
          "add",
          entry.name,
          "--command",
          "node",
          ...(entry.value === undefined ? [] : ["--priority", entry.value]),
          "--config",
          configPath,
        ],
        {
          cwd: path.resolve(path.dirname(entryPoint), ".."),
          env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, `${entry.name}: ${result.stdout}${result.stderr}`);
      const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        mcpServers: Record<string, { priority?: number }>;
      };
      assert.equal(written.mcpServers[entry.name].priority, entry.rawValue, entry.name);

      const inspected = spawnSync(
        process.execPath,
        ["--import", "tsx", entryPoint, "inspect", entry.name, "--config", configPath],
        {
          cwd: path.resolve(path.dirname(entryPoint), ".."),
          env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
          encoding: "utf8",
        },
      );
      assert.equal(inspected.status, 0, `${entry.name}: ${inspected.stdout}${inspected.stderr}`);
      assert.equal(JSON.parse(inspected.stdout).priority, entry.normalizedValue, entry.name);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
});
