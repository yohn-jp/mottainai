import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// 子processのcwdに依存すると一時workspaceからloader解決に失敗し、stdio境界検証が壊れるため。
export function resolveTsxLoaderUrl(): string {
  return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
}
