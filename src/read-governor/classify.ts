import path from "node:path";

/**
 * Read Governor のファイル分類。issue #62 の "File-type routing" に対応する。
 * source/document 系は構造探索を要求し、structured-config/log/lockfile/generated は
 * 別経路を要求する。分類自体は decision を出さない — policy.ts が phase を見て決める。
 */
export type FileClass =
  | "source"
  | "document"
  | "structured-config"
  | "log"
  | "lockfile"
  | "generated"
  | "unknown";

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".rs", ".go", ".java", ".kt", ".rb", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".sh", ".bash", ".zsh",
]);

const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

const STRUCTURED_CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml"]);

const LOG_EXTENSIONS = new Set([".log"]);

const LOCKFILE_BASENAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "Gemfile.lock",
  "poetry.lock", "composer.lock", "flake.lock", "bun.lockb",
]);

const GENERATED_PATH_SEGMENTS = new Set([
  "node_modules", "dist", "build", "target", ".turbo", ".next", "coverage",
  "vendor", ".git", ".codegraph",
]);

const GENERATED_SUFFIXES = [".min.js", ".min.css", ".map", ".tsbuildinfo"];

export function classifyFile(filePath: string): FileClass {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? normalized;

  if (segments.some((segment) => GENERATED_PATH_SEGMENTS.has(segment))) return "generated";
  if (GENERATED_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return "generated";
  if (LOCKFILE_BASENAMES.has(basename)) return "lockfile";

  const ext = path.extname(basename).toLowerCase();
  if (LOG_EXTENSIONS.has(ext)) return "log";
  if (STRUCTURED_CONFIG_EXTENSIONS.has(ext)) return "structured-config";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  return "unknown";
}
