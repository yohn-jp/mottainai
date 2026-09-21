import { createHash } from "node:crypto";
import type { CanonContentEntry, CanonJsonValue } from "./identity.js";
import type {
  RepositorySemanticSnapshot,
  SemanticEntity,
  SemanticRelation,
  SymbolEntity,
} from "../semantics/ir/types.js";

/** The bounded selector vocabulary accepted by C3. */
export const CANON_C3_SELECTOR_TYPES = ["path", "symbol", "interface", "component"] as const;
export type CanonC3SelectorType = (typeof CANON_C3_SELECTOR_TYPES)[number];
type CanonC3CandidateSelectorType = CanonC3SelectorType | "test";

export interface CanonC3SymbolSelector {
  readonly id?: string;
  readonly language?: string;
  readonly package?: string;
  readonly module?: string;
  readonly file?: string;
  readonly symbol?: string;
  readonly signature?: string;
}

export interface CanonC3SelectorInput {
  readonly type: CanonC3SelectorType;
  readonly value: string | CanonC3SymbolSelector;
}

export interface CanonC3Selector {
  readonly type: CanonC3CandidateSelectorType;
  /** The resolved, canonical entity id or repository-relative path. */
  readonly value: string;
}

export interface CanonC3SourceGenerationInput {
  /** An explicit repository identity is useful when a snapshot is supplied by an adapter. */
  readonly repositoryId?: string;
  /** Used only for candidates without a source file. File-local generations take precedence. */
  readonly generation?: string;
  readonly files?: readonly {
    readonly path: string;
    readonly generation: string;
  }[];
}

export interface CanonC3CandidateSource {
  readonly identity: string;
  readonly generation: string;
}

export interface CanonC3SemanticProvenance {
  readonly source: "repository-semantics";
  readonly reference: string;
  readonly entityId: string;
  readonly entityKind: SemanticEntity["kind"];
  readonly authority: SemanticEntity["authority"];
  readonly relationIds: readonly string[];
  readonly producer: SemanticEntity["provenance"]["producer"];
}

/** One normalized C3 artifact. Admission into a Canon prefix remains a later boundary. */
export interface CanonC3Candidate {
  readonly candidateId: string;
  readonly source: CanonC3CandidateSource;
  readonly selector: CanonC3Selector;
  readonly selectionReason: string;
  readonly semanticProvenance: CanonC3SemanticProvenance;
}

export type CanonC3DiagnosticCode =
  | "missing-selector"
  | "invalid-selector"
  | "unknown-selector"
  | "ambiguous-selector"
  | "semantic-state-unavailable";

export interface CanonC3Diagnostic {
  readonly code: CanonC3DiagnosticCode;
  readonly selector?: CanonC3SelectorInput;
  readonly message: string;
  readonly matches?: readonly string[];
}

export interface SelectCanonC3CandidatesInput {
  /** Resolved C2 scope/dependency entries. Their values are treated as data, not source. */
  readonly c2?: readonly CanonContentEntry[];
  /** Direct selectors are useful to callers that already normalized C2. */
  readonly selectors?: readonly CanonC3SelectorInput[];
  readonly semantic: RepositorySemanticSnapshot;
  readonly sourceGeneration?: CanonC3SourceGenerationInput;
}

export interface SelectCanonC3CandidatesResult {
  readonly candidates: readonly CanonC3Candidate[];
  readonly diagnostics: readonly CanonC3Diagnostic[];
  readonly completeness: "complete" | "incomplete";
}

const selectorTypeByKey: Readonly<Record<string, CanonC3SelectorType | undefined>> = {
  path: "path",
  paths: "path",
  file: "path",
  files: "path",
  symbol: "symbol",
  symbols: "symbol",
  interface: "interface",
  interfaces: "interface",
  component: "component",
  components: "component",
};

