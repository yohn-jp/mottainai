import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// The repository root that has @alibaba-group/open-code-review installed
// as a pinned devDependency (this file's own checkout), not necessarily
// the repository being analyzed (`cwd`/`--repo`) — tests point the
// latter at throwaway fixture repos while still using this repo's own
// installed `ocr` binary.
function ocrPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function ocrBinaryPath() {
  return path.join(ocrPackageRoot(), "node_modules", ".bin", "ocr");
}

export function ocrPackageVersion() {
  const packageJsonPath = path.join(
    ocrPackageRoot(),
    "node_modules",
    "@alibaba-group",
    "open-code-review",
    "package.json",
  );
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
}

function runOcr(args) {
  return execFileSync(ocrBinaryPath(), args, { encoding: "utf8", maxBuffer: MAX_BUFFER_BYTES });
}

// ocr delegate preview: OCR's own deterministic changed-file selection
// (extension/gitignore-style exclusion rules). Not reimplemented here.
export function runOcrPreview({ cwd, baseSha, headSha }) {
  const stdout = runOcr(["delegate", "preview", "--format", "json", "--from", baseSha, "--to", headSha, "--repo", cwd]);
  return JSON.parse(stdout);
}

// ocr delegate rule: OCR's own resolved review rules for the files its
// preview step selected. `ocr delegate rule` requires at least one path
// argument; an empty reviewable-file list is a legitimate no-op this
// wrapper short-circuits instead of invoking OCR for nothing.
export function runOcrRule({ cwd, baseSha, headSha, files }) {
  if (files.length === 0) {
    return { schema_version: "1", groups: [] };
  }
  const stdout = runOcr([
    "delegate",
    "rule",
    "--format",
    "json",
    "--from",
    baseSha,
    "--to",
    headSha,
    "--repo",
    cwd,
    ...files,
  ]);
  return JSON.parse(stdout);
}
