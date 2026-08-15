import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

function digest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const architecture = option("architecture");
const kernel = path.resolve(option("kernel"));
const initrd = path.resolve(option("initrd"));
const disk = path.resolve(option("disk"));
const hostKey = option("host-key").trim();
const buildIdentity = option("build-identity");
const output = path.resolve(option("output"));
const lock = path.resolve(option("lock"));
const flake = option("flake");
if (!/^(?:x86_64-linux|aarch64-linux)$/u.test(architecture))
  throw new Error(`unsupported Runtime architecture: ${architecture}`);
if (!/^(?:\[127\.0\.0\.1\]:48321|127\.0\.0\.1)\s+ssh-(?:ed25519|rsa|ecdsa-sha2-nistp256)\s+\S+$/u.test(hostKey)) {
  throw new Error("--host-key must be the pinned local Runtime known-hosts record");
}
for (const filePath of [kernel, initrd, disk, lock]) {
  if (!fs.statSync(filePath).isFile()) throw new Error(`missing Runtime image input: ${filePath}`);
}

const directory = path.join(output, architecture);
fs.mkdirSync(directory, { recursive: true });
const staged = {
  kernel: path.join(directory, "kernel"),
  initrd: path.join(directory, "initrd"),
  disk: path.join(directory, "runtime-disk.raw"),
};
fs.copyFileSync(kernel, staged.kernel);
fs.copyFileSync(initrd, staged.initrd);
fs.copyFileSync(disk, staged.disk);
const lockSha256 = digest(lock);
const manifest = {
  imageId: `mottainai-runtime-${architecture}-${lockSha256.slice(0, 16)}`,
  contractId: "mottainai.linux-runtime.v1",
  schemaVersion: 1,
  architecture,
  buildIdentity,
  kernelPath: staged.kernel,
  kernelSha256: digest(staged.kernel),
  initrdPath: staged.initrd,
  initrdSha256: digest(staged.initrd),
  diskPath: staged.disk,
  diskSha256: digest(staged.disk),
  sshHostKey: hostKey,
  canonicalSource: {
    flake,
    output: `nixosConfigurations.${architecture}.config.system.build.vm`,
    lockSha256,
  },
};
fs.writeFileSync(path.join(directory, "runtime-image.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...manifest, output: directory }, null, 2));