const associationRelations = new Set(["tests", "verifies", "implements"]);
const selectorContainers = new Set([
  "fields",
  "scope",
  "scopes",
  "dependency",
  "dependencies",
  "selectors",
  "selector",
]);
const candidateEntityKinds = new Set(["file", "symbol", "component", "test"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function normalizedPath(value: string): string | undefined {
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.split("/").includes("..")) return undefined;
  const result = normalized.replace(/^\.\//u, "");
  return result.length === 0 ? undefined : result;
}

function asSelectorType(value: unknown): CanonC3SelectorType | undefined {
  if (typeof value !== "string") return undefined;
  return (CANON_C3_SELECTOR_TYPES as readonly string[]).includes(value) ? (value as CanonC3SelectorType) : undefined;
}

function appendSelector(result: CanonC3SelectorInput[], type: CanonC3SelectorType, value: unknown): void {
  if (typeof value === "string" || isRecord(value)) {
    result.push({ type, value: value as string | CanonC3SymbolSelector });
  }
}

/** Read only explicitly named selector fields from the bounded C2 value shape. */
function selectorsFromValue(value: unknown, result: CanonC3SelectorInput[], depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 256)) selectorsFromValue(item, result, depth + 1);
    return;
  }
  if (!isRecord(value)) return;

  const explicitType = asSelectorType(value.type ?? value.kind ?? value.selectorType);
  if (explicitType !== undefined && "value" in value) appendSelector(result, explicitType, value.value);

  for (const [key, child] of Object.entries(value)) {
    const type = selectorTypeByKey[key.toLowerCase()];
    if (type !== undefined) {
      if (Array.isArray(child)) {
        for (const item of child.slice(0, 256)) {
          if (
            isRecord(item) &&
            asSelectorType(item.type ?? item.kind ?? item.selectorType) !== undefined &&
            "value" in item
          )
            selectorsFromValue(item, result, depth + 1);
          else appendSelector(result, type, item);
        }
      } else {
        if (
          isRecord(child) &&
          asSelectorType(child.type ?? child.kind ?? child.selectorType) !== undefined &&
          "value" in child
        )
          selectorsFromValue(child, result, depth + 1);
        else appendSelector(result, type, child);
      }
      continue;
    }
    if (selectorContainers.has(key.toLowerCase())) selectorsFromValue(child, result, depth + 1);
  }
}

function selectorsFromC2(c2: readonly CanonContentEntry[] | undefined): CanonC3SelectorInput[] {
  const selectors: CanonC3SelectorInput[] = [];
  for (const entry of c2 ?? []) selectorsFromValue(entry.value, selectors);
  return selectors;
}

function selectorKey(selector: CanonC3SelectorInput): string {
  return `${selector.type}:${stableJson(selector.value)}`;
}

