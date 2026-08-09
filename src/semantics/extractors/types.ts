import type { RepositorySemanticSnapshot } from "../ir/types.js";

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
}

export interface TypeScriptFactProvider {
  extract(options: TypeScriptExtractorOptions): TypeScriptFactResult;
}
