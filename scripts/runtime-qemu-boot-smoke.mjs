import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = process.argv[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

const artifactRoot = path.resolve(option("artifact-root"));
const manifestPath = path.resolve(option("manifest"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.availability !== "available") throw new Error(`artifact is not available: ${manifest.availability}`);
execFileSync(
  process.execPath,
  ["scripts/verify-runtime-qemu-artifact.mjs", "--manifest", manifestPath, "--artifact-root", artifactRoot],
  { stdio: "pipe" },
);
const executable = [
  path.join(artifactRoot, "bin", manifest.executableName),
  path.join(artifactRoot, manifest.executableName),
].find((candidate) => fs.existsSync(candidate));
if (executable === undefined) throw new Error(`managed QEMU executable is missing: ${manifest.executableName}`);

/**
 * Artifact-level smoke only: it starts the managed binary with a fixed empty
 * machine and proves that the packaged process can initialize. OS-specific
 * issues add their accelerator/image/guest-health adapter separately; this
 * command intentionally does not claim KVM, HVF, WHPX, or guest boot evidence.
 */
const child = spawn(executable, ["-nodefaults", "-machine", "none", "-display", "none", "-monitor", "none", "-S"], {
  cwd: artifactRoot,
  stdio: "ignore",
  windowsHide: true,
});
let settled = false;
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    resolve({ ok: true });
  }, 1_000);
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new Error(`managed QEMU exited during artifact smoke: code=${code ?? "null"}, signal=${signal ?? "null"}`));
  });
});
console.log(JSON.stringify({ ...result, artifactId: manifest.artifactId, host: manifest.host }, null, 2));