function normalizeSymbolSelector(value: string | CanonC3SymbolSelector): CanonC3SymbolSelector | undefined {
  if (typeof value === "string") return value.trim().length === 0 ? undefined : { symbol: value.trim() };
  const fields = ["id", "language", "package", "module", "file", "symbol", "signature"] as const;
  const normalized = Object.fromEntries(
    fields
      .filter((field) => typeof value[field] === "string" && value[field]!.trim().length > 0)
      .map((field) => [field, value[field]!.trim()]),
  ) as CanonC3SymbolSelector;
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function allEntities(snapshot: RepositorySemanticSnapshot): SemanticEntity[] {
  const entities = [
    snapshot.declarations.components,
    snapshot.derived.files,
    snapshot.derived.symbols,
    snapshot.observed.tests,
  ].flat();
  return entities.filter((entity) => candidateEntityKinds.has(entity.kind)) as SemanticEntity[];
}

function entityById(snapshot: RepositorySemanticSnapshot): Map<string, SemanticEntity> {
  return new Map(allEntities(snapshot).map((entity) => [entity.id, entity]));
}

function entityMatchesSymbol(entity: SymbolEntity, selector: CanonC3SymbolSelector): boolean {
  const locator = entity.locator;
  if (selector.id !== undefined && entity.id !== selector.id) return false;
  if (selector.language !== undefined && locator.language !== selector.language) return false;
  if (selector.package !== undefined && locator.package !== selector.package) return false;
  if (selector.module !== undefined && locator.module !== selector.module) return false;
  if (selector.file !== undefined && normalizedPath(locator.file ?? "") !== normalizedPath(selector.file)) return false;
  if (selector.symbol !== undefined && locator.symbol !== selector.symbol && entity.name !== selector.symbol)
    return false;
  if (selector.signature !== undefined && locator.signature !== selector.signature) return false;
  return true;
}

function resolveSelector(
  snapshot: RepositorySemanticSnapshot,
  selector: CanonC3SelectorInput,
): { selector?: CanonC3Selector; entity?: SemanticEntity; diagnostic?: CanonC3Diagnostic } {
  if (selector.type === "path") {
    if (typeof selector.value !== "string")
      return { diagnostic: { code: "invalid-selector", selector, message: "path selector must be a string" } };
    const path = normalizedPath(selector.value);
    if (path === undefined)
      return {
        diagnostic: { code: "invalid-selector", selector, message: "path selector is not repository-relative" },
      };
    const matches = snapshot.derived.files.filter((file) => normalizedPath(file.path) === path);
    if (matches.length === 0)
      return { diagnostic: { code: "unknown-selector", selector, message: `path is not represented: ${path}` } };
    if (matches.length > 1)
      return {
        diagnostic: {
          code: "ambiguous-selector",
          selector,
          message: `path resolves to multiple semantic files: ${path}`,
          matches: matches.map((item) => item.id).sort(),
        },
      };
    return { selector: { type: "path", value: path }, entity: matches[0] };
  }

  if (selector.type === "component") {
    if (typeof selector.value !== "string" || selector.value.trim().length === 0)
      return { diagnostic: { code: "invalid-selector", selector, message: "component selector must be a string" } };
    const value = selector.value.trim();
    const matches = snapshot.declarations.components.filter(
      (component) => component.id === value || component.name === value,
    );
    if (matches.length === 0)
      return { diagnostic: { code: "unknown-selector", selector, message: `component is not represented: ${value}` } };
    if (matches.length > 1)
      return {
        diagnostic: {
          code: "ambiguous-selector",
          selector,
          message: `component resolves to multiple semantic entities: ${value}`,
          matches: matches.map((item) => item.id).sort(),
        },
      };
    return { selector: { type: "component", value: matches[0]!.id }, entity: matches[0] };
  }

  const symbolSelector = normalizeSymbolSelector(selector.value);
  if (symbolSelector === undefined)
    return { diagnostic: { code: "invalid-selector", selector, message: `${selector.type} selector is empty` } };
  const matches = snapshot.derived.symbols.filter(
    (symbol) =>
      (typeof selector.value === "string" && symbol.id === selector.value.trim()) ||
      entityMatchesSymbol(symbol, symbolSelector),
  );
  if (matches.length === 0)
    return {
      diagnostic: {
        code: "unknown-selector",
        selector,
        message: `${selector.type} is not represented by Repository Semantics`,
      },
    };
  if (matches.length > 1)
    return {
      diagnostic: {
        code: "ambiguous-selector",
        selector,
        message: `${selector.type} resolves to multiple semantic symbols`,
        matches: matches.map((item) => item.id).sort(),
      },
    };
  return { selector: { type: selector.type, value: matches[0]!.id }, entity: matches[0] };
}

function relationForEntity(snapshot: RepositorySemanticSnapshot, entityId: string): SemanticRelation[] {
  return snapshot.graph.relations
    .filter((relation) => relation.from === entityId || relation.to === entityId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sourcePaths(snapshot: RepositorySemanticSnapshot, entity: SemanticEntity): string[] {
  const paths = new Set<string>();
  const addEntityPath = (candidate: SemanticEntity | undefined): void => {
    if (candidate?.kind === "file") {
      const path = normalizedPath(candidate.path);
      if (path !== undefined) paths.add(path);
    }
    if (candidate?.kind === "symbol") {
      const path = normalizedPath(candidate.locator.file ?? "");
      if (path !== undefined) paths.add(path);
    }
  };
  addEntityPath(entity);
  if (entity.kind === "component") {
    const entities = entityById(snapshot);
    for (const relation of relationForEntity(snapshot, entity.id)) {
      if (relation.from !== entity.id) continue;
      const related = entities.get(relation.to);
      if (relation.kind === "owns" || relation.kind === "shares" || relation.kind === "contains")
        addEntityPath(related);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function fileGeneration(
  snapshot: RepositorySemanticSnapshot,
  path: string,
  sourceGeneration: CanonC3SourceGenerationInput | undefined,
): string {
  const explicit = sourceGeneration?.files?.find((file) => normalizedPath(file.path) === path)?.generation;
  if (explicit !== undefined) return explicit;
  const tracked = snapshot.integrity.trackedFiles.find((file) => normalizedPath(file.path) === path);
  if (tracked === undefined) return "unfingerprinted";
  return tracked.semanticFingerprint?.value ?? tracked.physicalFingerprint.value;
}

function entityShape(entity: SemanticEntity): CanonJsonValue {
  switch (entity.kind) {
    case "file":
      return {
        kind: entity.kind,
        id: entity.id,
        name: entity.name,
        path: entity.path,
        language: entity.language ?? null,
      };
    case "symbol":
      return {
        kind: entity.kind,
        id: entity.id,
        name: entity.name,
        locator: {
          kind: entity.locator.kind,
          language: entity.locator.language,
          ...(entity.locator.package === undefined ? {} : { package: entity.locator.package }),
          ...(entity.locator.module === undefined ? {} : { module: entity.locator.module }),
          ...(entity.locator.file === undefined ? {} : { file: entity.locator.file }),
          symbol: entity.locator.symbol,
          ...(entity.locator.signature === undefined ? {} : { signature: entity.locator.signature }),
        },
        classification: entity.classification,
      };
    case "component":
      return {
        kind: entity.kind,
        id: entity.id,
        name: entity.name,
        responsibility: entity.responsibility,
        stability: entity.stability,
        reviewLevel: entity.reviewLevel,
      };
    case "test":
      return {
        kind: entity.kind,
        id: entity.id,
        name: entity.name,
        testName: entity.testName,
        status: entity.status,
        evidenceIds: entity.evidenceIds,
      };
    default:
      return { kind: entity.kind, id: entity.id, name: entity.name };
  }
}

function relationShape(relation: SemanticRelation): CanonJsonValue {
  return {
    id: relation.id,
    kind: relation.kind,
    from: relation.from,
    to: relation.to,
    authority: relation.authority,
    metadata: relation.metadata ?? null,
  };
}

function candidateGeneration(
  snapshot: RepositorySemanticSnapshot,
  entity: SemanticEntity,
  sourceGeneration: CanonC3SourceGenerationInput | undefined,
): { value: string; paths: readonly string[] } {
  const paths = sourcePaths(snapshot, entity);
  const files = paths.map((path) => ({ path, generation: fileGeneration(snapshot, path, sourceGeneration) }));
  const relations = relationForEntity(snapshot, entity.id).map(relationShape);
  const value = digest({ repositoryId: snapshot.repositoryIdentity.id, entity: entityShape(entity), files, relations });
  if (paths.length > 0) return { value, paths };
  const explicit = sourceGeneration?.generation;
  return { value: digest({ value, generation: explicit ?? "semantic-only" }), paths };
}

interface CandidateDraft {
  entity: SemanticEntity;
  selector: CanonC3Selector;
  reason: string;
  relationIds: Set<string>;
  explicit: boolean;
}

function addCandidate(
  drafts: Map<string, CandidateDraft>,
  entity: SemanticEntity,
  selector: CanonC3Selector,
  reason: string,
  relationId?: string,
): void {
  if (!candidateEntityKinds.has(entity.kind)) return;
  const current = drafts.get(entity.id);
  if (current === undefined || (!current.explicit && relationId === undefined)) {
    drafts.set(entity.id, {
      entity,
      selector,
      reason,
      relationIds: new Set(relationId === undefined ? [] : [relationId]),
      explicit: relationId === undefined,
    });
    return;
  }
  if (relationId !== undefined) current.relationIds.add(relationId);
}

function addAssociations(snapshot: RepositorySemanticSnapshot, drafts: Map<string, CandidateDraft>): void {
  const entities = entityById(snapshot);
  for (const root of [...drafts.values()]) {
    for (const relation of relationForEntity(snapshot, root.entity.id)) {
      if (!associationRelations.has(relation.kind)) continue;
      const otherId = relation.from === root.entity.id ? relation.to : relation.from;
      const other = entities.get(otherId);
      if (other === undefined) continue;
      if (other.kind === "test") {
        addCandidate(
          drafts,
          other,
          { type: "test", value: other.id },
          "deterministic semantic test association",
          relation.id,
        );
      } else if (other.kind === "symbol" && relation.kind === "implements") {
        addCandidate(
          drafts,
          other,
          { type: "interface", value: other.id },
          "deterministic semantic interface association",
          relation.id,
        );
      }
    }
  }
}

function toCandidate(
  snapshot: RepositorySemanticSnapshot,
  draft: CandidateDraft,
  sourceGeneration: CanonC3SourceGenerationInput | undefined,
): CanonC3Candidate {
  const generation = candidateGeneration(snapshot, draft.entity, sourceGeneration);
  const relationIds = [...draft.relationIds].sort((left, right) => left.localeCompare(right));
  return {
    candidateId: `c3:${draft.entity.id}`,
    source: {
      identity: `${sourceGeneration?.repositoryId ?? snapshot.repositoryIdentity.id}:${draft.entity.id}`,
      generation: generation.value,
    },
    selector: draft.selector,
    selectionReason: draft.reason,
    semanticProvenance: {
      source: "repository-semantics",
      reference: draft.entity.id,
      entityId: draft.entity.id,
      entityKind: draft.entity.kind,
      authority: draft.entity.authority,
      relationIds,
      producer: draft.entity.provenance.producer,
    },
  };
}

/**
 * Resolve only explicit C2 selectors against one immutable semantic snapshot.
 * Resolution is bounded by the selectors and direct semantic associations; no
 * repository-wide fallback or source transformation is performed.
 */
export function selectCanonC3Candidates(input: SelectCanonC3CandidatesInput): SelectCanonC3CandidatesResult {
  const rawSelectors = [...(input.selectors ?? []), ...selectorsFromC2(input.c2)];
  const selectors = [...new Map(rawSelectors.map((selector) => [selectorKey(selector), selector])).values()];
  const diagnostics: CanonC3Diagnostic[] = [];
  const drafts = new Map<string, CandidateDraft>();

  if (selectors.length === 0) {
    diagnostics.push({
      code: "missing-selector",
      message: "C2 contains no explicit path, symbol, interface, or component selector",
    });
  }
  for (const selector of selectors) {
    const resolved = resolveSelector(input.semantic, selector);
    if (resolved.diagnostic !== undefined) diagnostics.push(resolved.diagnostic);
    if (resolved.entity !== undefined && resolved.selector !== undefined) {
      addCandidate(drafts, resolved.entity, resolved.selector, `explicit ${resolved.selector.type} selector`);
    }
  }
  addAssociations(input.semantic, drafts);

  const candidates = [...drafts.values()]
    .map((draft) => toCandidate(input.semantic, draft, input.sourceGeneration))
    .sort((left, right) => {
      const source = left.source.identity.localeCompare(right.source.identity);
      if (source !== 0) return source;
      const selector = `${left.selector.type}:${left.selector.value}`.localeCompare(
        `${right.selector.type}:${right.selector.value}`,
      );
      return selector !== 0 ? selector : left.candidateId.localeCompare(right.candidateId);
    });
  return {
    candidates,
    diagnostics,
    completeness: diagnostics.length === 0 ? "complete" : "incomplete",
  };
}

/** Stable short alias for Canon callers. */
export const selectC3Candidates = selectCanonC3Candidates;
