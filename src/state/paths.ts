import os from "node:os";
import path from "node:path";

const APP_DIR_NAME = "mottainai";
export const STATE_DB_FILE_NAME = "state.sqlite3";

/**
 * OS ごとの user state directory を返す。`MOTTAINAI_STATE_DIR` が設定されていれば
 * それを最優先する（テスト・コンテナ・CI での上書き用）。
 *
 * - Linux: `$XDG_STATE_HOME/mottainai`（既定 `~/.local/state/mottainai`）
 * - macOS: `~/Library/Application Support/mottainai`
 *
 * リポジトリ内・node_modules・OS 一時ディレクトリには置かない。
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.MOTTAINAI_STATE_DIR;
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }

  const home = env.HOME ?? os.homedir();

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_DIR_NAME);
  }

  const xdgStateHome = env.XDG_STATE_HOME;
  const base =
    xdgStateHome !== undefined && xdgStateHome.length > 0 && path.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.join(home, ".local", "state");
  return path.join(base, APP_DIR_NAME);
}

export function resolveStateDbPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(resolveStateDir(env, platform), STATE_DB_FILE_NAME);
}
