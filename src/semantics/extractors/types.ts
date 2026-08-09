import type { RepositorySemanticSnapshot } from "../ir/types.js";
import type { SnapshotManifest, SemanticFactCache, DerivedFactCacheStatus } from "../cache/index.js";

export const TYPESCRIPT_FACT_PROVIDER_ID = "typescript-symbol-facts" as const;
export const TYPESCRIPT_FACT_PROVIDER_VERSION = "1.0.0" as const;

export interface TypeScriptExtractorOptions {
  rootDir: string;
  tsconfigPath?: string;
  /** Optional project inputs used to exercise deterministic enumeration. */
  rootNames?: readonly string[];
  repositoryName?: string;
  packageName?: string;
  revision?: string;
  /** Optional disposable derived-fact cache; absence preserves the cold path. */
  cache?: SemanticFactCache;
}

export interface TypeScriptFactCounts {
  files: number;
  symbols: number;
  relations: number;
  facts: number;
  externalPackages: number;
  externalApis: number;
  unknowns: number;
  diagnostics: number;
  partial: boolean;
}

export interface TypeScriptFactResult {
  snapshot: RepositorySemanticSnapshot;
  elapsedMs: number;
  counts: TypeScriptFactCounts;
  cacheStatus?: DerivedFactCacheStatus;
  /** Internal handoff used by the model compiler to finalize the worktree manifest. */
  cacheManifest?: SnapshotManifest;
}

export interface TypeScriptFactProvider {
  extract(options: TypeScriptExtractorOptions): TypeScriptFactResult;
}
