import {
  canonicalizeSnapshot,
  computeIntegrityDigestsFromValidated,
  digestCanonicalValue,
  stableStringifyValue,
} from "../ir/canonical.js";
import { validateSnapshot } from "../ir/schema.js";
import type {
  AnalysisState,
  DeclaredState,
  RepositoryIntegrity,
  RepositorySemanticSnapshot,
  SemanticDiagnostic,
  SemanticRelation,
  SnapshotValidationResult,
} from "../ir/types.js";

export const SEMANTIC_SOURCE_ROOT = ".mottainai/semantics" as const;
export const SEMANTIC_REPOSITORY_FILE = `${SEMANTIC_SOURCE_ROOT}/repository.json` as const;

export interface SemanticSourceWrite {
  path: string;
  operation: "write" | "delete";
  content?: string;
}

type SourceIntegrity = Omit<RepositoryIntegrity, "semanticStateDigest" | "modelDigest" | "snapshotDigest">;

interface SourceRepository {
  schemaVersion: RepositorySemanticSnapshot["schemaVersion"];
  modelVersion: RepositorySemanticSnapshot["modelVersion"];
  repositoryIdentity: RepositorySemanticSnapshot["repositoryIdentity"];
  revisionIdentity?: RepositorySemanticSnapshot["revisionIdentity"];
  derived: RepositorySemanticSnapshot["derived"];
  observed: RepositorySemanticSnapshot["observed"];
  analysis: AnalysisState;
  integrity: SourceIntegrity;
  graphRelations: SemanticRelation[];
}

interface SourceMetadata {
  commentPolicy: DeclaredState["commentPolicy"];
  verificationPerspectives?: DeclaredState["verificationPerspectives"];
  verificationRequirements?: DeclaredState["verificationRequirements"];
}

function writeJson(path: string, value: unknown): SemanticSourceWrite {
  return { path, operation: "write", content: `${stableStringifyValue(value)}\n` };
}

function fileFor(collection: string, key: string): string {
  return `${SEMANTIC_SOURCE_ROOT}/declarations/${collection}/${encodeURIComponent(key)}.json`;
}

function relationFileFor(id: string): string {
  return `${SEMANTIC_SOURCE_ROOT}/relations/${encodeURIComponent(id)}.json`;
}

function collectionKey(value: unknown): string {
  if (typeof value !== "object" || value === null) return stableStringifyValue(value);
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  if (typeof record.subject === "string") {
    return [
      record.subject,
      typeof record.term === "string" ? record.term : "",
      typeof record.decisionId === "string" ? record.decisionId : "",
      typeof record.relation === "string" ? record.relation : "",
    ].join("-");
  }
  return stableStringifyValue(value);
}

function sourceRepository(snapshot: RepositorySemanticSnapshot): SourceRepository {
  const {
    semanticStateDigest: _semanticStateDigest,
    modelDigest: _modelDigest,
    snapshotDigest: _snapshotDigest,
    ...integrity
  } = snapshot.integrity;
  return {
    schemaVersion: snapshot.schemaVersion,
    modelVersion: snapshot.modelVersion,
    repositoryIdentity: snapshot.repositoryIdentity,
    ...(snapshot.revisionIdentity === undefined ? {} : { revisionIdentity: snapshot.revisionIdentity }),
    derived: snapshot.derived,
    observed: snapshot.observed,
    analysis: snapshot.analysis,
    integrity,
    graphRelations: snapshot.graph.relations.filter((relation) => relation.authority !== "declared"),
  };
}

function sourceFiles(snapshot: RepositorySemanticSnapshot): SemanticSourceWrite[] {
  const canonical = canonicalizeSnapshot(snapshot);
  const declarations = canonical.declarations;
  const writes: SemanticSourceWrite[] = [
    writeJson(SEMANTIC_REPOSITORY_FILE, sourceRepository(canonical)),
    writeJson(`${SEMANTIC_SOURCE_ROOT}/declarations/project.json`, declarations.project),
    writeJson(`${SEMANTIC_SOURCE_ROOT}/declarations/metadata.json`, {
      commentPolicy: declarations.commentPolicy,
      ...(declarations.verificationPerspectives === undefined
        ? {}
        : { verificationPerspectives: declarations.verificationPerspectives }),
      ...(declarations.verificationRequirements === undefined
        ? {}
        : { verificationRequirements: declarations.verificationRequirements }),
    } satisfies SourceMetadata),
  ];

  const addCollection = (collection: string, values: readonly unknown[]): void => {
    for (const value of values) writes.push(writeJson(fileFor(collection, collectionKey(value)), value));
  };
  addCollection("components", declarations.components);
  addCollection("capabilities", declarations.capabilities);
  addCollection("contracts", declarations.contracts);
  addCollection("invariants", declarations.invariants);
  addCollection("decisions", declarations.decisions);
  addCollection("rationales", declarations.rationales);
  addCollection("constraints", declarations.constraints);
  addCollection("facts", declarations.facts);
  addCollection("effect-policies", declarations.effectPolicies);
  addCollection("dependency-policies", declarations.dependencyPolicies);
  addCollection("review-guidance", declarations.reviewGuidance);
  addCollection("stability", declarations.stability);
  addCollection("terminology", declarations.terminology);
  addCollection("decision-links", declarations.decisionLinks);
  addCollection("symbol-ownership", declarations.symbolOwnership ?? []);
  addCollection("semantic-debt", declarations.semanticDebt ?? []);
  for (const relation of canonical.graph.relations.filter((item) => item.authority === "declared")) {
    writes.push(writeJson(relationFileFor(relation.id), relation));
  }
  return writes.sort((left, right) => left.path.localeCompare(right.path));
}

