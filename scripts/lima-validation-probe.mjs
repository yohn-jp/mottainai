import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

export const PROBE_VERSION = "0.1.0";
export const EVIDENCE_SCHEMA = "mottainai.lima-validation.v1";
export const DEFAULT_INSTANCE_NAME = "mottainai-649-probe";
export const DEFAULT_TIMEOUT_SECONDS = 180;
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const MAX_DIAGNOSTIC_CHARS = 512;

const LIMA_ARCH_BY_NODE_ARCH = Object.freeze({ x64: "x86_64", arm64: "aarch64" });
const QEMU_ENVIRONMENT_KEYS = Object.freeze([
  "QEMU_SYSTEM_AARCH64",
  "QEMU_SYSTEM_ARM",
  "QEMU_SYSTEM_PPC64",
  "QEMU_SYSTEM_RISCV64",
  "QEMU_SYSTEM_S390X",
  "QEMU_SYSTEM_X86_64",
]);
const LIMA_ENVIRONMENT_KEYS_TO_CLEAR = Object.freeze([
  "LIMA_INSTANCE",
  "LIMA_SHELL",
  "LIMA_SHELLENV_ALLOW",
  "LIMA_SHELLENV_BLOCK",
  "LIMA_SSH_OVER_VSOCK",
  "LIMA_TEMPLATES_PATH",
  "LIMA_WORKDIR",
  ...QEMU_ENVIRONMENT_KEYS,
]);
const SUPPORTED_STATUSES = new Set(["Running", "Stopped"]);
const RUNTIME_IDENTITY_FIELDS = Object.freeze(["name", "arch"]);
const CONVERGED_START_PATTERNS = Object.freeze([
  /already running/i,
  /already started/i,
  /start(?:ing)? .*in progress/i,
]);

