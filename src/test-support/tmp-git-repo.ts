import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { createTempDir } from "./tmp-dir.js";

const DEV_NULL = process.platform === "win32" ? "NUL" : "/dev/null";
const TEST_AUTHOR_NAME = "Mottainai Test";
const TEST_AUTHOR_EMAIL = "test@example.com";

// 開発者のglobal/system Git設定がテスト結果へ混入するのを防ぐため。
export function isolatedGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, GIT_CONFIG_GLOBAL: DEV_NULL, GIT_CONFIG_SYSTEM: DEV_NULL };
}

export function runGit(
  commandArguments: string[],
  workingDirectory: string,
  environment: NodeJS.ProcessEnv = isolatedGitEnvironment(),
): string {
  return execFileSync("git", commandArguments, { cwd: workingDirectory, encoding: "utf8", env: environment }).trim();
}

export interface TempGitRepoOptions {
  prefix?: string;
  defaultBranch?: string;
  /** 初回コミット不要の失敗系テストを分離して実行するため。 */
  initialCommit?: boolean;
}

// Gitのglobal設定と作業ツリーを汚染せず、repository境界を検証するため。
export function createTempGitRepo(testContext: TestContext, options: TempGitRepoOptions = {}): string {
  const root = createTempDir(testContext, options.prefix ?? "mottainai-git-test-");
  const branch = options.defaultBranch ?? "main";
  const environment = isolatedGitEnvironment();
  runGit(["init", "--quiet", "-b", branch], root, environment);
  runGit(["config", "user.email", TEST_AUTHOR_EMAIL], root, environment);
  runGit(["config", "user.name", TEST_AUTHOR_NAME], root, environment);
  if (options.initialCommit !== false) {
    // commit前提の失敗系テストを安定して実行するため、初回コミットでfile.txtを追跡する。
    fs.writeFileSync(path.join(root, "file.txt"), "hello\n");
    runGit(["add", "file.txt"], root, environment);
    runGit(["commit", "--quiet", "-m", "initial"], root, environment);
  }
  return root;
}
