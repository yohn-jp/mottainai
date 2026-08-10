import { compareRepositorySnapshots } from "../diff/index.js";
import type { SemanticChangeSet } from "../diff/types.js";
import type { EffectAnalysis } from "../effects/types.js";
import { analyzeTypeScriptEffects } from "../effects/analyzer.js";
import { validateSnapshot } from "../ir/schema.js";
import type {
  CanonicalProsePolicy,
  RepositorySemanticSnapshot,
  SemanticDiagnostic,
  SemanticTransaction,
} from "../ir/types.js";
import type { LogicalId } from "../ir/ids.js";
import { compileRepositoryModel } from "../model/compiler.js";
import { loadSemanticSource, persistSemanticMutation } from "../source/index.js";
import { createSemanticMutationService } from "../mutations/index.js";
import type { SemanticMutationRequest, SemanticMutationResult } from "../mutations/types.js";
import { planMinimumSufficientVerification, type VerificationPlan } from "../verification/planner.js";
import { inspectManagedComments } from "./comments.js";
import { assessSnapshotIntegrity, inspectSemanticSource, type SemanticSourceInspection } from "./integrity.js";
import { configuredSemanticEnforcementMode, semanticDecision } from "./policy.js";
import type {
  SemanticBlocker,
  SemanticCommentReport,
  SemanticDiffSummary,
  SemanticEffectReport,
  SemanticEnforcementMode,
  SemanticEnforcementOptions,
  SemanticEnforcementReport,
  SemanticIntegrityReport,
  SemanticManagedScope,
  SemanticOwnershipReport,
  SemanticReviewReport,
  SemanticTransactionReport,
  SemanticVerificationReport,
} from "./types.js";

const DEFAULT_COMMENT_POLICY: CanonicalProsePolicy = {
  canonicalLanguage: "en",
  canonicalForm: "formal-english",
  humanLocalization: "projection",
  llmTokenCompression: "projection",
  sourceCodeSemantics: "implementation-only",
  semanticCommentKinds: ["rationale", "todo-debt-intent", "review-note", "constraint", "api-meaning"],
  inlineDirectives: ["compiler", "legal", "machine"],
  jsdoc: "projection",
};

