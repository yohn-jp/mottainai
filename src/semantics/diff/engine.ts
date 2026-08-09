import { computeEffectAnalysisDelta } from "../effects/analyzer.js";
import type { EffectAnalysisDelta, EffectViolation } from "../effects/types.js";
import { compareText, digestCanonicalValue, stableStringifyValue } from "../ir/canonical.js";
import { createLogicalId } from "../ir/ids.js";
import type { LogicalId } from "../ir/ids.js";
import type {
  Contract,
  ContentDigest,
  DeclaredState,
  EffectPolicy,
  InvariantEntity,
  JsonValue,
  RepositorySemanticSnapshot,
  ReviewLevel,
  SemanticEntity,
  SemanticFact,
  SemanticRelation,
  SemanticTransaction,
  SourceReference,
  SymbolEntity,
} from "../ir/types.js";
import { SEMANTIC_DELTA_KINDS } from "../ir/types.js";
import { propagateSemanticImpact } from "../impact/propagation.js";
import type { SemanticChangeSetView } from "../query.js";
import type {
  AuthorizedActualComparison,
  ChangeKind,
  CompatibilityResult,
  DerivedChange,
  EvidenceRefreshNeed,
  IdentityStatus,
  SemanticChangeSet,
  SemanticDeltaRecord,
  SemanticDiffInput,
  SemanticDiffOptions,
  SymbolChange,
  UnknownRegion,
} from "./types.js";
import { DIFF_ENGINE_PRODUCER, SEMANTIC_CHANGE_SET_VERSION } from "./types.js";

type AnyEntity = SemanticEntity;
type MutableDelta = SemanticDeltaRecord & { sourceChangeIds: string[] };

const REVIEW_RANK: Record<ReviewLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };
const KIND_RANK = new Map(SEMANTIC_DELTA_KINDS.map((kind, index) => [kind, index]));
const PHYSICAL_SYMBOL_FACTS = new Set(["symbol.source_range"]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareReview(left: ReviewLevel, right: ReviewLevel): ReviewLevel {
  return REVIEW_RANK[left] >= REVIEW_RANK[right] ? left : right;
}

function compareIds(left: { id: string }, right: { id: string }): number {
  return compareText(left.id, right.id);
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function valueEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableStringifyValue(left) === stableStringifyValue(right);
}

function stableId(namespace: string, value: unknown): string {
  return createLogicalId(namespace, digestCanonicalValue(value).value.slice(0, 48));
}

function entityArrays(snapshot: RepositorySemanticSnapshot): AnyEntity[] {
  return [
    snapshot.declarations.project,
    ...snapshot.declarations.components,
    ...snapshot.declarations.capabilities,
    ...snapshot.declarations.contracts,
    ...snapshot.declarations.invariants,
    ...snapshot.declarations.decisions,
    ...snapshot.declarations.rationales,
    ...snapshot.declarations.constraints,
    ...snapshot.derived.files,
    ...snapshot.derived.symbols,
    ...snapshot.derived.packages,
    ...snapshot.derived.externalDependencies,
    ...snapshot.derived.externalApis,
    ...snapshot.observed.evidences,
    ...snapshot.observed.tests,
  ];
}

function entityMap(snapshot: RepositorySemanticSnapshot): Map<LogicalId, AnyEntity> {
  return new Map(entityArrays(snapshot).map((item) => [item.id, item]));
}

function symbolMap(snapshot: RepositorySemanticSnapshot): Map<LogicalId, SymbolEntity> {
  return new Map(snapshot.derived.symbols.map((item) => [item.id, item]));
}

function factsBySubject(snapshot: RepositorySemanticSnapshot): Map<LogicalId, Map<string, JsonValue[]>> {
  const result = new Map<LogicalId, Map<string, JsonValue[]>>();
  const allFacts = [
    ...snapshot.derived.facts,
    ...snapshot.declarations.facts,
    ...snapshot.observed.facts,
    ...snapshot.analysis.facts,
  ];
  for (const fact of allFacts) {
    const predicates = result.get(fact.subject) ?? new Map<string, JsonValue[]>();
    const values = predicates.get(fact.predicate) ?? [];
    values.push(fact.value);
    predicates.set(fact.predicate, values);
    result.set(fact.subject, predicates);
  }
  for (const predicates of result.values()) {
    for (const [predicate, values] of predicates) {
      predicates.set(
        predicate,
        values.sort((left, right) => compareText(stableStringifyValue(left), stableStringifyValue(right))),
      );
    }
  }
  return result;
}

function firstFact(
  facts: Map<LogicalId, Map<string, JsonValue[]>>,
  id: LogicalId,
  predicate: string,
): JsonValue | undefined {
  return facts.get(id)?.get(predicate)?.[0];
}

function factValues(facts: Map<LogicalId, Map<string, JsonValue[]>>, id: LogicalId, predicate: string): JsonValue[] {
  return facts.get(id)?.get(predicate) ?? [];
}

function entitySource(snapshot: RepositorySemanticSnapshot, id: LogicalId): SourceReference[] {
  const entity = entityMap(snapshot).get(id);
  const references: SourceReference[] = [];
  if (entity?.kind === "symbol") {
    const locator = entity.locator;
    if (locator.file !== undefined) {
      references.push({
        path: locator.file,
        symbol: locator.symbol,
        ...(locator.range?.start.line === undefined ? {} : { startLine: locator.range.start.line }),
        ...(locator.range?.end?.line === undefined ? {} : { endLine: locator.range.end.line }),
        reason: "inspect the changed Symbol declaration and its semantic boundary",
      });
    }
  } else if (entity?.kind === "file") {
    references.push({ path: entity.path, reason: "inspect the changed source file and its extracted Symbol facts" });
  }
  if (references.length === 0 && entity !== undefined) {
    for (const provenance of [entity.provenance]) {
      for (const evidence of provenance.evidence ?? []) {
        if (evidence.locator?.kind === "symbol" && evidence.locator.file !== undefined) {
          references.push({
            path: evidence.locator.file,
            ...(evidence.locator.symbol === undefined ? {} : { symbol: evidence.locator.symbol }),
            reason: "inspect the source referenced by the semantic declaration",
          });
        } else if (evidence.locator?.kind === "file") {
          references.push({
            path: evidence.locator.path,
            reason: "inspect the source referenced by the semantic declaration",
          });
        }
      }
    }
  }
  if (references.length === 0 && entity !== undefined) {
    references.push({
      path: "semantic-model",
      symbol: id,
      reason: "inspect the semantic declaration; no source locator was supplied",
    });
  }
  return references;
}

function sourceKey(reference: SourceReference): string {
  return `${reference.path}:${reference.symbol ?? ""}:${reference.startLine ?? ""}:${reference.endLine ?? ""}:${reference.reason}`;
}

function dedupeSourceReads(references: readonly SourceReference[]): SourceReference[] {
  const result = new Map<string, SourceReference>();
  for (const reference of references) result.set(sourceKey(reference), reference);
  return [...result.values()].sort((left, right) => compareText(sourceKey(left), sourceKey(right)));
}

function snapshotDigest(snapshot: RepositorySemanticSnapshot): ContentDigest {
  try {
    return snapshot.integrity.snapshotDigest;
  } catch {
    return digestCanonicalValue(snapshot);
  }
}

function revision(snapshot: RepositorySemanticSnapshot): string {
  return snapshot.revisionIdentity?.id ?? snapshot.revisionIdentity?.revision ?? "unknown";
}

function kindOf(entity: AnyEntity | undefined): string | undefined {
  return entity?.kind;
}

function normalizeRelationKind(kind: string): string {
  return kind.replace(/-/gu, "_");
}

function relationKey(relation: SemanticRelation): string {
  return `${relation.kind}:${relation.from}:${relation.to}`;
}

function relationMap(snapshot: RepositorySemanticSnapshot): Map<string, SemanticRelation> {
  return new Map(snapshot.graph.relations.map((relation) => [relationKey(relation), relation]));
}

function collectionChanges<T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T) => string,
): Array<{ key: string; before?: T; after?: T }> {
  const beforeMap = new Map(before.map((item) => [keyOf(item), item]));
  const afterMap = new Map(after.map((item) => [keyOf(item), item]));
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])]
    .sort(compareText)
    .map((key) => ({ key, before: beforeMap.get(key), after: afterMap.get(key) }))
    .filter((item) => !valueEqual(item.before, item.after));
}

function symbolIdentityKey(symbol: SymbolEntity, mode: 0 | 1 | 2 | 3): string {
  const locator = symbol.locator;
  const packageName = locator.package ?? "";
  const moduleName = locator.module ?? "";
  const symbolName = locator.symbol;
  const signature = locator.signature ?? "";
  switch (mode) {
    case 0:
      return `${packageName}|${moduleName}|${symbolName}|${signature}`;
    case 1:
      return `${packageName}|${symbolName}|${signature}`;
    case 2:
      return `${packageName}|${symbolName}`;
    case 3:
      return `${packageName}|${signature}`;
  }
}

