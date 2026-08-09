import { canonicalizeSnapshot, computeIntegrityDigestsFromValidated, stableStringifyValue } from "../ir/canonical.js";
import { createEdgeId, createLogicalId, createRevisionId } from "../ir/ids.js";
import { validateSnapshot } from "../ir/schema.js";
import { computeSnapshotDigest } from "../ir/serialize.js";
import { serializeSemanticSourcePatch } from "../source/serialization.js";
import type {
  CapabilityEntity,
  ComponentEntity,
  ConstraintEntity,
  ContractEntity,
  DecisionEntity,
  DependencyPolicy,
  EffectPolicy,
  InvariantEntity,
  JsonValue,
  Provenance,
  RationaleEntity,
  RepositorySemanticSnapshot,
  ReviewGuidance,
  SemanticDebtIntent,
  SemanticDeltaEntry,
  SemanticDiagnostic,
  SemanticEntity,
  SemanticTransaction,
  StabilityDeclaration,
  SymbolEntity,
  SymbolOwnershipDeclaration,
  TerminologyLink,
} from "../ir/types.js";
import type { LogicalId } from "../ir/ids.js";
import { createSnapshotSymbolBindingResolver } from "./binding.js";
import type {
  BindingRequirement,
  BindingResolution,
  DeclaredEntityInput,
  MutationPlan,
  MutationProvenance,
  MutationValidationResult,
  SemanticMutation,
  SemanticMutationRequest,
  SemanticMutationResult,
  SemanticMutationService,
  SymbolBindingResolver,
  SymbolOwnershipInput,
  SymbolSelector,
} from "./types.js";
import { MUTATION_ENGINE_PRODUCER } from "./types.js";

const DELTA_KIND_BY_MUTATION: Record<
  SemanticMutation["kind"],
  "responsibility" | "capability" | "contract" | "effect" | "invariant" | "dependency-policy" | "public-surface"
> = {
  component: "responsibility",
  "symbol-ownership": "responsibility",
  capability: "capability",
  contract: "contract",
  invariant: "invariant",
  rationale: "public-surface",
  constraint: "public-surface",
  decision: "public-surface",
  "effect-policy": "effect",
  "dependency-policy": "dependency-policy",
  "review-guidance": "public-surface",
  stability: "public-surface",
  terminology: "public-surface",
  "semantic-debt": "public-surface",
};

