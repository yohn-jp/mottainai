import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BOOTSTRAP_KEY_LABEL,
  CONTROL_USER,
  DEFAULT_INSTANCE_NAME,
  SENTINEL_MARKER,
  SENTINEL_PATH,
  parseArguments,
  runApplianceBootProbe,
  verifyApplianceDisk,
} from "./lima-appliance-boot-probe.mjs";

test("argument parsing requires --manifest and --disk and stays bounded", () => {
  assert.throws(() => parseArguments([]), /--manifest is required/u);
  assert.throws(() => parseArguments(["--manifest", "m.json"]), /--disk is required/u);
  const parsed = parseArguments(["--manifest", "m.json", "--disk", "d.raw", "--timeout-seconds=90"]);
  assert.equal(parsed.manifest, "m.json");
  assert.equal(parsed.disk, "d.raw");
  assert.equal(parsed.timeoutSeconds, 90);
  assert.equal(parsed.instanceName, DEFAULT_INSTANCE_NAME);
  assert.throws(() => parseArguments(["--manifest", "m", "--disk", "d", "--timeout-seconds", "901"]), /at most 900/u);
  assert.throws(() => parseArguments(["--manifest", "m", "--disk", "d", "--unknown"]), /unknown option/u);
  assert.deepEqual(parseArguments(["--help"]), {
    manifest: undefined,
    disk: undefined,
    output: "./lima-appliance-boot-evidence.json",
    logs: undefined,
    timeoutSeconds: 180,
    instanceName: DEFAULT_INSTANCE_NAME,
    help: true,
  });
});

test("appliance disk verification fails closed on size and digest mismatch, passes on an exact match", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-655-disk-"));
  const diskPath = path.join(directory, "mottainai-runtime-appliance.raw");
  const content = Buffer.from("fixture-appliance-disk-bytes");
  fs.writeFileSync(diskPath, content);
  const sha256 = createHash("sha256").update(content).digest("hex");

  const mismatchSize = verifyApplianceDisk({ image: { sizeBytes: content.length + 1, sha256 } }, diskPath, createHash);
  assert.equal(mismatchSize.pass, false);
  assert.match(mismatchSize.diagnostic, /size mismatch/u);

  const mismatchDigest = verifyApplianceDisk(
    { image: { sizeBytes: content.length, sha256: "0".repeat(64) } },
    diskPath,
    createHash,
  );
  assert.equal(mismatchDigest.pass, false);
  assert.match(mismatchDigest.diagnostic, /SHA-256 mismatch/u);

  const match = verifyApplianceDisk({ image: { sizeBytes: content.length, sha256 } }, diskPath, createHash);
  assert.equal(match.pass, true);
  assert.equal(match.sha256, sha256);

  fs.rmSync(directory, { recursive: true, force: true });
});

const FIXTURE_MANIFEST = {
  contractId: "mottainai.linux-runtime-appliance.v1",
  schemaVersion: 1,
  architecture: "x86_64-linux",
  sourceRevision: "f".repeat(40),
  image: { filename: "mottainai-runtime-appliance.raw", format: "raw", sizeBytes: 1024, sha256: "a".repeat(64) },
};

const FIXTURE_HOST = {
  os: "linux",
  architecture: "x64",
  lima_architecture: "x86_64",
  kvm: { path: "/dev/kvm", readable_writable: true },
};

function fakeLimaRunner({
  createExitStatus = 0,
  startExitStatus = 0,
  startTimedOut = false,
  sshLocalPort = 60022,
} = {}) {
  return async ({ operation, args }) => {
    const command = args.find((argument, index) => !argument.startsWith("--") && args[index - 1] !== "--log-level");
    void command;
    if (args.includes("--version"))
      return { exitStatus: 0, stdout: "limactl version 1.0.0\n", stderr: "", durationMs: 1 };
    if (args.includes("create")) return { exitStatus: createExitStatus, stdout: "", stderr: "", durationMs: 1 };
    if (args.includes("start")) {
      return { exitStatus: startExitStatus, timedOut: startTimedOut, stdout: "", stderr: "", durationMs: 1 };
    }
    if (args.includes("list")) {
      const record = {
        name: DEFAULT_INSTANCE_NAME,
        status: startExitStatus === 0 ? "Running" : "Starting",
        vmType: "qemu",
        arch: "x86_64",
        sshLocalPort,
      };
      return { exitStatus: 0, stdout: `${JSON.stringify(record)}\n`, stderr: "", durationMs: 1 };
    }
    if (args.includes("delete")) return { exitStatus: 0, stdout: "", stderr: "", durationMs: 1 };
    throw new Error(`unexpected fake Lima operation: ${operation} ${args.join(" ")}`);
  };
}

