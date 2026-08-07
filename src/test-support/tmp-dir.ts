import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

/**
 * OS一時領域配下に隔離ディレクトリを作り、テスト終了時（失敗時含む）に必ず削除する。
 * realpathSyncで解決するのは、macOSの/tmp→/private/tmpのようなシンボリックリンク越しの
 * tmpdirで、パス同一性を比較するテスト（git worktree/repository identity解決など）が
 * 偽陽性の不一致を出さないため。
 */
export function createTempDir(t: TestContext, prefix = "mottainai-test-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
