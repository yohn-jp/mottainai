#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const sourceEntry = path.join(repoRoot, "src", "index.ts");
const requested = process.argv[2] ?? "claude";
const clients = requested === "all" ? ["claude", "codex"] : [requested];
const ENFORCEMENT_MODE = "enforce";
const MANAGED_EXEC_TOOL = "mcp__mottainai__mottainai_exec";
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

  const dependencies = path.join(repoRoot, "node_modules");
  if (!fs.existsSync(dependencies)) throw new Error("node_modules is required for the isolated real-client runner");
  fs.symlinkSync(dependencies, path.join(root, "node_modules"), "junction");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });

  const configPath = path.join(root, "mottainai.config.json");
  writeJson(configPath, { version: 2, mcpServers: {} });
  writeJson(path.join(root, ".mottainai", "hooks.json"), {
    version: 1,
    mode: ENFORCEMENT_MODE,
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

  // Claude's supported project MCP mechanism exposes the actual managed
  // capability used by the allowed half of the proof. User HOME is retained
  // for the client's normal authentication/trust state; the fixture itself
  // remains disposable and project-scoped.
  const mcpConfigPath = path.join(root, "mcp.json");
  writeJson(mcpConfigPath, {
    mcpServers: {
      mottainai: {
        command: process.execPath,
        args: ["--import", "tsx", sourceEntry],
        cwd: root,
        env: { MOTTAINAI_CONFIG: configPath },
      },
    },
  });
  return { root, mcpConfigPath };
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

function clientCommand(client, root, mcpConfigPath) {
  if (client === "claude") {
    const prompt =
      "For this bounded hook test, first try the native Bash tool exactly once with: printf managed-hooks-real-client. The native attempt is expected to be denied by the managed hook; do not retry it with Bash. Then use the mottainai_exec MCP tool exactly once with the same command as the allowed equivalent. Do not use any other tool. After the managed call succeeds, answer DONE.";
    return [
      "claude",
      [
        "--print",
        "--output-format",
        "stream-json",
        "--include-hook-events",
        "--verbose",
        "--no-session-persistence",
        "--setting-sources",
        "project",
        "--mcp-config",
        mcpConfigPath,
        "--permission-mode",
        "auto",
        "--allowed-tools=Bash,mcp__mottainai__mottainai_exec",
        "--max-budget-usd",
        "0.10",
        prompt,
      ],
    ];
  }

  // Codex remains available for explicit comparison, but its project-hook
  // trust flow is client-owned and cannot be granted by this runner.
  const prompt =
    "Use the native shell exactly once to run: printf managed-hooks-real-client. Do not read or write any file. Then answer DONE.";
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

function parseJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function explanationSummary(root) {
  const filePath = path.join(root, ".mottainai", "hook-explanations.jsonl");
  if (!fs.existsSync(filePath)) return { evaluations: 0, decisions: {}, operations: {}, records: [] };
  const decisions = {};
  const operations = {};
  const records = [];
  let evaluations = 0;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
      evaluations += 1;
      const decision = typeof record.decision === "string" ? record.decision : "unknown";
      const reason = typeof record.reason === "string" ? record.reason : "unknown";
      const key = `${decision}:${reason}`;
      decisions[key] = (decisions[key] ?? 0) + 1;
      const operation = typeof record.operation === "string" ? record.operation : "unknown";
      operations[operation] = (operations[operation] ?? 0) + 1;
      if (records.length < 20) {
        records.push({
          operation,
          decision,
          reason,
          ...(typeof record.replacement === "string" ? { replacement: record.replacement } : {}),
        });
      }
    } catch {
      // A malformed diagnostic line is not surfaced as client evidence.
    }
  }
  return { evaluations, decisions, operations, records };
}

function resetExplanationEvidence(root) {
  fs.rmSync(path.join(root, ".mottainai", "hook-explanations.jsonl"), { force: true });
}

function managedEntryPresent(root, client) {
  const filePath = path.join(root, client === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
  if (!fs.existsSync(filePath)) return false;
  return fs.readFileSync(filePath, "utf8").includes("mottainai-managed-hook-v1");
}

function clientConfigState(root, client) {
  const filePath = path.join(root, client === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
  if (!fs.existsSync(filePath)) return { configPresent: false, configValid: true, managedEntryPresent: false };
  const parsed = parseJson(fs.readFileSync(filePath, "utf8"));
  return {
    configPresent: true,
    configValid: parsed !== undefined,
    managedEntryPresent: managedEntryPresent(root, client),
  };
}

function boundedError(value, root) {
  const firstLine =
    String(value ?? "")
      .trim()
      .split(/\r?\n/u, 1)[0] ?? "";
  const withoutWorkspace = root.length === 0 ? firstLine : firstLine.replaceAll(root, "<isolated-workspace>");
  return withoutWorkspace.replace(/(api[_ -]?key|token|authorization)\s*[=:]\s*\S+/giu, "$1=<redacted>").slice(0, 240);
}

function eventSummary(value) {
  const kinds = {};
  const itemKinds = {};
  const toolCalls = {};
  const toolResults = {};
  const toolResultErrors = {};
  const toolUseNames = new Map();
  let toolEvents = 0;
  const increment = (target, key) => {
    if (typeof key !== "string" || key.length === 0) return;
    target[key] = (target[key] ?? 0) + 1;
  };

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
      increment(kinds, kind);
      if (typeof record.item?.type === "string") increment(itemKinds, record.item.type);

      const content = record.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_use" && typeof block.name === "string") {
            increment(toolCalls, block.name);
            if (typeof block.id === "string") toolUseNames.set(block.id, block.name);
          }
          if (block?.type === "tool_result") {
            const name = typeof block.tool_use_id === "string" ? toolUseNames.get(block.tool_use_id) : undefined;
            if (name !== undefined) {
              increment(toolResults, name);
              if (block.is_error === true) increment(toolResultErrors, name);
            }
          }
        }
      }

      // Codex emits item records rather than Claude's message/content blocks.
      if (record.item?.type === "command_execution") increment(toolCalls, "native-process");
      if (/command_execution|function_call|tool_call|shell/iu.test(line)) toolEvents += 1;
    } catch {
      // Human-readable client output is counted only by bytes.
    }
  }
  return { eventKinds: kinds, itemKinds, toolCalls, toolResults, toolResultErrors, toolEvents };
}

