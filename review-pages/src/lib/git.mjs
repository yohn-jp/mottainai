import { execFileSync } from "node:child_process";

const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

export function runGit(args, { cwd = process.cwd() } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: OUTPUT_LIMIT_BYTES,
    });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${error?.message ?? "unknown error"}`);
  }
}

const STATUS_NAMES = {
  A: "added",
  M: "modified",
  D: "removed",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

function statusName(letter) {
  return STATUS_NAMES[letter[0]] ?? "unknown";
}

// Deterministic changed-file list with per-file add/delete counts and a
// status, sorted by path. `--diff-filter` is intentionally omitted so
// deletions are represented, matching what a reviewer sees on GitHub.
export function collectChangedFiles(baseSha, headSha, { cwd } = {}) {
  const nameStatus = runGit(["diff", "--find-renames", "--name-status", "-z", baseSha, headSha, "--"], { cwd });
  const numstat = runGit(["diff", "--find-renames", "--numstat", "-z", baseSha, headSha, "--"], { cwd });

  const numstatByPath = new Map();
  const numstatFields = numstat.split("\0").filter((value) => value.length > 0);
  for (let index = 0; index < numstatFields.length; index += 1) {
    const [additions, deletions, path] = numstatFields[index].split("\t");
    if (path === undefined) continue;
    numstatByPath.set(path, {
      additions: additions === "-" ? null : Number(additions),
      deletions: deletions === "-" ? null : Number(deletions),
    });
  }

  const statusFields = nameStatus.split("\0").filter((value) => value.length > 0);
  const files = [];
  let index = 0;
  while (index < statusFields.length) {
    const code = statusFields[index];
    index += 1;
    if (code.startsWith("R") || code.startsWith("C")) {
      const previousPath = statusFields[index];
      const path = statusFields[index + 1];
      index += 2;
      const counts = numstatByPath.get(path) ?? { additions: null, deletions: null };
      files.push({ path, previousPath, status: statusName(code), ...counts });
    } else {
      const path = statusFields[index];
      index += 1;
      const counts = numstatByPath.get(path) ?? { additions: null, deletions: null };
      files.push({ path, status: statusName(code), ...counts });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

// Zero-context unified diff hunk headers per file: the minimal
// deterministic positioning data a reviewer or bot needs to place a
// comment, without publishing full diff content.
export function collectHunkPositions(baseSha, headSha, path, { cwd } = {}) {
  let output;
  try {
    output = runGit(["diff", "--unified=0", "--find-renames", baseSha, headSha, "--", path], { cwd });
  } catch {
    return [];
  }
  const hunks = [];
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;
  for (const line of output.split("\n")) {
    const match = hunkHeader.exec(line);
    if (!match) continue;
    hunks.push({
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}
