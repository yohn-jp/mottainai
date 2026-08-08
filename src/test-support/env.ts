import type { TestContext } from "node:test";
import { createTempDir } from "./tmp-dir.js";

// 実行環境差でテスト結果が変わる回帰を防ぐため。
export const DETERMINISTIC_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  TZ: "UTC",
  LANG: "C",
  LC_ALL: "C",
});

// 失敗時もprocess.envを復元し、テスト間の共有状態を残さないため。
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

export function withDeterministicEnv(t: TestContext, overrides: Record<string, string | undefined> = {}): void {
  withEnv(t, { ...DETERMINISTIC_ENV, ...overrides });
}

// 実ユーザー設定の影響を受けず、init/doctorのhost-state境界を検証するため。
export function isolatedHomeDir(t: TestContext, prefix = "mottainai-home-"): string {
  const home = createTempDir(t, prefix);
  withEnv(t, { HOME: home, USERPROFILE: home });
  return home;
}