test("records the expected limactl-start readiness-gate failure while still proving guest usability over direct SSH", async () => {
  const sshCalls = [];
  const sshRunner = async ({ command }) => {
    sshCalls.push(command);
    if (command === "nix --version") return { pass: true, stdout: "nix (Nix) 2.24.0\n", stderr: "" };
    if (command.includes(`> ${SENTINEL_PATH}`)) return { pass: true, stdout: `${SENTINEL_MARKER}\n`, stderr: "" };
    if (command === "sudo -n systemctl reboot") return { pass: false, stdout: "", stderr: "connection reset" };
    if (command === `cat ${SENTINEL_PATH}`) return { pass: true, stdout: `${SENTINEL_MARKER}\n`, stderr: "" };
    throw new Error(`unexpected fake SSH command: ${command}`);
  };

  const { evidence } = await runApplianceBootProbe({
    commandRunner: fakeLimaRunner({ startExitStatus: 1, startTimedOut: true }),
    host: FIXTURE_HOST,
    revision: FIXTURE_MANIFEST.sourceRevision,
    instanceName: DEFAULT_INSTANCE_NAME,
    executable: "limactl",
    timeoutSeconds: 1,
    manifest: FIXTURE_MANIFEST,
    diskVerification: {
      pass: true,
      sha256: FIXTURE_MANIFEST.image.sha256,
      sizeBytes: FIXTURE_MANIFEST.image.sizeBytes,
    },
    diskPath: "/fixture/mottainai-runtime-appliance.raw",
    keyDiskPath: "/fixture/mtnai-boot.raw",
    templatePath: "/fixture/appliance.yaml",
    sshPrivateKeyPath: "/fixture/id_ed25519",
    sshKnownHostsPath: "/fixture/known_hosts",
    sshRunner,
  });

  const startStep = evidence.steps.find((step) => step.id === "limactl-start-readiness-gate");
  assert.equal(startStep.pass, false);
  assert.match(startStep.diagnostics.join(" "), /boot-done\/ssh-ready/u);

  assert.equal(evidence.result.lima_reported_running, false);
  assert.match(evidence.result.appliance_boot_blocked_diagnostic, /cloud-init/u);

  const directSshStep = evidence.steps.find((step) => step.id === "direct-ssh-nix-version");
  assert.equal(directSshStep.pass, true);
  const sentinelWriteStep = evidence.steps.find((step) => step.id === "sentinel-write");
  assert.equal(sentinelWriteStep.pass, true);
  const sentinelSurvivesStep = evidence.steps.find((step) => step.id === "sentinel-survives-reboot");
  assert.equal(sentinelSurvivesStep.pass, true);

  // Overall pass is about actual guest usability, not Lima's own status label.
  assert.equal(evidence.result.pass, true);
  assert.equal(evidence.result.exit_status, 0);
  assert.deepEqual(sshCalls.filter((command) => command === "nix --version").length, 1);
});

test("fails closed when the appliance disk digest does not match the manifest, without contacting Lima", async () => {
  const commandRunner = async () => {
    throw new Error("commandRunner must not be invoked when disk verification fails");
  };
  const { evidence, instanceMayExist } = await runApplianceBootProbe({
    commandRunner,
    host: FIXTURE_HOST,
    revision: FIXTURE_MANIFEST.sourceRevision,
    instanceName: DEFAULT_INSTANCE_NAME,
    executable: "limactl",
    timeoutSeconds: 1,
    manifest: FIXTURE_MANIFEST,
    diskVerification: { pass: false, diagnostic: "disk SHA-256 mismatch; expected aaaa, got bbbb" },
    diskPath: "/fixture/mottainai-runtime-appliance.raw",
    keyDiskPath: "/fixture/mtnai-boot.raw",
    templatePath: "/fixture/appliance.yaml",
    sshPrivateKeyPath: "/fixture/id_ed25519",
    sshKnownHostsPath: "/fixture/known_hosts",
  });
  assert.equal(evidence.result.pass, false);
  assert.equal(instanceMayExist, false);
  const identityStep = evidence.steps.find((step) => step.id === "appliance-disk-identity");
  assert.equal(identityStep.pass, false);
});

test("skips direct SSH when machine-readable inspection reports no sshLocalPort", async () => {
  const commandRunner = async ({ args }) => {
    if (args.includes("--version"))
      return { exitStatus: 0, stdout: "limactl version 1.0.0\n", stderr: "", durationMs: 1 };
    if (args.includes("create")) return { exitStatus: 0, stdout: "", stderr: "", durationMs: 1 };
    if (args.includes("start")) return { exitStatus: 1, timedOut: true, stdout: "", stderr: "", durationMs: 1 };
    if (args.includes("list")) {
      const record = { name: DEFAULT_INSTANCE_NAME, status: "Starting", vmType: "qemu", arch: "x86_64" };
      return { exitStatus: 0, stdout: `${JSON.stringify(record)}\n`, stderr: "", durationMs: 1 };
    }
    throw new Error("unexpected fake Lima call");
  };
  const { evidence } = await runApplianceBootProbe({
    commandRunner,
    host: FIXTURE_HOST,
    revision: FIXTURE_MANIFEST.sourceRevision,
    instanceName: DEFAULT_INSTANCE_NAME,
    executable: "limactl",
    timeoutSeconds: 1,
    manifest: FIXTURE_MANIFEST,
    diskVerification: {
      pass: true,
      sha256: FIXTURE_MANIFEST.image.sha256,
      sizeBytes: FIXTURE_MANIFEST.image.sizeBytes,
    },
    diskPath: "/fixture/mottainai-runtime-appliance.raw",
    keyDiskPath: "/fixture/mtnai-boot.raw",
    templatePath: "/fixture/appliance.yaml",
    sshPrivateKeyPath: "/fixture/id_ed25519",
    sshKnownHostsPath: "/fixture/known_hosts",
  });
  const directSshStep = evidence.steps.find((step) => step.id === "direct-ssh-nix-version");
  assert.equal(directSshStep.pass, false);
  assert.match(directSshStep.diagnostics.join(" "), /sshLocalPort/u);
  assert.equal(evidence.result.pass, false);
});

test("exported constants match the bounded first-boot key bootstrap contract in nix/modules/runtime.nix", () => {
  assert.equal(BOOTSTRAP_KEY_LABEL, "MTNAI_BOOT");
  assert.equal(CONTROL_USER, "mottainai-control");
  assert.match(SENTINEL_PATH, /^\/var\/lib\/mottainai-control\//u);
});
