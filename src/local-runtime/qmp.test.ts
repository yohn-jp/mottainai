import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalQemuArguments, buildQemuEnvironment } from "./qmp.js";
import { LOCAL_RUNTIME_PROFILE } from "./types.js";

const paths = {
  stateDirectory: "/private/mottainai-runtime",
  stateFile: "/private/mottainai-runtime/state.json",
  qmpSocket: "/private/mottainai-runtime/qmp.sock",
  diskImage: "/private/mottainai-runtime/runtime-disk.raw",
  kernelImage: "/private/mottainai-runtime/kernel",
  initrdImage: "/private/mottainai-runtime/initrd",
  imageManifest: "/private/mottainai-runtime/runtime-image.json",
  qemuDirectory: "/private/mottainai-runtime/qemu",
  qemuExecutable: "/private/mottainai-runtime/qemu/qemu-system-x86_64",
  sshDirectory: "/private/mottainai-runtime/ssh",
  sshPrivateKey: "/private/mottainai-runtime/ssh/control_ed25519",
  sshKnownHosts: "/private/mottainai-runtime/ssh/known_hosts",
} as const;

const options = {
  artifact: {
    artifactId: "qemu-linux-x64-9.2.2",
    version: "9.2.2",
    buildId: "qemu-9.2.2-mottainai-runtime-v1",
    sha256: "a".repeat(64),
    executablePath: paths.qemuExecutable,
  },
  image: {
    imageId: "runtime-x86_64-test",
    architecture: "x86_64-linux" as const,
    buildIdentity: "/nix/store/runtime-test",
    diskSha256: "b".repeat(64),
  },
  paths,
  accelerator: "kvm" as const,
  platform: "linux" as const,
};

test("QEMU environment prepends only the verified bundled library directory", () => {
  const environment = buildQemuEnvironment({
    ...options,
    artifact: { ...options.artifact, runtimeLibraryDirectory: "/private/mottainai-runtime/qemu/lib" },
    environment: { LD_LIBRARY_PATH: "/existing/lib", KEEP: "value" },
    platform: "linux",
  });
  assert.deepEqual(environment, {
    LD_LIBRARY_PATH: "/private/mottainai-runtime/qemu/lib:/existing/lib",
    KEEP: "value",
  });
  assert.equal(buildQemuEnvironment({ ...options, platform: "linux" }), undefined);
});

test("QEMU environment uses DYLD_LIBRARY_PATH on darwin", () => {
  const environment = buildQemuEnvironment({
    ...options,
    artifact: { ...options.artifact, runtimeLibraryDirectory: "/private/mottainai-runtime/qemu/lib" },
    environment: { DYLD_LIBRARY_PATH: "/existing/lib" },
    platform: "darwin",
  });
  assert.deepEqual(environment, {
    DYLD_LIBRARY_PATH: "/private/mottainai-runtime/qemu/lib:/existing/lib",
  });
});

test("QEMU environment uses PATH with semicolon separator on win32", () => {
  const environment = buildQemuEnvironment({
    ...options,
    artifact: { ...options.artifact, runtimeLibraryDirectory: "C:\\private\\mottainai-runtime\\qemu\\lib" },
    environment: { PATH: "C:\\existing\\lib" },
    platform: "win32",
  });
  assert.deepEqual(environment, {
    PATH: "C:\\private\\mottainai-runtime\\qemu\\lib;C:\\existing\\lib",
  });
});

test("QEMU environment inherits process.env when options.environment is omitted", () => {
  const originalEnv = process.env;
  try {
    process.env = { EXISTING_VAR: "test-value", LD_LIBRARY_PATH: "/system/lib" };
    const environment = buildQemuEnvironment({
      ...options,
      artifact: { ...options.artifact, runtimeLibraryDirectory: "/private/mottainai-runtime/qemu/lib" },
      platform: "linux",
    });
    assert.equal(environment?.EXISTING_VAR, "test-value");
    assert.equal(environment?.LD_LIBRARY_PATH, "/private/mottainai-runtime/qemu/lib:/system/lib");
  } finally {
    process.env = originalEnv;
  }
});

test("QEMU argv is fixed, private-QMP, and accelerator-required", () => {
  const args = buildCanonicalQemuArguments(options);
  assert.equal(args[0], "-nodefaults");
  assert.equal(args[args.indexOf("-machine") + 1], LOCAL_RUNTIME_PROFILE.machineType);
  assert.equal(args[args.indexOf("-name") + 1], LOCAL_RUNTIME_PROFILE.machineId);
  assert.equal(args[args.indexOf("-uuid") + 1], LOCAL_RUNTIME_PROFILE.machineUuid);
  assert.equal(args[args.indexOf("-accel") + 1], "kvm");
  assert.equal(args[args.indexOf("-cpu") + 1], "host");
  assert.equal(args.includes("tcg"), false);
  assert.equal(args.includes("-qmp"), true);
  assert.match(
    args[args.indexOf("-qmp") + 1] ?? "",
    /^unix:\/private\/mottainai-runtime\/qmp\.sock,server=on,wait=off$/u,
  );
  assert.match(args[args.indexOf("-netdev") + 1] ?? "", /hostfwd=tcp:127\.0\.0\.1:48321-:22/u);
  assert.equal(args.includes("-daemonize"), false);
});

test("QMP stays host-private on every supported endpoint format", () => {
  const cases = [
    { platform: "linux" as const, endpoint: "/private/mottainai-runtime/qmp.sock", prefix: "unix:" },
    { platform: "darwin" as const, endpoint: "/private/mottainai-runtime/qmp.sock", prefix: "unix:" },
    { platform: "win32" as const, endpoint: "\\\\.\\pipe\\mottainai-local-runtime-v1", prefix: "pipe:" },
  ];
  for (const entry of cases) {
    const args = buildCanonicalQemuArguments({
      ...options,
      platform: entry.platform,
      paths: { ...paths, qmpSocket: entry.endpoint },
    });
    const qmp = args[args.indexOf("-qmp") + 1] ?? "";
    assert.equal(qmp.startsWith(entry.prefix), true);
    assert.equal(qmp.includes("tcp:"), false);
  }
});
