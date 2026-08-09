import * as ts from "typescript";
import { createFactId } from "../ir/ids.js";
import type { LogicalId } from "../ir/ids.js";
import { digestCanonicalValue } from "../ir/serialize.js";
import type {
  Completeness,
  EffectId,
  EffectPolicy as IrEffectPolicy,
  JsonValue,
  Provenance,
  RepositorySemanticSnapshot,
  SemanticFact,
} from "../ir/types.js";
import { extractTypeScriptFacts } from "../extractors/typescript/extractor.js";
import { DEFAULT_EFFECT_PRIMITIVE_ADAPTER } from "./primitives.js";
import { createEffectTaxonomy, effectIdsFromAdapters } from "./taxonomy.js";
import { createTypeScriptEffectProgram, type TypeScriptEffectProgram } from "./typescript-program.js";
import type {
  EffectAnalysis,
  EffectAnalysisDelta,
  EffectChange,
  EffectConformanceResult,
  EffectDiagnostic,
  EffectEvidence,
  EffectOrigin,
  EffectPolicyExtension,
  EffectPrimitiveAdapter,
  EffectSourceLocation,
  EffectUnknown,
  EffectViolation,
  EffectiveEffectPolicy,
  SymbolEffectResult,
  ComponentEffectResult,
  TypeScriptEffectOptions,
  ResolvedSymbolIdentity,
} from "./types.js";

export const EFFECT_ANALYZER_ID = "symbol-effects" as const;
export const EFFECT_ANALYZER_VERSION = "1.0.0" as const;

const MAX_EVIDENCE_PATH_LENGTH = 64;

type SymbolMap<T> = Map<LogicalId, T>;

interface DirectState {
  evidence: EffectEvidence[];
  unknowns: EffectUnknown[];
}

interface PolicyRecord {
  policy: IrEffectPolicy;
  extension: EffectPolicyExtension;
}

interface EffectivePolicyResolution {
  policy: EffectiveEffectPolicy;
  records: readonly PolicyRecord[];
  allowSources: ReadonlyMap<EffectId, LogicalId>;
  denySources: ReadonlyMap<EffectId, LogicalId>;
  puritySource?: LogicalId;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sourceRangeKey(location: EffectSourceLocation): string {
  const range = location.range;
  if (range === undefined) return `${location.path}:`;
  return `${location.path}:${range.start.line}:${range.start.column}:${range.end?.line ?? ""}:${range.end?.column ?? ""}`;
}

function provenance(
  snapshot: RepositorySemanticSnapshot,
  kind: Provenance["kind"],
  completeness: Completeness,
): Provenance {
  return {
    kind,
    producer: { name: EFFECT_ANALYZER_ID, version: EFFECT_ANALYZER_VERSION },
    sourceRevision: {
      repositoryId: snapshot.repositoryIdentity.id,
      ...(snapshot.revisionIdentity === undefined ? {} : { revisionId: snapshot.revisionIdentity.id }),
    },
    completeness,
  };
}

function completenessForUnknowns(unknowns: readonly EffectUnknown[]): Completeness {
  if (unknowns.some((unknown) => unknown.completeness === "unknown")) return "unknown";
  return unknowns.length === 0 ? "complete" : "partial";
}

function mergeCompleteness(values: readonly Completeness[]): Completeness {
  if (values.some((value) => value === "unknown")) return "unknown";
  return values.some((value) => value === "partial") ? "partial" : "complete";
}

function isAnyType(type: ts.Type | undefined): boolean {
  return type !== undefined && (type.flags & ts.TypeFlags.Any) !== 0;
}

function isStaticImportArgument(
  expression: ts.Expression | undefined,
): expression is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return expression !== undefined && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression));
}

function isDynamicProperty(node: ts.ElementAccessExpression): boolean {
  return !isStaticImportArgument(node.argumentExpression);
}

function isAssignmentOrUpdate(node: ts.Node): boolean {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return true;
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
  }
  return false;
}

function propertyOperation(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): "read" | "write" {
  const parent = node.parent;
  return parent !== undefined && isAssignmentOrUpdate(parent) ? "write" : "read";
}

function effectEvidenceKey(evidence: EffectEvidence): string {
  return `${evidence.effect}|${evidence.origin.symbolId}|${sourceRangeKey(evidence.origin.location)}|${evidence.path.join("->")}`;
}

function unknownKey(unknown: EffectUnknown): string {
  return `${unknown.code}|${unknown.subjectId ?? ""}|${unknown.location === undefined ? "" : sourceRangeKey(unknown.location)}|${unknown.message}`;
}

function violationKey(violation: EffectViolation): string {
  return `${violation.subjectId}|${violation.policyId}|${violation.code}|${violation.effect}|${effectEvidenceKey(violation.evidence)}`;
}

function sortEvidence(values: readonly EffectEvidence[]): EffectEvidence[] {
  return [...values].sort((left, right) => compareText(effectEvidenceKey(left), effectEvidenceKey(right)));
}

