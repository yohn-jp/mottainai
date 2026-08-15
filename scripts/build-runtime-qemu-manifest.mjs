import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SOURCE_URL = "https://download.qemu.org/qemu-9.2.2.tar.xz";
const SOURCE_SHA256 = "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf";
const VERSION = "9.2.2";
const BUILD_ID = "qemu-9.2.2-mottainai-runtime-v1";
const LICENSE = "GPL-2.0-or-later";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const host = option("host");
const executable = path.resolve(option("executable"));
const output = path.resolve(option("output"));
const executableName = path.basename(executable);
if (!/^(?:linux-(?:x64|arm64)|macos-(?:x64|arm64)|windows-x64)$/u.test(host))
  throw new Error(`unsupported host: ${host}`);
if (!fs.statSync(executable).isFile()) throw new Error(`QEMU artifact is not a regular file: ${executable}`);
if (!host.startsWith("windows-") && (fs.statSync(executable).mode & 0o111) === 0) {
  throw new Error(`QEMU artifact is not executable: ${executable}`);
}

const artifactId = `qemu-${host}-${VERSION}`;
const hostOutput = path.join(output, host);
fs.mkdirSync(hostOutput, { recursive: true });
const stagedExecutable = path.join(hostOutput, executableName);
fs.copyFileSync(executable, stagedExecutable);
if (process.platform !== "win32") fs.chmodSync(stagedExecutable, 0o700);
const manifest = {
  artifactId,
  version: VERSION,
  buildId: BUILD_ID,
  host,
  executableName,
  downloadUrl: `https://github.com/yohn-jp/mottainai/releases/download/qemu-${VERSION}/${artifactId}.tar.zst`,
  sha256: sha256(stagedExecutable),
  runtimeLibraries: [],
  firmware: [],
  source: {
    url: SOURCE_URL,
    sha256: SOURCE_SHA256,
    license: LICENSE,
    correspondingSource: SOURCE_URL,
  },
};
fs.writeFileSync(path.join(hostOutput, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...manifest, stagedExecutable }, null, 2));