interface SymbolPair {
  before?: SymbolEntity;
  after?: SymbolEntity;
  identityStatus: IdentityStatus;
  ambiguousCandidates?: SymbolEntity[];
}

function pairSymbols(before: readonly SymbolEntity[], after: readonly SymbolEntity[]): SymbolPair[] {
  const beforeMap = new Map(before.map((item) => [item.id, item]));
  const afterMap = new Map(after.map((item) => [item.id, item]));
  const pairedBefore = new Set<LogicalId>();
  const pairedAfter = new Set<LogicalId>();
  const pairs: SymbolPair[] = [];
  for (const id of [...beforeMap.keys()].filter((item) => afterMap.has(item)).sort(compareText)) {
    const left = beforeMap.get(id)!;
    const right = afterMap.get(id)!;
    pairedBefore.add(id);
    pairedAfter.add(id);
    const fileChanged = left.locator.file !== right.locator.file;
    const nameChanged = left.locator.symbol !== right.locator.symbol;
    const identityStatus: IdentityStatus = nameChanged ? "renamed" : fileChanged ? "moved" : "unchanged";
    pairs.push({ before: left, after: right, identityStatus });
  }

  const unmatchedBefore = [...beforeMap.values()].filter((item) => !pairedBefore.has(item.id)).sort(compareIds);
  const unmatchedAfter = [...afterMap.values()].filter((item) => !pairedAfter.has(item.id)).sort(compareIds);
  for (const mode of [0, 1, 2, 3] as const) {
    const beforeGroups = new Map<string, SymbolEntity[]>();
    const afterGroups = new Map<string, SymbolEntity[]>();
    for (const item of unmatchedBefore) {
      if (pairedBefore.has(item.id)) continue;
      const values = beforeGroups.get(symbolIdentityKey(item, mode)) ?? [];
      values.push(item);
      beforeGroups.set(symbolIdentityKey(item, mode), values);
    }
    for (const item of unmatchedAfter) {
      if (pairedAfter.has(item.id)) continue;
      const values = afterGroups.get(symbolIdentityKey(item, mode)) ?? [];
      values.push(item);
      afterGroups.set(symbolIdentityKey(item, mode), values);
    }
    for (const key of [...beforeGroups.keys()].sort(compareText)) {
      const left = beforeGroups.get(key)!;
      const right = afterGroups.get(key) ?? [];
      if (left.length !== 1 || right.length !== 1) continue;
      const beforeSymbol = left[0]!;
      const afterSymbol = right[0]!;
      pairedBefore.add(beforeSymbol.id);
      pairedAfter.add(afterSymbol.id);
      const renamed = beforeSymbol.locator.symbol !== afterSymbol.locator.symbol;
      pairs.push({ before: beforeSymbol, after: afterSymbol, identityStatus: renamed ? "renamed" : "moved" });
    }
  }

  const ambiguousAfter = new Set<LogicalId>();
  const ambiguousBefore = new Set<LogicalId>();
  for (const item of unmatchedAfter) {
    if (pairedAfter.has(item.id)) continue;
    const candidates = unmatchedBefore.filter(
      (candidate) =>
        !pairedBefore.has(candidate.id) &&
        (symbolIdentityKey(candidate, 2) === symbolIdentityKey(item, 2) ||
          symbolIdentityKey(candidate, 3) === symbolIdentityKey(item, 3)),
    );
    if (candidates.length > 1) {
      ambiguousAfter.add(item.id);
      pairs.push({ after: item, identityStatus: "ambiguous", ambiguousCandidates: candidates.sort(compareIds) });
    }
  }
  for (const item of unmatchedBefore) {
    if (pairedBefore.has(item.id)) continue;
    const candidates = unmatchedAfter.filter(
      (candidate) =>
        !pairedAfter.has(candidate.id) &&
        (symbolIdentityKey(candidate, 2) === symbolIdentityKey(item, 2) ||
          symbolIdentityKey(candidate, 3) === symbolIdentityKey(item, 3)),
    );
    if (candidates.length > 1) {
      ambiguousBefore.add(item.id);
      pairs.push({ before: item, identityStatus: "ambiguous", ambiguousCandidates: candidates.sort(compareIds) });
    }
  }
  for (const item of unmatchedBefore)
    if (!pairedBefore.has(item.id) && !ambiguousBefore.has(item.id))
      pairs.push({ before: item, identityStatus: "removed" });
  for (const item of unmatchedAfter)
    if (!pairedAfter.has(item.id) && !ambiguousAfter.has(item.id)) pairs.push({ after: item, identityStatus: "added" });
  return pairs.sort((left, right) =>
    compareText(
      `${left.after?.id ?? ""}:${left.before?.id ?? ""}`,
      `${right.after?.id ?? ""}:${right.before?.id ?? ""}`,
    ),
  );
}

function publicVisibility(
  facts: Map<LogicalId, Map<string, JsonValue[]>>,
  symbol: SymbolEntity | undefined,
): boolean | undefined {
  if (symbol === undefined) return undefined;
  const visibilityValues = factValues(facts, symbol.id, "symbol.visibility");
  const exportedValues = factValues(facts, symbol.id, "symbol.exported");
  if (visibilityValues.some((value) => value === "public" || value === "protected") || exportedValues.includes(true))
    return true;
  if (visibilityValues.some((value) => value === "private" || value === "internal") || exportedValues.includes(false))
    return false;
  return undefined;
}

function factValueForSymbol(
  facts: Map<LogicalId, Map<string, JsonValue[]>>,
  symbol: SymbolEntity,
  predicate: string,
): JsonValue | undefined {
  return firstFact(facts, symbol.id, predicate);
}

