import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SOURCE_URL = "https://download.qemu.org/qemu-9.2.2.tar.xz";
const SOURCE_SHA256 = "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf";
const VERSION = "9.2.2";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(command, args, cwd, env = {}) {
  execFileSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
}

const host = option("host");
const target = option("target");
const workdir = path.resolve(option("workdir"));
const output = path.resolve(option("output", path.join(workdir, "artifact")));
const jobs = option("jobs", "2");
const sourceUrl = option("source-url", SOURCE_URL);
const sourceSha256 = option("source-sha256", SOURCE_SHA256);
const sourceArchive = path.join(workdir, `qemu-${VERSION}.tar.xz`);
const sourceDirectory = path.join(workdir, `qemu-${VERSION}`);
const prefix = path.join(workdir, "prefix");
if (sourceUrl !== SOURCE_URL || sourceSha256 !== SOURCE_SHA256) {
  throw new Error("QEMU source URL and SHA-256 must match the pinned Mottainai release source");
}
fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
fs.rmSync(sourceDirectory, { recursive: true, force: true });
fs.rmSync(prefix, { recursive: true, force: true });

const response = await fetch(sourceUrl, { redirect: "error" });
if (!response.ok) throw new Error(`QEMU source download failed: HTTP ${response.status}`);
fs.writeFileSync(sourceArchive, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
if (sha256(sourceArchive) !== sourceSha256) throw new Error("QEMU source SHA-256 mismatch");
run("tar", ["-xf", sourceArchive], workdir);

const configureArgs = [
  `--target-list=${target}`,
  `--prefix=${prefix}`,
  "--enable-system",
  "--disable-user",
  "--disable-tools",
  "--disable-docs",
  "--disable-debug-info",
  "--disable-gtk",
  "--disable-sdl",
  "--disable-vnc",
  "--disable-spice",
  "--disable-curl",
  "--disable-slirp",
  "--static",
];
run("./configure", configureArgs, sourceDirectory, { SOURCE_DATE_EPOCH: "0" });
run("make", [`-j${jobs}`], sourceDirectory, { SOURCE_DATE_EPOCH: "0" });
run("make", ["install"], sourceDirectory, { SOURCE_DATE_EPOCH: "0" });

const executableName = host.startsWith("windows-")
  ? `qemu-system-${target.split("-")[0]}.exe`
  : `qemu-system-${target.split("-")[0]}`;
const executable = path.join(prefix, "bin", executableName);
if (!fs.existsSync(executable)) throw new Error(`built QEMU executable is missing: ${executable}`);
const firmwareDirectory = path.join(prefix, "share", "qemu");
const firmwareNames = ["bios-256k.bin", "efi-virtio.rom", "kvmvapic.bin"];
const firmware = firmwareNames
  .map((name) => ({ name, source: path.join(firmwareDirectory, name) }))
  .filter(({ source }) => fs.existsSync(source));
if (firmware.length === 0) throw new Error("built QEMU did not install a supported firmware payload");
const license = path.join(sourceDirectory, "COPYING");
if (!fs.existsSync(license)) throw new Error("QEMU source license file COPYING is missing");

const builder = path.resolve("scripts/build-runtime-qemu-manifest.mjs");
const builderArgs = [
  builder,
  "--host",
  host,
  "--executable",
  executable,
  "--output",
  output,
  "--source-revision",
  sourceSha256,
  "--source-date-epoch",
  "0",
  "--dependency-mode",
  "static",
  "--license-file",
  `COPYING=${license}`,
  ...firmware.flatMap(({ name, source }) => ["--firmware", `${name}=${source}`]),
  ...configureArgs.flatMap((argument) => ["--configure-arg", argument]),
];
run(process.execPath, builderArgs, path.resolve("."), { SOURCE_DATE_EPOCH: "0" });
console.log(
  JSON.stringify(
    { host, source: sourceSha256, executable, firmware: firmware.map(({ name }) => name), output },
    null,
    2,
  ),
);
