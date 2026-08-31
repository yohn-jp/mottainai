import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INSTANCE_NAME,
  collectHostObservations,
  classifyConcurrentStartResult,
  inspectKvmAcceleration,
  parseArguments,
  parseLimaListOutput,
  runProbe,
  validateInstanceState,
  verifyCleanup,
} from "./lima-validation-probe.mjs";

test("argument parsing stays bounded and supports a downloadable-script invocation", () => {
  assert.deepEqual(parseArguments(["--output", "evidence.json", "--logs=logs", "--timeout-seconds=90"]), {
    output: "evidence.json",
    logs: "logs",
    timeoutSeconds: 90,
    instanceName: DEFAULT_INSTANCE_NAME,
    revision: undefined,
    help: false,
  });
  assert.throws(() => parseArguments(["--timeout-seconds", "901"]), /at most 900/u);
  assert.throws(() => parseArguments(["--unknown"]), /unknown option/u);
});

test("Lima list output accepts documented JSON lines and fails closed on malformed output", () => {
  const parsed = parseLimaListOutput(
    `${JSON.stringify({ name: "one", status: "Stopped" })}\n${JSON.stringify({ name: "two", status: "Running" })}\n`,
  );
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.records.length, 2);

  const array = parseLimaListOutput(JSON.stringify([{ name: "one" }]));
  assert.deepEqual(array.errors, []);
  assert.deepEqual(array.records, [{ name: "one" }]);

  const malformed = parseLimaListOutput('{"name":"one"}\nnot-json\n');
  assert.equal(malformed.records.length, 1);
  assert.equal(malformed.errors.length, 1);
});

test("instance validation rejects unsupported and ambiguous state", () => {
  const base = { name: DEFAULT_INSTANCE_NAME, status: "Running", vmType: "qemu", arch: "x86_64" };
  assert.equal(
    validateInstanceState(
      { ...base, vmType: "vz" },
      {
        instanceName: DEFAULT_INSTANCE_NAME,
        expectedStatus: "Running",
        expectedArch: "x86_64",
      },
    ).pass,
    false,
  );
  assert.equal(
    validateInstanceState(
      { ...base, status: "Recovering" },
      {
        instanceName: DEFAULT_INSTANCE_NAME,
        expectedStatus: "Running",
        expectedArch: "x86_64",
      },
    ).pass,
    false,
  );
  assert.equal(
    validateInstanceState(
      { name: DEFAULT_INSTANCE_NAME, status: "Running", vmType: "qemu" },
      {
        instanceName: DEFAULT_INSTANCE_NAME,
        expectedStatus: "Running",
        expectedArch: "x86_64",
      },
    ).pass,
    false,
  );

  const baseline = validateInstanceState(
    { ...base, dir: "/tmp/one", sshLocalPort: 60022 },
    { instanceName: DEFAULT_INSTANCE_NAME, expectedStatus: "Running", expectedArch: "x86_64" },
  );
  const changedTransport = validateInstanceState(
    { ...base, dir: "/tmp/two", sshLocalPort: 60023 },
    {
      instanceName: DEFAULT_INSTANCE_NAME,
      expectedStatus: "Running",
      expectedArch: "x86_64",
      baselineIdentity: baseline.identity,
    },
  );
  assert.deepEqual(baseline.identity, { name: DEFAULT_INSTANCE_NAME, arch: "x86_64" });
  assert.equal(changedTransport.pass, true);
});

test("KVM acceleration remains fail-closed when Lima exposes no documented observation", () => {
  const internalLog = JSON.stringify({
    level: "debug",
    msg: "qCmd.Args: [/usr/bin/qemu-system-x86_64 -machine q35,accel=kvm]",
  });
  const observation = inspectKvmAcceleration({ stderr: `${internalLog}\n` });
  assert.equal(observation.pass, false);
  assert.equal(observation.status, "blocked-public-surface");
  assert.match(observation.diagnostic, /documented\/public/u);
});

test("concurrent start outcomes distinguish convergence from unknown provider errors", () => {
  assert.equal(classifyConcurrentStartResult({ exitStatus: 0 }), "succeeded");
  assert.equal(
    classifyConcurrentStartResult({ exitStatus: 1, stderr: "instance is already running\n" }),
    "already-running",
  );
  assert.equal(classifyConcurrentStartResult({ exitStatus: 1, stderr: "permission denied\n" }), "failed");
});

test("host prerequisite probe records a readable/writable KVM character device", () => {
  const opened = [];
  const observed = collectHostObservations({
    platform: "linux",
    nodeArchitecture: "x64",
    kernelRelease: "fixture-kernel",
    kvmPath: "/fixture/dev/kvm",
    fsApi: {
      constants: { O_RDWR: 2 },
      statSync: () => ({ isCharacterDevice: () => true }),
      openSync: (_path, flags) => {
        opened.push(flags);
        return 7;
      },
      closeSync: () => {},
    },
  });
  assert.equal(observed.lima_architecture, "x86_64");
  assert.equal(observed.kvm.present, true);
  assert.equal(observed.kvm.character_device, true);
  assert.equal(observed.kvm.readable_writable, true);
  assert.deepEqual(opened, [2]);
});