export function serializeSemanticSource(snapshot: RepositorySemanticSnapshot): SemanticSourceWrite[] {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    throw new Error(
      `cannot serialize invalid semantic source: ${validation.diagnostics.map((item) => item.code).join(",")}`,
    );
  }
  return sourceFiles(validation.snapshot);
}

function writeMap(writes: readonly SemanticSourceWrite[]): Map<string, SemanticSourceWrite> {
  return new Map(writes.map((write) => [write.path, write]));
}

export function serializeSemanticSourcePatch(
  before: RepositorySemanticSnapshot,
  after: RepositorySemanticSnapshot,
): SemanticSourceWrite[] {
  const beforeMap = writeMap(serializeSemanticSource(before));
  const afterMap = writeMap(serializeSemanticSource(after));
  const paths = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const patch: SemanticSourceWrite[] = [];
  for (const path of [...paths].sort()) {
    if (path === SEMANTIC_REPOSITORY_FILE) continue;
    const previous = beforeMap.get(path);
    const next = afterMap.get(path);
    if (next === undefined) {
      patch.push({ path, operation: "delete" });
    } else if (previous?.content !== next.content) {
      patch.push(next);
    }
  }
  return patch;
}

function diagnostic(code: string, message: string): SemanticDiagnostic {
  return { code, severity: "error", message };
}

function readJson<T>(files: Map<string, SemanticSourceWrite>, path: string): T {
  const file = files.get(path);
  if (file?.operation !== "write" || file.content === undefined)
    throw new Error(`missing semantic source file: ${path}`);
  return JSON.parse(file.content) as T;
}

function collection<T>(files: Map<string, SemanticSourceWrite>, name: string): T[] {
  const prefix = `${SEMANTIC_SOURCE_ROOT}/declarations/${name}/`;
  return [...files.entries()]
    .filter(([path, file]) => path.startsWith(prefix) && path.endsWith(".json") && file.operation === "write")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, file]) => JSON.parse(file.content ?? "") as T);
}

export function parseSemanticSource(writes: readonly SemanticSourceWrite[]): SnapshotValidationResult {
  try {
    const files = writeMap(writes);
    const repository = readJson<SourceRepository>(files, SEMANTIC_REPOSITORY_FILE);
    const project = readJson<DeclaredState["project"]>(files, `${SEMANTIC_SOURCE_ROOT}/declarations/project.json`);
    const metadata = readJson<SourceMetadata>(files, `${SEMANTIC_SOURCE_ROOT}/declarations/metadata.json`);
    const relations = [...files.entries()]
      .filter(([path, file]) => path.startsWith(`${SEMANTIC_SOURCE_ROOT}/relations/`) && file.operation === "write")
      .map(([, file]) => JSON.parse(file.content ?? "") as SemanticRelation);
    const pending = digestCanonicalValue("source-pending");
    const snapshot: RepositorySemanticSnapshot = {
      schemaVersion: repository.schemaVersion,
      modelVersion: repository.modelVersion,
      repositoryIdentity: repository.repositoryIdentity,
      ...(repository.revisionIdentity === undefined ? {} : { revisionIdentity: repository.revisionIdentity }),
      declarations: {
        project,
        components: collection(files, "components"),
        capabilities: collection(files, "capabilities"),
        contracts: collection(files, "contracts"),
        invariants: collection(files, "invariants"),
        decisions: collection(files, "decisions"),
        rationales: collection(files, "rationales"),
        constraints: collection(files, "constraints"),
        facts: collection(files, "facts"),
        effectPolicies: collection(files, "effect-policies"),
        dependencyPolicies: collection(files, "dependency-policies"),
        reviewGuidance: collection(files, "review-guidance"),
        stability: collection(files, "stability"),
        terminology: collection(files, "terminology"),
        decisionLinks: collection(files, "decision-links"),
        commentPolicy: metadata.commentPolicy,
        ...(collection(files, "symbol-ownership").length === 0
          ? {}
          : { symbolOwnership: collection(files, "symbol-ownership") }),
        ...(collection(files, "semantic-debt").length === 0
          ? {}
          : { semanticDebt: collection(files, "semantic-debt") }),
        ...(metadata.verificationPerspectives === undefined
          ? {}
          : { verificationPerspectives: metadata.verificationPerspectives }),
        ...(metadata.verificationRequirements === undefined
          ? {}
          : { verificationRequirements: metadata.verificationRequirements }),
      },
      derived: repository.derived,
      observed: repository.observed,
      analysis: repository.analysis,
      integrity: {
        ...repository.integrity,
        semanticStateDigest: pending,
        modelDigest: pending,
        snapshotDigest: pending,
        status: repository.integrity.status === "fresh" ? "stale" : repository.integrity.status,
        ...(repository.integrity.status === "fresh"
          ? { statusReason: "integrity is recomputed from canonical source files" }
          : {}),
      },
      graph: { relations: [...repository.graphRelations, ...relations] },
    };
    const initial = validateSnapshot(snapshot);
    if (!initial.ok) return initial;
    if (repository.integrity.status !== "fresh") return initial;
    const { statusReason: _statusReason, ...integrity } = initial.snapshot.integrity;
    const freshShape: RepositorySemanticSnapshot = {
      ...initial.snapshot,
      integrity: { ...integrity, status: "fresh" },
    };
    const complete: RepositorySemanticSnapshot = {
      ...freshShape,
      integrity: {
        ...freshShape.integrity,
        ...computeIntegrityDigestsFromValidated(freshShape),
        status: "fresh",
      },
    };
    const final = validateSnapshot(complete);
    return final.ok ? { ok: true, snapshot: canonicalizeSnapshot(final.snapshot), diagnostics: [] } : final;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("invalid_semantic_source", error instanceof Error ? error.message : "invalid semantic source"),
      ],
    };
  }
}
