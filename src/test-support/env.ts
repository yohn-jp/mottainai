import type { TestContext } from "node:test";
import { createTempDir } from "./tmp-dir.js";

/**
 * TZ/LANG/LC_ALLをUTC/Cへ固定する既定値。実行順・developer machine・timezone・localeで
 * テスト結果が変わらないようにするための最小セット（docs/testing.md「Determinism」）。
 */
export const DETERMINISTIC_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  TZ: "UTC",
  LANG: "C",
  LC_ALL: "C",
});

/**
 * process.envへ一時的にキーを設定し、テスト終了時（失敗時含む）に元の値へ必ず復元する。
 * 値が undefined のキーは「テスト中は未設定にする」を意味する。
 */
export function withEnv(t: TestContext, overrides: Record<string, string | undefined>): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) previous.set(key, process.env[key]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** TZ/LANG/LC_ALLを決定論的な値へ固定する。実HOME/実gitconfig等には触れない。 */
export function withDeterministicEnv(t: TestContext, overrides: Record<string, string | undefined> = {}): void {
  withEnv(t, { ...DETERMINISTIC_ENV, ...overrides });
}

/**
 * HOMEを隔離済みの一時ディレクトリへ差し替える。実の開発者HOME・実グローバル設定・
 * 実ユーザーconfigへ意図せず依存するテスト（init/doctor等）向け。
 */
export function isolatedHomeDir(t: TestContext, prefix = "mottainai-home-"): string {
  const home = createTempDir(t, prefix);
  withEnv(t, { HOME: home, USERPROFILE: home });
  return home;
}