test("cleanup requires both successful deletion and public post-delete absence", () => {
  const deleted = { exitStatus: 0, stdout: "", stderr: "", durationMs: 1 };
  const absent = { exitStatus: 0, stdout: "[]\n", stderr: "", durationMs: 1 };
  assert.equal(verifyCleanup(deleted, absent, DEFAULT_INSTANCE_NAME).pass, true);

  const stillPresent = {
    exitStatus: 0,
    stdout: `${JSON.stringify({ name: DEFAULT_INSTANCE_NAME, status: "Stopped" })}\n`,
    stderr: "",
    durationMs: 1,
  };
  assert.equal(verifyCleanup(deleted, stillPresent, DEFAULT_INSTANCE_NAME).pass, false);
  assert.equal(verifyCleanup({ ...deleted, exitStatus: 1 }, absent, DEFAULT_INSTANCE_NAME).pass, false);
});

test("full lifecycle harness uses only fake limactl output and records every required operation", async () => {
  let state = "missing";
  let inspectionNumber = 0;
  const calls = [];
  const record = () => ({
    name: DEFAULT_INSTANCE_NAME,
    status: state === "running" ? "Running" : "Stopped",
    vmType: "qemu",
    arch: "x86_64",
    dir: `/tmp/fixture-lima-instance-${inspectionNumber}`,
    sshLocalPort: 60022 + inspectionNumber,
  });
  const fakeRunner = async ({ operation, args }) => {
    calls.push({ operation, args });
    if (args.includes("--version")) {
      return { exitStatus: 0, stdout: "limactl version 2.1.0\n", stderr: "", durationMs: 1 };
    }
    const command = args.find((value) =>
      ["list", "create", "start", "stop", "restart", "shell", "delete"].includes(value),
    );
    if (command === "list") {
      if (operation === "missing-instance-lookup") {
        return { exitStatus: 1, stdout: "", stderr: "instance does not exist\n", durationMs: 1 };
      }
      inspectionNumber += 1;
      const output = state === "missing" ? "\n" : `${JSON.stringify(record())}\n`;
      return { exitStatus: 0, stdout: output, stderr: "", durationMs: 1 };
    }
    if (command === "create") {
      state = "stopped";
      return { exitStatus: 0, stdout: "", stderr: "", durationMs: 1 };
    }
    if (command === "start") {
      if (operation === "concurrent-ensure-b" && state === "running") {
        return { exitStatus: 1, stdout: "", stderr: "instance is already running\n", durationMs: 1 };
      }
      state = "running";
      return { exitStatus: 0, stdout: "", stderr: "", durationMs: 1 };
    }
    if (command === "stop") {
      state = "stopped";
      return { exitStatus: 0, stdout: "", stderr: "", durationMs: 1 };
    }
    if (command === "restart") {
      state = "running";
      return {
        exitStatus: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      };
    }
    if (command === "shell") return { exitStatus: 0, stdout: "", stderr: "", durationMs: 1 };
    throw new Error(`unexpected fake command: ${args.join(" ")}`);
  };

  const result = await runProbe({
    commandRunner: fakeRunner,
    host: {
      os: "linux",
      architecture: "x64",
      lima_architecture: "x86_64",
      kvm: { path: "/dev/kvm", readable_writable: true },
    },
    revision: "fixture-revision",
    now: () => 1,
  });

  assert.equal(result.evidence.result.pass, false);
  assert.equal(result.evidence.result.exit_status, 1);
  assert.equal(
    result.evidence.steps.some((step) => step.id === "kvm-acceleration" && step.status === "failed"),
    true,
  );
  assert.equal(
    result.evidence.steps.some((step) => step.id === "concurrent-ensure" && step.pass),
    true,
  );
  assert.equal(
    result.evidence.steps.some((step) => step.id === "repeated-stop" && step.pass),
    true,
  );
  assert.equal(
    result.evidence.steps.some((step) => step.id === "inspect-after-restart" && step.pass),
    true,
  );
  const restartedInspection = result.evidence.steps.find((step) => step.id === "inspect-after-restart");
  assert.deepEqual(restartedInspection.instance_identity, {
    name: DEFAULT_INSTANCE_NAME,
    arch: "x86_64",
  });
  assert.equal(result.evidence.steps.filter((step) => step.id === "repeated-stop")[0].observed_state.action, "no-op");
  assert.equal(calls.filter((call) => call.operation === "repeated-stop").length, 0);
  assert.equal(
    result.evidence.deterministic_guard_checks.every((check) => check.pass),
    true,
  );
  const createCall = calls.find((call) => call.operation === "create");
  assert.ok(createCall);
  assert.equal(createCall.args.includes("--plain"), true);
  assert.equal(createCall.args.includes("template:alpine"), true);
  assert.equal(
    calls.some((call) => call.args.some((argument) => argument.includes("qmp"))),
    false,
  );
});
