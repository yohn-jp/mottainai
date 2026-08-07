import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * tsxローダーのfile://絶対URLを、このモジュール自身の位置から解決する。
 * 子プロセスのcwd（黒箱テストの一時workspace等）に関係なく `--import` へ渡せる
 * （`tsx`をbare specifierのままcwd依存解決させると、リポジトリ外のcwdで解決に失敗する）。
 */
export function resolveTsxLoaderUrl(): string {
  return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
}
