import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// A small, fixed two-commit repository used across generator tests:
// base adds two files, head modifies one and adds another. Every test
// gets its own temp directory so runs never interfere.
export function createFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-review-pages-"));
  git(["init", "--initial-branch", "main", "."], dir);
  git(["config", "user.name", "fixture"], dir);
  git(["config", "user.email", "fixture@example.com"], dir);

  fs.writeFileSync(path.join(dir, "a.txt"), "line one\nline two\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "unchanged\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "base"], dir);
  const baseSha = git(["rev-parse", "HEAD"], dir);

  fs.writeFileSync(path.join(dir, "a.txt"), "line one\nline two changed\nline three\n");
  fs.writeFileSync(path.join(dir, "c.txt"), "new file\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "head"], dir);
  const headSha = git(["rev-parse", "HEAD"], dir);

  return { dir, baseSha, headSha };
}

export function removeFixtureRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
