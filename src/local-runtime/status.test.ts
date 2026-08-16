import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LOCAL_RUNTIME_MACHINE_ID,
  LOCAL_RUNTIME_PROFILE,
  LOCAL_RUNTIME_STATE_SCHEMA_VERSION,
  type LocalRuntimeState,
} from "./types.js";
import { resolveLocalRuntimePaths, saveLocalRuntimeState } from "./state.js";
import { readLocalRuntimeStatus } from "./status.js";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-runtime-status-"));
}

function persistedState(stateDirectory: string): LocalRuntimeState {
  const paths = resolveLocalRuntimePaths(stateDirectory, "linux-x64", "linux");
  return {
    schemaVersion: LOCAL_RUNTIME_STATE_SCHEMA_VERSION,
    machineId: LOCAL_RUNTIME_MACHINE_ID,
    host: "linux-x64",
    accelerator: "kvm",
    lifecycle: "ready",
    qemu: {
      artifactId: "test-qemu",
      version: "9.2.2",
      buildId: "qemu-9.2.2-mottainai-runtime-v1",
      sha256: "a".repeat(64),
      executablePath: paths.qemuExecutable,
    },
    image: {
      imageId: "test-image",
      architecture: "x86_64-linux",
      buildIdentity: "/nix/store/test-runtime",
      diskSha256: "b".repeat(64),
    },
    paths: {
      stateDirectory: paths.stateDirectory,
      diskImage: paths.diskImage,
      qmpSocket: paths.qmpSocket,
      sshPrivateKey: paths.sshPrivateKey,
      sshKnownHosts: paths.sshKnownHosts,
    },
    ssh: {
      host: LOCAL_RUNTIME_PROFILE.sshHost,
      port: LOCAL_RUNTIME_PROFILE.sshPort,
      user: LOCAL_RUNTIME_PROFILE.sshUser,
      hostKey: "ssh-ed25519 AAAA test",
    },
    qmp: { endpoint: paths.qmpSocket, private: true },
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:01:00.000Z",
  };
}

test("runtime status reports absent without creating the state directory", () => {
  const root = temporaryDirectory();
  const stateRoot = path.join(root, "state");
  try {
    const status = readLocalRuntimeStatus({ stateDirectory: stateRoot });
    assert.equal(status.ok, true);
    assert.equal(status.machineId, LOCAL_RUNTIME_MACHINE_ID);
    assert.equal(status.lifecycle, "absent");
    assert.equal(status.stateFile, path.join(path.resolve(stateRoot, LOCAL_RUNTIME_MACHINE_ID), "state.json"));
    assert.equal(fs.existsSync(stateRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime status projects persisted state without exposing lifecycle secrets or mutating it", () => {
  const root = temporaryDirectory();
  const stateRoot = path.join(root, "state");
  const paths = resolveLocalRuntimePaths(stateRoot, "linux-x64", "linux");
  try {
    saveLocalRuntimeState(paths.stateFile, persistedState(stateRoot));
    const before = fs.readFileSync(paths.stateFile, "utf8");
    const status = readLocalRuntimeStatus({ stateDirectory: stateRoot });
    const after = fs.readFileSync(paths.stateFile, "utf8");

    assert.equal(status.lifecycle, "ready");
    assert.equal(status.host, "linux-x64");
    assert.equal(status.accelerator, "kvm");
    assert.equal(status.qemu?.buildId, "qemu-9.2.2-mottainai-runtime-v1");
    assert.equal(status.image?.imageId, "test-image");
    assert.deepEqual(status.ssh, { host: "127.0.0.1", port: 48321, user: "mottainai-control" });
    assert.deepEqual(status.qmp, { private: true });
    assert.equal("hostKey" in (status.ssh ?? {}), false);
    assert.equal("endpoint" in (status.qmp ?? {}), false);
    assert.equal(after, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