function sortUnknowns(values: readonly EffectUnknown[]): EffectUnknown[] {
  return [...values].sort((left, right) => compareText(unknownKey(left), unknownKey(right)));
}

function sortViolations(values: readonly EffectViolation[]): EffectViolation[] {
  return [...values].sort((left, right) => compareText(violationKey(left), violationKey(right)));
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value)) return value.map((item) => asJsonValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, asJsonValue(item)]),
    );
  }
  return String(value);
}

function factId(subject: LogicalId, predicate: string, value: JsonValue): LogicalId {
  return createFactId(digestCanonicalValue({ subject, predicate, value }).value.slice(0, 48));
}

function fact(
  subject: LogicalId,
  predicate: string,
  value: unknown,
  authority: SemanticFact["authority"],
  factProvenance: Provenance,
): SemanticFact {
  const jsonValue = asJsonValue(value);
  return {
    id: factId(subject, predicate, jsonValue),
    subject,
    predicate,
    value: jsonValue,
    authority,
    provenance: factProvenance,
  };
}

function evidenceValue(evidence: EffectEvidence): JsonValue {
  return asJsonValue({
    effect: evidence.effect,
    path: evidence.path,
    origin: evidence.origin,
  });
}

function unknownValue(unknown: EffectUnknown): JsonValue {
  return asJsonValue(unknown);
}

function policyExtension(policy: IrEffectPolicy): EffectPolicyExtension {
  const value = policy as IrEffectPolicy & Record<string, unknown>;
  const extension: EffectPolicyExtension = {};
  if (
    value.purity === "pure" ||
    value.purity === "readonly" ||
    value.purity === "effectful" ||
    value.purity === "unknown"
  ) {
    extension.purity = value.purity;
  }
  if (value.inheritance === "inherit" || value.inheritance === "extend" || value.inheritance === "replace") {
    extension.inheritance = value.inheritance;
  }
  return extension;
}

function mutationEffect(effect: EffectId): boolean {
  return effect.endsWith(".write") || effect === "process.spawn" || effect === "process.state";
}

class TypeScriptEffectCollector {
  private readonly snapshot: RepositorySemanticSnapshot;
  private readonly options: TypeScriptEffectOptions;
  private readonly taxonomy;
  private readonly adapters: readonly EffectPrimitiveAdapter[];
  private readonly symbols: LogicalId[];
  private readonly symbolSet: ReadonlySet<LogicalId>;
  private readonly direct = new Map<LogicalId, DirectState>();
  private readonly calls = new Map<LogicalId, Set<LogicalId>>();
  private readonly globalUnknowns: EffectUnknown[] = [];
  private readonly diagnostics: EffectDiagnostic[] = [];
  private readonly unknownKeys = new Set<string>();
  private readonly evidenceKeys = new Set<string>();
  private program: TypeScriptEffectProgram | undefined;

  constructor(snapshot: RepositorySemanticSnapshot, options: TypeScriptEffectOptions) {
    this.snapshot = snapshot;
    this.options = options;
    this.taxonomy = options.taxonomy ?? createEffectTaxonomy();
    this.adapters = options.adapters ?? [DEFAULT_EFFECT_PRIMITIVE_ADAPTER];
    this.symbols = snapshot.derived.symbols.map((symbol) => symbol.id).sort(compareText);
    this.symbolSet = new Set(this.symbols);
    for (const symbolId of this.symbols) this.direct.set(symbolId, { evidence: [], unknowns: [] });
    for (const relation of snapshot.graph.relations) {
      if (relation.kind !== "calls" || !this.symbolSet.has(relation.from) || !this.symbolSet.has(relation.to)) continue;
      const targets = this.calls.get(relation.from) ?? new Set<LogicalId>();
      targets.add(relation.to);
      this.calls.set(relation.from, targets);
    }
  }

