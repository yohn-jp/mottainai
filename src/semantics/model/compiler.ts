import { performance } from "node:perf_hooks";
import { computeIntegrityDigestsFromValidated } from "../ir/canonical.js";
import { validateSnapshot } from "../ir/schema.js";
import type { DeclaredState, RepositorySemanticSnapshot, SemanticDiagnostic } from "../ir/types.js";
import { extractTypeScriptFacts, typeScriptFactProvider } from "../extractors/typescript/index.js";
import type { TypeScriptExtractorOptions, TypeScriptFactCounts, TypeScriptFactProvider } from "../extractors/types.js";
import { LiveRepositoryModelQuery, type RepositoryModelBenchmark, type RepositoryModelSource } from "./query.js";
import { digestCanonicalValue } from "../ir/canonical.js";
import type { SemanticFactCache } from "../cache/index.js";
import type { DerivedFactCacheStatus, SnapshotManifest } from "../cache/index.js";

export interface RepositoryModelCompilerOptions {
  /** Worktree root for live TypeScript fact extraction. */
  rootDir?: string;
  tsconfigPath?: string;
  repositoryName?: string;
  packageName?: string;
  revision?: string;
  /** Validated or stale/invalid snapshots may be supplied for deterministic query tests/replay. */
  snapshot?: RepositorySemanticSnapshot;
  /** Explicit #49 declarations. No ownership is synthesized when this is absent. */
  declarations?: DeclaredState;
  factProvider?: TypeScriptFactProvider;
  /** Optional disposable cache; cache absence remains a valid cold path. */
  cache?: SemanticFactCache;
}

export interface RepositoryModelCompileResult {
  query: LiveRepositoryModelQuery;
  snapshot?: RepositorySemanticSnapshot;
  diagnostics: readonly SemanticDiagnostic[];
  integrityStatus: "fresh" | "stale" | "invalid";
  benchmark: RepositoryModelBenchmark;
}