function clientReport(report) {
  if (report === undefined) return undefined;
  return {
    client: report.client,
    adapterVersion: report.adapterVersion,
    state: report.state,
    compatibility: report.compatibility,
    ...(typeof report.clientVersion === "string" ? { clientVersion: report.clientVersion } : {}),
    managedEntry: report.managedEntry,
    ...(typeof report.effectiveMode === "string" ? { effectiveMode: report.effectiveMode } : {}),
    ...(typeof report.reason === "string" ? { reason: report.reason } : {}),
  };
}

function lifecycleSummary(result) {
  const parsed = parseJson(result.stdout);
  return {
    ok: result.status === 0 && parsed?.ok === true,
    exitCode: result.status,
    ...(typeof parsed?.dispatcherAvailable === "boolean" ? { dispatcherAvailable: parsed.dispatcherAvailable } : {}),
    clients: Array.isArray(parsed?.clients) ? parsed.clients.map(clientReport).filter(Boolean) : [],
    ...(Array.isArray(parsed?.problems) ? { problems: parsed.problems.slice(0, 12) } : {}),
  };
}

function installSummary(result, client) {
  const parsed = parseJson(result.stdout);
  const report = Array.isArray(parsed?.clients)
    ? parsed.clients.find((candidate) => candidate?.client === client)
    : undefined;
  const boundedClient = clientReport(report);
  return {
    ok: result.status === 0 && parsed?.ok === true && report?.managedEntry === "healthy",
    exitCode: result.status,
    ...(boundedClient === undefined ? {} : { client: boundedClient }),
    ...(result.status !== 0 ? { blocker: boundedError(result.stderr || result.stdout, "") } : {}),
  };
}

function runClient(client, root, mcpConfigPath) {
  resetExplanationEvidence(root);
  const [command, args] = clientCommand(client, root, mcpConfigPath);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    env: childEnvironment(root),
    encoding: "utf8",
    timeout: 45_000,
  });
  const summary = explanationSummary(root);
  const events = eventSummary(result.stdout);
  const nativeCalls = client === "claude" ? (events.toolCalls.Bash ?? 0) : (events.toolCalls["native-process"] ?? 0);
  const managedCalls = client === "claude" ? (events.toolCalls[MANAGED_EXEC_TOOL] ?? 0) : 0;
  const managedSuccesses = Math.max(0, managedCalls - (events.toolResultErrors[MANAGED_EXEC_TOOL] ?? 0));
  const nativeRedirect = summary.records.some(
    (record) =>
      record.operation === "process.exec" &&
      record.decision === "redirect" &&
      record.reason === "managed_capability_available",
  );
  const hookEvidenceObserved = summary.evaluations > 0;
  const proof =
    client === "claude" &&
    result.status === 0 &&
    nativeCalls > 0 &&
    managedCalls > 0 &&
    managedSuccesses > 0 &&
    hookEvidenceObserved &&
    nativeRedirect;
  return {
    client,
    exitCode: result.status,
    timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
    elapsedMs: Date.now() - started,
    stdoutBytes: Buffer.byteLength(result.stdout ?? "", "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr ?? "", "utf8"),
    managedEntryPresent: managedEntryPresent(root, client),
    ...(result.status !== 0 ? { blocker: boundedError(result.stderr || result.stdout, root) } : {}),
    hookEvaluations: summary.evaluations,
    evidenceStatus: proof ? "proved" : "blocked",
    enforcementEvidence: proof
      ? "native-process-denied-and-managed-equivalent-succeeded"
      : "not-counted-incomplete-live-enforce-proof",
    decisions: summary.decisions,
    hookOperations: summary.operations,
    decisionRecords: summary.records,
    nativeCalls,
    managedCalls,
    managedSuccesses,
    ...events,
  };
}

