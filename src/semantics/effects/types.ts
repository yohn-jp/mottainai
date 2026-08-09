import type { FactView } from "../query.js";
import type { LogicalId } from "../ir/ids.js";
import type {
  Completeness,
  EffectId,
  Provenance,
  RepositorySemanticSnapshot,
  SemanticFact,
  SourceRange,
} from "../ir/types.js";

export type EffectCompleteness = Completeness;

export type EffectOperation = "call" | "construct" | "read" | "write";

export type EffectIdentityKind = "builtin" | "external" | "global" | "project" | "unknown";

/**
 * Identity resolved by the TypeScript checker. `exportPath` is the resolved
 * import/property path, not a best-effort function-name label.
 */
export interface ResolvedSymbolIdentity {
  kind: EffectIdentityKind;
  module?: string;
  package?: string;
  exportPath: readonly string[];
  declarationName: string;
  declarationFile?: string;
  symbolName?: string;
}

export interface EffectSourceLocation {
  path: string;
  range?: SourceRange;
}

export interface EffectOrigin {
  symbolId: LogicalId;
  location: EffectSourceLocation;
  identity: ResolvedSymbolIdentity;
  provenance: Provenance;
}

/** One concrete, statically resolved effect observation. */
export interface EffectEvidence {
  effect: EffectId;
  origin: EffectOrigin;
  /** Symbol IDs followed from the owning symbol to the primitive identity. */
  path: readonly string[];
}

export type EffectUnknownCode =
  | "dynamic-call"
  | "unresolved-call"
  | "opaque-external-call"
  | "dynamic-import"
  | "unresolved-symbol"
  | "evidence-path-bounded"
  | "symbol-identity-unavailable"
  | "analysis-unavailable";

export interface EffectUnknown {
  code: EffectUnknownCode;
  subjectId?: LogicalId;
  message: string;
  location?: EffectSourceLocation;
  /** Unknowns reduce completeness; they never carry a concrete effect. */
  completeness: Exclude<EffectCompleteness, "complete">;
}

export interface SymbolEffectResult {
  symbolId: LogicalId;
  direct: readonly EffectEvidence[];
  transitive: readonly EffectEvidence[];
  directCompleteness: EffectCompleteness;
  transitiveCompleteness: EffectCompleteness;
  unknowns: readonly EffectUnknown[];
  provenance: Provenance;
}

export interface ComponentEffectResult {
  componentId: LogicalId;
  ownedSymbolIds: readonly LogicalId[];
  direct: readonly EffectEvidence[];
  transitive: readonly EffectEvidence[];
  completeness: EffectCompleteness;
  unknowns: readonly EffectUnknown[];
  provenance: Provenance;
}

export type EffectPolicyPurity = "pure" | "readonly" | "effectful" | "unknown";
export type EffectPolicyInheritance = "inherit" | "extend" | "replace";

/**
 * #84's serializable EffectPolicy is the required base. The optional fields
 * are accepted as a forward-compatible #49 policy extension when a declared
 * provider supplies them, without making effects its own declaration store.
 */
export interface EffectPolicyExtension {
  purity?: EffectPolicyPurity;
  inheritance?: EffectPolicyInheritance;
}

export interface EffectiveEffectPolicy extends EffectPolicyExtension {
  policyIds: readonly LogicalId[];
  subjectId: LogicalId;
  allow: readonly EffectId[];
  deny: readonly EffectId[];
  purity?: EffectPolicyPurity;
  inheritedFrom: readonly LogicalId[];
}

export type EffectViolationCode = "forbidden-effect" | "declared-pure-violation" | "unallowed-effect";

export interface EffectViolation {
  subjectId: LogicalId;
  policyId: LogicalId;
  code: EffectViolationCode;
  effect: EffectId;
  evidence: EffectEvidence;
  proven: true;
}

export type EffectConformanceStatus = "conforming" | "violation" | "unknown" | "unconstrained";

export interface EffectConformanceResult {
  subjectId: LogicalId;
  status: EffectConformanceStatus;
  completeness: EffectCompleteness;
  policy?: EffectiveEffectPolicy;
  actualEffects: readonly EffectId[];
  violations: readonly EffectViolation[];
  unknowns: readonly EffectUnknown[];
  provenance: Provenance;
}

export interface EffectDiagnostic {
  code: string;
  message: string;
  subjectId?: LogicalId;
  details?: Record<string, unknown>;
}

export interface EffectAnalysis {
  taxonomy: EffectTaxonomy;
  symbols: readonly SymbolEffectResult[];
  components: readonly ComponentEffectResult[];
  conformance: readonly EffectConformanceResult[];
  completeness: EffectCompleteness;
  unknowns: readonly EffectUnknown[];
  diagnostics: readonly EffectDiagnostic[];
  provenance: Provenance;
  /** Derived Symbol/Component facts for #53/live-model and IR consumers. */
  derivedFacts: readonly SemanticFact[];
  /** Analysis facts for conformance projections; no final L0-L3 classification. */
  analysisFacts: readonly SemanticFact[];
}

export interface EffectDefinition {
  id: EffectId;
  domain: string;
  operation: string;
  description: string;
}

export interface EffectTaxonomy {
  version: 1;
  definitions: readonly EffectDefinition[];
  isKnown(effect: EffectId): boolean;
  extend(definitions: readonly EffectDefinition[]): EffectTaxonomy;
}

export interface EffectPrimitiveContext {
  operation: EffectOperation;
  identity: ResolvedSymbolIdentity;
  location: EffectSourceLocation;
}

export interface EffectPrimitiveAdapter {
  id: string;
  resolve(context: EffectPrimitiveContext): readonly EffectId[];
}

export interface TypeScriptEffectOptions {
  rootDir: string;
  tsconfigPath?: string;
  rootNames?: readonly string[];
  repositoryName?: string;
  packageName?: string;
  revision?: string;
  snapshot?: RepositorySemanticSnapshot;
  taxonomy?: EffectTaxonomy;
  adapters?: readonly EffectPrimitiveAdapter[];
}

export interface EffectQueryProjection {
  factsFor(entityId: LogicalId): readonly FactView[];
  entities: ReadonlyMap<LogicalId, readonly FactView[]>;
}

export interface EffectChange {
  subjectId: LogicalId;
  added: readonly EffectId[];
  removed: readonly EffectId[];
  previousCompleteness?: EffectCompleteness;
  nextCompleteness?: EffectCompleteness;
  conformanceChanged: boolean;
  violations: readonly EffectViolation[];
}

export interface EffectAnalysisDelta {
  changes: readonly EffectChange[];
  violations: readonly EffectViolation[];
}