  collect(): EffectAnalysis {
    const snapshotUsable = this.snapshot.integrity.status === "fresh";
    if (!snapshotUsable) {
      this.addUnknown({
        code: "analysis-unavailable",
        message: `Effect analysis requires a fresh Symbol snapshot; received ${this.snapshot.integrity.status}`,
        completeness: "unknown",
      });
      for (const symbolId of this.symbols) {
        this.addUnknown({
          code: "analysis-unavailable",
          subjectId: symbolId,
          message: "The Symbol identity snapshot is not fresh enough to attach effects safely",
          completeness: "unknown",
        });
      }
    } else {
      try {
        this.program = createTypeScriptEffectProgram(this.options, this.snapshot);
        this.collectSnapshotUnknowns();
        this.collectAstFacts();
      } catch (error) {
        this.addUnknown({
          code: "analysis-unavailable",
          message: error instanceof Error ? error.message : String(error),
          completeness: "unknown",
        });
        for (const symbolId of this.symbols) {
          this.addUnknown({
            code: "analysis-unavailable",
            subjectId: symbolId,
            message: "The TypeScript effect program could not be constructed or traversed",
            completeness: "unknown",
          });
        }
      }
    }

    const symbols = this.buildSymbolResults();
    const components = this.buildComponentResults(symbols);
    const conformance = this.buildConformance(symbols, components);
    const allUnknowns = sortUnknowns([
      ...this.globalUnknowns,
      ...symbols.flatMap((result) => result.unknowns),
      ...components.flatMap((result) => result.unknowns),
      ...conformance.flatMap((result) => result.unknowns),
    ]).filter(
      (unknown, index, values) =>
        index === values.findIndex((candidate) => unknownKey(candidate) === unknownKey(unknown)),
    );
    const completeness = mergeCompleteness([
      completenessForUnknowns(allUnknowns),
      ...symbols.map((result) => result.transitiveCompleteness),
    ]);
    const derivedFacts = this.buildDerivedFacts(symbols, components);
    const analysisFacts = this.buildAnalysisFacts(symbols, components, conformance);
    const analysisProvenance = provenance(this.snapshot, "derived", completeness);
    return {
      taxonomy: this.taxonomy,
      symbols,
      components,
      conformance,
      completeness,
      unknowns: allUnknowns,
      diagnostics: [...this.diagnostics].sort((left, right) =>
        compareText(`${left.code}|${left.message}`, `${right.code}|${right.message}`),
      ),
      provenance: analysisProvenance,
      derivedFacts,
      analysisFacts,
    };
  }

  private collectSnapshotUnknowns(): void {
    for (const unknown of this.snapshot.analysis.unknowns) {
      const code = this.effectUnknownCode(unknown.code);
      if (code === undefined) continue;
      const base = {
        code,
        message: unknown.message,
        completeness: code === "analysis-unavailable" ? ("unknown" as const) : ("partial" as const),
      };
      if (unknown.subjects === undefined || unknown.subjects.length === 0) this.addUnknown(base);
      else for (const subjectId of unknown.subjects) this.addUnknown({ ...base, subjectId });
    }
  }

  private effectUnknownCode(code: string): EffectUnknown["code"] | undefined {
    if (
      code === "dynamic_call_target" ||
      code === "dynamic_import_unresolved" ||
      code === "any_mediated_target" ||
      code === "ambiguous_call_target" ||
      code === "ambiguous_reference_target" ||
      code === "symbol_unresolved" ||
      code === "alias_unresolved" ||
      code === "alias_target_ambiguous" ||
      code === "module_unresolved" ||
      code === "module_exports_unresolved" ||
      code === "module_outside_project" ||
      code === "opaque_external_symbol" ||
      code === "ambiguous_symbol_identity"
    ) {
      if (code === "dynamic_import_unresolved") return "dynamic-import";
      if (code === "dynamic_call_target" || code === "any_mediated_target") return "dynamic-call";
      if (
        code === "ambiguous_call_target" ||
        code === "ambiguous_reference_target" ||
        code === "ambiguous_symbol_identity"
      )
        return "unresolved-symbol";
      if (code === "opaque_external_symbol") return "opaque-external-call";
      return "unresolved-symbol";
    }
    if (code === "unsupported_module_mode" || code === "unsupported_module_resolution") return "analysis-unavailable";
    return undefined;
  }

  private collectAstFacts(): void {
    const program = this.program;
    if (program === undefined) return;
    for (const sourceFile of program.sourceFiles) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          this.inspectCall(node);
        } else if (ts.isNewExpression(node)) {
          this.inspectCall(node);
        } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          if (this.isOuterPropertyExpression(node)) this.inspectProperty(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  private isOuterPropertyExpression(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
    const parent = node.parent;
    if (parent === undefined) return true;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node)
      return false;
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return false;
    return true;
  }