function diagnostic(
  code: string,
  message: string,
  subject?: LogicalId,
  details?: Record<string, JsonValue>,
): SemanticDiagnostic {
  return {
    code,
    severity: "error",
    message,
    ...(subject === undefined ? {} : { subject }),
    ...(details === undefined ? {} : { details }),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function replaceById<T extends { id: LogicalId }>(values: readonly T[], value: T): T[] {
  const index = values.findIndex((item) => item.id === value.id);
  if (index < 0) return [...values, value];
  return values.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function replaceBySubject<T extends { subject: LogicalId }>(values: readonly T[], value: T): T[] {
  const index = values.findIndex((item) => item.subject === value.subject);
  if (index < 0) return [...values, value];
  return values.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function declaredProvenance(snapshot: RepositorySemanticSnapshot, actor: string): Provenance {
  return {
    kind: "declared",
    producer: MUTATION_ENGINE_PRODUCER,
    sourceRevision: {
      repositoryId: snapshot.repositoryIdentity.id,
      revisionId: snapshot.revisionIdentity?.id ?? createRevisionId("working-tree"),
    },
  };
}

function entityWithDeclaredAuthority<T extends SemanticEntity>(
  value: DeclaredEntityInput<T>,
  provenance: Provenance,
): T {
  return { ...value, authority: "declared", provenance } as T;
}

function isProtectedEntity(entity: SemanticEntity | undefined): boolean {
  return entity?.kind === "component" ||
    entity?.kind === "project" ||
    entity?.kind === "capability" ||
    entity?.kind === "contract"
    ? entity.stability === "stable" || entity.stability === "protected" || entity.reviewLevel === "L3"
    : entity?.kind === "invariant"
      ? entity.stability === "stable" || entity.stability === "protected"
      : false;
}

function entityById(snapshot: RepositorySemanticSnapshot, id: LogicalId): SemanticEntity | undefined {
  const all: SemanticEntity[] = [
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
  return all.find((entity) => entity.id === id);
}

function formalEnglish(value: string): boolean {
  return value.length > 0 && value === value.trim() && /^[\x20-\x7e]+$/u.test(value) && /[A-Za-z]/u.test(value);
}

const PROSE_KEYS = new Set([
  "description",
  "responsibility",
  "meaning",
  "statement",
  "scope",
  "guidance",
  "definition",
  "summary",
  "reason",
]);

function collectProse(value: unknown, path: string, diagnostics: SemanticDiagnostic[], key?: string): void {
  if (typeof value === "string") {
    if (key !== undefined && PROSE_KEYS.has(key) && !formalEnglish(value)) {
      diagnostics.push(diagnostic("canonical_prose_not_formal_english", `${path} must be non-empty formal English`));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectProse(item, `${path}.${index}`, diagnostics));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [childKey, childValue] of Object.entries(value))
    collectProse(childValue, `${path}.${childKey}`, diagnostics, childKey);
}

function validateCanonicalProse(snapshot: RepositorySemanticSnapshot): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  collectProse(snapshot.declarations, "declarations", diagnostics);
  return diagnostics;
}

function validateMutationRequest(request: SemanticMutationRequest): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  if (request.provenance.actor.trim().length === 0)
    diagnostics.push(diagnostic("missing_transaction_actor", "transaction provenance actor is required"));
  if (request.intent === "semantic-change" && request.mutations.length > 0 && !formalEnglish(request.reason ?? "")) {
    diagnostics.push(
      diagnostic("missing_semantic_change_reason", "meaning-changing mutations require a formal-English reason"),
    );
  }
  if (request.intent === "semantic-neutral" && request.mutations.length > 0) {
    diagnostics.push(
      diagnostic("semantic_neutral_mutation", "semantic-neutral transactions cannot carry declared mutations"),
    );
  }
  const authorized = new Set(request.authorizedDeltaKinds ?? []);
  for (const mutation of request.mutations) {
    const required = DELTA_KIND_BY_MUTATION[mutation.kind];
    if (!authorized.has(required)) {
      diagnostics.push(
        diagnostic("unauthorized_delta_kind", `mutation ${mutation.kind} requires authorized delta kind ${required}`),
      );
    }
  }
  return diagnostics;
}

function resolveSymbol(
  snapshot: RepositorySemanticSnapshot,
  selector: SymbolSelector,
  resolver: SymbolBindingResolver,
): { symbol?: SymbolEntity; resolution?: BindingResolution; diagnostics: SemanticDiagnostic[] } {
  if ("symbolId" in selector) {
    const symbol = snapshot.derived.symbols.find((item) => item.id === selector.symbolId);
    if (symbol === undefined)
      return {
        diagnostics: [
          diagnostic("symbol_binding_missing", `Symbol does not exist: ${selector.symbolId}`, selector.symbolId),
        ],
      };
    return { symbol, diagnostics: [] };
  }
  const resolution = resolver.resolve(selector.locator, selector.expectedRevision);
  if (resolution.status !== "resolved") {
    return {
      resolution,
      diagnostics: [
        diagnostic(
          `symbol_binding_${resolution.status}`,
          resolution.message ?? `Symbol binding is ${resolution.status}; no ownership guess is allowed`,
        ),
      ],
    };
  }
  const symbol = snapshot.derived.symbols.find((item) => item.id === resolution.symbolId);
  if (symbol === undefined)
    return {
      resolution,
      diagnostics: [diagnostic("symbol_binding_missing", `Resolved Symbol is absent: ${resolution.symbolId}`)],
    };
  return { symbol, resolution, diagnostics: [] };
}

function relation(
  snapshot: RepositorySemanticSnapshot,
  kind: "owns" | "shares",
  from: LogicalId,
  to: LogicalId,
  actor: string,
): RepositorySemanticSnapshot["graph"]["relations"][number] {
  return {
    id: createEdgeId(`${kind}-${encodeURIComponent(from)}-${encodeURIComponent(to)}`),
    kind,
    from,
    to,
    authority: "declared",
    provenance: declaredProvenance(snapshot, actor),
  };
}

function applyOwnership(
  snapshot: RepositorySemanticSnapshot,
  mutation: Extract<SemanticMutation, { kind: "symbol-ownership" }>,
  actor: string,
  resolver: SymbolBindingResolver,
  affected: Set<LogicalId>,
  bindings: BindingRequirement[],
  diagnostics: SemanticDiagnostic[],
): void {
  const resolved = resolveSymbol(snapshot, mutation.symbol, resolver);
  if (resolved.resolution !== undefined) bindings.push({ selector: mutation.symbol, resolution: resolved.resolution });
  diagnostics.push(...resolved.diagnostics);
  const symbol = resolved.symbol;
  if (symbol === undefined) return;
  affected.add(symbol.id);
  const components = new Map(snapshot.declarations.components.map((component) => [component.id, component]));
  const ownership = mutation.ownership;
  const sharedComponents =
    ownership.classification === "shared" ? [...new Set(ownership.sharedComponentIds ?? [])].sort() : [];
  if (ownership.classification === "managed") {
    const component = components.get(ownership.componentId);
    if (component === undefined) {
      diagnostics.push(
        diagnostic(
          "component_binding_missing",
          `Component does not exist: ${ownership.componentId}`,
          ownership.componentId,
        ),
      );
      return;
    }
    affected.add(component.id);
  } else {
    for (const componentId of sharedComponents) {
      if (!components.has(componentId))
        diagnostics.push(
          diagnostic("component_binding_missing", `Component does not exist: ${componentId}`, componentId),
        );
      affected.add(componentId);
    }
  }
  const declaration: SymbolOwnershipDeclaration = {
    id: createLogicalId("ownership", encodeURIComponent(symbol.id)),
    symbolId: symbol.id,
    classification: ownership.classification,
    ...(ownership.classification === "managed" ? { componentId: ownership.componentId } : {}),
  };
  snapshot.declarations.symbolOwnership = replaceById(snapshot.declarations.symbolOwnership ?? [], declaration);
  const retained = snapshot.graph.relations.filter(
    (item) =>
      !(item.authority === "declared" && (item.kind === "owns" || item.kind === "shares") && item.to === symbol.id),
  );
  const newRelations =
    ownership.classification === "managed"
      ? [relation(snapshot, "owns", ownership.componentId, symbol.id, actor)]
      : sharedComponents.map((componentId) => relation(snapshot, "shares", componentId, symbol.id, actor));
  snapshot.graph.relations = [...retained, ...newRelations];
}

function applyMutation(
  snapshot: RepositorySemanticSnapshot,
  mutation: SemanticMutation,
  actor: string,
  resolver: SymbolBindingResolver,
  affected: Set<LogicalId>,
  bindings: BindingRequirement[],
  protectedChanges: Set<LogicalId>,
  diagnostics: SemanticDiagnostic[],
): void {
  const provenance = declaredProvenance(snapshot, actor);
  switch (mutation.kind) {
    case "component": {
      const previous = entityById(snapshot, mutation.component.id);
      const next = entityWithDeclaredAuthority(mutation.component, provenance);
      snapshot.declarations.components = replaceById(snapshot.declarations.components, next);
      affected.add(next.id);
      if (isProtectedEntity(previous) || isProtectedEntity(next)) protectedChanges.add(next.id);
      return;
    }
    case "symbol-ownership":
      applyOwnership(snapshot, mutation, actor, resolver, affected, bindings, diagnostics);
      return;
    case "capability": {
      const previous = entityById(snapshot, mutation.capability.id);
      const next = entityWithDeclaredAuthority(mutation.capability, provenance);
      snapshot.declarations.capabilities = replaceById(snapshot.declarations.capabilities, next);
      affected.add(next.id);
      if (isProtectedEntity(previous) || isProtectedEntity(next)) protectedChanges.add(next.id);
      return;
    }
    case "contract": {
      const previous = entityById(snapshot, mutation.contract.id);
      const next = entityWithDeclaredAuthority(mutation.contract, provenance);
      snapshot.declarations.contracts = replaceById(snapshot.declarations.contracts, next);
      affected.add(next.id);
      if (isProtectedEntity(previous) || isProtectedEntity(next)) protectedChanges.add(next.id);
      return;
    }
    case "invariant": {
      const previous = entityById(snapshot, mutation.invariant.id);
      const next = entityWithDeclaredAuthority(mutation.invariant, provenance);
      snapshot.declarations.invariants = replaceById(snapshot.declarations.invariants, next);
      affected.add(next.id);
      if (isProtectedEntity(previous) || isProtectedEntity(next)) protectedChanges.add(next.id);
      return;
    }
    case "rationale": {
      const next = entityWithDeclaredAuthority(mutation.rationale, provenance);
      snapshot.declarations.rationales = replaceById(snapshot.declarations.rationales, next);
      affected.add(next.id);
      return;
    }
    case "constraint": {
      const next = entityWithDeclaredAuthority(mutation.constraint, provenance);
      snapshot.declarations.constraints = replaceById(snapshot.declarations.constraints, next);
      affected.add(next.id);
      return;
    }
    case "decision": {
      const next = entityWithDeclaredAuthority(mutation.decision, provenance);
      snapshot.declarations.decisions = replaceById(snapshot.declarations.decisions, next);
      affected.add(next.id);
      return;
    }
    case "effect-policy":
      snapshot.declarations.effectPolicies = replaceById(snapshot.declarations.effectPolicies, mutation.policy);
      affected.add(mutation.policy.subject);
      return;
    case "dependency-policy":
      snapshot.declarations.dependencyPolicies = replaceById(snapshot.declarations.dependencyPolicies, mutation.policy);
      affected.add(mutation.policy.subject);
      return;
    case "review-guidance":
      snapshot.declarations.reviewGuidance = replaceById(snapshot.declarations.reviewGuidance, mutation.guidance);
      affected.add(mutation.guidance.subject);
      if (mutation.guidance.level === "L3") protectedChanges.add(mutation.guidance.subject);
      return;
    case "stability":
      snapshot.declarations.stability = replaceBySubject(snapshot.declarations.stability, mutation.declaration);
      affected.add(mutation.declaration.subject);
      if (mutation.declaration.stability === "stable" || mutation.declaration.stability === "protected") {
        protectedChanges.add(mutation.declaration.subject);
      }
      return;
    case "terminology":
      snapshot.declarations.terminology = [
        ...snapshot.declarations.terminology.filter((item) => item.term !== mutation.link.term),
        mutation.link,
      ];
      mutation.link.relatedEntityIds.forEach((id) => affected.add(id));
      return;
    case "semantic-debt":
      snapshot.declarations.semanticDebt = replaceById(snapshot.declarations.semanticDebt ?? [], mutation.debt);
      affected.add(mutation.debt.subject);
      return;
  }
}

function refreshIntegrity(
  snapshot: RepositorySemanticSnapshot,
  status: RepositorySemanticSnapshot["integrity"]["status"],
): RepositorySemanticSnapshot {
  const draft: RepositorySemanticSnapshot = {
    ...snapshot,
    integrity: {
      ...snapshot.integrity,
      status: "stale",
      statusReason: "integrity is recomputed after the declared mutation",
    },
  };
  const validation = validateSnapshot(draft);
  if (!validation.ok) return draft;
  const digestShape: RepositorySemanticSnapshot =
    status === "fresh"
      ? (() => {
          const { statusReason: _statusReason, ...integrity } = validation.snapshot.integrity;
          return { ...validation.snapshot, integrity: { ...integrity, status: "fresh" } };
        })()
      : {
          ...validation.snapshot,
          integrity: {
            ...validation.snapshot.integrity,
            status,
            statusReason: snapshot.integrity.statusReason ?? "integrity is stale after the declared mutation",
          },
        };
  return {
    ...digestShape,
    integrity: {
      ...digestShape.integrity,
      ...computeIntegrityDigestsFromValidated(digestShape),
      status,
    },
  };
}

function transactionFor(
  request: SemanticMutationRequest,
  snapshot: RepositorySemanticSnapshot,
  affected: readonly LogicalId[],
  protectedChanges: readonly LogicalId[],
): SemanticTransaction {
  const authorizedDeltaKinds = [...new Set(request.authorizedDeltaKinds ?? [])].sort();
  const entries: SemanticDeltaEntry[] = request.mutations.map((mutation, index) => {
    const subject = affected[index] ?? snapshot.declarations.project.id;
    return {
      id: createLogicalId("delta", `${index}-${encodeURIComponent(subject)}`),
      subject,
      kind: DELTA_KIND_BY_MUTATION[mutation.kind],
      summary: `Apply the declared ${mutation.kind} mutation through the semantic mutation boundary.`,
      reviewLevel: protectedChanges.includes(subject) ? "L3" : "L2",
    };
  });
  return {
    version: 1,
    intent: request.intent,
    delta: { version: 1, intent: request.intent, entries, unauthorized: false },
    provenance: {
      ...declaredProvenance(snapshot, request.provenance.actor),
    },
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    authorizedDeltaKinds,
    protectedChanges: [...protectedChanges].sort(),
    transactionProvenance: {
      actor: request.provenance.actor,
      ...(request.provenance.issue === undefined ? {} : { issue: request.provenance.issue }),
      ...(request.provenance.task === undefined ? {} : { task: request.provenance.task }),
      ...(request.provenance.ref === undefined ? {} : { ref: request.provenance.ref }),
    },
  };
}

function buildCandidate(
  base: RepositorySemanticSnapshot,
  request: SemanticMutationRequest,
  resolver: SymbolBindingResolver,
): {
  candidate?: RepositorySemanticSnapshot;
  affected: readonly LogicalId[];
  protectedChanges: readonly LogicalId[];
  bindings: readonly BindingRequirement[];
  diagnostics: readonly SemanticDiagnostic[];
} {
  const diagnostics = validateMutationRequest(request);
  if (diagnostics.length > 0) return { affected: [], protectedChanges: [], bindings: [], diagnostics };
  const candidate = clone(base);
  const affected = new Set<LogicalId>();
  const protectedChanges = new Set<LogicalId>();
  const bindings: BindingRequirement[] = [];
  for (const mutation of request.mutations) {
    applyMutation(
      candidate,
      mutation,
      request.provenance.actor,
      resolver,
      affected,
      bindings,
      protectedChanges,
      diagnostics,
    );
  }
  if (diagnostics.length > 0)
    return { affected: [...affected].sort(), protectedChanges: [...protectedChanges].sort(), bindings, diagnostics };
  const beforeNonDeclared = stableStringifyValue({
    derived: base.derived,
    observed: base.observed,
    analysis: base.analysis,
  });
  const afterNonDeclared = stableStringifyValue({
    derived: candidate.derived,
    observed: candidate.observed,
    analysis: candidate.analysis,
  });
  if (beforeNonDeclared !== afterNonDeclared) {
    diagnostics.push(
      diagnostic(
        "derived_state_mutation_forbidden",
        "declared semantic mutations cannot change derived or observed facts",
      ),
    );
    return { affected: [...affected].sort(), protectedChanges: [...protectedChanges].sort(), bindings, diagnostics };
  }
  const refreshed = refreshIntegrity(candidate, base.integrity.status);
  const validation = validateSnapshot(refreshed);
  if (!validation.ok)
    return {
      affected: [...affected].sort(),
      protectedChanges: [...protectedChanges].sort(),
      bindings,
      diagnostics: validation.diagnostics,
    };
  const proseDiagnostics = validateCanonicalProse(validation.snapshot);
  if (proseDiagnostics.length > 0)
    return {
      affected: [...affected].sort(),
      protectedChanges: [...protectedChanges].sort(),
      bindings,
      diagnostics: proseDiagnostics,
    };
  return {
    candidate: canonicalizeSnapshot(validation.snapshot),
    affected: [...affected].sort(),
    protectedChanges: [...protectedChanges].sort(),
    bindings,
    diagnostics: [],
  };
}

function changedDeclarationIds(before: RepositorySemanticSnapshot, after: RepositorySemanticSnapshot): Set<LogicalId> {
  const changed = new Set<LogicalId>();
  const collections: Array<[readonly { id: LogicalId }[], readonly { id: LogicalId }[]]> = [
    [[before.declarations.project], [after.declarations.project]],
    [before.declarations.components, after.declarations.components],
    [before.declarations.capabilities, after.declarations.capabilities],
    [before.declarations.contracts, after.declarations.contracts],
    [before.declarations.invariants, after.declarations.invariants],
    [before.declarations.decisions, after.declarations.decisions],
    [before.declarations.rationales, after.declarations.rationales],
    [before.declarations.constraints, after.declarations.constraints],
    [before.declarations.facts, after.declarations.facts],
    [before.declarations.effectPolicies, after.declarations.effectPolicies],
    [before.declarations.dependencyPolicies, after.declarations.dependencyPolicies],
    [before.declarations.reviewGuidance, after.declarations.reviewGuidance],
    [before.declarations.symbolOwnership ?? [], after.declarations.symbolOwnership ?? []],
    [before.declarations.semanticDebt ?? [], after.declarations.semanticDebt ?? []],
  ];
  for (const [left, right] of collections) {
    const all = new Map([...left, ...right].map((item) => [item.id, item]));
    for (const [id, item] of all) {
      const beforeItem = left.find((candidate) => candidate.id === id);
      const afterItem = right.find((candidate) => candidate.id === id);
      if (stableStringifyValue(beforeItem) !== stableStringifyValue(afterItem)) changed.add(id);
      void item;
    }
  }
  const markReferenceChanges = <T>(
    left: readonly T[],
    right: readonly T[],
    keyOf: (item: T) => string,
    referencesOf: (item: T) => readonly LogicalId[],
  ): void => {
    const keys = new Set([...left, ...right].map(keyOf));
    for (const key of keys) {
      const leftItem = left.find((item) => keyOf(item) === key);
      const rightItem = right.find((item) => keyOf(item) === key);
      if (stableStringifyValue(leftItem) === stableStringifyValue(rightItem)) continue;
      for (const item of [leftItem, rightItem]) {
        if (item !== undefined) referencesOf(item).forEach((id) => changed.add(id));
      }
    }
  };
  markReferenceChanges(
    before.declarations.effectPolicies,
    after.declarations.effectPolicies,
    (item) => item.id,
    (item) => [item.subject],
  );
  markReferenceChanges(
    before.declarations.dependencyPolicies,
    after.declarations.dependencyPolicies,
    (item) => item.id,
    (item) => [item.subject],
  );
  markReferenceChanges(
    before.declarations.reviewGuidance,
    after.declarations.reviewGuidance,
    (item) => item.id,
    (item) => [item.subject],
  );
  markReferenceChanges(
    before.declarations.stability,
    after.declarations.stability,
    (item) => item.subject,
    (item) => [item.subject],
  );
  markReferenceChanges(
    before.declarations.decisionLinks,
    after.declarations.decisionLinks,
    (item) => `${item.subject}:${item.decisionId}:${item.relation}`,
    (item) => [item.subject, item.decisionId],
  );
  markReferenceChanges(
    before.declarations.terminology,
    after.declarations.terminology,
    (item) => item.term,
    (item) => item.relatedEntityIds,
  );
  markReferenceChanges(
    before.declarations.symbolOwnership ?? [],
    after.declarations.symbolOwnership ?? [],
    (item) => item.id,
    (item) => [item.symbolId, ...(item.componentId === undefined ? [] : [item.componentId])],
  );
  markReferenceChanges(
    before.declarations.semanticDebt ?? [],
    after.declarations.semanticDebt ?? [],
    (item) => item.id,
    (item) => [item.subject],
  );
  const relations = new Map([...before.graph.relations, ...after.graph.relations].map((item) => [item.id, item]));
  for (const [id, relationItem] of relations) {
    const beforeRelation = before.graph.relations.find((item) => item.id === id);
    const afterRelation = after.graph.relations.find((item) => item.id === id);
    if (stableStringifyValue(beforeRelation) !== stableStringifyValue(afterRelation)) {
      changed.add(relationItem.from);
      changed.add(relationItem.to);
    }
  }
  return changed;
}

export function createSemanticMutationService(
  initialSnapshot: RepositorySemanticSnapshot,
  resolver: SymbolBindingResolver = createSnapshotSymbolBindingResolver(initialSnapshot),
): SemanticMutationService {
  let current = clone(initialSnapshot);

  const validate = (state: RepositorySemanticSnapshot): MutationValidationResult => {
    const schema = validateSnapshot(state);
    if (!schema.ok) return { ok: false, diagnostics: schema.diagnostics };
    const proseDiagnostics = validateCanonicalProse(schema.snapshot);
    return proseDiagnostics.length === 0
      ? { ok: true, snapshot: canonicalizeSnapshot(schema.snapshot), diagnostics: [] }
      : { ok: false, diagnostics: proseDiagnostics };
  };

  const buildPlan = (base: RepositorySemanticSnapshot, request: SemanticMutationRequest): MutationPlan => {
    const baseValidation = validate(base);
    const baseSnapshot = baseValidation.ok ? baseValidation.snapshot : base;
    const baseDigest = (() => {
      try {
        return computeSnapshotDigest(baseSnapshot);
      } catch {
        return { algorithm: "sha256" as const, value: "0".repeat(64) };
      }
    })();
    const diagnostics = [...(baseValidation.ok ? [] : baseValidation.diagnostics)];
    if (
      request.expectedSnapshotDigest !== undefined &&
      stableStringifyValue(request.expectedSnapshotDigest) !== stableStringifyValue(baseDigest)
    ) {
      diagnostics.push(
        diagnostic(
          "mutation_base_digest_mismatch",
          "request expectedSnapshotDigest does not match the current semantic state",
        ),
      );
    }
    const built =
      diagnostics.length > 0
        ? { affected: [], protectedChanges: [], bindings: [], diagnostics }
        : buildCandidate(baseSnapshot, request, resolver);
    const transaction =
      built.candidate === undefined
        ? undefined
        : transactionFor(request, built.candidate, built.affected, built.protectedChanges);
    return {
      baseSnapshot: clone(baseSnapshot),
      ...(built.candidate === undefined ? {} : { candidateSnapshot: built.candidate }),
      request,
      baseSnapshotDigest: baseDigest,
      affectedEntities: built.affected,
      protectedChanges: built.protectedChanges,
      bindingRequirements: built.bindings,
      expectedWrites: built.candidate === undefined ? [] : serializeSemanticSourcePatch(baseSnapshot, built.candidate),
      ...(transaction === undefined ? {} : { transaction }),
      diagnostics: built.diagnostics,
    };
  };

  const apply = (plan: MutationPlan): SemanticMutationResult => {
    const currentDigest = (() => {
      try {
        return computeSnapshotDigest(current);
      } catch {
        return { algorithm: "sha256" as const, value: "0".repeat(64) };
      }
    })();
    if (plan.diagnostics.length > 0) return { ok: false, diagnostics: plan.diagnostics };
    if (stableStringifyValue(currentDigest) !== stableStringifyValue(plan.baseSnapshotDigest)) {
      const changed = changedDeclarationIds(plan.baseSnapshot, current);
      const overlap = plan.affectedEntities.filter((id) => changed.has(id));
      if (overlap.length > 0) {
        return {
          ok: false,
          diagnostics: [
            diagnostic(
              "mutation_conflict",
              "concurrent semantic mutation conflicts with an affected entity",
              overlap[0],
              { affectedEntities: overlap },
            ),
          ],
        };
      }
      const rebased = buildPlan(current, plan.request);
      if (rebased.diagnostics.length > 0) return { ok: false, diagnostics: rebased.diagnostics };
      return apply(rebased);
    }
    if (plan.candidateSnapshot === undefined || plan.transaction === undefined) {
      return {
        ok: false,
        diagnostics: [
          diagnostic("mutation_plan_incomplete", "mutation plan has no validated candidate or transaction"),
        ],
      };
    }
    current = clone(plan.candidateSnapshot);
    return {
      ok: true,
      snapshot: clone(current),
      transaction: clone(plan.transaction),
      writes: [...plan.expectedWrites],
      affectedEntities: plan.affectedEntities,
      protectedChanges: plan.protectedChanges,
    };
  };

  return {
    plan: (request) => buildPlan(current, request),
    apply,
    validate,
    getSnapshot: () => clone(current),
  };
}
