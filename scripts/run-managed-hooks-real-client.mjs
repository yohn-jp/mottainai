#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const sourceEntry = path.join(repoRoot, "src", "index.ts");
const requested = process.argv[2] ?? "all";
const clients = requested === "all" ? ["claude", "codex"] : [requested];
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CODEX_HOME",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "NO_COLOR",
  "CI",
]);
if (!clients.every((client) => client === "claude" || client === "codex")) {
  console.error("usage: node scripts/run-managed-hooks-real-client.mjs [claude|codex|all]");
  process.exitCode = 2;
  process.exit();
}

function runGit(root, args) {
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function allowListedEnvironment(overrides = {}) {
  const environment = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!CHILD_ENVIRONMENT_KEYS.includes(key)) throw new Error(`environment key is not allow-listed: ${key}`);
    if (value !== undefined) environment[key] = String(value);
  }
  return environment;
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-hooks-real-client-"));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.email", "dogfood@example.invalid"]);
  runGit(root, ["config", "user.name", "Managed Hooks Dogfood"]);
  fs.writeFileSync(path.join(root, "fixture.txt"), "managed-hooks-real-client\n");
  runGit(root, ["add", "fixture.txt"]);
  runGit(root, ["commit", "-m", "real client fixture"]);
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  writeJson(path.join(root, "mottainai.config.json"), { version: 2, mcpServers: {} });
  writeJson(path.join(root, ".mottainai", "hooks.json"), {
    version: 1,
    mode: "observe",
    operationModes: {},
    failureModes: {
      "source.read": "open",
      "source.search": "open",
      "source.write": "closed",
      "process.exec": "closed",
      "git.mutate": "closed",
      other: "open",
    },
    timeoutMs: 1_000,
    maxOutputBytes: 512,
  });
  return root;
}

function childEnvironment(root) {
  const temporaryDirectory = path.join(root, ".tmp");
  return allowListedEnvironment({
    CI: "1",
    NO_COLOR: "1",
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
  });
}

function invokeMottainai(root, args) {
  return spawnSync(
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
    {
      cwd: repoRoot,
      env: childEnvironment(root),
      encoding: "utf8",
      timeout: 15_000,
    },
  );
}

function clientCommand(client, root) {
  const prompt =
    "Use the native shell exactly once to run: printf managed-hooks-real-client. Do not read or write any file. Then answer DONE.";
  if (client === "claude") {
    return [
      "claude",
      [
        "--print",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--setting-sources",
        "project",
        "--permission-mode",
        "dontAsk",
        "--allowed-tools=Bash",
        "--max-budget-usd",
        "0.05",
        prompt,
      ],
    ];
  }
  return [
    "codex",
    [
      "exec",
      "--cd",
      root,
      "--ephemeral",
      "--ignore-user-config",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="on-request"',
      "--json",
      prompt,
    ],
  ];
}

function explanationSummary(root) {
  const filePath = path.join(root, ".mottainai", "hook-explanations.jsonl");
  if (!fs.existsSync(filePath)) return { evaluations: 0, decisions: {}, operations: {} };
  const decisions = {};
  const operations = {};
  let evaluations = 0;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
      evaluations += 1;
      const key = `${record.decision ?? "unknown"}:${record.reason ?? "unknown"}`;
      decisions[key] = (decisions[key] ?? 0) + 1;
      const operation = typeof record.operation === "string" ? record.operation : "unknown";
      operations[operation] = (operations[operation] ?? 0) + 1;
    } catch {
      // A malformed diagnostic line is not surfaced as client evidence.
    }
  }
  return { evaluations, decisions, operations };
}

function installedClientReports(output) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed?.clients)) return {};
    return Object.fromEntries(
      parsed.clients
        .filter((report) => report && typeof report.client === "string")
        .map((report) => [report.client, report]),
    );
  } catch {
    return {};
  }
}

function resetExplanationEvidence(root) {
  fs.rmSync(path.join(root, ".mottainai", "hook-explanations.jsonl"), { force: true });
}

function managedEntryPresent(root, client) {
  const filePath = path.join(root, client === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
  if (!fs.existsSync(filePath)) return false;
  return fs.readFileSync(filePath, "utf8").includes("mottainai-managed-hook-v1");
}

function boundedError(value, root) {
  const firstLine =
    String(value ?? "")
      .trim()
      .split(/\r?\n/u, 1)[0] ?? "";
  return firstLine.replaceAll(root, "<isolated-workspace>").slice(0, 240);
}

function eventSummary(value) {
  const kinds = {};
  const itemKinds = {};
  let toolEvents = 0;
  for (const line of String(value ?? "")
    .split(/\r?\n/u)
    .filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      const kind =
        typeof record.type === "string"
          ? record.type
          : typeof record.item?.type === "string"
            ? record.item.type
            : "unknown";
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      if (typeof record.item?.type === "string") itemKinds[record.item.type] = (itemKinds[record.item.type] ?? 0) + 1;
      if (/command_execution|function_call|tool_call|shell/iu.test(line)) toolEvents += 1;
    } catch {
      // Human-readable client output is counted only by bytes.
    }
  }
  return { eventKinds: kinds, itemKinds, toolEvents };
}

const root = createWorkspace();
try {
  const install = invokeMottainai(root, ["hooks", "install", "--client", "all", "--mode", "observe"]);
  if (install.status !== 0) {
    console.log(
      JSON.stringify({ status: "blocked", reason: "managed hook install failed", clients, exitCode: install.status }),
    );
    process.exitCode = 1;
  } else {
    const installationReports = installedClientReports(install.stdout);
    const results = {};
    for (const client of clients) {
      resetExplanationEvidence(root);
      const [command, args] = clientCommand(client, root);
      const started = Date.now();
      const result = spawnSync(command, args, {
        cwd: root,
        env: childEnvironment(root),
        encoding: "utf8",
        timeout: 30_000,
      });
      const summary = explanationSummary(root);
      const clientEvents = eventSummary(result.stdout);
      const hookEvidenceObserved = summary.evaluations > 0;
      results[client] = {
        clientVersion: installationReports[client]?.clientVersion ?? "unknown",
        exitCode: result.status,
        timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
        elapsedMs: Date.now() - started,
        stdoutBytes: Buffer.byteLength(result.stdout ?? "", "utf8"),
        stderrBytes: Buffer.byteLength(result.stderr ?? "", "utf8"),
        managedEntryPresent: managedEntryPresent(root, client),
        ...(result.status !== 0 ? { blocker: boundedError(result.stderr || result.stdout, root) } : {}),
        hookEvaluations: summary.evaluations,
        evidenceStatus: hookEvidenceObserved ? "observed" : "blocked",
        enforcementEvidence: hookEvidenceObserved ? "not-claimed-observe-mode" : "not-counted-no-hook-evaluations",
        decisions: summary.decisions,
        hookOperations: summary.operations,
        ...clientEvents,
      };
    }
    const blockedClients = clients.filter((client) => results[client].hookEvaluations === 0);
    const blocked = blockedClients.length > 0;
    console.log(
      JSON.stringify({
        status: blocked ? "blocked" : "completed",
        ...(blocked ? { reason: `no hook evaluations: ${blockedClients.join(", ")}` } : {}),
        clients,
        mode: "observe",
        results,
      }),
    );
    if (blocked) process.exitCode = 1;
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
