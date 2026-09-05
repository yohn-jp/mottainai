import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_DIAGNOSTIC_CHARS,
  collectHostObservations,
  createCommandRunner,
  findLimaInstance,
  parseLimaListOutput,
  publicInstanceState,
} from "./lima-validation-probe.mjs";

// Issue #655 — physical-delivery proof that the exact canonical
// `.#runtime-appliance-image` raw disk boots through Lima on Linux/KVM. This
// is a research/evidence harness only, distinct from the #649
// lima-validation-probe.mjs (which exercises Lima's own lifecycle against
// Lima's stock `template:alpine`, not the canonical appliance). It never
// builds a surrogate NixOS guest configuration and never changes the
// canonical appliance's guest semantics (nix/modules/runtime.nix,
// nix/runtime-appliance-image.nix) — it only supplies Lima-side delivery
// configuration (a `images:` base-disk override and an `additionalDisks:`
// key-carrier disk) on top of the same disk `nix build .#runtime-appliance-image`
// produces.
export const PROBE_VERSION = "0.1.0";
export const EVIDENCE_SCHEMA = "mottainai.lima-appliance-boot.v1";
export const DEFAULT_INSTANCE_NAME = "mottainai-655-appliance-probe";
export const BOOTSTRAP_KEY_LABEL = "MTNAI_BOOT";
export const CONTROL_USER = "mottainai-control";
export const SENTINEL_PATH = "/var/lib/mottainai-control/lima-boot-probe-sentinel";
export const SENTINEL_MARKER = "mottainai-655-lima-appliance-boot-probe";

function excerpt(value, limit = MAX_DIAGNOSTIC_CHARS) {
  const text = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function commandPass(result) {
  return result?.exitStatus === 0 && !result?.timedOut && !result?.error;
}

function nextOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

export function parseArguments(argv = process.argv.slice(2)) {
  const options = {
    manifest: undefined,
    disk: undefined,
    output: "./lima-appliance-boot-evidence.json",
    logs: undefined,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    instanceName: DEFAULT_INSTANCE_NAME,
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
    if (optionName === "--manifest") {
      options.manifest = inlineValue ?? nextOptionValue(argv, index++, "--manifest");
      continue;
    }
    if (optionName === "--disk") {
      options.disk = inlineValue ?? nextOptionValue(argv, index++, "--disk");
      continue;
    }
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
      if (!/^\d+$/u.test(value)) throw new Error("--timeout-seconds must be a positive integer");
      options.timeoutSeconds = Number.parseInt(value, 10);
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
    throw new Error(`unknown option: ${argument}`);
  }
  if (!options.help) {
    if (!options.manifest) throw new Error("--manifest is required");
    if (!options.disk) throw new Error("--disk is required");
  }
  return options;
}

function readManifest(manifestPath) {
  const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    value.contractId !== "mottainai.linux-runtime-appliance.v1" ||
    value.schemaVersion !== 1 ||
    typeof value.image !== "object" ||
    value.image === null ||
    value.image.format !== "raw" ||
    typeof value.image.sha256 !== "string" ||
    typeof value.image.sizeBytes !== "number"
  ) {
    throw new Error(`canonical Runtime Appliance manifest is invalid or unsupported: ${manifestPath}`);
  }
  return value;
}