  private inspectCall(node: ts.CallExpression | ts.NewExpression): void {
    const ownerId = this.program?.symbols.symbolIdForNode(node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (!isStaticImportArgument(node.arguments[0])) {
        this.addUnknown({
          code: "dynamic-import",
          subjectId: ownerId,
          message: "Dynamic import target cannot be resolved to one module identity",
          location: this.location(node),
          completeness: "partial",
        });
      }
      return;
    }
    if (ts.isCallExpression(node) && this.program?.symbols.isCommonJsRequire(node.expression)) {
      if (!isStaticImportArgument(node.arguments[0])) {
        this.addUnknown({
          code: "dynamic-import",
          subjectId: ownerId,
          message: "Dynamic require target cannot be resolved to one module identity",
          location: this.location(node),
          completeness: "partial",
        });
      }
      return;
    }
    const expression = node.expression;
    const expressionType = this.program?.checker.getTypeAtLocation(expression);
    if (isAnyType(expressionType)) {
      this.addUnknown({
        code: "dynamic-call",
        subjectId: ownerId,
        message: "Any-typed call target prevents deterministic effect identity resolution",
        location: this.location(node),
        completeness: "partial",
      });
      return;
    }
    const identity = this.program?.symbols.identityForExpression(expression);
    if (identity === undefined) {
      this.addUnknown({
        code:
          ts.isElementAccessExpression(expression) && isDynamicProperty(expression)
            ? "dynamic-call"
            : "unresolved-call",
        subjectId: ownerId,
        message: "TypeChecker did not resolve a unique call target identity",
        location: this.location(node),
        completeness: "partial",
      });
      return;
    }

    const targetId = this.projectTargetId(node);
    if (ownerId !== undefined && targetId !== undefined && ownerId !== targetId) this.addCall(ownerId, targetId);
    if (identity.kind === "project" && targetId === undefined) {
      this.addUnknown({
        code: "unresolved-symbol",
        subjectId: ownerId,
        message: `Resolved project identity ${this.program?.symbols.formatIdentity(identity) ?? identity.declarationName} has no Symbol target`,
        location: this.location(node),
        completeness: "partial",
      });
    }
    const operation = ts.isNewExpression(node) ? "construct" : "call";
    const effects = this.resolveEffects(operation, identity, node);
    if (effects.length > 0 && ownerId !== undefined) {
      for (const effect of effects) this.addEvidence(ownerId, effect, identity, node);
      return;
    }
    if (effects.length > 0) {
      this.addDiagnostic({
        code: "effect_without_symbol_owner",
        message: `Concrete ${this.program?.symbols.formatIdentity(identity) ?? "resolved"} effect occurs outside a Symbol body`,
        details: { effects },
      });
      return;
    }
    if (identity.kind === "builtin" || identity.kind === "external") {
      this.addUnknown({
        code: "opaque-external-call",
        subjectId: ownerId,
        message: `No primitive adapter is registered for ${this.program?.symbols.formatIdentity(identity) ?? identity.declarationName}`,
        location: this.location(node),
        completeness: "partial",
      });
    }
  }

  private inspectProperty(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): void {
    if (ts.isElementAccessExpression(node) && isDynamicProperty(node)) {
      const ownerId = this.program?.symbols.symbolIdForNode(node);
      const expressionType = this.program?.checker.getTypeAtLocation(node.expression);
      if (isAnyType(expressionType)) {
        this.addUnknown({
          code: "dynamic-call",
          subjectId: ownerId,
          message: "Any-typed computed property prevents deterministic effect identity resolution",
          location: this.location(node),
          completeness: "partial",
        });
      }
      return;
    }
    const identity = this.program?.symbols.identityForExpression(node);
    if (identity === undefined) return;
    const ownerId = this.program?.symbols.symbolIdForNode(node);
    const operation = propertyOperation(node);
    const effects = this.resolveEffects(operation, identity, node);
    if (ownerId === undefined) {
      if (effects.length > 0)
        this.addDiagnostic({
          code: "effect_without_symbol_owner",
          message: "Property effect occurs outside a Symbol body",
        });
      return;
    }
    for (const effect of effects) this.addEvidence(ownerId, effect, identity, node);
  }