function splitTopLevel(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(" || character === "[" || character === "{" || character === "<") depth += 1;
    else if (character === ")" || character === "]" || character === "}" || character === ">")
      depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail.length > 0) result.push(tail);
  return result;
}

interface ParsedSignature {
  parameters: Array<{ type: string; optional: boolean }>;
  returnType?: string;
}

function parseSignature(value: string): ParsedSignature | undefined {
  const open = value.indexOf("(");
  if (open < 0) return undefined;
  let depth = 0;
  let close = -1;
  for (let index = open; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) return undefined;
  const parameters = splitTopLevel(value.slice(open + 1, close)).map((parameter) => {
    const optional = parameter.includes("?") || parameter.includes("=") || parameter.startsWith("...");
    const colon = parameter.indexOf(":");
    return { type: (colon < 0 ? parameter : parameter.slice(colon + 1)).replace(/\s+/gu, " ").trim(), optional };
  });
  const returnPart = value.slice(close + 1).trim();
  return { parameters, ...(returnPart.startsWith(":") ? { returnType: returnPart.slice(1).trim() } : {}) };
}

function compareSignatures(
  before: string | undefined,
  after: string | undefined,
): { level: ReviewLevel; compatibility: CompatibilityResult; reason: string } {
  if (before === undefined || after === undefined)
    return { level: "L2", compatibility: "unknown", reason: "public Symbol signature completeness is unknown" };
  if (before === after) return { level: "L0", compatibility: "unchanged", reason: "signature is unchanged" };
  const left = parseSignature(before);
  const right = parseSignature(after);
  if (left === undefined || right === undefined)
    return {
      level: "L2",
      compatibility: "review-required",
      reason: "public Symbol signature changed and cannot be parsed conservatively",
    };
  if (right.parameters.length > left.parameters.length) {
    const added = right.parameters.slice(left.parameters.length);
    if (added.every((parameter) => parameter.optional)) {
      return { level: "L1", compatibility: "compatible", reason: "only optional public input parameters were added" };
    }
    return { level: "L3", compatibility: "breaking", reason: "a required public input parameter was added" };
  }
  if (right.parameters.length < left.parameters.length) {
    return { level: "L3", compatibility: "breaking", reason: "a public input parameter was removed" };
  }
  if (left.parameters.some((parameter, index) => parameter.type !== right.parameters[index]?.type)) {
    return { level: "L2", compatibility: "review-required", reason: "a public input parameter type changed" };
  }
  if (left.returnType !== right.returnType) {
    if (left.returnType === "void" && right.returnType !== "void")
      return { level: "L1", compatibility: "compatible", reason: "the public return guarantee was strengthened" };
    if (right.returnType === "void" && left.returnType !== "void")
      return { level: "L3", compatibility: "breaking", reason: "the public return guarantee was removed" };
    return { level: "L2", compatibility: "review-required", reason: "the public output type changed" };
  }
  return { level: "L2", compatibility: "review-required", reason: "the public signature changed" };
}

function entityProtected(snapshot: RepositorySemanticSnapshot, id: LogicalId): boolean {
  const entity = entityMap(snapshot).get(id);
  if (entity !== undefined) {
    if ("stability" in entity && (entity.stability === "stable" || entity.stability === "protected")) return true;
    if ("reviewLevel" in entity && entity.reviewLevel === "L3") return true;
    if (entity.kind === "constraint" && entity.enforcement === "protected") return true;
  }
  return (
    snapshot.declarations.stability.some(
      (item) => item.subject === id && (item.stability === "stable" || item.stability === "protected"),
    ) || snapshot.declarations.reviewGuidance.some((item) => item.subject === id && item.level === "L3")
  );
}

function semanticLevelForEntityChange(
  kind: string,
  changeKind: ChangeKind,
  before: AnyEntity | undefined,
  after: AnyEntity | undefined,
):
  | {
      level: ReviewLevel;
      compatibility: CompatibilityResult;
      breaking: boolean;
      kind: "responsibility" | "capability" | "contract" | "invariant" | "dependency-policy" | "public-surface";
    }
  | undefined {
  const added = changeKind === "added";
  const removed = changeKind === "removed";
  const protectedValue =
    (before !== undefined &&
      "stability" in before &&
      (before.stability === "protected" || before.stability === "stable")) ||
    (after !== undefined && "stability" in after && (after.stability === "protected" || after.stability === "stable"));
  if (kind === "component")
    return {
      kind: "responsibility",
      level: removed ? "L3" : added ? "L1" : protectedValue ? "L3" : "L2",
      compatibility: removed ? "breaking" : added ? "compatible" : "review-required",
      breaking: removed,
    };
  if (kind === "capability")
    return {
      kind: "capability",
      level: removed ? "L3" : added ? "L1" : protectedValue ? "L3" : "L2",
      compatibility: removed ? "breaking" : added ? "compatible" : "review-required",
      breaking: removed,
    };
  if (kind === "contract")
    return {
      kind: "contract",
      level: removed ? "L3" : added ? "L1" : protectedValue ? "L3" : "L2",
      compatibility: removed ? "breaking" : added ? "compatible" : "review-required",
      breaking: removed,
    };
  if (kind === "invariant")
    return {
      kind: "invariant",
      level: removed ? "L3" : added ? "L1" : protectedValue ? "L3" : "L2",
      compatibility: removed ? "breaking" : added ? "compatible" : "review-required",
      breaking: removed,
    };
  if (kind === "package" || kind === "external_dependency" || kind === "external_api")
    return {
      kind: "dependency-policy",
      level: removed ? "L3" : "L2",
      compatibility: removed ? "breaking" : "review-required",
      breaking: removed,
    };
  if (kind === "constraint" || kind === "decision" || kind === "rationale")
    return {
      kind: "public-surface",
      level: removed ? "L3" : protectedValue ? "L3" : "L2",
      compatibility: removed ? "breaking" : "review-required",
      breaking: removed,
    };
  return undefined;
}

function entityFieldValue(entity: AnyEntity, key: string): unknown {
  return Reflect.get(entity, key);
}

function changedKeys(before: AnyEntity, after: AnyEntity): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter(
      (key) =>
        !["id", "authority", "provenance"].includes(key) &&
        !valueEqual(entityFieldValue(before, key), entityFieldValue(after, key)),
    )
    .sort(compareText);
}

function boundaryRelationKind(kind: string): "responsibility" | "capability" | "invariant" | undefined {
  const normalized = normalizeRelationKind(kind);
  if (normalized === "owns" || normalized === "shares") return "responsibility";
  if (normalized === "provides" || normalized === "requires" || normalized === "implements") return "capability";
  if (normalized === "constrained_by" || normalized === "governs") return "invariant";
  return undefined;
}

function factSemanticKind(
  predicate: string,
):
  | "responsibility"
  | "capability"
  | "contract"
  | "effect"
  | "invariant"
  | "dependency-policy"
  | "public-surface"
  | undefined {
  const prefix = predicate.split(".")[0];
  if (prefix === "responsibility") return "responsibility";
  if (prefix === "capability") return "capability";
  if (prefix === "contract") return "contract";
  if (prefix === "effect") return "effect";
  if (prefix === "invariant") return "invariant";
  if (prefix === "dependency") return "dependency-policy";
  if (prefix === "public" || prefix === "api") return "public-surface";
  return undefined;
}

function contractCompatibility(
  before: Contract | undefined,
  after: Contract | undefined,
): { level: ReviewLevel; compatibility: CompatibilityResult; reasons: string[] } {
  if (before === undefined || after === undefined)
    return { level: "L2", compatibility: "unknown", reasons: ["contract completeness is unknown"] };
  const reasons: string[] = [];
  let level: ReviewLevel = "L0";
  const raise = (next: ReviewLevel): void => {
    level = compareReview(level, next);
  };
  const oldParameters = before.inputs.parameters;
  const newParameters = after.inputs.parameters;
  if (newParameters.length > oldParameters.length) {
    if (newParameters.slice(oldParameters.length).every((item) => item.required !== true)) {
      raise("L1");
      reasons.push("optional contract inputs were added");
    } else {
      raise("L3");
      reasons.push("required contract inputs were added");
    }
  } else if (newParameters.length < oldParameters.length) {
    raise("L3");
    reasons.push("contract inputs were removed");
  }
  const oldByName = new Map(oldParameters.map((item) => [item.name, item]));
  for (const parameter of newParameters) {
    const previous = oldByName.get(parameter.name);
    if (previous !== undefined && !valueEqual(previous, parameter)) {
      raise("L2");
      reasons.push(`contract input ${parameter.name} changed`);
    }
  }
  const oldAccepted = new Set(before.inputs.acceptedDomain.map((item) => stableStringifyValue(item)));
  const newAccepted = new Set(after.inputs.acceptedDomain.map((item) => stableStringifyValue(item)));
  if ([...oldAccepted].some((item) => !newAccepted.has(item))) {
    raise("L3");
    reasons.push("accepted contract input domain was weakened");
  }
  if ([...newAccepted].some((item) => !oldAccepted.has(item))) {
    raise("L1");
    reasons.push("accepted contract input domain was strengthened");
  }
  const oldPre = new Set(before.inputs.preconditions.map((item) => stableStringifyValue(item)));
  const newPre = new Set(after.inputs.preconditions.map((item) => stableStringifyValue(item)));
  if ([...oldPre].some((item) => !newPre.has(item))) {
    raise("L3");
    reasons.push("a contract precondition was removed");
  }
  if ([...newPre].some((item) => !oldPre.has(item))) {
    raise("L3");
    reasons.push("a contract precondition was added");
  }
  if (!valueEqual(before.outputs.returnValue, after.outputs.returnValue)) {
    raise("L2");
    reasons.push("contract return guarantee changed");
  }
  const oldPost = new Set(before.outputs.postconditions.map((item) => stableStringifyValue(item)));
  const newPost = new Set(after.outputs.postconditions.map((item) => stableStringifyValue(item)));
  if ([...oldPost].some((item) => !newPost.has(item))) {
    raise("L3");
    reasons.push("a contract postcondition was removed");
  }
  if ([...newPost].some((item) => !oldPost.has(item))) {
    raise("L1");
    reasons.push("a contract postcondition was strengthened");
  }
  if (!valueEqual(before.outputs.errors, after.outputs.errors)) {
    raise("L3");
    reasons.push("the public error domain changed");
  }
  if (!valueEqual(before.outputs.stateTransitions, after.outputs.stateTransitions)) {
    raise("L2");
    reasons.push("contract state transitions changed");
  }
  if (
    !valueEqual(before.outputs.externalCalls, after.outputs.externalCalls) ||
    !valueEqual(before.outputs.externalEvents, after.outputs.externalEvents)
  ) {
    raise("L2");
    reasons.push("contract external interactions changed");
  }
  if (level === "L0") return { level: "L0", compatibility: "unchanged", reasons: [] };
  return {
    level,
    compatibility: level === "L1" ? "compatible" : level === "L3" ? "breaking" : "review-required",
    reasons,
  };
}

function invariantCompatibility(
  before: InvariantEntity | undefined,
  after: InvariantEntity | undefined,
): { level: ReviewLevel; compatibility: CompatibilityResult; reason: string } {
  if (before === undefined || after === undefined)
    return {
      level: before === undefined ? "L1" : "L3",
      compatibility: before === undefined ? "compatible" : "breaking",
      reason: before === undefined ? "invariant was added" : "protected invariant was removed",
    };
  if (before.severity === "error" && after.severity !== "error")
    return { level: "L3", compatibility: "breaking", reason: "invariant severity was weakened" };
  if (
    before.statement !== after.statement ||
    before.severity !== after.severity ||
    before.stability !== after.stability
  )
    return { level: "L3", compatibility: "breaking", reason: "protected invariant declaration changed" };
  return { level: "L0", compatibility: "unchanged", reason: "invariant is unchanged" };
}

function sortDeltas(deltas: readonly SemanticDeltaRecord[]): SemanticDeltaRecord[] {
  return [...deltas].sort((left, right) =>
    compareText(
      `${left.subject}:${KIND_RANK.get(left.kind) ?? 99}:${left.id}`,
      `${right.subject}:${KIND_RANK.get(right.kind) ?? 99}:${right.id}`,
    ),
  );
}

function transactionComparison(
  actual: readonly SemanticDeltaRecord[],
  transaction: SemanticTransaction | undefined,
): AuthorizedActualComparison {
  if (transaction === undefined) {
    return {
      authorizedKinds: [],
      actualKinds: [...new Set(actual.map((item) => item.kind))].sort(compareText),
      excessKinds: [],
      missingKinds: [],
      status: "not-provided",
      unauthorized: false,
    };
  }
  const actualKinds = [...new Set(actual.map((item) => item.kind))].sort(
    (left, right) => (KIND_RANK.get(left) ?? 99) - (KIND_RANK.get(right) ?? 99),
  );
  const authorizedKinds = [
    ...new Set(transaction.authorizedDeltaKinds ?? transaction.delta.entries.map((item) => item.kind)),
  ].sort((left, right) => (KIND_RANK.get(left) ?? 99) - (KIND_RANK.get(right) ?? 99));
  const excessKinds = actualKinds.filter((kind) => !authorizedKinds.includes(kind));
  const missingKinds = authorizedKinds.filter((kind) => !actualKinds.includes(kind));
  const unauthorized = transaction.intent === "semantic-neutral" ? actualKinds.length > 0 : excessKinds.length > 0;
  let status: AuthorizedActualComparison["status"] = "matched";
  if (transaction.intent === "semantic-neutral" && actualKinds.length > 0) status = "unauthorized";
  else if (excessKinds.length > 0 && missingKinds.length > 0) status = "excess-and-missing";
  else if (excessKinds.length > 0) status = "excess";
  else if (missingKinds.length > 0) status = "missing";
  const transactionId = digestCanonicalValue(transaction).value;
  return {
    transactionId,
    intent: transaction.intent,
    authorizedKinds,
    actualKinds,
    excessKinds,
    missingKinds,
    status,
    unauthorized,
    ...(unauthorized
      ? {
          stopEvent: {
            kind: "unauthorized-semantic-delta" as const,
            level: "L3" as const,
            reason:
              transaction.intent === "semantic-neutral"
                ? "semantic-neutral transaction produced a material semantic delta"
                : "actual semantic delta exceeded the authorized transaction kinds",
          },
        }
      : {}),
  };
}

function effectDeltaFromOptions(options: SemanticDiffOptions): EffectAnalysisDelta | undefined {
  if (options.effectDelta !== undefined) return options.effectDelta;
  if (options.effects?.delta !== undefined) return options.effects.delta;
  if (options.effects?.before !== undefined && options.effects.after !== undefined)
    return computeEffectAnalysisDelta(options.effects.before, options.effects.after);
  return undefined;
}

function comparePolicyCollections(
  before: DeclaredState,
  after: DeclaredState,
  derived: DerivedChange[],
  addDelta: (
    subject: LogicalId,
    kind: "effect" | "dependency-policy",
    summary: string,
    level: ReviewLevel,
    compatibility: CompatibilityResult,
    sourceIds: readonly string[],
    breaking?: boolean,
  ) => void,
): void {
  for (const item of collectionChanges(before.effectPolicies, after.effectPolicies, (value) => value.id)) {
    const subject = item.after?.subject ?? item.before?.subject;
    if (subject === undefined) continue;
    const change = makeDerivedChange(
      subject,
      "effect-policy",
      item.before,
      item.after,
      item.before === undefined ? "added" : item.after === undefined ? "removed" : "modified",
      `declarations.effectPolicies.${item.key}`,
    );
    derived.push(change);
    addDelta(
      subject,
      "effect",
      "Declared effect policy changed.",
      item.after === undefined ? "L3" : "L2",
      item.after === undefined ? "breaking" : "review-required",
      [change.id],
      item.after === undefined,
    );
  }
  for (const item of collectionChanges(before.dependencyPolicies, after.dependencyPolicies, (value) => value.id)) {
    const subject = item.after?.subject ?? item.before?.subject;
    if (subject === undefined) continue;
    const change = makeDerivedChange(
      subject,
      "dependency-policy",
      item.before,
      item.after,
      item.before === undefined ? "added" : item.after === undefined ? "removed" : "modified",
      `declarations.dependencyPolicies.${item.key}`,
    );
    derived.push(change);
    addDelta(
      subject,
      "dependency-policy",
      "Declared dependency policy changed.",
      item.after === undefined ? "L3" : "L2",
      item.after === undefined ? "breaking" : "review-required",
      [change.id],
      item.after === undefined,
    );
  }
}

function makeDerivedChange(
  entityId: LogicalId,
  entityKind: string,
  before: unknown,
  after: unknown,
  changeKind: ChangeKind,
  path: string,
  summary = `${entityKind} ${changeKind} at ${path}`,
): DerivedChange {
  return {
    id: stableId("change", { entityId, entityKind, before, after, changeKind, path }),
    entityId,
    entityKind,
    path,
    changeKind,
    ...(before === undefined ? {} : { before: asJson(before) }),
    ...(after === undefined ? {} : { after: asJson(after) }),
    summary,
  };
}

function addUnknownRegion(
  unknowns: Map<string, UnknownRegion>,
  snapshot: RepositorySemanticSnapshot,
  code: string,
  message: string,
  subjects: readonly LogicalId[],
): void {
  const uniqueSubjects = [...new Set(subjects)].sort(compareText);
  const id = stableId("unknown", { code, message, subjects: uniqueSubjects });
  if (unknowns.has(id)) return;
  unknowns.set(id, {
    id,
    code,
    message,
    subjects: uniqueSubjects,
    material: true,
    recommendedSourceReads: dedupeSourceReads(uniqueSubjects.flatMap((subject) => entitySource(snapshot, subject))),
  });
}

function collectEvidenceNeeds(
  snapshot: RepositorySemanticSnapshot,
  subjects: readonly LogicalId[],
  sourceReads: readonly SourceReference[],
): EvidenceRefreshNeed[] {
  const relationByTarget = new Map<LogicalId, { evidence: Set<LogicalId>; tests: Set<LogicalId> }>();
  for (const relation of snapshot.graph.relations) {
    if (relation.kind !== "evidence_for" && relation.kind !== "verifies" && relation.kind !== "tests") continue;
    const value = relationByTarget.get(relation.to) ?? { evidence: new Set<LogicalId>(), tests: new Set<LogicalId>() };
    const from = entityMap(snapshot).get(relation.from);
    if (from?.kind === "test" || relation.kind === "tests") value.tests.add(relation.from);
    else value.evidence.add(relation.from);
    relationByTarget.set(relation.to, value);
  }
  return [...new Set(subjects)].sort(compareText).map((subject) => {
    const value = relationByTarget.get(subject) ?? { evidence: new Set<LogicalId>(), tests: new Set<LogicalId>() };
    const evidenceIds = [...value.evidence].sort(compareText);
    const testIds = [...value.tests].sort(compareText);
    return {
      id: stableId("evidence", { subject, evidenceIds, testIds }),
      subject,
      evidenceIds,
      testIds,
      required: evidenceIds.length === 0 && testIds.length === 0,
      reason:
        evidenceIds.length === 0 && testIds.length === 0
          ? "semantic change has no associated evidence; add or refresh conformance evidence"
          : "refresh associated evidence after the semantic change",
      sourceReads: dedupeSourceReads([...sourceReads, ...entitySource(snapshot, subject)]),
    };
  });
}

function projectEntityChange(
  before: AnyEntity | undefined,
  after: AnyEntity | undefined,
  entityId: LogicalId,
  derived: DerivedChange[],
  protectedEntity: boolean,
  addDelta: (
    subject: LogicalId,
    kind:
      | "responsibility"
      | "capability"
      | "contract"
      | "effect"
      | "invariant"
      | "dependency-policy"
      | "public-surface",
    summary: string,
    level: ReviewLevel,
    compatibility: CompatibilityResult,
    sourceIds: readonly string[],
    breaking?: boolean,
    protectedOverride?: boolean,
  ) => void,
): void {
  const entity = after ?? before;
  if (entity === undefined || entity.kind === "symbol") return;
  const changeKind: ChangeKind = before === undefined ? "added" : after === undefined ? "removed" : "modified";
  if (before === undefined || after === undefined) {
    const change = makeDerivedChange(entityId, entity.kind, before, after, changeKind, `$entity`);
    derived.push(change);
    const semantic = semanticLevelForEntityChange(entity.kind, changeKind, before, after);
    if (semantic !== undefined)
      addDelta(
        entityId,
        semantic.kind,
        `${entity.kind} declaration was ${changeKind}.`,
        protectedEntity ? "L3" : semantic.level,
        protectedEntity ? "breaking" : semantic.compatibility,
        [change.id],
        protectedEntity || semantic.breaking,
        protectedEntity,
      );
    return;
  }
  const keys = changedKeys(before, after);
  if (keys.length === 0) return;
  for (const key of keys) {
    const change = makeDerivedChange(
      entityId,
      entity.kind,
      entityFieldValue(before, key),
      entityFieldValue(after, key),
      key === "name" ? "renamed" : key === "path" ? "moved" : "modified",
      `${entity.kind}.${key}`,
    );
    derived.push(change);
    let semantic = semanticLevelForEntityChange(entity.kind, "modified", before, after);
    if (entity.kind === "contract" && key === "definition") {
      const compatibility = contractCompatibility(
        before.kind === "contract" ? before.definition : undefined,
        after.kind === "contract" ? after.definition : undefined,
      );
      semantic = {
        kind: "contract",
        level: compatibility.level,
        compatibility: compatibility.compatibility,
        breaking: compatibility.level === "L3",
      };
      if (before.kind === "contract" && after.kind === "contract") {
        if (!valueEqual(before.definition.outputs.effects, after.definition.outputs.effects))
          addDelta(
            entityId,
            "effect",
            "Contract-declared effects changed; use #51 conformance results for actual effect evidence.",
            protectedEntity ? "L3" : "L2",
            protectedEntity ? "breaking" : "review-required",
            [change.id],
            protectedEntity,
            protectedEntity,
          );
        if (!valueEqual(before.definition.inputs.dependencies, after.definition.inputs.dependencies))
          addDelta(
            entityId,
            "dependency-policy",
            "Contract-required dependencies changed.",
            protectedEntity ? "L3" : "L2",
            protectedEntity ? "breaking" : "review-required",
            [change.id],
            protectedEntity,
            protectedEntity,
          );
      }
    } else if (entity.kind === "invariant" && ["statement", "severity", "stability"].includes(key)) {
      const compatibility = invariantCompatibility(before as InvariantEntity, after as InvariantEntity);
      semantic = {
        kind: "invariant",
        level: compatibility.level,
        compatibility: compatibility.compatibility,
        breaking: compatibility.level === "L3",
      };
    } else if (
      entity.kind === "file" ||
      entity.kind === "package" ||
      entity.kind === "external_dependency" ||
      entity.kind === "external_api"
    ) {
      semantic = key === "version" ? semanticLevelForEntityChange(entity.kind, "modified", before, after) : undefined;
    } else if (
      entity.kind === "component" &&
      !["responsibility", "description", "stability", "reviewLevel"].includes(key)
    )
      semantic = undefined;
    if (semantic !== undefined) {
      const protectedValue = protectedEntity;
      addDelta(
        entityId,
        semantic.kind,
        `${entity.kind}.${key} changed.`,
        protectedValue ? "L3" : semantic.level,
        protectedValue ? "breaking" : semantic.compatibility,
        [change.id],
        protectedValue || semantic.breaking,
        protectedValue,
      );
    } else if (protectedEntity && key !== "description") {
      addDelta(
        entityId,
        "public-surface",
        `Protected ${entity.kind} declaration changed at ${key}.`,
        "L3",
        "breaking",
        [change.id],
        true,
        true,
      );
    }
  }
}

/** Compare two validated or fixture Repository Models without reading source text. */
export function compareSemanticSnapshots(
  baseSnapshot: RepositorySemanticSnapshot,
  headSnapshot: RepositorySemanticSnapshot,
  options: SemanticDiffOptions = {},
): SemanticChangeSet {
  const baseEntities = entityMap(baseSnapshot);
  const headEntities = entityMap(headSnapshot);
  const baseFacts = factsBySubject(baseSnapshot);
  const headFacts = factsBySubject(headSnapshot);
  const derived: DerivedChange[] = [];
  const deltaMap = new Map<string, MutableDelta>();
  const changedSymbols = new Set<LogicalId>();
  const changedFiles = new Set<LogicalId>();
  const changedComponents = new Set<LogicalId>();
  const boundaryChangedComponents = new Set<LogicalId>();
  const boundaryChangedSymbols = new Set<LogicalId>();
  const unknowns = new Map<string, UnknownRegion>();

  const addDelta = (
    subject: LogicalId,
    kind: MutableDelta["kind"],
    summary: string,
    level: ReviewLevel,
    compatibility: CompatibilityResult,
    sourceIds: readonly string[],
    breaking = level === "L3",
    protectedOverride = false,
  ): void => {
    if (level === "L0" && !protectedOverride) return;
    const key = `${subject}:${kind}`;
    const existing = deltaMap.get(key);
    const protectedValue = protectedOverride || existing?.protected === true;
    const nextLevel = compareReview(existing?.reviewLevel ?? "L0", level);
    if (existing === undefined) {
      deltaMap.set(key, {
        id: stableId("delta", { subject, kind }),
        subject,
        kind,
        summary,
        reviewLevel: nextLevel,
        compatibility,
        sourceChangeIds: [...new Set(sourceIds)].sort(compareText),
        protected: protectedValue,
        breaking: breaking || protectedValue,
      });
    } else {
      existing.reviewLevel = nextLevel;
      existing.summary = `${existing.summary} ${summary}`;
      existing.compatibility =
        compareReview(existing.reviewLevel, level) === "L1" &&
        existing.compatibility === "compatible" &&
        compatibility === "compatible"
          ? "compatible"
          : existing.compatibility === "breaking" || compatibility === "breaking"
            ? "breaking"
            : compatibility;
      existing.sourceChangeIds = [...new Set([...existing.sourceChangeIds, ...sourceIds])].sort(compareText);
      existing.protected = protectedValue;
      existing.breaking = existing.breaking || breaking || protectedValue;
    }
    const subjectEntity = headEntities.get(subject) ?? baseEntities.get(subject);
    if (subjectEntity?.kind === "component" && (level !== "L0" || protectedOverride))
      boundaryChangedComponents.add(subject);
  };

  const markEntityChange = (before: AnyEntity | undefined, after: AnyEntity | undefined, id: LogicalId): void => {
    const entity = after ?? before;
    if (entity === undefined) return;
    projectEntityChange(
      before,
      after,
      id,
      derived,
      entityProtected(baseSnapshot, id) || entityProtected(headSnapshot, id),
      addDelta,
    );
    if (entity.kind === "component") {
      changedComponents.add(id);
      if (before !== undefined && after !== undefined && changedKeys(before, after).length > 0)
        boundaryChangedComponents.add(id);
      if (before === undefined || after === undefined) boundaryChangedComponents.add(id);
    }
    if (entity.kind === "file") changedFiles.add(id);
  };

  const symbolPairs = pairSymbols(baseSnapshot.derived.symbols, headSnapshot.derived.symbols);
  const symbolIdentityRemap = new Map<LogicalId, LogicalId>();
  for (const pair of symbolPairs) {
    if (pair.before !== undefined && pair.after !== undefined && pair.identityStatus !== "ambiguous")
      symbolIdentityRemap.set(pair.before.id, pair.after.id);
  }
  const symbolChanges: SymbolChange[] = [];
  for (const pair of symbolPairs) {
    const before = pair.before;
    const after = pair.after;
    const id = after?.id ?? before?.id;
    if (id === undefined) continue;
    const symbolDerived: DerivedChange[] = [];
    if (before === undefined || after === undefined) {
      symbolDerived.push(
        makeDerivedChange(
          id,
          "symbol",
          before,
          after,
          pair.identityStatus === "added" ? "added" : "removed",
          "$entity",
          `Symbol was ${pair.identityStatus}.`,
        ),
      );
    } else {
      const locatorKeys = ["language", "package", "module", "file", "symbol", "signature", "range"] as const;
      for (const key of locatorKeys) {
        if (!valueEqual(before.locator[key], after.locator[key])) {
          const changeKind: ChangeKind =
            key === "range"
              ? "moved"
              : key === "file" || key === "module"
                ? "moved"
                : key === "symbol"
                  ? "renamed"
                  : "modified";
          symbolDerived.push(
            makeDerivedChange(id, "symbol", before.locator[key], after.locator[key], changeKind, `locator.${key}`),
          );
        }
      }
      if (before.name !== after.name)
        symbolDerived.push(makeDerivedChange(id, "symbol", before.name, after.name, "renamed", "name"));
      if (before.classification !== after.classification)
        symbolDerived.push(
          makeDerivedChange(id, "symbol", before.classification, after.classification, "modified", "classification"),
        );
    }
    const predicates = new Set([
      ...(factsBySubject(baseSnapshot)
        .get(before?.id ?? id)
        ?.keys() ?? []),
      ...(factsBySubject(headSnapshot)
        .get(after?.id ?? id)
        ?.keys() ?? []),
    ]);
    if (before !== undefined && after !== undefined && before.id !== after.id) {
      const beforePredicates = baseFacts.get(before.id);
      const afterPredicates = headFacts.get(after.id);
      for (const predicate of new Set([...(beforePredicates?.keys() ?? []), ...(afterPredicates?.keys() ?? [])]))
        predicates.add(predicate);
    }
    for (const predicate of [...predicates].sort(compareText)) {
      const left = before === undefined ? undefined : baseFacts.get(before.id)?.get(predicate);
      const right = after === undefined ? undefined : headFacts.get(after.id)?.get(predicate);
      if (valueEqual(left, right)) continue;
      if (PHYSICAL_SYMBOL_FACTS.has(predicate) && valueEqual(left, right)) continue;
      symbolDerived.push(
        makeDerivedChange(
          id,
          "symbol",
          left,
          right,
          before === undefined ? "added" : after === undefined ? "removed" : "modified",
          `facts.${predicate}`,
        ),
      );
    }
    for (const change of symbolDerived) derived.push(change);
    const hasChanges = symbolDerived.length > 0 || pair.identityStatus !== "unchanged";
    if (!hasChanges && pair.identityStatus === "unchanged") continue;
    changedSymbols.add(id);
    const publicBefore = publicVisibility(baseFacts, before);
    const publicAfter = publicVisibility(headFacts, after);
    const publicChanged = publicBefore !== publicAfter;
    if (publicChanged) {
      const level: ReviewLevel = publicAfter === true ? "L1" : "L3";
      const change =
        symbolDerived.find((item) => item.path.includes("visibility") || item.path.includes("exported")) ??
        symbolDerived[0]!;
      addDelta(
        id,
        "public-surface",
        `Symbol public visibility changed from ${String(publicBefore)} to ${String(publicAfter)}.`,
        level,
        level === "L1" ? "compatible" : "breaking",
        [change.id],
        level === "L3",
      );
      boundaryChangedSymbols.add(id);
    }
    const beforeSignature =
      before === undefined
        ? undefined
        : String(factValueForSymbol(baseFacts, before, "symbol.signature") ?? before.locator.signature ?? "") ||
          undefined;
    const afterSignature =
      after === undefined
        ? undefined
        : String(factValueForSymbol(headFacts, after, "symbol.signature") ?? after.locator.signature ?? "") ||
          undefined;
    const signatureChanged = beforeSignature !== afterSignature;
    if (
      signatureChanged &&
      (publicBefore === true || publicAfter === true || publicBefore === undefined || publicAfter === undefined)
    ) {
      const signatureResult = compareSignatures(beforeSignature, afterSignature);
      const change = symbolDerived.find((item) => item.path.includes("signature")) ?? symbolDerived[0]!;
      addDelta(
        id,
        "contract",
        `Public Symbol signature changed: ${signatureResult.reason}.`,
        signatureResult.level,
        signatureResult.compatibility,
        [change.id],
        signatureResult.level === "L3",
      );
      addDelta(
        id,
        "public-surface",
        "Public Symbol surface signature changed.",
        signatureResult.level,
        signatureResult.compatibility,
        [change.id],
        signatureResult.level === "L3",
      );
      boundaryChangedSymbols.add(id);
    }
    for (const change of symbolDerived) {
      const predicate = change.path.startsWith("facts.") ? change.path.slice("facts.".length) : undefined;
      const semanticKind = predicate === undefined ? undefined : factSemanticKind(predicate);
      if (
        semanticKind === undefined ||
        (semanticKind === "public-surface" && (predicate === "public" || predicate === "api"))
      )
        continue;
      if (semanticKind === "effect" && predicate?.startsWith("effect.")) {
        addDelta(
          id,
          semanticKind,
          `Effect fact ${predicate} changed; consume #51 conformance results for policy status.`,
          "L2",
          "review-required",
          [change.id],
        );
      } else if (semanticKind !== "contract" || !(predicate ?? "").endsWith("signature")) {
        addDelta(id, semanticKind, `Semantic fact ${predicate} changed.`, "L2", "review-required", [change.id]);
      }
      if (semanticKind !== "public-surface" && semanticKind !== undefined) boundaryChangedSymbols.add(id);
    }
    const identityStatus =
      pair.identityStatus === "unchanged" && symbolDerived.some((item) => item.path === "locator.range")
        ? "moved"
        : pair.identityStatus;
    if (pair.identityStatus === "ambiguous") {
      addUnknownRegion(
        unknowns,
        headSnapshot,
        "ambiguous-symbol-identity",
        "before/after Symbol identity could not be established uniquely; no ownership or rename guess was made",
        [id, ...(pair.ambiguousCandidates ?? []).map((item) => item.id)],
      );
    }
    symbolChanges.push({
      ...(before === undefined
        ? {}
        : { beforeId: before.id, beforeFile: before.locator.file, beforeSymbol: before.locator.symbol }),
      ...(after === undefined
        ? {}
        : { afterId: after.id, afterFile: after.locator.file, afterSymbol: after.locator.symbol }),
      identityStatus,
      derivedChangeIds: symbolDerived.map((item) => item.id).sort(compareText),
      semanticDeltaIds: sortDeltas([...deltaMap.values()])
        .filter((item) => item.subject === id)
        .map((item) => item.id),
    });
  }

  const symbolIds = new Set([
    ...baseSnapshot.derived.symbols.map((item) => item.id),
    ...headSnapshot.derived.symbols.map((item) => item.id),
  ]);
  for (const id of symbolIds) {
    if (changedSymbols.has(id)) {
      const symbol = headEntities.get(id) ?? baseEntities.get(id);
      if (symbol?.kind === "symbol" && symbol.locator.file !== undefined) {
        const file = [...headSnapshot.derived.files, ...baseSnapshot.derived.files].find(
          (item) => item.path === symbol.locator.file,
        );
        if (file !== undefined) changedFiles.add(file.id);
      }
    }
  }

  const allIds = new Set([...baseEntities.keys(), ...headEntities.keys()]);
  for (const id of [...allIds].sort(compareText)) {
    const before = baseEntities.get(id);
    const after = headEntities.get(id);
    if (before?.kind === "symbol" || after?.kind === "symbol") continue;
    if (before === undefined || after === undefined || !valueEqual(before, after)) markEntityChange(before, after, id);
  }

  comparePolicyCollections(baseSnapshot.declarations, headSnapshot.declarations, derived, addDelta as never);
  for (const item of collectionChanges(
    baseSnapshot.declarations.stability,
    headSnapshot.declarations.stability,
    (value) => value.subject,
  )) {
    const subject = item.after?.subject ?? item.before?.subject;
    if (subject === undefined) continue;
    const change = makeDerivedChange(
      subject,
      "stability",
      item.before,
      item.after,
      item.before === undefined ? "added" : item.after === undefined ? "removed" : "modified",
      `declarations.stability.${item.key}`,
    );
    derived.push(change);
    addDelta(subject, "public-surface", "Stability declaration changed.", "L3", "breaking", [change.id], true, true);
  }
  for (const item of collectionChanges(
    baseSnapshot.declarations.reviewGuidance,
    headSnapshot.declarations.reviewGuidance,
    (value) => value.id,
  )) {
    const subject = item.after?.subject ?? item.before?.subject;
    if (subject === undefined) continue;
    const change = makeDerivedChange(
      subject,
      "review-guidance",
      item.before,
      item.after,
      item.before === undefined ? "added" : item.after === undefined ? "removed" : "modified",
      `declarations.reviewGuidance.${item.key}`,
    );
    derived.push(change);
    addDelta(
      subject,
      "public-surface",
      "Review guidance declaration changed.",
      item.after?.level === "L3" || item.before?.level === "L3" ? "L3" : "L2",
      "review-required",
      [change.id],
      item.after?.level === "L3" || item.before?.level === "L3",
      item.after?.level === "L3" || item.before?.level === "L3",
    );
  }
  for (const item of collectionChanges(
    baseSnapshot.declarations.symbolOwnership ?? [],
    headSnapshot.declarations.symbolOwnership ?? [],
    (value) => value.id,
  )) {
    const subject = item.after?.symbolId ?? item.before?.symbolId;
    if (subject === undefined) continue;
    const change = makeDerivedChange(
      subject,
      "symbol-ownership",
      item.before,
      item.after,
      item.before === undefined ? "added" : item.after === undefined ? "removed" : "modified",
      `declarations.symbolOwnership.${item.key}`,
    );
    derived.push(change);
    addDelta(subject, "responsibility", "Explicit Symbol ownership changed.", "L2", "review-required", [change.id]);
    changedSymbols.add(subject);
    for (const componentId of [item.before?.componentId, item.after?.componentId])
      if (componentId !== undefined) {
        changedComponents.add(componentId);
        boundaryChangedComponents.add(componentId);
      }
  }

  const normalizedBeforeRelations = baseSnapshot.graph.relations.map((relation) => ({
    ...relation,
    id: stableId("edge", {
      kind: relation.kind,
      from: symbolIdentityRemap.get(relation.from) ?? relation.from,
      to: symbolIdentityRemap.get(relation.to) ?? relation.to,
    }) as LogicalId,
    from: symbolIdentityRemap.get(relation.from) ?? relation.from,
    to: symbolIdentityRemap.get(relation.to) ?? relation.to,
  }));
  const normalizedHeadRelations = headSnapshot.graph.relations.map((relation) => ({
    ...relation,
    id: stableId("edge", { kind: relation.kind, from: relation.from, to: relation.to }) as LogicalId,
  }));
  const relationChanges = collectionChanges(normalizedBeforeRelations, normalizedHeadRelations, relationKey);
  for (const item of relationChanges) {
    const relation = item.after ?? item.before;
    if (relation === undefined) continue;
    const entityId = relation.from;
    const change = makeDerivedChange(
      entityId,
      "relation",
      item.before,
      item.after,
      item.before === undefined ? "added" : item.after === undefined ? "removed" : "modified",
      `graph.${relation.kind}.${relation.from}.${relation.to}`,
    );
    derived.push(change);
    const semanticKind = boundaryRelationKind(relation.kind);
    if (semanticKind !== undefined) {
      const level: ReviewLevel = relation.kind === "owns" || relation.kind === "shares" ? "L2" : "L2";
      addDelta(
        entityId,
        semanticKind,
        `Explicit ${relation.kind} boundary relation changed.`,
        level,
        "review-required",
        [change.id],
      );
      const fromEntity = headEntities.get(relation.from) ?? baseEntities.get(relation.from);
      const toEntity = headEntities.get(relation.to) ?? baseEntities.get(relation.to);
      if (fromEntity?.kind === "component") {
        changedComponents.add(fromEntity.id);
        boundaryChangedComponents.add(fromEntity.id);
      }
      if (toEntity?.kind === "component") {
        changedComponents.add(toEntity.id);
        boundaryChangedComponents.add(toEntity.id);
      }
      if (fromEntity?.kind === "symbol") changedSymbols.add(fromEntity.id);
      if (toEntity?.kind === "symbol") changedSymbols.add(toEntity.id);
    }
  }

  const fileByPath = new Map<string, LogicalId>();
  for (const file of [...baseSnapshot.derived.files, ...headSnapshot.derived.files]) fileByPath.set(file.path, file.id);
  const trackedFileChanges = collectionChanges(
    baseSnapshot.integrity.trackedFiles,
    headSnapshot.integrity.trackedFiles,
    (item) => item.path,
  );
  for (const item of trackedFileChanges) {
    const fileId = fileByPath.get(item.key);
    if (fileId === undefined) continue;
    changedFiles.add(fileId);
    derived.push(
      makeDerivedChange(
        fileId,
        "file",
        item.before,
        item.after,
        item.before === undefined ? "added" : item.after === undefined ? "removed" : "modified",
        `integrity.trackedFiles.${item.key}`,
        "Tracked file fingerprint changed; semantic classification comes from the Symbol/declared model.",
      ),
    );
  }

  const effectDelta = effectDeltaFromOptions(options);
  const effectViolations: EffectViolation[] = [];
  if (effectDelta !== undefined) {
    for (const violation of effectDelta.violations) effectViolations.push(violation);
    for (const effectChange of effectDelta.changes) {
      const change = makeDerivedChange(
        effectChange.subjectId,
        "effect-analysis",
        undefined,
        effectChange,
        "modified",
        `effects.${effectChange.subjectId}`,
      );
      derived.push(change);
      const violation = effectChange.violations.length > 0;
      addDelta(
        effectChange.subjectId,
        "effect",
        violation ? "#51 reported a policy violation for the changed effect surface." : "#51 effect analysis changed.",
        violation ? "L3" : "L2",
        violation ? "breaking" : "review-required",
        [change.id],
        violation,
      );
      if (effectChange.added.length > 0 || effectChange.removed.length > 0 || effectChange.conformanceChanged)
        boundaryChangedSymbols.add(effectChange.subjectId);
      if (effectChange.nextCompleteness !== undefined && effectChange.nextCompleteness !== "complete")
        addUnknownRegion(
          unknowns,
          headSnapshot,
          "effect-analysis-incomplete",
          "#51 effect/conformance analysis is incomplete for a changed subject",
          [effectChange.subjectId],
        );
    }
  }
  const sortedViolations = [...effectViolations].sort((left, right) =>
    compareText(stableStringifyValue(left), stableStringifyValue(right)),
  );
  for (const violation of sortedViolations) {
    addDelta(
      violation.subjectId,
      "effect",
      "#51 reported a proven effect-policy violation.",
      "L3",
      "breaking",
      [],
      true,
    );
    boundaryChangedSymbols.add(violation.subjectId);
  }

  const changedSubjectIds = [
    ...new Set(
      [...changedSymbols, ...deltaMap.values()].map((item) => (typeof item === "string" ? item : item.subject)),
    ),
  ].sort(compareText);
  const materiallyUnknownSubjects = new Set<LogicalId>(changedSubjectIds);
  for (const snapshot of [baseSnapshot, headSnapshot]) {
    if (snapshot.integrity.status !== "fresh")
      addUnknownRegion(
        unknowns,
        snapshot,
        "integrity-not-fresh",
        `Repository Model integrity is ${snapshot.integrity.status}; semantic L0 cannot be asserted`,
        changedSubjectIds,
      );
    if (snapshot.analysis.health.status === "partial" || snapshot.analysis.health.status === "unknown")
      addUnknownRegion(
        unknowns,
        snapshot,
        "analysis-incomplete",
        "Repository Model analysis is incomplete for the compared revision",
        changedSubjectIds,
      );
    for (const unknown of snapshot.analysis.unknowns) {
      const subjects =
        unknown.subjects === undefined || unknown.subjects.length === 0
          ? changedSubjectIds
          : unknown.subjects.filter((subject) => materiallyUnknownSubjects.has(subject));
      if (unknown.subjects === undefined || subjects.length > 0)
        addUnknownRegion(
          unknowns,
          snapshot,
          unknown.code,
          unknown.message,
          subjects.length > 0 ? subjects : changedSubjectIds,
        );
    }
    for (const id of changedSubjectIds) {
      const entity = entityMap(snapshot).get(id);
      if (entity?.provenance.completeness !== undefined && entity.provenance.completeness !== "complete")
        addUnknownRegion(
          unknowns,
          snapshot,
          "entity-incomplete",
          `changed ${entity.kind} provenance is ${entity.provenance.completeness}`,
          [id],
        );
      if (entity?.provenance.ambiguity?.status !== undefined && entity.provenance.ambiguity.status !== "none")
        addUnknownRegion(
          unknowns,
          snapshot,
          "entity-identity-ambiguous",
          `changed ${entity.kind} identity is ${entity.provenance.ambiguity.status}`,
          [id],
        );
    }
  }

  const semanticDeltas = sortDeltas(
    [...deltaMap.values()].map((item) => ({ ...item, sourceChangeIds: [...item.sourceChangeIds].sort(compareText) })),
  );
  const transaction = transactionComparison(semanticDeltas, options.transaction);
  if (transaction.unauthorized) {
    const subject = semanticDeltas[0]?.subject ?? headSnapshot.declarations.project.id;
    addDelta(
      subject,
      "public-surface",
      transaction.stopEvent?.reason ?? "transaction authorization mismatch",
      "L3",
      "breaking",
      [],
      true,
    );
  }
  if (transaction.status === "missing") {
    const subject = headSnapshot.declarations.project.id;
    addUnknownRegion(
      unknowns,
      headSnapshot,
      "authorized-delta-missing",
      "authorized semantic change was not observed in the actual head model",
      [subject],
    );
  }

  const finalDeltas = sortDeltas(
    [...deltaMap.values()].map((item) => ({ ...item, sourceChangeIds: [...item.sourceChangeIds].sort(compareText) })),
  );
  for (const symbolId of changedSymbols) {
    for (const relation of [...baseSnapshot.graph.relations, ...headSnapshot.graph.relations]) {
      if (
        relation.authority !== "declared" ||
        (relation.kind !== "owns" && relation.kind !== "shares") ||
        relation.to !== symbolId
      )
        continue;
      const owner = headEntities.get(relation.from) ?? baseEntities.get(relation.from);
      if (owner?.kind === "component") changedComponents.add(owner.id);
    }
  }
  for (const delta of finalDeltas) {
    if (delta.subject.startsWith("component:") || headEntities.get(delta.subject)?.kind === "component") {
      changedComponents.add(delta.subject);
      if (delta.kind !== "public-surface" || delta.reviewLevel !== "L0") boundaryChangedComponents.add(delta.subject);
    }
    for (const relation of [...baseSnapshot.graph.relations, ...headSnapshot.graph.relations]) {
      const normalized = normalizeRelationKind(relation.kind);
      if (
        relation.authority !== "declared" ||
        !["defines", "provides", "requires", "constrained_by", "governs"].includes(normalized) ||
        (relation.from !== delta.subject && relation.to !== delta.subject)
      )
        continue;
      const endpoint = relation.from === delta.subject ? relation.to : relation.from;
      const endpointEntity = headEntities.get(endpoint) ?? baseEntities.get(endpoint);
      if (endpointEntity?.kind === "component") {
        changedComponents.add(endpoint);
        boundaryChangedComponents.add(endpoint);
      }
    }
  }
  const unknownSymbolIds = [...unknowns.values()].flatMap((item) =>
    item.subjects.filter((subject) => (headEntities.get(subject) ?? baseEntities.get(subject))?.kind === "symbol"),
  );
  const impact = propagateSemanticImpact({
    baseSnapshot,
    headSnapshot,
    changedSymbolIds: [...changedSymbols].sort(compareText),
    changedComponentIds: [...boundaryChangedComponents].sort(compareText),
    boundaryChangedSymbolIds: [...boundaryChangedSymbols].sort(compareText),
    unknownSymbolIds,
    maxDepth: options.maxImpactDepth,
  });
  for (const symbolId of impact.unknownSymbolIds)
    addUnknownRegion(
      unknowns,
      headSnapshot,
      "symbol-ownership-unknown",
      "impact propagation could not establish explicit Symbol ownership",
      [symbolId],
    );

  const deltaSubjects = finalDeltas.map((item) => item.subject);
  const sourceReads = dedupeSourceReads([
    ...finalDeltas.flatMap((item) => entitySource(headSnapshot, item.subject)),
    ...[...changedSymbols].flatMap((id) => entitySource(headSnapshot, id)),
    ...[...unknowns.values()].flatMap((item) => item.recommendedSourceReads),
  ]);
  const evidenceRefreshNeeds = collectEvidenceNeeds(
    headSnapshot,
    finalDeltas.length === 0 ? [] : [...new Set([...deltaSubjects, ...impact.affectedEntities])],
    sourceReads,
  );
  const reviewReasons: string[] = [];
  if (finalDeltas.length === 0)
    reviewReasons.push("no agreed semantic boundary changed; model differences are Derived Changes only");
  if (finalDeltas.some((item) => item.compatibility === "compatible"))
    reviewReasons.push("semantic changes are compatible under the explicit v1 compatibility rules");
  if (finalDeltas.some((item) => item.reviewLevel === "L2"))
    reviewReasons.push("one or more semantic changes require review");
  if (finalDeltas.some((item) => item.reviewLevel === "L3"))
    reviewReasons.push("one or more semantic changes are protected, breaking, or violating");
  if (transaction.unauthorized)
    reviewReasons.push(transaction.stopEvent?.reason ?? "transaction authorization mismatch");
  if (unknowns.size > 0)
    reviewReasons.push("material analysis is incomplete or identity is uncertain; L0 is not permitted");
  if (sortedViolations.length > 0)
    reviewReasons.push("#51 effect-policy violations are L3 without recomputing effects");
  let reviewLevel: ReviewLevel = finalDeltas.reduce<ReviewLevel>(
    (level, item) => compareReview(level, item.reviewLevel),
    "L0",
  );
  if (unknowns.size > 0) reviewLevel = compareReview(reviewLevel, "L2");
  if (transaction.unauthorized || sortedViolations.length > 0) reviewLevel = "L3";
  const allDerived = [...derived].sort((left, right) => compareText(left.id, right.id));
  const changedFileIds = [...changedFiles].sort(compareText);
  const changedSymbolIds = [...changedSymbols].sort(compareText);
  const changedComponentIds = [...changedComponents].sort(compareText);
  const baseDigest = snapshotDigest(baseSnapshot);
  const headDigest = snapshotDigest(headSnapshot);
  const set: SemanticChangeSet = {
    version: SEMANTIC_CHANGE_SET_VERSION,
    apiVersion: "v1",
    baseSnapshotId: baseDigest.value,
    headSnapshotId: headDigest.value,
    baseSnapshotDigest: baseDigest,
    headSnapshotDigest: headDigest,
    baseRevision: revision(baseSnapshot),
    headRevision: revision(headSnapshot),
    changedFiles: changedFileIds,
    changedSymbols: changedSymbolIds,
    symbolChanges: symbolChanges.sort((left, right) =>
      compareText(`${left.afterId ?? ""}:${left.beforeId ?? ""}`, `${right.afterId ?? ""}:${right.beforeId ?? ""}`),
    ),
    changedComponents: changedComponentIds,
    derivedChanges: allDerived,
    semanticDeltas: finalDeltas,
    contractChanges: finalDeltas.filter((item) => item.kind === "contract"),
    effectChanges: finalDeltas.filter((item) => item.kind === "effect"),
    invariantChanges: finalDeltas.filter((item) => item.kind === "invariant"),
    dependencyPolicyChanges: finalDeltas.filter((item) => item.kind === "dependency-policy"),
    publicSurfaceChanges: finalDeltas.filter((item) => item.kind === "public-surface"),
    responsibilityChanges: finalDeltas.filter((item) => item.kind === "responsibility"),
    capabilityChanges: finalDeltas.filter((item) => item.kind === "capability"),
    authorizedVsActual: transaction,
    affectedEntities: [...new Set([...impact.affectedEntities, ...deltaSubjects])].sort(compareText),
    impactPaths: impact.impactPaths,
    propagationStopPoints: impact.stopPoints,
    evidenceRefreshNeeds,
    unknownRegions: [...unknowns.values()].sort((left, right) => compareText(left.id, right.id)),
    reviewLevel,
    reviewReasons: [...new Set(reviewReasons)].sort(compareText),
    recommendedSourceReads: sourceReads,
    effectViolations: sortedViolations,
    provenance: {
      producer: DIFF_ENGINE_PRODUCER,
      version: "1.0.0",
      note: "canonical Symbol-first Semantic Delta and impact analysis",
    },
  };
  return clone(set);
}

export function computeSemanticChangeSet(input: SemanticDiffInput): SemanticChangeSet {
  const { baseSnapshot, headSnapshot, ...options } = input;
  return compareSemanticSnapshots(baseSnapshot, headSnapshot, options);
}

export function compareRepositorySnapshots(input: SemanticDiffInput): SemanticChangeSet;
export function compareRepositorySnapshots(
  baseSnapshot: RepositorySemanticSnapshot,
  headSnapshot: RepositorySemanticSnapshot,
  options?: SemanticDiffOptions,
): SemanticChangeSet;
export function compareRepositorySnapshots(
  first: SemanticDiffInput | RepositorySemanticSnapshot,
  second?: RepositorySemanticSnapshot,
  options: SemanticDiffOptions = {},
): SemanticChangeSet {
  return second === undefined
    ? computeSemanticChangeSet(first as SemanticDiffInput)
    : compareSemanticSnapshots(first as RepositorySemanticSnapshot, second, options);
}

export const analyzeSemanticDelta = compareRepositorySnapshots;

/** Map the canonical result onto #83's existing Change Impact/query contract. */
export function projectSemanticChangeSet(
  changeSet: SemanticChangeSet,
  reviewLevel?: ReviewLevel,
): SemanticChangeSetView {
  const deltas =
    reviewLevel === undefined
      ? changeSet.semanticDeltas
      : changeSet.semanticDeltas.filter((item) => item.reviewLevel === reviewLevel);
  const provenance = {
    authority: "analysis" as const,
    status: changeSet.unknownRegions.length > 0 ? ("partial" as const) : ("partial" as const),
    provider: DIFF_ENGINE_PRODUCER,
    note: "projected from the canonical Semantic Change Set; the viewer does not reclassify it",
  };
  return {
    apiVersion: "v1",
    version: changeSet.version,
    baseRevision: changeSet.baseRevision,
    headRevision: changeSet.headRevision,
    filesChanged: reviewLevel === undefined ? changeSet.changedFiles.length : 0,
    symbolsChanged: reviewLevel === undefined ? changeSet.changedSymbols.length : 0,
    componentsChanged: [...new Set(deltas.map((item) => item.subject).filter((id) => id.startsWith("component:")))]
      .length,
    contractsTouched: deltas.filter((item) => item.kind === "contract").length,
    staleEvidence: changeSet.evidenceRefreshNeeds.filter((item) => item.required).length,
    recommendedReads: changeSet.recommendedSourceReads,
    entries: deltas.map((item) => ({
      id: item.id,
      entityId: item.subject,
      kind: item.kind,
      summary: item.summary,
      reviewLevel: item.reviewLevel,
      authority: "analysis" as const,
      provenance,
    })),
    impactPaths: changeSet.impactPaths.map((item) => ({ entityIds: item.entityIds, stopReason: item.stopReason })),
    changedFileIds: changeSet.changedFiles,
    changedSymbolIds: changeSet.changedSymbols,
    changedComponentIds: changeSet.changedComponents,
    snapshotIds: { base: changeSet.baseSnapshotId, head: changeSet.headSnapshotId },
    derivedChanges: changeSet.derivedChanges,
    symbolChanges: changeSet.symbolChanges,
    semanticDeltas: changeSet.semanticDeltas,
    contractChanges: changeSet.contractChanges,
    effectChanges: changeSet.effectChanges,
    invariantChanges: changeSet.invariantChanges,
    dependencyPolicyChanges: changeSet.dependencyPolicyChanges,
    publicSurfaceChanges: changeSet.publicSurfaceChanges,
    responsibilityChanges: changeSet.responsibilityChanges,
    capabilityChanges: changeSet.capabilityChanges,
    authorizedVsActual: changeSet.authorizedVsActual,
    affectedEntities: changeSet.affectedEntities,
    propagationStopPoints: changeSet.propagationStopPoints,
    evidenceRefreshNeeds: changeSet.evidenceRefreshNeeds,
    unknownRegions: changeSet.unknownRegions,
    reviewLevel: changeSet.reviewLevel,
    reviewReasons: changeSet.reviewReasons,
    effectViolations: changeSet.effectViolations,
    provenance,
  };
}
