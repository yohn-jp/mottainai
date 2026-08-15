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

function optionalOption(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  if (process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

function digest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function canonicalImageInputs(imageOutput, architecture) {
  const filePath = path.join(imageOutput, "runtime-image-inputs.json");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `canonical Runtime image inputs cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    value.contractId !== "mottainai.linux-runtime.v1" ||
    value.schemaVersion !== 1 ||
    value.architecture !== architecture ||
    typeof value.buildIdentity !== "string" ||
    typeof value.canonicalSource !== "object" ||
    value.canonicalSource === null ||
    typeof value.canonicalSource.flake !== "string" ||
    typeof value.canonicalSource.output !== "string"
  ) {
    throw new Error(`canonical Runtime image inputs are invalid: ${filePath}`);
  }
  return value;
}

const architecture = option("architecture");
const imageOutput = optionalOption("image-output");
const imageInputs = imageOutput === undefined ? undefined : canonicalImageInputs(imageOutput, architecture);
const kernel = path.resolve(imageOutput === undefined ? option("kernel") : path.join(imageOutput, "kernel"));
const initrd = path.resolve(imageOutput === undefined ? option("initrd") : path.join(imageOutput, "initrd"));
const disk = path.resolve(imageOutput === undefined ? option("disk") : path.join(imageOutput, "runtime-disk.raw"));
const hostKey = option("host-key").trim();
const buildIdentity = imageInputs?.buildIdentity ?? optionalOption("build-identity");
const output = path.resolve(option("output"));
const lock = path.resolve(option("lock"));
const flake = option("flake");
if (buildIdentity === undefined) throw new Error("missing --build-identity (required without --image-output inputs)");
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
  // Paths are relative to runtime-image.json. The bundle is intentionally
  // relocatable: the adapter consumes the verified projection after release
  // staging, where the temporary build directory no longer exists.
  kernelPath: path.basename(staged.kernel),
  kernelSha256: digest(staged.kernel),
  initrdPath: path.basename(staged.initrd),
  initrdSha256: digest(staged.initrd),
  diskPath: path.basename(staged.disk),
  diskSha256: digest(staged.disk),
  sshHostKey: hostKey,
  canonicalSource: {
    flake: imageInputs?.canonicalSource.flake ?? flake,
    output: imageInputs?.canonicalSource.output ?? `nixosConfigurations.${architecture}.config.system.build.vm`,
    lockSha256,
  },
};
fs.writeFileSync(path.join(directory, "runtime-image.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...manifest, output: directory }, null, 2));