function diagnostic(code: string, message: string, details?: Record<string, string>): SemanticDiagnostic {
  return {
    code,
    severity: "error",
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function validationDiagnostics(result: ReturnType<typeof validateSnapshot>): SemanticDiagnostic[] {
  return result.ok ? [] : result.diagnostics;
}

function bindDeclarations(
  snapshot: RepositorySemanticSnapshot,
  declarations: DeclaredState,
): { ok: true; snapshot: RepositorySemanticSnapshot } | { ok: false; diagnostics: SemanticDiagnostic[] } {
  const draft: RepositorySemanticSnapshot = {
    ...snapshot,
    declarations,
    integrity: {
      ...snapshot.integrity,
      status: snapshot.integrity.status === "fresh" ? "stale" : snapshot.integrity.status,
      ...(snapshot.integrity.status === "fresh"
        ? { statusReason: "declared semantics were bound during live model compilation" }
        : {}),
    },
  };
  const validated = validateSnapshot(draft);
  if (!validated.ok) return { ok: false, diagnostics: validated.diagnostics };
  if (snapshot.integrity.status !== "fresh") return validated;

  const digestInput: RepositorySemanticSnapshot = {
    ...validated.snapshot,
    integrity: {
      ...validated.snapshot.integrity,
      status: "fresh",
      statusReason: undefined,
    },
  };
  const digests = computeIntegrityDigestsFromValidated(digestInput);
  const rebound: RepositorySemanticSnapshot = {
    ...digestInput,
    integrity: {
      ...digestInput.integrity,
      ...digests,
      status: "fresh",
      statusReason: undefined,
    },
  };
  const finalValidation = validateSnapshot(rebound);
  return finalValidation.ok ? finalValidation : { ok: false, diagnostics: finalValidation.diagnostics };
}

function compileSource(options: RepositoryModelCompilerOptions): {
  snapshot?: RepositorySemanticSnapshot;
  diagnostics: SemanticDiagnostic[];
  factCounts?: TypeScriptFactCounts;
  factExtractionMs?: number;
  cacheStatus?: DerivedFactCacheStatus;
  cacheManifest?: SnapshotManifest;
} {
  if (options.snapshot !== undefined) {
    const validation = validateSnapshot(options.snapshot);
    if (!validation.ok) return { diagnostics: validation.diagnostics };
    if (options.declarations === undefined) return { snapshot: validation.snapshot, diagnostics: [] };
    const rebound = bindDeclarations(validation.snapshot, options.declarations);
    return rebound.ok ? { snapshot: rebound.snapshot, diagnostics: [] } : { diagnostics: rebound.diagnostics };
  }
  if (options.rootDir === undefined) {
    return {
      diagnostics: [diagnostic("missing_root_dir", "rootDir is required when compiling live repository facts")],
    };
  }
  const provider = options.factProvider ?? typeScriptFactProvider;
  const extractorOptions: TypeScriptExtractorOptions = {
    rootDir: options.rootDir,
    ...(options.tsconfigPath === undefined ? {} : { tsconfigPath: options.tsconfigPath }),
    ...(options.repositoryName === undefined ? {} : { repositoryName: options.repositoryName }),
    ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
  };
  const extracted = provider.extract(extractorOptions);
  if (options.declarations === undefined)
    return {
      snapshot: extracted.snapshot,
      diagnostics: [],
      factCounts: extracted.counts,
      factExtractionMs: extracted.elapsedMs,
      ...(extracted.cacheStatus === undefined ? {} : { cacheStatus: extracted.cacheStatus }),
      ...(extracted.cacheManifest === undefined ? {} : { cacheManifest: extracted.cacheManifest }),
    };
  const rebound = bindDeclarations(extracted.snapshot, options.declarations);
  return rebound.ok
    ? {
        snapshot: rebound.snapshot,
        diagnostics: [],
        factCounts: extracted.counts,
        factExtractionMs: extracted.elapsedMs,
        ...(extracted.cacheStatus === undefined ? {} : { cacheStatus: extracted.cacheStatus }),
        ...(extracted.cacheManifest === undefined ? {} : { cacheManifest: extracted.cacheManifest }),
      }
    : {
        diagnostics: rebound.diagnostics,
        factCounts: extracted.counts,
        factExtractionMs: extracted.elapsedMs,
        ...(extracted.cacheStatus === undefined ? {} : { cacheStatus: extracted.cacheStatus }),
        ...(extracted.cacheManifest === undefined ? {} : { cacheManifest: extracted.cacheManifest }),
      };
}

export function compileRepositoryModel(options: RepositoryModelCompilerOptions): RepositoryModelCompileResult {
  const startedAt = performance.now();
  let compiled: ReturnType<typeof compileSource>;
  try {
    compiled = compileSource(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    compiled = {
      diagnostics: [diagnostic("model_compile_failed", `live Repository Model compilation failed: ${message}`)],
    };
  }
  if (options.cache !== undefined && compiled.cacheManifest !== undefined && compiled.snapshot !== undefined) {
    try {
      options.cache.putManifest({
        ...compiled.cacheManifest,
        declarationFingerprint: digestCanonicalValue(options.declarations ?? null),
        trackedFiles: structuredClone(compiled.snapshot.integrity.trackedFiles),
        snapshotDigest: compiled.snapshot.integrity.snapshotDigest,
      });
    } catch {
      // A disposable manifest must never change the compiler's semantic result.
    }
  }
  const integrityStatus = compiled.snapshot?.integrity.status ?? "invalid";
  const integrityReason = compiled.snapshot?.integrity.statusReason ?? compiled.diagnostics[0]?.message;
  const benchmark: RepositoryModelBenchmark = {
    compileMs: performance.now() - startedAt,
    queryCount: 0,
    queryMs: 0,
    ...(compiled.factCounts === undefined ? {} : { factCounts: compiled.factCounts }),
    ...(compiled.factExtractionMs === undefined ? {} : { factExtractionMs: compiled.factExtractionMs }),
    ...(compiled.cacheStatus === undefined ? {} : { cacheStatus: compiled.cacheStatus }),
    ...(compiled.cacheStatus === undefined ? {} : { cacheHit: compiled.cacheStatus === "hit" }),
  };
  const source: RepositoryModelSource = {
    snapshot: compiled.snapshot,
    diagnostics: [...compiled.diagnostics, ...(compiled.snapshot?.analysis.diagnostics ?? [])],
    integrityStatus,
    ...(integrityReason === undefined ? {} : { integrityReason }),
    benchmark,
  };
  const query = new LiveRepositoryModelQuery(source);
  return {
    query,
    ...(compiled.snapshot === undefined ? {} : { snapshot: compiled.snapshot }),
    diagnostics: source.diagnostics,
    integrityStatus,
    benchmark,
  };
}

/** Compile the current worktree and return the stable RepositorySemanticQuery implementation. */
export function createLiveRepositoryQuery(options: RepositoryModelCompilerOptions): LiveRepositoryModelQuery {
  return compileRepositoryModel(options).query;
}

/** Alias emphasizing that the returned object implements the existing query contract. */
export const createRepositoryModelQuery = createLiveRepositoryQuery;

/** Injectable compiler facade used by integrations that already own extraction configuration. */
export class RepositoryModelCompiler {
  constructor(private readonly defaults: RepositoryModelCompilerOptions = {}) {}

  compile(options: RepositoryModelCompilerOptions = {}): RepositoryModelCompileResult {
    return compileRepositoryModel({ ...this.defaults, ...options });
  }
}

/** Default provider export retained for callers that want the explicit extractor function. */
export { extractTypeScriptFacts };
