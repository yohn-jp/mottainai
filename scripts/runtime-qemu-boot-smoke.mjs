import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { option } from "./runtime-qemu-contract.mjs";

const artifactRoot = path.resolve(option("artifact-root"));
const manifestPath = path.resolve(option("manifest"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.availability !== "available") throw new Error(`artifact is not available: ${manifest.availability}`);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const verifierScript = path.join(scriptDirectory, "verify-runtime-qemu-artifact.mjs");
execFileSync(
  process.execPath,
  [verifierScript, "--manifest", manifestPath, "--artifact-root", artifactRoot],
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
const environment = {};
if (manifest.runtimeLibraries && manifest.runtimeLibraries.length > 0) {
  const libDirectory = path.join(artifactRoot, "lib");
  const platform = process.platform;
  const key = platform === "win32" ? "PATH" : platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const separator = platform === "win32" ? ";" : ":";
  const existing = process.env[key];
  environment[key] = existing ? `${libDirectory}${separator}${existing}` : libDirectory;
}
const child = spawn(executable, ["-nodefaults", "-machine", "none", "-display", "none", "-monitor", "none", "-S"], {
  cwd: artifactRoot,
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
  env: Object.keys(environment).length > 0 ? { ...process.env, ...environment } : process.env,
});
const stderrChunks = [];
child.stderr?.on("data", (chunk) => {
  stderrChunks.push(chunk);
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
    const stderrText = Buffer.concat(stderrChunks).toString("utf8");
    const stderrExcerpt = stderrText.length > 512 ? stderrText.slice(0, 512) + "..." : stderrText;
    const errorMessage = `managed QEMU exited during artifact smoke: code=${code ?? "null"}, signal=${signal ?? "null"}${stderrExcerpt ? `\nstderr: ${stderrExcerpt}` : ""}`;
    reject(new Error(errorMessage));
  });
});
console.log(JSON.stringify({ ...result, artifactId: manifest.artifactId, host: manifest.host }, null, 2));