function blocker(code: string, message: string, details?: Record<string, unknown>): SemanticBlocker {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function diagnostic(code: string, message: string): SemanticDiagnostic {
  return { code, severity: "error", message };
}

function statusRank(status: "fresh" | "stale" | "invalid"): number {
  return status === "invalid" ? 2 : status === "stale" ? 1 : 0;
}

function mergeIntegrity(left: SemanticIntegrityReport, right: SemanticIntegrityReport): SemanticIntegrityReport {
  const status = statusRank(left.status) >= statusRank(right.status) ? left.status : right.status;
  return {
    status,
    sourceAvailable: left.sourceAvailable && right.sourceAvailable,
    sourceCanonical: left.sourceCanonical && right.sourceCanonical,
    directEdits: [...new Set([...left.directEdits, ...right.directEdits])].sort(),
    staleReasons: [...new Set([...left.staleReasons, ...right.staleReasons])].sort(),
    diagnostics: [...left.diagnostics, ...right.diagnostics],
    ...(right.snapshotDigest === undefined ? {} : { snapshotDigest: right.snapshotDigest }),
  };
}

function sourcePathMatches(managedPath: string, filePath: string): boolean {
  const normalizedManaged = managedPath.split("\\").join("/").replace(/\/$/u, "");
  const normalizedFile = filePath.split("\\").join("/");
  return normalizedFile === normalizedManaged || normalizedFile.startsWith(`${normalizedManaged}/`);
}

function managedScope(snapshot: RepositorySemanticSnapshot, options: SemanticEnforcementOptions): SemanticManagedScope {
  const requestedPaths = [...new Set(options.managedPaths ?? [])].map((path) => path.split("\\").join("/"));
  const explicit = new Set(options.managedSymbolIds ?? []);
  const selectedSymbols = snapshot.derived.symbols.filter((symbol) => {
    if (explicit.has(symbol.id)) return true;
    return (
      symbol.locator.file !== undefined && requestedPaths.some((path) => sourcePathMatches(path, symbol.locator.file!))
    );
  });
  const paths = [
    ...new Set([
      ...requestedPaths,
      ...selectedSymbols.map((symbol) => symbol.locator.file).filter((path): path is string => path !== undefined),
    ]),
  ].sort();
  const symbolIds = [...new Set([...selectedSymbols.map((symbol) => symbol.id), ...explicit])].sort();
  return { paths, symbolIds, fullyManaged: paths.length > 0 || explicit.size > 0 };
}

function ownershipReport(
  snapshot: RepositorySemanticSnapshot,
  symbolIds: readonly LogicalId[],
): SemanticOwnershipReport {
  const declarationsBySymbol = new Map<LogicalId, NonNullable<typeof snapshot.declarations.symbolOwnership>>();
  for (const declaration of snapshot.declarations.symbolOwnership ?? []) {
    const values = declarationsBySymbol.get(declaration.symbolId) ?? [];
    values.push(declaration);
    declarationsBySymbol.set(declaration.symbolId, values);
  }
  const symbols = new Map(snapshot.derived.symbols.map((symbol) => [symbol.id, symbol]));
  const relations = snapshot.graph.relations.filter(
    (relation) => relation.authority === "declared" && (relation.kind === "owns" || relation.kind === "shares"),
  );
  const ownedSymbolIds: LogicalId[] = [];
  const sharedSymbolIds: LogicalId[] = [];
  const missingSymbolIds: LogicalId[] = [];
  const invalidSymbolIds: LogicalId[] = [];
  for (const symbolId of symbolIds) {
    const declarations = declarationsBySymbol.get(symbolId) ?? [];
    const declaration = declarations[0];
    const owns = relations.filter((relation) => relation.kind === "owns" && relation.to === symbolId);
    const shares = relations.filter((relation) => relation.kind === "shares" && relation.to === symbolId);
    if (declaration === undefined) {
      missingSymbolIds.push(symbolId);
      continue;
    }
    if (declarations.length !== 1 || symbols.get(symbolId)?.classification !== declaration.classification) {
      invalidSymbolIds.push(symbolId);
      continue;
    }
    if (declaration.classification === "managed") {
      if (
        declaration.componentId === undefined ||
        owns.length !== 1 ||
        owns[0]?.from !== declaration.componentId ||
        shares.length > 0
      )
        invalidSymbolIds.push(symbolId);
      else ownedSymbolIds.push(symbolId);
    } else if (owns.length > 0 || declaration.componentId !== undefined) {
      invalidSymbolIds.push(symbolId);
    } else sharedSymbolIds.push(symbolId);
  }
  return {
    managedSymbolIds: [...symbolIds],
    ownedSymbolIds,
    sharedSymbolIds,
    missingSymbolIds,
    invalidSymbolIds,
  };
}

function emptyComments(paths: readonly string[]): SemanticCommentReport {
  return {
    managedPaths: [...paths],
    findings: [],
    humanCommentCount: 0,
    todoDebtCount: 0,
    jsdocCount: 0,
    allowedCount: 0,
  };
}

function transactionReport(
  changeSet: SemanticChangeSet | undefined,
  transaction: SemanticTransaction | undefined,
  directEdit = false,
): SemanticTransactionReport {
  const comparison = changeSet?.authorizedVsActual;
  const actualKinds = comparison?.actualKinds ?? changeSet?.semanticDeltas.map((item) => item.kind) ?? [];
  const authorizedKinds = comparison?.authorizedKinds ?? transaction?.authorizedDeltaKinds ?? [];
  const unauthorized =
    comparison?.unauthorized === true ||
    (actualKinds.length > 0 && transaction === undefined) ||
    (transaction?.intent === "semantic-neutral" && actualKinds.length > 0);
  return {
    provided: transaction !== undefined,
    ...(transaction === undefined ? {} : { intent: transaction.intent }),
    actualKinds: [...new Set(actualKinds)].sort(),
    authorizedKinds: [...new Set(authorizedKinds)].sort(),
    status: comparison?.status ?? (actualKinds.length > 0 ? "not-provided" : "matched"),
    unauthorized,
    missing: actualKinds.length > 0 && transaction === undefined,
    directEdit,
  };
}

function reviewReport(
  snapshot: RepositorySemanticSnapshot,
  changeSet: SemanticChangeSet | undefined,
  transaction: SemanticTransaction | undefined,
): SemanticReviewReport {
  const level = changeSet?.reviewLevel ?? snapshot.analysis.reviewLevel;
  const reasons = changeSet?.reviewReasons ?? [];
  const protectedSubjects = [
    ...(changeSet?.semanticDeltas.filter((item) => item.protected).map((item) => item.subject) ?? []),
    ...(transaction?.protectedChanges ?? []),
  ].sort();
  return {
    level,
    reasons: [...new Set(reasons)].sort(),
    l3: level === "L3",
    protectedSubjects: [...new Set(protectedSubjects)],
    recommendedSourceReads: changeSet?.recommendedSourceReads ?? snapshot.analysis.recommendedSourceReads,
  };
}

function verificationReport(plan: VerificationPlan | undefined): SemanticVerificationReport {
  if (plan === undefined)
    return { status: "unavailable", sufficient: false, missing: [], stale: [], failed: [], uncertain: [] };
  return {
    status: plan.status,
    sufficient: plan.sufficient,
    missing: plan.missing.map((item) => item.id),
    stale: plan.stale.map((item) => item.id),
    failed: plan.failed.map((item) => item.id),
    uncertain: plan.uncertain.map((item) => item.id),
  };
}

function effectReport(analysis: EffectAnalysis | undefined): SemanticEffectReport {
  if (analysis === undefined) return { status: "unavailable", violations: 0, unknowns: 0 };
  const violations = analysis.conformance.flatMap((item) => item.violations).length;
  const unknowns = analysis.unknowns.length;
  return {
    status: violations > 0 ? "violation" : unknowns > 0 ? "unknown" : "conforming",
    violations,
    unknowns,
    completeness: analysis.completeness,
  };
}

function snapshotSourceIntegrity(snapshot: RepositorySemanticSnapshot): SemanticIntegrityReport {
  return {
    status: snapshot.integrity.status,
    sourceAvailable: true,
    sourceCanonical: true,
    directEdits: [],
    staleReasons:
      snapshot.integrity.status === "fresh"
        ? []
        : [snapshot.integrity.statusReason ?? `snapshot is ${snapshot.integrity.status}`],
    diagnostics: [],
    snapshotDigest: snapshot.integrity.snapshotDigest,
  };
}

function diffSummary(changeSet: SemanticChangeSet | undefined): SemanticDiffSummary | undefined {
  if (changeSet === undefined) return undefined;
  const limit = <T>(values: readonly T[], count = 80): T[] => [...values].slice(0, count);
  return {
    baseSnapshotId: changeSet.baseSnapshotId,
    headSnapshotId: changeSet.headSnapshotId,
    changedFiles: limit(changeSet.changedFiles),
    changedSymbols: limit(changeSet.changedSymbols),
    changedComponents: limit(changeSet.changedComponents),
    semanticDeltas: limit(changeSet.semanticDeltas, 64).map((item) => ({
      subject: item.subject,
      kind: item.kind,
      summary: item.summary,
      reviewLevel: item.reviewLevel,
      compatibility: item.compatibility,
      protected: item.protected,
      breaking: item.breaking,
    })),
    affectedEntities: limit(changeSet.affectedEntities),
    evidenceRefreshNeeds: limit(changeSet.evidenceRefreshNeeds.map((item) => item.id)),
    unknownRegions: limit(changeSet.unknownRegions.map((item) => item.id)),
    authorizedVsActual: {
      status: changeSet.authorizedVsActual.status,
      authorizedKinds: limit(changeSet.authorizedVsActual.authorizedKinds),
      actualKinds: limit(changeSet.authorizedVsActual.actualKinds),
      excessKinds: limit(changeSet.authorizedVsActual.excessKinds),
      missingKinds: limit(changeSet.authorizedVsActual.missingKinds),
      unauthorized: changeSet.authorizedVsActual.unauthorized,
    },
    reviewLevel: changeSet.reviewLevel,
    reviewReasons: limit(changeSet.reviewReasons),
    recommendedSourceReads: limit(changeSet.recommendedSourceReads),
  };
}

async function snapshotFor(options: SemanticEnforcementOptions): Promise<{
  snapshot?: RepositorySemanticSnapshot;
  source?: SemanticSourceInspection;
  diagnostics: SemanticDiagnostic[];
  queryAvailable: boolean;
  queryReason?: string;
  effectAnalysis?: EffectAnalysis;
}> {
  const diagnostics: SemanticDiagnostic[] = [];
  if (options.snapshot !== undefined) {
    const validation = validateSnapshot(options.snapshot);
    if (!validation.ok)
      return { diagnostics: validation.diagnostics, queryAvailable: false, queryReason: "snapshot validation failed" };
    return { snapshot: validation.snapshot, diagnostics: [], queryAvailable: true };
  }
  if (options.rootDir === undefined)
    return {
      diagnostics: [diagnostic("missing_root_dir", "rootDir is required for live semantic enforcement")],
      queryAvailable: false,
      queryReason: "rootDir is required",
    };
  const source = await inspectSemanticSource({
    rootDir: options.rootDir,
    ...(options.baselineRef === undefined ? {} : { baselineRef: options.baselineRef }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    baselineSnapshot: options.baseSnapshot,
    transaction: options.transaction,
    supportedMutation: options.supportedMutation,
  });
  diagnostics.push(...source.diagnostics);
  if (!source.sourceAvailable) {
    return { source, diagnostics, queryAvailable: false, queryReason: "semantic source is unavailable" };
  }
  const declarations = source.snapshot?.declarations;
  const compiled = compileRepositoryModel({
    rootDir: options.rootDir,
    ...(declarations === undefined ? {} : { declarations }),
    ...(options.baseSnapshot === undefined && source.baselineSnapshot === undefined
      ? {}
      : { baseSnapshot: options.baseSnapshot ?? source.baselineSnapshot }),
    ...(options.transaction === undefined ? {} : { transaction: options.transaction }),
  });
  diagnostics.push(...compiled.diagnostics);
  let effectAnalysis: EffectAnalysis | undefined;
  if (compiled.snapshot !== undefined) {
    try {
      effectAnalysis = analyzeTypeScriptEffects({ rootDir: options.rootDir, snapshot: compiled.snapshot });
    } catch (error) {
      diagnostics.push({
        code: "effect_analysis_unavailable",
        severity: "warning",
        message: error instanceof Error ? error.message : "effect analysis could not be completed",
      });
    }
  }
  return {
    snapshot: compiled.snapshot,
    source,
    diagnostics,
    queryAvailable: compiled.snapshot !== undefined,
    queryReason: compiled.snapshot === undefined ? "live model compilation failed" : undefined,
    ...(effectAnalysis === undefined ? {} : { effectAnalysis }),
  };
}

/** Evaluate the current repository through the existing semantic authorities. */
export async function evaluateSemanticEnforcement(
  options: SemanticEnforcementOptions = {},
): Promise<SemanticEnforcementReport> {
  const mode: SemanticEnforcementMode = options.mode ?? configuredSemanticEnforcementMode(options.environment);
  const resolved = await snapshotFor(options);
  const snapshot = resolved.snapshot;
  const managed =
    snapshot === undefined
      ? {
          paths: [...new Set(options.managedPaths ?? [])].sort(),
          symbolIds: [...new Set(options.managedSymbolIds ?? [])].sort(),
          fullyManaged: (options.managedPaths?.length ?? 0) > 0 || (options.managedSymbolIds?.length ?? 0) > 0,
        }
      : managedScope(snapshot, options);
  let integrity: SemanticIntegrityReport =
    snapshot === undefined
      ? {
          status: "invalid",
          sourceAvailable: resolved.source?.sourceAvailable ?? false,
          sourceCanonical: resolved.source?.sourceCanonical ?? false,
          directEdits: resolved.source?.directEdits ?? [],
          staleReasons: resolved.source?.staleReasons ?? [],
          diagnostics: resolved.diagnostics,
        }
      : snapshotSourceIntegrity(snapshot);
  if (resolved.source !== undefined) {
    integrity = mergeIntegrity(integrity, resolved.source);
  }
  if (snapshot !== undefined && options.rootDir !== undefined)
    integrity = mergeIntegrity(integrity, assessSnapshotIntegrity(options.rootDir, snapshot));

  const emptyOwnership: SemanticOwnershipReport = {
    managedSymbolIds: managed.symbolIds,
    ownedSymbolIds: [],
    sharedSymbolIds: [],
    missingSymbolIds: managed.symbolIds,
    invalidSymbolIds: [],
  };
  const ownership = snapshot === undefined ? emptyOwnership : ownershipReport(snapshot, managed.symbolIds);
  const commentZero = options.commentZero ?? managed.fullyManaged;
  const comments =
    snapshot !== undefined && options.rootDir !== undefined && commentZero
      ? inspectManagedComments({
          rootDir: options.rootDir,
          paths: managed.paths,
          policy: snapshot.declarations.commentPolicy,
        })
      : emptyComments(managed.paths);
  const baselineSnapshot = options.baseSnapshot ?? resolved.source?.baselineSnapshot;
  const changeSet =
    options.changeSet ??
    (snapshot !== undefined && baselineSnapshot !== undefined
      ? compareRepositorySnapshots(baselineSnapshot, snapshot, { transaction: options.transaction })
      : undefined);
  const transaction = transactionReport(changeSet, options.transaction, integrity.directEdits.length > 0);
  const diff = diffSummary(changeSet);
  const review =
    snapshot === undefined
      ? { level: "L3" as const, reasons: [], l3: true, protectedSubjects: [], recommendedSourceReads: [] }
      : reviewReport(snapshot, changeSet, options.transaction);
  const plan =
    options.verificationPlan ??
    (snapshot === undefined ? undefined : planMinimumSufficientVerification({ snapshot, changeSet }));
  const verification = verificationReport(plan);
  // Effect conformance remains #51-owned. Live callers may inject its analysis;
  // the bounded governance command does not silently launch a second repository
  // analysis pass merely to populate a report.
  const effects: EffectAnalysis | undefined = options.effectAnalysis ?? resolved.effectAnalysis;
  const effectSummary = effectReport(effects);
  const blockers: SemanticBlocker[] = [];
  const warnings: SemanticBlocker[] = [];
  const reportDiagnostics = [
    ...new Map(resolved.diagnostics.map((item) => [`${item.code}:${item.path ?? ""}:${item.message}`, item])).values(),
  ];
  for (const item of reportDiagnostics) {
    if (item.code === "semantic_source_unavailable" && mode !== "enforce" && !managed.fullyManaged)
      warnings.push(blocker(item.code, item.message));
    else if (item.severity === "warning") warnings.push(blocker(item.code, item.message));
    else blockers.push(blocker(item.code, item.message));
  }
  if (integrity.status !== "fresh")
    blockers.push(
      blocker(
        `semantic_integrity_${integrity.status}`,
        integrity.staleReasons.join("; ") || "semantic integrity is not fresh",
      ),
    );
  if (integrity.directEdits.length > 0)
    blockers.push(
      blocker(
        "direct_canonical_edit",
        "direct edits to canonical semantic serialization require an explicit mutation or migration path",
        { paths: integrity.directEdits },
      ),
    );
  if (managed.fullyManaged) {
    if (ownership.missingSymbolIds.length > 0)
      blockers.push(
        blocker(
          "symbol_ownership_missing",
          "managed Symbols require explicit Component ownership or Shared classification",
          { symbolIds: ownership.missingSymbolIds },
        ),
      );
    if (ownership.invalidSymbolIds.length > 0)
      blockers.push(
        blocker(
          "symbol_ownership_invalid",
          "managed Symbol ownership must have exactly one owner or explicit Shared relations",
          { symbolIds: ownership.invalidSymbolIds },
        ),
      );
    if (comments.humanCommentCount > 0)
      blockers.push(
        blocker("managed_comment_zero_violation", "human semantic comments are forbidden in fully managed source", {
          count: comments.humanCommentCount,
        }),
      );
    if (comments.todoDebtCount > 0)
      blockers.push(
        blocker("semantic_debt_missing", "TODO/FIXME/TBD comments require structured semantic debt before removal", {
          count: comments.todoDebtCount,
        }),
      );
    if (comments.jsdocCount > 0)
      blockers.push(
        blocker("managed_jsdoc_not_canonical", "hand-authored JSDoc is not canonical for managed Symbols", {
          count: comments.jsdocCount,
        }),
      );
  }
  if (transaction.missing)
    blockers.push(
      blocker("missing_semantic_transaction", "material semantic delta requires an explicit #49 Semantic Transaction"),
    );
  if (transaction.unauthorized)
    blockers.push(
      blocker("unauthorized_semantic_delta", "actual semantic delta is not authorized by the supplied transaction"),
    );
  if (options.intent === "semantic-change" && options.transaction === undefined)
    blockers.push(
      blocker("missing_semantic_transaction", "semantic-change intent requires an explicit Semantic Transaction"),
    );
  if (review.l3 && (changeSet?.semanticDeltas.length ?? 0) > 0 && !transaction.unauthorized)
    blockers.push(
      blocker(
        "l3_review_required",
        "L3 protected/breaking semantic changes require explicit review before enforce mode",
      ),
    );
  if (effectSummary.violations > 0)
    blockers.push(
      blocker("effect_conformance_violation", "authoritative effect policy conformance reported violations", {
        count: effectSummary.violations,
      }),
    );
  if (effectSummary.unknowns > 0)
    warnings.push(
      blocker(
        "effect_analysis_unknown",
        "effect analysis contains unknown or incomplete facts; inferred facts do not authorize a failure",
        { count: effectSummary.unknowns },
      ),
    );
  if (plan === undefined)
    warnings.push(blocker("verification_unavailable", "verification planner could not produce a plan"));
  else {
    if (verification.missing.length > 0)
      blockers.push(
        blocker("verification_evidence_missing", "required verification evidence is missing", {
          ids: verification.missing,
        }),
      );
    if (verification.stale.length > 0)
      blockers.push(
        blocker("verification_evidence_stale", "required verification evidence is stale", { ids: verification.stale }),
      );
    if (verification.failed.length > 0)
      blockers.push(
        blocker("verification_failed", "required verification evidence failed", { ids: verification.failed }),
      );
    if (verification.uncertain.length > 0)
      warnings.push(
        blocker("verification_uncertain", "verification selection or evidence is uncertain", {
          ids: verification.uncertain,
        }),
      );
  }
  const decision = semanticDecision(mode, blockers.length, warnings.length);
  const authoritative =
    snapshot !== undefined &&
    integrity.status === "fresh" &&
    resolved.queryAvailable &&
    decision !== "block" &&
    decision !== "warn";
  return {
    apiVersion: "v1",
    mode,
    decision,
    authoritative,
    managed,
    integrity,
    ownership,
    comments,
    transaction,
    ...(diff === undefined ? {} : { diff }),
    review,
    verification,
    effects: effectSummary,
    blockers: [...new Map(blockers.map((item) => [`${item.code}:${item.message}`, item])).values()],
    warnings: [...new Map(warnings.map((item) => [`${item.code}:${item.message}`, item])).values()],
    diagnostics: reportDiagnostics,
    query: {
      available: resolved.queryAvailable,
      successful: resolved.queryAvailable,
      ...(resolved.queryAvailable ? { provider: "live-repository-model" } : { reason: resolved.queryReason }),
    },
    provenance: { producer: "mottainai-semantic-enforcement", version: "1.0.0", authority: "analysis" },
  };
}

/** The only supported programmatic declaration write path exposed to CLI/governance. */
export async function applySemanticTransaction(
  rootDir: string,
  request: SemanticMutationRequest,
): Promise<SemanticMutationResult> {
  const loaded = await loadSemanticSource(rootDir);
  if (!loaded.ok) return { ok: false, diagnostics: loaded.diagnostics };
  const service = createSemanticMutationService(loaded.snapshot);
  const plan = service.plan(request);
  const result = service.apply(plan);
  if (result.ok) await persistSemanticMutation(rootDir, result);
  return result;
}