function excerpt(value, limit = MAX_DIAGNOSTIC_CHARS) {
  const text = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function monotonicMilliseconds() {
  return performance.now();
}

function durationMilliseconds(startedAt, now = monotonicMilliseconds) {
  return Math.max(0, Math.round(now() - startedAt));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePositiveInteger(value, optionName) {
  if (!/^\d+$/u.test(value)) throw new Error(`${optionName} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${optionName} must be a positive integer`);
  return parsed;
}

function nextOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

export function parseArguments(argv = process.argv.slice(2)) {
  const options = {
    output: "./lima-validation-evidence.json",
    logs: undefined,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    instanceName: DEFAULT_INSTANCE_NAME,
    revision: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const optionName = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    if (optionName === "--output") {
      options.output = inlineValue ?? nextOptionValue(argv, index++, "--output");
      continue;
    }
    if (optionName === "--logs") {
      options.logs = inlineValue ?? nextOptionValue(argv, index++, "--logs");
      continue;
    }
    if (optionName === "--timeout-seconds") {
      const value = inlineValue ?? nextOptionValue(argv, index++, "--timeout-seconds");
      options.timeoutSeconds = parsePositiveInteger(value, "--timeout-seconds");
      if (options.timeoutSeconds > 900) throw new Error("--timeout-seconds must be at most 900");
      continue;
    }
    if (optionName === "--instance-name") {
      options.instanceName = inlineValue ?? nextOptionValue(argv, index++, "--instance-name");
      if (!/^[a-z][a-z0-9-]{0,62}$/u.test(options.instanceName)) {
        throw new Error("--instance-name must be a lowercase Lima-compatible name");
      }
      continue;
    }
    if (optionName === "--revision") {
      options.revision = inlineValue ?? nextOptionValue(argv, index++, "--revision");
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  return options;
}

export function resolveLimaArchitecture(nodeArchitecture) {
  return LIMA_ARCH_BY_NODE_ARCH[nodeArchitecture];
}

export function collectHostObservations({
  platform = process.platform,
  nodeArchitecture = process.arch,
  kernelRelease = os.release(),
  kvmPath = "/dev/kvm",
  fsApi = fs,
} = {}) {
  const limaArchitecture = resolveLimaArchitecture(nodeArchitecture);
  const kvm = {
    path: kvmPath,
    present: false,
    character_device: false,
    readable_writable: false,
    diagnostic: undefined,
  };

  try {
    const stats = fsApi.statSync(kvmPath);
    kvm.present = true;
    kvm.character_device = stats.isCharacterDevice();
    if (!kvm.character_device) {
      kvm.diagnostic = "the KVM path is not a character device";
    } else {
      const descriptor = fsApi.openSync(kvmPath, fs.constants.O_RDWR);
      fsApi.closeSync(descriptor);
      kvm.readable_writable = true;
    }
  } catch (error) {
    kvm.diagnostic = excerpt(errorMessage(error));
  }

  return {
    os: platform,
    architecture: nodeArchitecture,
    kernel_release: excerpt(kernelRelease, 128),
    lima_architecture: limaArchitecture ?? null,
    kvm,
  };
}

function appendBounded(chunks, length, chunk, maxBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = maxBytes - length.value;
  if (remaining <= 0) {
    length.truncated = true;
    return;
  }
  chunks.push(buffer.subarray(0, remaining));
  length.value += Math.min(buffer.length, remaining);
  if (buffer.length > remaining) length.truncated = true;
}

function boundedOutput(chunks) {
  return Buffer.concat(chunks).toString("utf8");
}

function safeLogName(value) {
  return (
    value
      .replace(/[^a-z0-9_-]+/giu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "command"
  );
}

function writeDiagnosticLog(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
}

export function createCommandRunner({
  executable,
  environment,
  cwd = process.cwd(),
  logsDirectory,
  spawnImpl = spawn,
  commandTimeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  maxOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
  now = monotonicMilliseconds,
} = {}) {
  if (typeof executable !== "string" || executable.length === 0) throw new Error("a Lima executable is required");
  let sequence = 0;

  return ({ operation, args, timeoutMs = commandTimeoutMs }) =>
    new Promise((resolve) => {
      const startedAt = now();
      const stdoutChunks = [];
      const stderrChunks = [];
      const stdoutLength = { value: 0, truncated: false };
      const stderrLength = { value: 0, truncated: false };
      const sequencePrefix = String(++sequence).padStart(2, "0");
      const logPrefix = path.join(logsDirectory, `${sequencePrefix}-${safeLogName(operation)}`);
      let child;
      let timeoutHandle;
      let forceKillHandle;
      let settled = false;
      let timedOut = false;
      let spawnError;

      const finish = (exitStatus, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearTimeout(forceKillHandle);
        const stdout = boundedOutput(stdoutChunks);
        const stderr = boundedOutput(stderrChunks);
        const stdoutLog = `${logPrefix}.stdout.log`;
        const stderrLog = `${logPrefix}.stderr.log`;
        writeDiagnosticLog(stdoutLog, stdout);
        writeDiagnosticLog(stderrLog, stderr);
        resolve({
          command: [executable, ...args],
          exitStatus,
          signal: signal ?? null,
          timedOut,
          stdout,
          stderr,
          output_truncated: stdoutLength.truncated || stderrLength.truncated,
          durationMs: durationMilliseconds(startedAt, now),
          rawLogs: { stdout: stdoutLog, stderr: stderrLog },
          error: spawnError ? excerpt(errorMessage(spawnError)) : undefined,
        });
      };

      try {
        child = spawnImpl(executable, args, {
          cwd,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        child.stdout?.on("data", (chunk) => appendBounded(stdoutChunks, stdoutLength, chunk, maxOutputBytes));
        child.stderr?.on("data", (chunk) => appendBounded(stderrChunks, stderrLength, chunk, maxOutputBytes));
        child.once("error", (error) => {
          spawnError = error;
          finish(null, null);
        });
        child.once("close", (code, signal) => finish(code, signal));
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill?.("SIGTERM");
          forceKillHandle = setTimeout(() => child.kill?.("SIGKILL"), 1_000);
        }, timeoutMs);
      } catch (error) {
        spawnError = error;
        finish(null, null);
      }
    });
}

export function parseJsonLines(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) return { values: [], errors: [] };
  if (trimmed.startsWith("[")) {
    try {
      const value = JSON.parse(trimmed);
      return { values: Array.isArray(value) ? value : [value], errors: [] };
    } catch (error) {
      return { values: [], errors: [excerpt(errorMessage(error))] };
    }
  }

  const values = [];
  const errors = [];
  for (const [lineNumber, line] of trimmed.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      errors.push(`line ${lineNumber + 1}: ${excerpt(errorMessage(error), 160)}`);
    }
  }
  return { values, errors };
}

export function parseLimaListOutput(text) {
  const parsed = parseJsonLines(text);
  const records = [];
  const errors = [...parsed.errors];
  for (const value of parsed.values) {
    if (Array.isArray(value)) {
      for (const nested of value) {
        if (!isObject(nested)) errors.push("list output contains a non-object record");
        else records.push(nested);
      }
      continue;
    }
    if (!isObject(value)) errors.push("list output contains a non-object record");
    else records.push(value);
  }
  return { records, errors };
}

export function findLimaInstance(records, instanceName) {
  const matches = records.filter((record) => record.name === instanceName);
  if (matches.length === 0) return { kind: "missing", record: undefined };
  if (matches.length !== 1) return { kind: "ambiguous", record: undefined };
  return { kind: "found", record: matches[0] };
}

export function publicInstanceState(record) {
  if (!isObject(record)) return null;
  const state = {};
  for (const field of ["name", "status", "vmType", "arch", "dir", "sshLocalPort"]) {
    if (Object.hasOwn(record, field)) state[field] = record[field];
  }
  return state;
}

export function publicInstanceIdentity(record) {
  if (!isObject(record)) return null;
  const identity = {};
  for (const field of RUNTIME_IDENTITY_FIELDS) {
    if (Object.hasOwn(record, field)) identity[field] = record[field];
  }
  return identity;
}

function compareIdentity(previous, current) {
  if (!previous || !current) return "identity is unavailable";
  for (const field of RUNTIME_IDENTITY_FIELDS) {
    const previousHasField = Object.hasOwn(previous, field);
    const currentHasField = Object.hasOwn(current, field);
    if (previousHasField !== currentHasField) return `${field} presence changed`;
    if (previousHasField && JSON.stringify(previous[field]) !== JSON.stringify(current[field])) {
      return `${field} changed across lifecycle operations`;
    }
  }
  return undefined;
}

export function validateInstanceState(record, { instanceName, expectedStatus, expectedArch, baselineIdentity } = {}) {
  if (!isObject(record)) return { pass: false, diagnostic: "instance inspection is not an object" };
  const requiredFields = ["name", "status", "vmType", "arch"];
  const missing = requiredFields.filter((field) => !Object.hasOwn(record, field));
  if (missing.length > 0) {
    return { pass: false, diagnostic: `unsupported or ambiguous inspection; missing fields: ${missing.join(", ")}` };
  }
  if (record.name !== instanceName) return { pass: false, diagnostic: "inspection returned a different instance name" };
  if (!SUPPORTED_STATUSES.has(record.status)) {
    return { pass: false, diagnostic: `unsupported or ambiguous instance status: ${String(record.status)}` };
  }
  if (record.vmType !== "qemu") return { pass: false, diagnostic: `unsupported VM type: ${String(record.vmType)}` };
  if (record.arch !== expectedArch) {
    return { pass: false, diagnostic: `unexpected guest architecture: ${String(record.arch)}` };
  }
  if (expectedStatus !== undefined && record.status !== expectedStatus) {
    return { pass: false, diagnostic: `expected status ${expectedStatus}, observed ${record.status}` };
  }
  const identity = publicInstanceIdentity(record);
  const identityDiagnostic = baselineIdentity ? compareIdentity(baselineIdentity, identity) : undefined;
  if (identityDiagnostic) return { pass: false, diagnostic: identityDiagnostic, identity };
  return { pass: true, identity, state: publicInstanceState(record) };
}

export function inspectKvmAcceleration() {
  return {
    pass: false,
    status: "blocked-public-surface",
    requested: null,
    fallback: null,
    diagnostic:
      "Lima does not expose actual QEMU accelerator selection through a documented/public machine-readable interface",
    observation: "unavailable through documented/public Lima surfaces",
  };
}

export function classifyConcurrentStartResult(result) {
  if (commandPass(result)) return "succeeded";
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  return CONVERGED_START_PATTERNS.some((pattern) => pattern.test(output)) ? "already-running" : "failed";
}

export function runGuardFixtures() {
  const cases = [
    {
      id: "unsupported-vm-type",
      record: { name: DEFAULT_INSTANCE_NAME, status: "Running", vmType: "vz", arch: "x86_64" },
      expectedDiagnostic: "unsupported VM type",
    },
    {
      id: "ambiguous-status",
      record: { name: DEFAULT_INSTANCE_NAME, status: "Recovering", vmType: "qemu", arch: "x86_64" },
      expectedDiagnostic: "unsupported or ambiguous instance status",
    },
    {
      id: "missing-inspection-field",
      record: { name: DEFAULT_INSTANCE_NAME, status: "Stopped", vmType: "qemu" },
      expectedDiagnostic: "missing fields",
    },
  ];
  return cases.map((fixture) => {
    const result = validateInstanceState(fixture.record, {
      instanceName: DEFAULT_INSTANCE_NAME,
      expectedStatus: "Running",
      expectedArch: "x86_64",
    });
    const pass = !result.pass && result.diagnostic.includes(fixture.expectedDiagnostic);
    return {
      id: fixture.id,
      mode: "deterministic-fixture",
      expected: "reject unsupported or ambiguous state",
      observed: result.diagnostic,
      pass,
      status: pass ? "passed" : "failed",
    };
  });
}

function globalLimaArguments(level, command, args) {
  return ["--tty=false", "--log-format", "json", "--log-level", level, command, ...args];
}

function machineReadableListArguments(instanceName) {
  return ["--all-fields", "--format", "json", ...(instanceName ? [instanceName] : [])];
}

async function invokeLima(commandRunner, { operation, command, args = [], level = "info", timeoutMs } = {}) {
  return commandRunner({
    operation,
    args: globalLimaArguments(level, command, args),
    timeoutMs,
  });
}

function commandPass(result) {
  return result?.exitStatus === 0 && !result?.timedOut && !result?.error;
}

function expectedMissingInstanceError(result) {
  return /(?:does not exist|not found|no such instance|cannot find.*instance)/iu.test(
    `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`,
  );
}

export function verifyCleanup(deleteResult, inspectionResult, instanceName) {
  const inspection = parseLimaListOutput(inspectionResult?.stdout ?? "");
  const absent =
    commandPass(inspectionResult) &&
    inspection.errors.length === 0 &&
    findLimaInstance(inspection.records, instanceName).kind === "missing";
  return { pass: commandPass(deleteResult) && absent, absent, inspection };
}

function makeStep({
  id,
  operation = id,
  expectedState,
  observedState,
  result,
  pass,
  diagnostic,
  identity,
  durationMs,
  rawLogs,
} = {}) {
  const diagnostics = diagnostic ? [excerpt(diagnostic)] : [];
  if (result?.stderr) diagnostics.push(excerpt(result.stderr));
  if (result?.error) diagnostics.push(excerpt(result.error));
  return {
    id,
    operation,
    expected_state: expectedState ?? null,
    observed_state: observedState ?? null,
    instance_identity: identity ?? null,
    exit_status: result?.exitStatus ?? null,
    duration_ms: durationMs ?? result?.durationMs ?? 0,
    pass: pass === null ? null : Boolean(pass),
    status: pass === null ? "skipped" : pass ? "passed" : "failed",
    diagnostics: [...new Set(diagnostics)].slice(0, 3),
    ...(result?.rawLogs || rawLogs ? { raw_logs: result?.rawLogs ?? rawLogs } : {}),
  };
}

function skipStep(id, expectedState, diagnostic) {
  return makeStep({ id, expectedState, pass: null, diagnostic });
}

function parseListResult(result) {
  return parseLimaListOutput(result?.stdout ?? "");
}

async function inspectInstance({
  commandRunner,
  instanceName,
  expectedArch,
  expectedStatus,
  baselineIdentity,
  operation,
}) {
  const result = await invokeLima(commandRunner, {
    operation,
    command: "list",
    args: machineReadableListArguments(instanceName),
  });
  const parsed = parseListResult(result);
  const found = findLimaInstance(parsed.records, instanceName);
  const validation =
    commandPass(result) && parsed.errors.length === 0 && found.kind === "found"
      ? validateInstanceState(found.record, { instanceName, expectedStatus, expectedArch, baselineIdentity })
      : {
          pass: false,
          diagnostic:
            parsed.errors.length > 0
              ? `machine-readable inspection parse failed: ${parsed.errors[0]}`
              : found.kind === "missing"
                ? "instance is absent from machine-readable inspection"
                : "machine-readable inspection returned an ambiguous instance set",
        };
  return {
    result,
    parsed,
    found,
    validation,
    step: makeStep({
      id: operation,
      operation: "limactl list --format json",
      expectedState: expectedStatus ? { status: expectedStatus, vmType: "qemu", arch: expectedArch } : null,
      observedState: validation.state ?? publicInstanceState(found.record),
      identity: validation.identity,
      result,
      pass: validation.pass,
      diagnostic: validation.diagnostic,
    }),
  };
}

function baseEvidence({ revision, instanceName, host, executable, timeoutSeconds, outputPath, logsDirectory }) {
  return {
    schema_version: EVIDENCE_SCHEMA,
    probe: {
      name: "Mottainai Linux/KVM Lima lifecycle validation probe",
      version: PROBE_VERSION,
      issue: 649,
      repository: "yohn-jp/mottainai",
      instance_name: instanceName,
      timeout_seconds: timeoutSeconds,
      evidence_path: outputPath ?? null,
      raw_log_directory: logsDirectory ?? null,
    },
    mottainai_revision: revision,
    host,
    lima: {
      executable,
      version: null,
      inspection_interface: "limactl list --format json",
      log_interface: "limactl --log-format json (diagnostics only)",
    },
    virtualization: {
      required_vm_type: "qemu",
      requested_acceleration: "kvm",
      host_kvm_usable: Boolean(host.kvm?.readable_writable),
      actual_acceleration: null,
    },
    deterministic_guard_checks: runGuardFixtures(),
    steps: [],
    result: {
      pass: false,
      exit_status: 1,
      duration_ms: 0,
      diagnostics: [],
    },
  };
}

function appendDiagnostic(evidence, diagnostic) {
  if (!diagnostic) return;
  const value = excerpt(diagnostic);
  if (!evidence.result.diagnostics.includes(value)) evidence.result.diagnostics.push(value);
  evidence.result.diagnostics = evidence.result.diagnostics.slice(0, 5);
}

function appendSkippedLifecycleSteps(evidence, diagnostic) {
  const ids = [
    "inspect-created",
    "start",
    "inspect-running",
    "repeated-start",
    "inspect-after-repeated-start",
    "concurrent-ensure",
    "inspect-after-concurrent-ensure",
    "guest-shell",
    "stop",
    "inspect-stopped",
    "repeated-stop",
    "inspect-after-repeated-stop",
    "restart",
    "inspect-after-restart",
    "recovery-shell",
    "final-stop",
    "inspect-final-stopped",
  ];
  for (const id of ids) evidence.steps.push(skipStep(id, null, diagnostic));
}

function overallPass(evidence) {
  const guardPass = evidence.deterministic_guard_checks.every((check) => check.pass);
  const stepsPass = evidence.steps.filter((step) => step.status !== "skipped").every((step) => step.pass === true);
  return (
    guardPass &&
    stepsPass &&
    evidence.virtualization.host_kvm_usable &&
    evidence.virtualization.actual_acceleration?.pass === true
  );
}

export async function runProbe({
  commandRunner,
  host,
  revision = "unavailable",
  instanceName = DEFAULT_INSTANCE_NAME,
  expectedArch = host?.lima_architecture,
  executable = "limactl",
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  outputPath,
  logsDirectory,
  now = monotonicMilliseconds,
} = {}) {
  if (typeof commandRunner !== "function") throw new Error("commandRunner is required");
  const startedAt = now();
  const evidence = baseEvidence({
    revision,
    instanceName,
    host,
    executable,
    timeoutSeconds,
    outputPath,
    logsDirectory,
  });
  let instanceMayExist = false;
  let baselineIdentity;
  let versionResult;

  const hostPass = host?.os === "linux" && typeof expectedArch === "string" && host?.kvm?.readable_writable === true;
  evidence.steps.push(
    makeStep({
      id: "host-prerequisites",
      expectedState: { os: "linux", native_architecture: expectedArch, kvm: "readable and writable /dev/kvm" },
      observedState: {
        os: host?.os ?? null,
        architecture: host?.architecture ?? null,
        lima_architecture: expectedArch ?? null,
        kvm: host?.kvm ?? null,
      },
      pass: hostPass,
      diagnostic: hostPass ? undefined : (host?.kvm?.diagnostic ?? "native Linux/KVM prerequisites are not satisfied"),
    }),
  );
  if (!hostPass) {
    appendDiagnostic(evidence, "probe stopped before VM creation because prerequisites failed");
    appendSkippedLifecycleSteps(evidence, "not run because host prerequisites failed");
    evidence.result.duration_ms = durationMilliseconds(startedAt, now);
    evidence.result.pass = false;
    return { evidence, instanceMayExist };
  }

  versionResult = await invokeLima(commandRunner, { operation: "lima-version", command: "--version" });
  const version = excerpt(versionResult.stdout || versionResult.stderr, 128);
  evidence.lima.version = version || null;
  const versionPass = commandPass(versionResult) && version.length > 0;
  evidence.steps.push(
    makeStep({
      id: "lima-version",
      operation: "limactl --version",
      expectedState: { available: true, version: "reported" },
      observedState: { version: version || null },
      result: versionResult,
      pass: versionPass,
      diagnostic: versionPass ? undefined : "limactl availability/version check failed",
    }),
  );
  if (!versionPass) {
    appendDiagnostic(evidence, "probe stopped because limactl --version failed");
    appendSkippedLifecycleSteps(evidence, "not run because limactl availability/version check failed");
    evidence.result.duration_ms = durationMilliseconds(startedAt, now);
    evidence.result.pass = false;
    return { evidence, instanceMayExist };
  }

  const missingName = `${instanceName}-missing`;
  const allInstancesResult = await invokeLima(commandRunner, {
    operation: "missing-instance-list-all",
    command: "list",
    args: machineReadableListArguments(),
  });
  const namedMissingResult = await invokeLima(commandRunner, {
    operation: "missing-instance-lookup",
    command: "list",
    args: machineReadableListArguments(missingName),
  });
  const allInstances = parseListResult(allInstancesResult);
  const namedMissing = parseListResult(namedMissingResult);
  const missingAbsent =
    commandPass(allInstancesResult) &&
    allInstances.errors.length === 0 &&
    findLimaInstance(allInstances.records, missingName).kind === "missing";
  const namedAbsent =
    (commandPass(namedMissingResult) &&
      namedMissing.errors.length === 0 &&
      findLimaInstance(namedMissing.records, missingName).kind === "missing") ||
    (!commandPass(namedMissingResult) &&
      namedMissing.records.length === 0 &&
      expectedMissingInstanceError(namedMissingResult));
  evidence.steps.push(
    makeStep({
      id: "missing-instance",
      operation: "limactl list --format json [missing instance]",
      expectedState: { instance: missingName, present: false },
      observedState: {
        all_list_exit_status: allInstancesResult.exitStatus,
        named_lookup_exit_status: namedMissingResult.exitStatus,
        named_records: namedMissing.records.length,
      },
      pass: missingAbsent && namedAbsent,
      diagnostic: missingAbsent && namedAbsent ? undefined : "missing-instance lookup was not safely mapped to absence",
      rawLogs: {
        all_list: allInstancesResult.rawLogs,
        named_lookup: namedMissingResult.rawLogs,
      },
      durationMs: (allInstancesResult.durationMs ?? 0) + (namedMissingResult.durationMs ?? 0),
    }),
  );
  if (!(missingAbsent && namedAbsent)) appendDiagnostic(evidence, "missing-instance handling failed closed");

  const createResult = await invokeLima(commandRunner, {
    operation: "create",
    command: "create",
    args: [
      "--name",
      instanceName,
      "--vm-type",
      "qemu",
      "--arch",
      expectedArch,
      "--cpus",
      "1",
      "--memory",
      "1",
      "--disk",
      "8",
      "--plain",
      "template:alpine",
    ],
  });
  instanceMayExist = true;
  const createPass = commandPass(createResult);
  evidence.steps.push(
    makeStep({
      id: "create",
      operation: "limactl create",
      expectedState: { status: "Stopped", vmType: "qemu", arch: expectedArch, mounts: "disabled by plain mode" },
      observedState: { command_completed: createPass },
      result: createResult,
      pass: createPass,
      diagnostic: createPass ? undefined : "Lima instance creation failed",
    }),
  );
  if (!createPass) {
    appendDiagnostic(evidence, "probe stopped after create failed");
    appendSkippedLifecycleSteps(evidence, "not run because instance creation failed");
    evidence.result.duration_ms = durationMilliseconds(startedAt, now);
    evidence.result.pass = false;
    return { evidence, instanceMayExist };
  }

  const createdInspection = await inspectInstance({
    commandRunner,
    instanceName,
    expectedArch,
    expectedStatus: "Stopped",
    operation: "inspect-created",
  });
  evidence.steps.push(createdInspection.step);
  if (!createdInspection.validation.pass) {
    appendDiagnostic(evidence, createdInspection.validation.diagnostic);
    appendSkippedLifecycleSteps(evidence, "not run because created-instance inspection failed");
    evidence.result.duration_ms = durationMilliseconds(startedAt, now);
    evidence.result.pass = false;
    return { evidence, instanceMayExist };
  }

  const startResult = await invokeLima(commandRunner, {
    operation: "start",
    command: "start",
    args: [instanceName, "--timeout", `${timeoutSeconds}s`],
    timeoutMs: timeoutSeconds * 1000,
  });
  const startPass = commandPass(startResult);
  evidence.steps.push(
    makeStep({
      id: "start",
      operation: "limactl start",
      expectedState: { status: "Running" },
      observedState: { command_completed: startPass },
      result: startResult,
      pass: startPass,
      diagnostic: startPass ? undefined : "Lima start failed",
    }),
  );
  const accelerationObservation = inspectKvmAcceleration();
  evidence.virtualization.actual_acceleration = accelerationObservation;
  appendDiagnostic(evidence, accelerationObservation.diagnostic);
  evidence.steps.push(
    makeStep({
      id: "kvm-acceleration",
      operation: "documented/public Lima KVM observation",
      expectedState: { actual_acceleration: "kvm" },
      observedState: accelerationObservation,
      pass: accelerationObservation.pass,
      diagnostic: accelerationObservation.diagnostic,
      rawLogs: startResult.rawLogs,
    }),
  );
  if (!startPass) {
    appendDiagnostic(evidence, "probe stopped after start failed");
    appendSkippedLifecycleSteps(evidence, "not run because start failed");
    evidence.result.duration_ms = durationMilliseconds(startedAt, now);
    evidence.result.pass = false;
    return { evidence, instanceMayExist };
  }

  const runningInspection = await inspectInstance({
    commandRunner,
    instanceName,
    expectedArch,
    expectedStatus: "Running",
    operation: "inspect-running",
  });
  evidence.steps.push(runningInspection.step);
  if (!runningInspection.validation.pass) {
    appendDiagnostic(evidence, runningInspection.validation.diagnostic);
    appendSkippedLifecycleSteps(evidence, "not run because running-instance inspection failed");
    evidence.result.duration_ms = durationMilliseconds(startedAt, now);
    evidence.result.pass = false;
    return { evidence, instanceMayExist };
  }
  baselineIdentity = runningInspection.validation.identity;

  const repeatedStartResult = await invokeLima(commandRunner, {
    operation: "repeated-start",
    command: "start",
    args: [instanceName, "--timeout", `${timeoutSeconds}s`],
    timeoutMs: timeoutSeconds * 1000,
  });
  evidence.steps.push(
    makeStep({
      id: "repeated-start",
      operation: "limactl start (repeated)",
      expectedState: { status: "Running", idempotent: true },
      observedState: { command_completed: commandPass(repeatedStartResult) },
      result: repeatedStartResult,
      pass: commandPass(repeatedStartResult),
      diagnostic: commandPass(repeatedStartResult) ? undefined : "repeated start was not safely idempotent",
    }),
  );
  const repeatedStartInspection = await inspectInstance({
    commandRunner,
    instanceName,
    expectedArch,
    expectedStatus: "Running",
    baselineIdentity,
    operation: "inspect-after-repeated-start",
  });
  evidence.steps.push(repeatedStartInspection.step);

  const guestShellResult = await invokeLima(commandRunner, {
    operation: "guest-shell",
    command: "shell",
    args: [instanceName, "/bin/true"],
  });
  evidence.steps.push(
    makeStep({
      id: "guest-shell",
      operation: "limactl shell",
      expectedState: { guest_command: "/bin/true", status: "Running" },
      observedState: { command_completed: commandPass(guestShellResult) },
      result: guestShellResult,
      pass: commandPass(guestShellResult),
      diagnostic: commandPass(guestShellResult) ? undefined : "documented limactl shell health check failed",
    }),
  );

  const stopResult = await invokeLima(commandRunner, { operation: "stop", command: "stop", args: [instanceName] });
  evidence.steps.push(
    makeStep({
      id: "stop",
      operation: "limactl stop",
      expectedState: { status: "Stopped" },
      observedState: { command_completed: commandPass(stopResult) },
      result: stopResult,
      pass: commandPass(stopResult),
      diagnostic: commandPass(stopResult) ? undefined : "stop failed",
    }),
  );
  const stoppedInspection = await inspectInstance({
    commandRunner,
    instanceName,
    expectedArch,
    expectedStatus: "Stopped",
    baselineIdentity,
    operation: "inspect-stopped",
  });
  evidence.steps.push(stoppedInspection.step);

  const alreadyStopped = stoppedInspection.validation.pass && stoppedInspection.validation.state?.status === "Stopped";
  const repeatedStopResult = alreadyStopped
    ? undefined
    : await invokeLima(commandRunner, {
        operation: "repeated-stop",
        command: "stop",
        args: [instanceName],
      });
  const repeatedStopPass = alreadyStopped || commandPass(repeatedStopResult);
  evidence.steps.push(
    makeStep({
      id: "repeated-stop",
      operation: alreadyStopped ? "Mottainai stop reconciliation (no-op)" : "limactl stop (repeated)",
      expectedState: { status: "Stopped", reconciled: true },
      observedState: {
        precondition_status: stoppedInspection.validation.state?.status ?? null,
        action: alreadyStopped ? "no-op" : "provider-stop",
        provider_command_completed: alreadyStopped ? null : commandPass(repeatedStopResult),
      },
      result: repeatedStopResult,
      pass: repeatedStopPass,
      diagnostic: repeatedStopPass ? undefined : "repeated stop did not converge to Stopped",
    }),
  );
  const repeatedStopInspection = await inspectInstance({
    commandRunner,
    instanceName,
    expectedArch,
    expectedStatus: "Stopped",
    baselineIdentity,
    operation: "inspect-after-repeated-stop",
  });
  evidence.steps.push(repeatedStopInspection.step);

  const concurrentResults = await Promise.all([
    invokeLima(commandRunner, {
      operation: "concurrent-ensure-a",
      command: "start",
      args: [instanceName, "--timeout", `${timeoutSeconds}s`],
      timeoutMs: timeoutSeconds * 1000,
    }),
    invokeLima(commandRunner, {
      operation: "concurrent-ensure-b",
      command: "start",
      args: [instanceName, "--timeout", `${timeoutSeconds}s`],
      timeoutMs: timeoutSeconds * 1000,
    }),
  ]);
  const concurrentOutcomes = concurrentResults.map(classifyConcurrentStartResult);
  const concurrentInspection = await inspectInstance({
    commandRunner,
    instanceName,
    expectedArch,
    expectedStatus: "Running",
    baselineIdentity,
    operation: "inspect-after-concurrent-ensure",
  });
  const concurrentPass =
    concurrentInspection.validation.pass &&
    concurrentOutcomes.includes("succeeded") &&
    concurrentOutcomes.every((outcome) => outcome !== "failed");
  evidence.steps.push(
    makeStep({
      id: "concurrent-ensure",
      operation: "two concurrent limactl start calls from Stopped",
      expectedState: { status: "Running", concurrent_calls: 2 },
      observedState: {
        outcomes: concurrentOutcomes,
        exit_statuses: concurrentResults.map((result) => result.exitStatus),
        final_status: concurrentInspection.validation.state?.status ?? null,
        final_identity: concurrentInspection.validation.identity ?? null,
      },
      identity: concurrentInspection.validation.identity,
      pass: concurrentPass,
      diagnostic: concurrentPass ? undefined : "concurrent ensure did not deterministically converge to Running",
      rawLogs: {
        first: concurrentResults[0].rawLogs,
        second: concurrentResults[1].rawLogs,
      },
      durationMs: concurrentResults.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
    }),
  );
  evidence.steps.push(concurrentInspection.step);

  const restartResult = await invokeLima(commandRunner, {
    operation: "restart",
    command: "restart",
    args: [instanceName],
    timeoutMs: timeoutSeconds * 1000,
  });
  const restartPass = commandPass(restartResult);
  evidence.steps.push(
    makeStep({
      id: "restart",
      operation: "limactl restart",
      expectedState: { status: "Running" },
      observedState: { command_completed: restartPass },
      result: restartResult,
      pass: restartPass,
      diagnostic: restartPass ? undefined : "Lima restart failed",
    }),
  );

  const restartedInspection = await inspectInstance({
    commandRunner,
    instanceName,
    expectedArch,
    expectedStatus: "Running",
    baselineIdentity,
    operation: "inspect-after-restart",
  });
  evidence.steps.push(restartedInspection.step);
  const recoveryShellResult = await invokeLima(commandRunner, {
    operation: "recovery-shell",
    command: "shell",
    args: [instanceName, "/bin/true"],
  });
  evidence.steps.push(
    makeStep({
      id: "recovery-shell",
      operation: "limactl shell (after restart)",
      expectedState: { guest_command: "/bin/true", status: "Running", identity: "stable" },
      observedState: { command_completed: commandPass(recoveryShellResult) },
      identity: restartedInspection.validation.identity,
      result: recoveryShellResult,
      pass: commandPass(recoveryShellResult) && restartedInspection.validation.pass,
      diagnostic:
        commandPass(recoveryShellResult) && restartedInspection.validation.pass
          ? undefined
          : "recovery inspection failed",
    }),
  );

  const finalStopResult = await invokeLima(commandRunner, {
    operation: "final-stop",
    command: "stop",
    args: [instanceName],
  });
  evidence.steps.push(
    makeStep({
      id: "final-stop",
      operation: "limactl stop (final)",
      expectedState: { status: "Stopped" },
      observedState: { command_completed: commandPass(finalStopResult) },
      result: finalStopResult,
      pass: commandPass(finalStopResult),
      diagnostic: commandPass(finalStopResult) ? undefined : "final stop failed",
    }),
  );
  const finalInspection = await inspectInstance({
    commandRunner,
    instanceName,
    expectedArch,
    expectedStatus: "Stopped",
    baselineIdentity,
    operation: "inspect-final-stopped",
  });
  evidence.steps.push(finalInspection.step);

  evidence.result.duration_ms = durationMilliseconds(startedAt, now);
  evidence.result.pass = overallPass(evidence);
  evidence.result.exit_status = evidence.result.pass ? 0 : 1;
  if (!evidence.result.pass)
    appendDiagnostic(evidence, "one or more lifecycle, identity, or acceleration checks failed");
  return { evidence, instanceMayExist };
}

function buildSandboxEnvironment(sandboxRoot, parentEnvironment = process.env) {
  const environment = { ...parentEnvironment };
  const privateHome = path.join(sandboxRoot, "home");
  const limaHome = path.join(sandboxRoot, "lima");
  const cacheHome = path.join(sandboxRoot, "cache");
  fs.mkdirSync(privateHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(limaHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cacheHome, { recursive: true, mode: 0o700 });
  environment.HOME = privateHome;
  environment.LIMA_HOME = limaHome;
  environment.XDG_CACHE_HOME = cacheHome;
  for (const key of LIMA_ENVIRONMENT_KEYS_TO_CLEAR) delete environment[key];
  return { environment, limaHome };
}

function resolveRevision(cwd, explicitRevision, environment = process.env, execFileSyncImpl = execFileSync) {
  if (explicitRevision) return { value: explicitRevision, source: "argument" };
  if (environment.MOTTAINAI_REVISION) return { value: environment.MOTTAINAI_REVISION, source: "environment" };
  try {
    const value = execFileSyncImpl("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return { value: value.trim() || "unavailable", source: "git" };
  } catch {
    return { value: "unavailable", source: "unavailable" };
  }
}

function writeEvidence(filePath, evidence) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function helpText() {
  return [
    "Usage: node scripts/lima-validation-probe.mjs [options]",
    "",
    "Options:",
    "  --output PATH             Evidence JSON path (default: ./lima-validation-evidence.json)",
    "  --logs PATH               Separate bounded raw-log directory (default: beside evidence)",
    "  --timeout-seconds N       Per-Lima-operation timeout, 1..900 (default: 180)",
    "  --instance-name NAME      Isolated Lima instance name",
    "  --revision VALUE          Mottainai revision when running a downloaded script",
    "",
    "The probe requires native Linux, usable /dev/kvm, and limactl. It cleans up its isolated instance and state.",
  ].join("\n");
}

async function main() {
  const options = parseArguments();
  if (options.help) {
    console.log(helpText());
    return 0;
  }

  const outputPath = path.resolve(options.output);
  const logsDirectory = path.resolve(options.logs ?? path.join(path.dirname(outputPath), "lima-validation-logs"));
  fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-lima-649-"));
  const { environment, limaHome } = buildSandboxEnvironment(sandboxRoot);
  const executable = environment.LIMACTL || "limactl";
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const revision = resolveRevision(path.dirname(scriptDirectory), options.revision);
  const host = collectHostObservations();
  const runner = createCommandRunner({
    executable,
    environment,
    cwd: path.dirname(scriptDirectory),
    logsDirectory,
    commandTimeoutMs: options.timeoutSeconds * 1000,
  });

  let runResult;
  try {
    runResult = await runProbe({
      commandRunner: runner,
      host,
      revision: revision.value,
      instanceName: options.instanceName,
      expectedArch: host.lima_architecture,
      executable,
      timeoutSeconds: options.timeoutSeconds,
      outputPath,
      logsDirectory,
    });
  } catch (error) {
    runResult = {
      evidence: baseEvidence({
        revision: revision.value,
        instanceName: options.instanceName,
        host,
        executable,
        timeoutSeconds: options.timeoutSeconds,
        outputPath,
        logsDirectory,
      }),
      instanceMayExist: true,
    };
    runResult.evidence.result.diagnostics = [excerpt(`probe execution error: ${errorMessage(error)}`)];
  }

  let cleanupResult = null;
  let cleanupConfirmed = true;
  if (runResult.instanceMayExist) {
    cleanupResult = await invokeLima(runner, {
      operation: "cleanup-delete",
      command: "delete",
      args: ["--force", options.instanceName],
      timeoutMs: options.timeoutSeconds * 1000,
    });
    const cleanupInspectionResult = await invokeLima(runner, {
      operation: "cleanup-verify",
      command: "list",
      args: machineReadableListArguments(),
    });
    const cleanupVerification = verifyCleanup(cleanupResult, cleanupInspectionResult, options.instanceName);
    const cleanupAbsent = cleanupVerification.absent;
    const cleanupPass = cleanupVerification.pass;
    cleanupConfirmed = cleanupPass;
    runResult.evidence.steps.push(
      makeStep({
        id: "cleanup",
        operation: "limactl delete --force",
        expectedState: { instance: options.instanceName, present: false },
        observedState: {
          delete_completed: commandPass(cleanupResult),
          post_delete_instance_absent: cleanupAbsent,
        },
        result: cleanupResult,
        pass: cleanupPass,
        diagnostic: cleanupPass
          ? undefined
          : cleanupAbsent
            ? "cleanup delete failed; isolated Lima state was retained"
            : "cleanup verification found the instance or ambiguous machine-readable state",
      }),
    );
    runResult.evidence.steps[runResult.evidence.steps.length - 1].raw_logs = {
      delete: cleanupResult.rawLogs,
      verify: cleanupInspectionResult.rawLogs,
    };
    runResult.evidence.result.duration_ms +=
      (cleanupResult.durationMs ?? 0) + (cleanupInspectionResult.durationMs ?? 0);
    if (!cleanupPass) {
      runResult.evidence.result.pass = false;
      runResult.evidence.result.exit_status = 1;
      runResult.evidence.result.diagnostics.push(
        "cleanup failed; do not remove the retained temporary Lima state manually without review",
      );
    }
  } else {
    runResult.evidence.steps.push(
      makeStep({
        id: "cleanup",
        operation: "limactl delete --force",
        expectedState: { instance: options.instanceName, present: false },
        observedState: { attempted: false },
        pass: true,
        diagnostic: "no instance was created; cleanup was not required",
      }),
    );
  }

  const cleanupPass = cleanupResult === null || cleanupConfirmed;
  if (cleanupPass) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
  runResult.evidence.probe.cleanup = {
    lima_home: limaHome,
    isolated_state_removed: cleanupPass,
  };
  writeEvidence(outputPath, runResult.evidence);
  console.log(
    JSON.stringify({
      evidence_path: outputPath,
      raw_log_directory: logsDirectory,
      pass: runResult.evidence.result.pass,
      exit_status: runResult.evidence.result.exit_status,
      isolated_lima_state_removed: cleanupPass,
    }),
  );
  return runResult.evidence.result.pass ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(excerpt(errorMessage(error)));
      process.exitCode = 2;
    });
}
