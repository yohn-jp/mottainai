import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { createTempDir } from "./tmp-dir.js";

const DEV_NULL = process.platform === "win32" ? "NUL" : "/dev/null";
const TEST_AUTHOR_NAME = "Mottainai Test";
const TEST_AUTHOR_EMAIL = "test@example.com";

/**
 * developer machineのglobal/system git設定（commit.gpgsign, core.autocrlf, alias等）から
 * 隔離した環境変数を返す。GIT_CONFIG_GLOBAL/SYSTEMを無効な宛先に向けることで、実行環境の
 * ~/.gitconfigや/etc/gitconfigを一切読ませない。
 */
export function isolatedGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, GIT_CONFIG_GLOBAL: DEV_NULL, GIT_CONFIG_SYSTEM: DEV_NULL };
}

export function runGit(args: string[], cwd: string, environment: NodeJS.ProcessEnv = isolatedGitEnvironment()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: environment }).trim();
}

export interface TempGitRepoOptions {
  prefix?: string;
  defaultBranch?: string;
  /** false なら init のみ行い、コミットを作らない（no-commitの失敗系テスト用）。既定 true。 */
  initialCommit?: boolean;
}

/** 隔離済み環境変数で `git init` した一時リポジトリを作り、既定で初回コミットまで済ませて返す。 */
export function createTempGitRepo(t: TestContext, options: TempGitRepoOptions = {}): string {
  const root = createTempDir(t, options.prefix ?? "mottainai-git-test-");
  const branch = options.defaultBranch ?? "main";
  const environment = isolatedGitEnvironment();
  runGit(["init", "--quiet", "-b", branch], root, environment);
  runGit(["config", "user.email", TEST_AUTHOR_EMAIL], root, environment);
  runGit(["config", "user.name", TEST_AUTHOR_NAME], root, environment);
  if (options.initialCommit !== false) {
    // git commit -am は未追跡ファイルを拾わないため、初回コミットで file.txt を追跡済みにする。
    fs.writeFileSync(path.join(root, "file.txt"), "hello\n");
    runGit(["add", "file.txt"], root, environment);
    runGit(["commit", "--quiet", "-m", "initial"], root, environment);
  }
  return root;
}
