import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * 判定は隔離した一時 git リポジトリで行う。ローカル開発機の `.git/info/exclude`
 * （mottainai init --scope personal が書く personal exclude、リポジトリ非共有）が
 * `.mottainai/` を独立に ignore していることがあり、そちらを混ぜるとリポジトリ共有の
 * `.gitignore` 単体の挙動を検証できない。
 */
function isIgnoredByRepoGitignore(relativePath: string): boolean {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-gitignore-test-"));
  try {
    execFileSync("git", ["init", "-q", workspace]);
    fs.copyFileSync(path.join(REPO_ROOT, ".gitignore"), path.join(workspace, ".gitignore"));
    const target = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
    try {
      execFileSync("git", ["-C", workspace, "check-ignore", "--quiet", relativePath]);
      return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 1) return false;
      throw err;
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test(".mottainai/workflow.json is trackable (not ignored)", () => {
  assert.equal(isIgnoredByRepoGitignore(".mottainai/workflow.json"), false);
});

test(".mottainai/log/* stays ignored", () => {
  assert.equal(isIgnoredByRepoGitignore(".mottainai/log/upstream.jsonl"), true);
});

test(".mottainai/policy/* stays ignored", () => {
  assert.equal(isIgnoredByRepoGitignore(".mottainai/policy/candidate.json"), true);
});

test("unknown files under .mottainai/ stay ignored by default", () => {
  assert.equal(isIgnoredByRepoGitignore(".mottainai/other.txt"), true);
});