function cleanupClient(root, client) {
  const uninstall = invokeMottainai(root, ["hooks", "uninstall", "--client", client]);
  const config = clientConfigState(root, client);
  const status = lifecycleSummary(invokeMottainai(root, ["hooks", "status"]));
  const clientStatus = status.clients.find((report) => report.client === client);
  return {
    ok:
      uninstall.status === 0 &&
      config.configValid &&
      !config.managedEntryPresent &&
      clientStatus?.managedEntry === "missing",
    uninstallExitCode: uninstall.status,
    config,
    postCleanupStatus:
      clientStatus === undefined
        ? undefined
        : {
            ok: status.ok,
            managedEntry: clientStatus.managedEntry,
          },
  };
}

let report;
let workspace;
try {
  workspace = createWorkspace();
  const { root, mcpConfigPath } = workspace;
  const results = {};
  const lifecycle = {};
  const cleanup = {};

  try {
    for (const client of clients) {
      const install = invokeMottainai(root, ["hooks", "install", "--client", client, "--mode", ENFORCEMENT_MODE]);
      lifecycle[client] = { install: installSummary(install, client) };
      if (!lifecycle[client].install.ok) {
        results[client] = {
          client,
          evidenceStatus: "blocked",
          enforcementEvidence: "not-counted-installation-failed",
          blocker: lifecycle[client].install.blocker ?? "managed hook install did not report healthy",
        };
        continue;
      }

      const status = lifecycleSummary(invokeMottainai(root, ["hooks", "status"]));
      const doctor = lifecycleSummary(invokeMottainai(root, ["hooks", "doctor"]));
      lifecycle[client].status = status;
      const selected = status.clients.find((candidate) => candidate.client === client);
      const selectedDoctor = doctor.clients.find((candidate) => candidate.client === client);
      const selectedDoctorHealthy =
        selectedDoctor?.managedEntry === "healthy" &&
        !(doctor.problems ?? []).some((problem) => problem.startsWith(`${client}:`));
      lifecycle[client].doctor = {
        ...doctor,
        selectedClient: {
          ok: selectedDoctorHealthy,
          ...(selectedDoctor === undefined ? {} : { report: selectedDoctor }),
        },
      };
      const lifecycleReady =
        status.ok &&
        status.dispatcherAvailable === true &&
        selected?.state === "installed" &&
        selected.compatibility === "compatible" &&
        selected.managedEntry === "healthy" &&
        selected.effectiveMode === ENFORCEMENT_MODE &&
        selectedDoctorHealthy;
      if (!lifecycleReady) {
        results[client] = {
          client,
          ...(typeof selected?.clientVersion === "string" ? { clientVersion: selected.clientVersion } : {}),
          evidenceStatus: "blocked",
          enforcementEvidence: "not-counted-lifecycle-not-ready",
          blocker: "hooks status/doctor did not report a healthy enforce-mode managed entry",
        };
        continue;
      }
      results[client] = {
        ...(typeof selected?.clientVersion === "string" ? { clientVersion: selected.clientVersion } : {}),
        ...runClient(client, root, mcpConfigPath),
      };
    }
    report = {
      status: "blocked",
      clients,
      mode: ENFORCEMENT_MODE,
      lifecycle,
      results,
    };
  } finally {
    for (const client of clients) {
      try {
        cleanup[client] = cleanupClient(root, client);
      } catch (error) {
        cleanup[client] = {
          ok: false,
          blocker: boundedError(error instanceof Error ? error.message : String(error), root),
        };
      }
    }
    if (report !== undefined) report.cleanup = cleanup;
  }
} catch (error) {
  report = {
    status: "blocked",
    clients,
    mode: ENFORCEMENT_MODE,
    reason: boundedError(error instanceof Error ? error.message : String(error), workspace?.root ?? ""),
  };
} finally {
  if (workspace?.root !== undefined) fs.rmSync(workspace.root, { recursive: true, force: true });
}

const provenClients =
  report?.results === undefined
    ? []
    : clients.filter(
        (client) => report.results[client]?.evidenceStatus === "proved" && report.cleanup?.[client]?.ok === true,
      );
if (report !== undefined) {
  report.status = provenClients.length > 0 ? "completed" : "blocked";
  report.provenClients = provenClients;
  if (report.status === "blocked" && report.reason === undefined) {
    report.reason = "no client completed the live enforce proof";
  }
  console.log(JSON.stringify(report));
  process.exitCode = report.status === "completed" ? 0 : 1;
}
