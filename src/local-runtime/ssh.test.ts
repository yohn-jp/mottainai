import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSshArguments, ensureKnownHost } from "./ssh.js";

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

test("SSH always uses the private known-hosts file and strict identity checking", () => {
  const args = buildSshArguments(
    { paths, host: "127.0.0.1", port: 48321, user: "mottainai-control", sshExecutable: "ssh" },
    "health",
  );
  assert.equal(args.includes("StrictHostKeyChecking=yes"), true);
  assert.equal(args.includes("GlobalKnownHostsFile=/dev/null"), true);
  assert.equal(args.includes(`UserKnownHostsFile=${paths.sshKnownHosts}`), true);
  assert.equal(args.includes("-oStrictHostKeyChecking=no"), false);
  assert.equal(args.at(-1), "mottainai-runtime-health");
});

test("SSH host-key substitution fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-ssh-host-key-test-"));
  const tempPaths = {
    ...paths,
    sshDirectory: path.join(root, "ssh"),
    sshKnownHosts: path.join(root, "ssh", "known_hosts"),
  };
  try {
    ensureKnownHost(tempPaths, "[127.0.0.1]:48321 ssh-ed25519 AAAAORIGINAL");
    assert.throws(
      () => ensureKnownHost(tempPaths, "[127.0.0.1]:48321 ssh-ed25519 AAAASUBSTITUTED"),
      /possibly unrelated machine/,
    );
    assert.match(fs.readFileSync(tempPaths.sshKnownHosts, "utf8"), /AAAAORIGINAL/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
