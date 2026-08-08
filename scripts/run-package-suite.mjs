import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

const artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-package-suite-"));
try {
  const distEntry = path.join(repoRoot, "dist", "index.js");
  if (!fs.existsSync(distEntry)) throw new Error("dist is missing; run pnpm run build before the package suite");
  const distMtime = fs.statSync(distEntry).mtimeMs;
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", artifactDirectory],
    { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" },
  );
  const [packInfo] = JSON.parse(packOutput);
  const tarballPath = path.join(artifactDirectory, packInfo.filename);
  const environment = {
    ...process.env,
    MOTTAINAI_PACKAGE_TARBALL: tarballPath,
    MOTTAINAI_DIST_MTIME: String(distMtime),
    MOTTAINAI_PACKED_FILES: JSON.stringify(packInfo.files.map((entry) => entry.path)),
  };

  // 依存解決・launcher・initの責務は既存smokeへ委譲する。同一artifactを渡して再packを防ぐ。
  run(process.execPath, ["scripts/smoke-test.mjs", "--tarball", tarballPath], { env: environment });
  run(process.execPath, ["--test", "scripts/mcp-stdio-package.test.mjs"], { env: environment });
} finally {
  fs.rmSync(artifactDirectory, { recursive: true, force: true });
}
