import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// Review Pages has its own pinned OCR dependency so the generation workflow
// does not install the repository's unrelated dependencies. The repository
// root fallback keeps existing root-level test invocations working while the
// boundary is adopted; both locations resolve the same pinned package.
function ocrPackageRoot() {
  const reviewPagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const repositoryRoot = path.resolve(reviewPagesRoot, "..");
  const packageRoots = [reviewPagesRoot, repositoryRoot];

  for (const packageRoot of packageRoots) {
    if (fs.existsSync(path.join(packageRoot, "node_modules", "@alibaba-group", "open-code-review", "package.json"))) {
      return packageRoot;
    }
  }

  throw new Error("@alibaba-group/open-code-review is not installed for Review Pages");
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