export function verifyApplianceDisk(manifest, diskPath, createHash) {
  const stat = fs.statSync(diskPath);
  if (stat.size !== manifest.image.sizeBytes) {
    return { pass: false, diagnostic: `disk size mismatch; expected ${manifest.image.sizeBytes}, got ${stat.size}` };
  }
  const hash = createHash("sha256");
  const descriptor = fs.openSync(diskPath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const actual = hash.digest("hex");
  if (actual !== manifest.image.sha256) {
    return { pass: false, diagnostic: `disk SHA-256 mismatch; expected ${manifest.image.sha256}, got ${actual}` };
  }
  return { pass: true, sha256: actual, sizeBytes: stat.size };
}

function limaArchitecture(nodeArchitecture) {
  return { x64: "x86_64", arm64: "aarch64" }[nodeArchitecture];
}

function writeLimaTemplate({ templatePath, diskPath, diskDigest, architecture, keyDiskPath }) {
  // Every field here is Lima's own documented/public limayaml surface
  // (https://lima-vm.io/docs/reference/limayaml/): `images[].location` lets
  // an operator boot Lima from an existing local disk instead of Lima's
  // downloaded template base image, and `additionalDisks` attaches a second
  // disk. Neither field, nor `--plain`, changes anything Lima expects of the
  // guest OS; they only change which bytes Lima boots and mounts. No
  // cloud-init/user-data/provision stanza is present — the guest never
  // exposes the surface those would target, and adding one would be exactly
  // the "Lima-specific NixOS fork" the Issue forbids.
  const template = [
    "images:",
    `  - location: "file://${diskPath}"`,
    `    arch: "${architecture}"`,
    `    digest: "sha256:${diskDigest}"`,
    "additionalDisks:",
    `  - name: "${path.basename(keyDiskPath, ".raw")}"`,
    "cpus: 2",
    'memory: "2GiB"',
    'disk: "0GiB"',
    "mounts: []",
    "containerd:",
    "  system: false",
    "  user: false",
    "",
  ].join("\n");
  fs.writeFileSync(templatePath, template, { encoding: "utf8", mode: 0o600 });
}

function globalLimaArguments(command, args) {
  return ["--tty=false", "--log-format", "json", "--log-level", "info", command, ...args];
}

async function invokeLima(commandRunner, { operation, command, args = [], timeoutMs } = {}) {
  return commandRunner({ operation, args: globalLimaArguments(command, args), timeoutMs });
}

function machineReadableListArguments(instanceName) {
  return ["--all-fields", "--format", "json", ...(instanceName ? [instanceName] : [])];
}

export async function runSsh({
  port,
  privateKeyPath,
  knownHostsPath,
  command,
  timeoutMs = 20_000,
  execFileImpl = execFile,
}) {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "ConnectTimeout=5",
    "-i",
    privateKeyPath,
    "-p",
    String(port),
    `${CONTROL_USER}@127.0.0.1`,
    command,
  ];
  try {
    const result = await promisify(execFileImpl)("ssh", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return { pass: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      pass: false,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      diagnostic: excerpt(errorMessage(error)),
    };
  }
}

function makeStep({ id, expectedState, observedState, pass, diagnostic, result }) {
  const diagnostics = [];
  if (diagnostic) diagnostics.push(excerpt(diagnostic));
  if (result?.stderr) diagnostics.push(excerpt(result.stderr));
  return {
    id,
    expected_state: expectedState ?? null,
    observed_state: observedState ?? null,
    pass: pass === null ? null : Boolean(pass),
    status: pass === null ? "skipped" : pass ? "passed" : "failed",
    diagnostics: [...new Set(diagnostics)].slice(0, 3),
  };
}

function baseEvidence({ revision, instanceName, host, executable, timeoutSeconds, manifest, diskVerification }) {
  return {
    schema_version: EVIDENCE_SCHEMA,
    probe: {
      name: "Mottainai canonical Runtime Appliance Lima boot probe",
      version: PROBE_VERSION,
      issue: 655,
      repository: "yohn-jp/mottainai",
      instance_name: instanceName,
      timeout_seconds: timeoutSeconds,
    },
    mottainai_revision: revision,
    host,
    lima: { executable, version: null },
    appliance: {
      manifest,
      disk_verification: diskVerification,
    },
    steps: [],
    result: { pass: false, exit_status: 1, diagnostics: [] },
  };
}

function appendDiagnostic(evidence, diagnostic) {
  if (!diagnostic) return;
  const value = excerpt(diagnostic);
  if (!evidence.result.diagnostics.includes(value)) evidence.result.diagnostics.push(value);
  evidence.result.diagnostics = evidence.result.diagnostics.slice(0, 8);
}

export async function runApplianceBootProbe({
  commandRunner,
  host,
  revision,
  instanceName,
  executable,
  timeoutSeconds,
  manifest,
  diskVerification,
  diskPath,
  keyDiskPath,
  templatePath,
  sshPrivateKeyPath,
  sshKnownHostsPath,
  sshRunner = runSsh,
} = {}) {
  const evidence = baseEvidence({
    revision,
    instanceName,
    host,
    executable,
    timeoutSeconds,
    manifest,
    diskVerification,
  });
  let instanceMayExist = false;

  const hostPass = host?.os === "linux" && host?.kvm?.readable_writable === true;
  evidence.steps.push(
    makeStep({
      id: "host-prerequisites",
      expectedState: { os: "linux", kvm: "readable and writable /dev/kvm" },
      observedState: { os: host?.os ?? null, kvm: host?.kvm ?? null },
      pass: hostPass,
      diagnostic: hostPass ? undefined : "native Linux/KVM prerequisites are not satisfied",
    }),
  );
  evidence.steps.push(
    makeStep({
      id: "appliance-disk-identity",
      expectedState: { sizeBytes: manifest.image.sizeBytes, sha256: manifest.image.sha256 },
      observedState: diskVerification,
      pass: diskVerification.pass,
      diagnostic: diskVerification.pass ? undefined : diskVerification.diagnostic,
    }),
  );
  if (!hostPass || !diskVerification.pass) {
    appendDiagnostic(evidence, "probe stopped before Lima instance creation");
    evidence.result.pass = false;
    return { evidence, instanceMayExist };
  }

  const versionResult = await invokeLima(commandRunner, { operation: "lima-version", command: "--version" });
  const version = excerpt(versionResult.stdout || versionResult.stderr, 128);
  evidence.lima.version = version || null;
  evidence.steps.push(
    makeStep({
      id: "lima-version",
      expectedState: { available: true },
      observedState: { version: version || null },
      result: versionResult,
      pass: commandPass(versionResult) && version.length > 0,
    }),
  );
  if (!commandPass(versionResult)) {
    appendDiagnostic(evidence, "probe stopped because limactl --version failed");
    evidence.result.pass = false;
    return { evidence, instanceMayExist };
  }

  const createResult = await invokeLima(commandRunner, {
    operation: "create",
    command: "create",
    args: ["--name", instanceName, "--vm-type", "qemu", "--plain", templatePath],
  });
  instanceMayExist = true;
  evidence.steps.push(
    makeStep({
      id: "create",
      expectedState: { status: "Stopped", vmType: "qemu", base_disk: "canonical runtime-appliance-image raw disk" },
      observedState: { command_completed: commandPass(createResult) },
      result: createResult,
      pass: commandPass(createResult),
      diagnostic: commandPass(createResult)
        ? undefined
        : "Lima instance creation from the canonical appliance disk failed",
    }),
  );
  if (!commandPass(createResult)) {
    appendDiagnostic(evidence, "probe stopped after create failed");
    evidence.result.pass = false;
    return { evidence, instanceMayExist };
  }

  // The primary, expected-to-fail observation for Issue #655: Lima's own
  // readiness gate (Running / "user session is ready for ssh") is driven by
  // guest-side cloud-init-delivered boot.sh scripts writing
  // /run/lima-boot-done and /run/lima-ssh-ready. The canonical appliance has
  // no cloud-init and never runs those scripts, so this is expected to time
  // out even when the guest itself booted correctly. The probe records
  // exactly this, rather than papering over it with a longer timeout or a
  // guest-side change.
  const startResult = await invokeLima(commandRunner, {
    operation: "start",
    command: "start",
    args: [instanceName, "--timeout", `${timeoutSeconds}s`],
    timeoutMs: (timeoutSeconds + 30) * 1000,
  });
  const startPass = commandPass(startResult);
  evidence.steps.push(
    makeStep({
      id: "limactl-start-readiness-gate",
      expectedState: { status: "Running", note: "expected to fail — see appliance-boot-blocked-diagnostic below" },
      observedState: { command_completed: startPass, timed_out: Boolean(startResult.timedOut) },
      result: startResult,
      pass: startPass,
      diagnostic: startPass
        ? undefined
        : "limactl start did not observe Lima's own boot-done/ssh-ready readiness signal (expected: canonical appliance has no cloud-init and never runs Lima's boot.sh)",
    }),
  );

  const inspectResult = await invokeLima(commandRunner, {
    operation: "inspect-after-start",
    command: "list",
    args: machineReadableListArguments(instanceName),
  });
  const parsed = parseLimaListOutput(inspectResult.stdout ?? "");
  const found = findLimaInstance(parsed.records, instanceName);
  const state = found.kind === "found" ? publicInstanceState(found.record) : null;
  evidence.steps.push(
    makeStep({
      id: "inspect-after-start",
      expectedState: null,
      observedState: state,
      result: inspectResult,
      pass: found.kind === "found",
      diagnostic:
        found.kind === "found" ? undefined : "post-start machine-readable inspection did not find the instance",
    }),
  );

  const sshLocalPort = state?.sshLocalPort;
  let directSshResult = null;
  let sentinelWriteResult = null;
  let sentinelSurviveResult = null;
  if (typeof sshLocalPort === "number") {
    // Independent of Lima's own readiness gate: dial the guest's real sshd
    // directly through the same QEMU user-mode hostfwd port Lima itself
    // reports, authenticating with the appliance's own bounded first-boot
    // key bootstrap (nix/modules/runtime.nix
    // mottainai-runtime-bootstrap-authorized-keys.service, fed by the
    // `additionalDisks` MTNAI_BOOT disk this probe attached). This checks
    // whether the appliance is genuinely usable even though Lima's own CLI
    // never reports it as Running.
    directSshResult = await sshRunner({
      port: sshLocalPort,
      privateKeyPath: sshPrivateKeyPath,
      knownHostsPath: sshKnownHostsPath,
      command: "nix --version",
    });
    evidence.steps.push(
      makeStep({
        id: "direct-ssh-nix-version",
        expectedState: { reachable: true, command: "nix --version" },
        observedState: { pass: directSshResult.pass, stdout: excerpt(directSshResult.stdout, 128) },
        pass: directSshResult.pass,
        diagnostic: directSshResult.pass ? undefined : directSshResult.diagnostic,
      }),
    );

    if (directSshResult.pass) {
      sentinelWriteResult = await sshRunner({
        port: sshLocalPort,
        privateKeyPath: sshPrivateKeyPath,
        knownHostsPath: sshKnownHostsPath,
        command: `mkdir -p $(dirname ${SENTINEL_PATH}) && printf '%s\\n' ${SENTINEL_MARKER} > ${SENTINEL_PATH} && cat ${SENTINEL_PATH}`,
      });
      evidence.steps.push(
        makeStep({
          id: "sentinel-write",
          expectedState: { path: SENTINEL_PATH, content: SENTINEL_MARKER },
          observedState: { pass: sentinelWriteResult.pass, stdout: excerpt(sentinelWriteResult.stdout, 128) },
          pass: sentinelWriteResult.pass && sentinelWriteResult.stdout.trim() === SENTINEL_MARKER,
          diagnostic: sentinelWriteResult.pass ? undefined : sentinelWriteResult.diagnostic,
        }),
      );

      // limactl restart/stop are themselves gated on Lima's own Running
      // status tracking, which never converged above — using them here
      // would reintroduce the same blocked gate for the reboot step. A
      // direct guest-issued reboot exercises actual persistence across a
      // real appliance restart without depending on Lima's status machine.
      const rebootResult = await sshRunner({
        port: sshLocalPort,
        privateKeyPath: sshPrivateKeyPath,
        knownHostsPath: sshKnownHostsPath,
        command: "sudo -n systemctl reboot",
        timeoutMs: 5_000,
      }).catch(() => ({ pass: false }));
      evidence.steps.push(
        makeStep({
          id: "guest-issued-reboot",
          expectedState: { command: "systemctl reboot" },
          observedState: { attempted: true },
          pass: null,
          diagnostic: "reboot connection drop is expected; reconnection is verified by sentinel-survives-reboot below",
        }),
      );
      void rebootResult;

      const reconnect = async (attempt) =>
        sshRunner({
          port: sshLocalPort,
          privateKeyPath: sshPrivateKeyPath,
          knownHostsPath: sshKnownHostsPath,
          command: `cat ${SENTINEL_PATH}`,
          timeoutMs: 5_000,
        }).then((result) => ({ ...result, attempt }));
      const deadline = Date.now() + timeoutSeconds * 1000;
      let attempt = 0;
      while (Date.now() < deadline) {
        attempt += 1;
        sentinelSurviveResult = await reconnect(attempt);
        if (sentinelSurviveResult.pass) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      const sentinelSurvived =
        Boolean(sentinelSurviveResult?.pass) && sentinelSurviveResult.stdout.trim() === SENTINEL_MARKER;
      evidence.steps.push(
        makeStep({
          id: "sentinel-survives-reboot",
          expectedState: { path: SENTINEL_PATH, content: SENTINEL_MARKER, ssh_reconnect: true },
          observedState: {
            pass: sentinelSurvived,
            attempts: sentinelSurviveResult?.attempt ?? 0,
            stdout: excerpt(sentinelSurviveResult?.stdout, 128),
          },
          pass: sentinelSurvived,
          diagnostic: sentinelSurvived
            ? undefined
            : "guest did not become reachable with the sentinel intact within the timeout",
        }),
      );
    }
  } else {
    evidence.steps.push(
      makeStep({
        id: "direct-ssh-nix-version",
        expectedState: { reachable: true },
        observedState: { sshLocalPort: null },
        pass: false,
        diagnostic: "no sshLocalPort was reported by machine-readable inspection; direct SSH could not be attempted",
      }),
    );
  }

  evidence.result.appliance_boot_blocked_diagnostic = startPass
    ? null
    : "Lima's documented readiness gate (limactl start / Running status) requires guest-side cloud-init-delivered boot.sh to write /run/lima-boot-done and /run/lima-ssh-ready. The canonical runtime-appliance-image has no cloud-init and never runs those scripts, so limactl start cannot converge without changing canonical guest semantics. See docs/testing/integration/lima-appliance-boot-probe.md.";

  // Overall pass criterion for #655's acceptance is intentionally about
  // actual usability (SSH, nix --version, sentinel survives reboot), not
  // about Lima's own "Running" status label — that label is exactly the
  // part this probe demonstrates is not reachable without a guest-side
  // change the Issue forbids.
  const usabilityPass =
    Boolean(directSshResult?.pass) &&
    Boolean(sentinelWriteResult?.pass) &&
    Boolean(sentinelSurviveResult?.pass) &&
    sentinelSurviveResult.stdout.trim() === SENTINEL_MARKER;
  evidence.result.pass = usabilityPass;
  evidence.result.exit_status = usabilityPass ? 0 : 1;
  evidence.result.lima_reported_running = startPass;
  if (!startPass) appendDiagnostic(evidence, evidence.result.appliance_boot_blocked_diagnostic);
  if (!usabilityPass)
    appendDiagnostic(evidence, "guest usability (SSH / nix --version / sentinel-survives-reboot) did not fully pass");

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
  for (const key of [
    "LIMA_INSTANCE",
    "LIMA_SHELL",
    "LIMA_SHELLENV_ALLOW",
    "LIMA_SHELLENV_BLOCK",
    "LIMA_SSH_OVER_VSOCK",
    "LIMA_TEMPLATES_PATH",
    "LIMA_WORKDIR",
  ]) {
    delete environment[key];
  }
  return { environment, limaHome };
}

function writeEvidence(filePath, evidence) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function helpText() {
  return [
    "Usage: node scripts/lima-appliance-boot-probe.mjs --manifest PATH --disk PATH [options]",
    "",
    "Required:",
    "  --manifest PATH   runtime-appliance-manifest.json produced by build-runtime-appliance-manifest.mjs",
    "  --disk PATH       mottainai-runtime-appliance.raw produced by nix build .#runtime-appliance-image",
    "",
    "Options:",
    "  --output PATH             Evidence JSON path (default: ./lima-appliance-boot-evidence.json)",
    "  --logs PATH               Bounded raw-log directory (default: beside evidence)",
    "  --timeout-seconds N       Per-Lima-operation and reboot-reconnect timeout, 1..900 (default: 180)",
    "  --instance-name NAME      Isolated Lima instance name",
    "",
    "Requires native Linux, usable /dev/kvm, limactl, ssh, and ssh-keygen. Cleans up its isolated instance and state.",
  ].join("\n");
}

async function generateSshKeyPair(sandboxRoot, execFileImpl = execFile) {
  const privateKeyPath = path.join(sandboxRoot, "id_ed25519");
  await promisify(execFileImpl)("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privateKeyPath], {
    windowsHide: true,
  });
  const publicKey = fs.readFileSync(`${privateKeyPath}.pub`, "utf8").trim();
  return { privateKeyPath, publicKey };
}

function writeBootstrapKeyDisk(sandboxRoot, publicKey, execFileImpl = execFile) {
  const keyDiskDir = path.join(sandboxRoot, "bootstrap-key-disk");
  fs.mkdirSync(keyDiskDir, { recursive: true, mode: 0o700 });
  const authorizedKeysPath = path.join(keyDiskDir, "authorized_keys");
  fs.writeFileSync(authorizedKeysPath, `${publicKey}\n`, { encoding: "utf8", mode: 0o600 });
  const keyDiskPath = path.join(sandboxRoot, "mtnai-boot.raw");
  return promisify(execFileImpl)("mkfs.vfat", ["-n", BOOTSTRAP_KEY_LABEL, "-C", keyDiskPath, "1024"], {
    windowsHide: true,
  })
    .then(() =>
      promisify(execFileImpl)("mcopy", ["-i", keyDiskPath, authorizedKeysPath, "::authorized_keys"], {
        windowsHide: true,
      }),
    )
    .then(() => keyDiskPath);
}

async function main() {
  const options = parseArguments();
  if (options.help) {
    console.log(helpText());
    return 0;
  }

  const outputPath = path.resolve(options.output);
  const logsDirectory = path.resolve(options.logs ?? path.join(path.dirname(outputPath), "lima-appliance-boot-logs"));
  fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-lima-655-"));
  const { environment, limaHome } = buildSandboxEnvironment(sandboxRoot);
  const executable = environment.LIMACTL || "limactl";

  const manifestPath = path.resolve(options.manifest);
  const diskPath = path.resolve(options.disk);
  const manifest = readManifest(manifestPath);
  const diskVerification = verifyApplianceDisk(manifest, diskPath, createHash);
  const host = collectHostObservations();
  const architecture = limaArchitecture(process.arch);

  const { privateKeyPath, publicKey } = await generateSshKeyPair(sandboxRoot);
  const sshKnownHostsPath = path.join(sandboxRoot, "known_hosts");
  fs.writeFileSync(sshKnownHostsPath, "", { encoding: "utf8", mode: 0o600 });

  let keyDiskPath;
  let templatePath;
  try {
    keyDiskPath = await writeBootstrapKeyDisk(sandboxRoot, publicKey);
  } catch (error) {
    keyDiskPath = null;
    console.error(
      `mtnai-boot key-carrier disk could not be built (requires mkfs.vfat + mcopy from mtools/dosfstools): ${errorMessage(error)}`,
    );
  }

  const runner = createCommandRunner({
    executable,
    environment,
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    logsDirectory,
    commandTimeoutMs: options.timeoutSeconds * 1000,
  });

  let runResult;
  if (diskVerification.pass && keyDiskPath) {
    templatePath = path.join(sandboxRoot, "appliance.yaml");
    writeLimaTemplate({
      templatePath,
      diskPath,
      diskDigest: manifest.image.sha256,
      architecture: architecture ?? manifest.architecture.replace("-linux", ""),
      keyDiskPath,
    });
    runResult = await runApplianceBootProbe({
      commandRunner: runner,
      host,
      revision: manifest.sourceRevision,
      instanceName: options.instanceName,
      executable,
      timeoutSeconds: options.timeoutSeconds,
      manifest,
      diskVerification,
      diskPath,
      keyDiskPath,
      templatePath,
      sshPrivateKeyPath: privateKeyPath,
      sshKnownHostsPath,
    });
  } else {
    const evidence = baseEvidence({
      revision: manifest.sourceRevision,
      instanceName: options.instanceName,
      host,
      executable,
      timeoutSeconds: options.timeoutSeconds,
      manifest,
      diskVerification,
    });
    appendDiagnostic(
      evidence,
      diskVerification.pass ? "bootstrap key-carrier disk could not be built" : diskVerification.diagnostic,
    );
    evidence.result.pass = false;
    runResult = { evidence, instanceMayExist: false };
  }

  let cleanupConfirmed = true;
  if (runResult.instanceMayExist) {
    const deleteResult = await invokeLima(runner, {
      operation: "cleanup-delete",
      command: "delete",
      args: ["--force", options.instanceName],
      timeoutMs: options.timeoutSeconds * 1000,
    });
    const verifyResult = await invokeLima(runner, {
      operation: "cleanup-verify",
      command: "list",
      args: machineReadableListArguments(),
    });
    const verifyParsed = parseLimaListOutput(verifyResult.stdout ?? "");
    const absent =
      commandPass(verifyResult) && findLimaInstance(verifyParsed.records, options.instanceName).kind === "missing";
    cleanupConfirmed = commandPass(deleteResult) && absent;
    runResult.evidence.steps.push(
      makeStep({
        id: "cleanup",
        expectedState: { instance: options.instanceName, present: false },
        observedState: { delete_completed: commandPass(deleteResult), post_delete_instance_absent: absent },
        result: deleteResult,
        pass: cleanupConfirmed,
        diagnostic: cleanupConfirmed
          ? undefined
          : "cleanup delete failed or instance is still present; isolated Lima state was retained",
      }),
    );
    if (!cleanupConfirmed) {
      runResult.evidence.result.pass = false;
      runResult.evidence.result.exit_status = 1;
      appendDiagnostic(
        runResult.evidence,
        "cleanup failed; do not remove the retained temporary Lima state manually without review",
      );
    }
  }

  if (cleanupConfirmed) fs.rmSync(sandboxRoot, { recursive: true, force: true });
  runResult.evidence.probe.cleanup = { lima_home: limaHome, isolated_state_removed: cleanupConfirmed };
  writeEvidence(outputPath, runResult.evidence);
  console.log(
    JSON.stringify({
      evidence_path: outputPath,
      raw_log_directory: logsDirectory,
      pass: runResult.evidence.result.pass,
      lima_reported_running: runResult.evidence.result.lima_reported_running ?? false,
      exit_status: runResult.evidence.result.exit_status,
      isolated_lima_state_removed: cleanupConfirmed,
    }),
  );
  return runResult.evidence.result.exit_status;
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