  private resolveEffects(
    operation: "call" | "construct" | "read" | "write",
    identity: ResolvedSymbolIdentity,
    node: ts.Node,
  ): readonly EffectId[] {
    const location = this.location(node);
    const resolved: EffectId[] = [];
    for (const adapter of this.adapters) {
      try {
        const effects = adapter.resolve({ operation, identity, location });
        for (const effect of effects) {
          if (!this.taxonomy.isKnown(effect)) {
            this.addDiagnostic({
              code: "effect_not_in_taxonomy",
              message: `Adapter ${adapter.id} returned an effect outside taxonomy: ${effect}`,
              details: { adapter: adapter.id, effect },
            });
          }
          resolved.push(effect);
        }
      } catch (error) {
        this.addDiagnostic({
          code: "primitive_adapter_error",
          message: `${adapter.id}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return sortedUnique(resolved) as EffectId[];
  }

  private projectTargetId(node: ts.CallExpression | ts.NewExpression): LogicalId | undefined {
    const program = this.program;
    if (program === undefined) return undefined;
    const signature = program.checker.getResolvedSignature(node);
    const declaration = signature?.declaration;
    const declarationId = declaration === undefined ? undefined : program.symbols.symbolIdForDeclaration(declaration);
    if (declarationId !== undefined && this.symbolSet.has(declarationId as LogicalId))
      return declarationId as LogicalId;
    const expressionSymbol = program.checker.getSymbolAtLocation(node.expression);
    if (expressionSymbol === undefined) return undefined;
    const declarationFromSymbol = expressionSymbol.declarations?.[0] ?? expressionSymbol.valueDeclaration;
    const id =
      declarationFromSymbol === undefined ? undefined : program.symbols.symbolIdForDeclaration(declarationFromSymbol);
    return id !== undefined && this.symbolSet.has(id as LogicalId) ? (id as LogicalId) : undefined;
  }

  private addCall(from: LogicalId, to: LogicalId): void {
    const targets = this.calls.get(from) ?? new Set<LogicalId>();
    targets.add(to);
    this.calls.set(from, targets);
  }

  private location(node: ts.Node): EffectSourceLocation {
    const source = this.program?.symbols.sourceLocation(node);
    if (source === undefined) return { path: "<unavailable>" };
    return source;
  }

  private addEvidence(
    ownerId: LogicalId,
    effect: EffectId,
    identity: EffectEvidence["origin"]["identity"],
    node: ts.Node,
  ): void {
    const location = this.location(node);
    const evidence: EffectEvidence = {
      effect,
      origin: {
        symbolId: ownerId,
        location,
        identity,
        provenance: provenance(this.snapshot, "derived", "complete"),
      },
      path: [ownerId, this.program?.symbols.formatIdentity(identity) ?? identity.declarationName],
    };
    const key = effectEvidenceKey(evidence);
    if (this.evidenceKeys.has(key)) return;
    this.evidenceKeys.add(key);
    const state = this.direct.get(ownerId);
    if (state === undefined) return;
    state.evidence.push(evidence);
  }

  private addUnknown(unknown: EffectUnknown): void {
    const key = unknownKey(unknown);
    if (this.unknownKeys.has(key)) return;
    this.unknownKeys.add(key);
    if (unknown.subjectId !== undefined && this.direct.has(unknown.subjectId))
      this.direct.get(unknown.subjectId)!.unknowns.push(unknown);
    else this.globalUnknowns.push(unknown);
  }

  private addDiagnostic(diagnostic: EffectDiagnostic): void {
    const key = `${diagnostic.code}|${diagnostic.message}`;
    if (this.diagnostics.some((item) => `${item.code}|${item.message}` === key)) return;
    this.diagnostics.push(diagnostic);
  }

  private buildSymbolResults(): SymbolEffectResult[] {
    return this.symbols.map((symbolId) => {
      const state = this.direct.get(symbolId) ?? { evidence: [], unknowns: [] };
      const direct = sortEvidence(state.evidence);
      const directUnknowns = sortUnknowns(state.unknowns);
      const visited = new Set<LogicalId>();
      const transitiveEvidence = new Map<string, EffectEvidence>();
      const transitiveUnknowns = new Map<string, EffectUnknown>();
      const visit = (current: LogicalId, path: readonly LogicalId[]): void => {
        if (visited.has(current)) return;
        visited.add(current);
        const currentState = this.direct.get(current);
        if (currentState !== undefined) {
          for (const evidence of currentState.evidence) {
            const evidencePath = [...path, ...evidence.path.slice(1)];
            const boundedPath = evidencePath.slice(0, MAX_EVIDENCE_PATH_LENGTH);
            const propagated: EffectEvidence = { ...evidence, path: boundedPath };
            transitiveEvidence.set(
              `${propagated.effect}|${propagated.origin.symbolId}|${sourceRangeKey(propagated.origin.location)}`,
              propagated,
            );
          }
          for (const unknown of currentState.unknowns) transitiveUnknowns.set(unknownKey(unknown), unknown);
        }
        for (const target of [...(this.calls.get(current) ?? [])].sort(compareText)) {
          if (path.length >= MAX_EVIDENCE_PATH_LENGTH) {
            this.addUnknown({
              code: "evidence-path-bounded",
              subjectId: symbolId,
              message: `Evidence path from ${symbolId} exceeded the deterministic bound of ${MAX_EVIDENCE_PATH_LENGTH}`,
              completeness: "partial",
            });
            this.addDiagnostic({
              code: "evidence_path_bounded",
              message: `Evidence path from ${symbolId} reached the deterministic bound of ${MAX_EVIDENCE_PATH_LENGTH}`,
              subjectId: symbolId,
            });
            continue;
          }
          visit(target, [...path, target]);
        }
      };
      visit(symbolId, [symbolId]);
      const transitive = sortEvidence([...transitiveEvidence.values()]);
      const unknowns = sortUnknowns([...transitiveUnknowns.values()]);
      return {
        symbolId,
        direct,
        transitive,
        directCompleteness: completenessForUnknowns(directUnknowns),
        transitiveCompleteness: completenessForUnknowns(unknowns),
        unknowns,
        provenance: provenance(this.snapshot, "derived", completenessForUnknowns(unknowns)),
      };
    });
  }

  private buildComponentResults(symbols: readonly SymbolEffectResult[]): ComponentEffectResult[] {
    const bySymbol = new Map(symbols.map((result) => [result.symbolId, result]));
    const componentSymbols = new Map<LogicalId, Set<LogicalId>>();
    for (const relation of this.snapshot.graph.relations) {
      if (relation.kind !== "owns" || relation.authority !== "declared") continue;
      if (!this.snapshot.declarations.components.some((component) => component.id === relation.from)) continue;
      if (!this.symbolSet.has(relation.to)) continue;
      const owned = componentSymbols.get(relation.from) ?? new Set<LogicalId>();
      owned.add(relation.to);
      componentSymbols.set(relation.from, owned);
    }
    return this.snapshot.declarations.components
      .map((component) => {
        const ownedSymbolIds = [...(componentSymbols.get(component.id) ?? [])].sort(compareText);
        const memberResults = ownedSymbolIds
          .map((id) => bySymbol.get(id))
          .filter((result): result is SymbolEffectResult => result !== undefined);
        const direct = sortEvidence(memberResults.flatMap((result) => result.direct));
        const transitive = sortEvidence(memberResults.flatMap((result) => result.transitive));
        const unknowns = sortUnknowns([
          ...memberResults.flatMap((result) => result.unknowns),
          ...this.globalUnknowns.filter((unknown) => unknown.code === "analysis-unavailable"),
        ]);
        return {
          componentId: component.id,
          ownedSymbolIds,
          direct,
          transitive,
          completeness: mergeCompleteness([
            completenessForUnknowns(unknowns),
            ...memberResults.map((result) => result.transitiveCompleteness),
          ]),
          unknowns,
          provenance: provenance(this.snapshot, "derived", completenessForUnknowns(unknowns)),
        };
      })
      .sort((left, right) => compareText(left.componentId, right.componentId));
  }

  private buildConformance(
    symbols: readonly SymbolEffectResult[],
    components: readonly ComponentEffectResult[],
  ): EffectConformanceResult[] {
    const symbolById = new Map(symbols.map((result) => [result.symbolId, result]));
    const componentById = new Map(components.map((result) => [result.componentId, result]));
    const policySubjects = this.snapshot.declarations.effectPolicies.map((policy) => policy.subject);
    const subjects = sortedUnique([
      ...symbols.map((result) => result.symbolId),
      ...components.map((result) => result.componentId),
      ...policySubjects,
    ]) as LogicalId[];
    const allEffects = sortEvidence(symbols.flatMap((result) => result.transitive));
    const allUnknowns = sortUnknowns([...this.globalUnknowns, ...symbols.flatMap((result) => result.unknowns)]);
    return subjects.map((subjectId) => {
      const result = symbolById.get(subjectId) ?? componentById.get(subjectId);
      const evidence = result?.transitive ?? (subjectId === this.snapshot.declarations.project.id ? allEffects : []);
      const unknowns =
        result?.unknowns ??
        (subjectId === this.snapshot.declarations.project.id
          ? allUnknowns
          : [
              {
                code: "unresolved-symbol" as const,
                subjectId,
                message: "Declared effect policy subject has no derived Symbol or Component result",
                completeness: "unknown" as const,
              },
            ]);
      const completeness =
        result === undefined
          ? completenessForUnknowns(unknowns)
          : "transitiveCompleteness" in result
            ? result.transitiveCompleteness
            : result.completeness;
      const actualEffects = sortedUnique(evidence.map((item) => item.effect)) as EffectId[];
      const policyResolution = this.resolvePolicy(subjectId);
      const violations =
        policyResolution === undefined
          ? []
          : this.evaluateViolations(subjectId, actualEffects, evidence, policyResolution);
      const status: EffectConformanceResult["status"] =
        policyResolution === undefined
          ? completeness === "complete"
            ? "unconstrained"
            : "unknown"
          : violations.length > 0
            ? "violation"
            : completeness !== "complete"
              ? "unknown"
              : "conforming";
      return {
        subjectId,
        status,
        completeness,
        ...(policyResolution === undefined ? {} : { policy: policyResolution.policy }),
        actualEffects,
        violations,
        unknowns,
        provenance: provenance(this.snapshot, "inferred", completeness),
      };
    });
  }

  private resolvePolicy(subjectId: LogicalId): EffectivePolicyResolution | undefined {
    const policies = this.snapshot.declarations.effectPolicies.map((policy) => ({
      policy,
      extension: policyExtension(policy),
    }));
    const bySubject = new Map<LogicalId, PolicyRecord[]>();
    for (const record of policies) {
      const records = bySubject.get(record.policy.subject) ?? [];
      records.push(record);
      bySubject.set(record.policy.subject, records);
    }
    const chain = this.policyChain(subjectId);
    const records = chain.flatMap((id) =>
      [...(bySubject.get(id) ?? [])].sort((left, right) => compareText(left.policy.id, right.policy.id)),
    );
    if (records.length === 0) return undefined;
    let allow: EffectId[] = [];
    let deny: EffectId[] = [];
    const allowSources = new Map<EffectId, LogicalId>();
    const denySources = new Map<EffectId, LogicalId>();
    let purity: EffectiveEffectPolicy["purity"];
    let puritySource: LogicalId | undefined;
    let initialized = false;
    const inheritedFrom: LogicalId[] = [];
    for (const record of records) {
      const mode = record.extension.inheritance ?? (record.policy.subject === subjectId ? "extend" : "inherit");
      if (!initialized || mode === "replace") {
        allow = [...record.policy.allow];
        deny = [...record.policy.deny];
        allowSources.clear();
        denySources.clear();
        for (const effect of allow) allowSources.set(effect, record.policy.id);
        for (const effect of deny) denySources.set(effect, record.policy.id);
        initialized = true;
      } else if (mode === "extend") {
        allow = sortedUnique([...allow, ...record.policy.allow]) as EffectId[];
        deny = sortedUnique([...deny, ...record.policy.deny]) as EffectId[];
        for (const effect of record.policy.allow) allowSources.set(effect, record.policy.id);
        for (const effect of record.policy.deny) denySources.set(effect, record.policy.id);
      } else if (record.policy.allow.length > 0 || record.policy.deny.length > 0) {
        allow = [...record.policy.allow];
        deny = [...record.policy.deny];
        allowSources.clear();
        denySources.clear();
        for (const effect of allow) allowSources.set(effect, record.policy.id);
        for (const effect of deny) denySources.set(effect, record.policy.id);
      }
      if (record.extension.purity !== undefined && (mode !== "inherit" || purity === undefined)) {
        purity = record.extension.purity;
        puritySource = record.policy.id;
      }
      if (record.policy.subject !== subjectId && !inheritedFrom.includes(record.policy.subject))
        inheritedFrom.push(record.policy.subject);
    }
    return {
      policy: {
        policyIds: records.map((record) => record.policy.id),
        subjectId,
        allow: sortedUnique(allow) as EffectId[],
        deny: sortedUnique(deny) as EffectId[],
        ...(purity === undefined ? {} : { purity }),
        inheritedFrom: [...inheritedFrom].sort(compareText),
      },
      records,
      allowSources,
      denySources,
      ...(puritySource === undefined ? {} : { puritySource }),
    };
  }

  private policyChain(subjectId: LogicalId): LogicalId[] {
    const projectId = this.snapshot.declarations.project.id;
    const components = new Set<LogicalId>();
    for (const relation of this.snapshot.graph.relations) {
      if (relation.kind !== "owns" || relation.authority !== "declared") continue;
      if (relation.to !== subjectId) continue;
      if (this.snapshot.declarations.components.some((component) => component.id === relation.from))
        components.add(relation.from);
    }
    const componentParents = [...components].sort(compareText);
    const chain: LogicalId[] = [];
    if (subjectId !== projectId) chain.push(projectId);
    chain.push(...componentParents.filter((id) => id !== subjectId));
    chain.push(subjectId);
    return [...new Set(chain)];
  }

  private evaluateViolations(
    subjectId: LogicalId,
    actualEffects: readonly EffectId[],
    evidence: readonly EffectEvidence[],
    resolution: EffectivePolicyResolution,
  ): EffectViolation[] {
    const policy = resolution.policy;
    const policyId = policy.policyIds.at(-1) ?? policy.subjectId;
    const sourcePolicyId = (code: EffectViolation["code"], effect: EffectId): LogicalId => {
      if (code === "forbidden-effect") return resolution.denySources.get(effect) ?? policyId;
      if (code === "declared-pure-violation") return resolution.puritySource ?? policyId;
      return resolution.allowSources.get(effect) ?? policyId;
    };
    const evidenceByEffect = new Map<EffectId, EffectEvidence>();
    for (const item of evidence) evidenceByEffect.set(item.effect, evidenceByEffect.get(item.effect) ?? item);
    const violations: EffectViolation[] = [];
    for (const effect of actualEffects) {
      const item = evidenceByEffect.get(effect);
      if (item === undefined) continue;
      if (policy.deny.includes(effect)) {
        const code = "forbidden-effect" as const;
        violations.push({
          subjectId,
          policyId: sourcePolicyId(code, effect),
          code,
          effect,
          evidence: item,
          proven: true,
        });
      }
      if (policy.purity === "pure" || (policy.purity === "readonly" && mutationEffect(effect))) {
        const code = "declared-pure-violation" as const;
        violations.push({
          subjectId,
          policyId: sourcePolicyId(code, effect),
          code,
          effect,
          evidence: item,
          proven: true,
        });
      }
      if (policy.allow.length > 0 && !policy.allow.includes(effect)) {
        const code = "unallowed-effect" as const;
        violations.push({
          subjectId,
          policyId: sourcePolicyId(code, effect),
          code,
          effect,
          evidence: item,
          proven: true,
        });
      }
    }
    const deduped = new Map<string, EffectViolation>();
    for (const violation of violations) deduped.set(violationKey(violation), violation);
    return sortViolations([...deduped.values()]);
  }

  private buildDerivedFacts(
    symbols: readonly SymbolEffectResult[],
    components: readonly ComponentEffectResult[],
  ): SemanticFact[] {
    const facts: SemanticFact[] = [];
    const add = (
      subject: LogicalId,
      direct: readonly EffectEvidence[],
      transitive: readonly EffectEvidence[],
      completeness: Completeness,
      resultProvenance: Provenance,
    ): void => {
      facts.push(
        fact(subject, "effect.direct", sortedUnique(direct.map((item) => item.effect)), "derived", resultProvenance),
      );
      facts.push(
        fact(
          subject,
          "effect.transitive",
          sortedUnique(transitive.map((item) => item.effect)),
          "derived",
          resultProvenance,
        ),
      );
      facts.push(fact(subject, "effect.completeness", { completeness }, "derived", resultProvenance));
      facts.push(fact(subject, "effect.evidence", transitive.map(evidenceValue), "derived", resultProvenance));
    };
    for (const result of symbols)
      add(result.symbolId, result.direct, result.transitive, result.transitiveCompleteness, result.provenance);
    for (const result of components)
      add(result.componentId, result.direct, result.transitive, result.completeness, result.provenance);
    return facts.sort((left, right) => compareText(left.id, right.id));
  }

  private buildAnalysisFacts(
    symbols: readonly SymbolEffectResult[],
    components: readonly ComponentEffectResult[],
    conformance: readonly EffectConformanceResult[],
  ): SemanticFact[] {
    const facts: SemanticFact[] = [];
    for (const result of [...symbols, ...components]) {
      const subjectId = "symbolId" in result ? result.symbolId : result.componentId;
      facts.push(
        fact(
          subjectId,
          "effect.unknowns",
          result.unknowns.map(unknownValue),
          "analysis",
          provenance(this.snapshot, "inferred", completenessForUnknowns(result.unknowns)),
        ),
      );
    }
    for (const result of conformance) {
      const resultProvenance = result.provenance;
      facts.push(fact(result.subjectId, "effect.conformance", result.status, "analysis", resultProvenance));
      facts.push(fact(result.subjectId, "effect.violations", result.violations, "analysis", resultProvenance));
      facts.push(
        fact(result.subjectId, "effect.conformance_completeness", result.completeness, "analysis", resultProvenance),
      );
      if (result.policy !== undefined)
        facts.push(fact(result.subjectId, "effect.effective_policy", result.policy, "analysis", resultProvenance));
    }
    return facts.sort((left, right) => compareText(left.id, right.id));
  }
}

export function analyzeTypeScriptEffects(options: TypeScriptEffectOptions): EffectAnalysis {
  const snapshot = options.snapshot ?? extractTypeScriptFacts(options).snapshot;
  return new TypeScriptEffectCollector(snapshot, options).collect();
}

export const analyzeEffects = analyzeTypeScriptEffects;

function conformanceBySubject(analysis: EffectAnalysis): Map<LogicalId, EffectConformanceResult> {
  return new Map(analysis.conformance.map((result) => [result.subjectId, result]));
}

function actualEffectsBySubject(
  analysis: EffectAnalysis,
): Map<LogicalId, { effects: readonly EffectId[]; completeness: Completeness }> {
  const values = new Map<LogicalId, { effects: readonly EffectId[]; completeness: Completeness }>();
  for (const result of analysis.symbols)
    values.set(result.symbolId, {
      effects: sortedUnique(result.transitive.map((item) => item.effect)) as EffectId[],
      completeness: result.transitiveCompleteness,
    });
  for (const result of analysis.components)
    values.set(result.componentId, {
      effects: sortedUnique(result.transitive.map((item) => item.effect)) as EffectId[],
      completeness: result.completeness,
    });
  for (const result of analysis.conformance) {
    if (!values.has(result.subjectId))
      values.set(result.subjectId, { effects: result.actualEffects, completeness: result.completeness });
  }
  return values;
}

export function computeEffectAnalysisDelta(previous: EffectAnalysis, next: EffectAnalysis): EffectAnalysisDelta {
  const previousValues = actualEffectsBySubject(previous);
  const nextValues = actualEffectsBySubject(next);
  const previousConformance = conformanceBySubject(previous);
  const nextConformance = conformanceBySubject(next);
  const subjects = sortedUnique([...previousValues.keys(), ...nextValues.keys()]) as LogicalId[];
  const changes: EffectChange[] = [];
  for (const subjectId of subjects) {
    const before = previousValues.get(subjectId) ?? { effects: [], completeness: "unknown" as const };
    const after = nextValues.get(subjectId) ?? { effects: [], completeness: "unknown" as const };
    const added = after.effects.filter((effect) => !before.effects.includes(effect));
    const removed = before.effects.filter((effect) => !after.effects.includes(effect));
    const beforeConformance = previousConformance.get(subjectId);
    const afterConformance = nextConformance.get(subjectId);
    const conformanceChanged =
      beforeConformance?.status !== afterConformance?.status ||
      JSON.stringify(beforeConformance?.violations ?? []) !== JSON.stringify(afterConformance?.violations ?? []);
    if (added.length === 0 && removed.length === 0 && before.completeness === after.completeness && !conformanceChanged)
      continue;
    changes.push({
      subjectId,
      added: [...added].sort(compareText) as EffectId[],
      removed: [...removed].sort(compareText) as EffectId[],
      previousCompleteness: before.completeness,
      nextCompleteness: after.completeness,
      conformanceChanged,
      violations: afterConformance?.violations ?? [],
    });
  }
  const violations = sortViolations(next.conformance.flatMap((result) => result.violations));
  return { changes, violations };
}
