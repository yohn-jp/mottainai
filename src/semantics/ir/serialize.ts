import { validateSnapshot } from "./schema.js";
import type {
  AnalysisSummary,
  AmbiguityMetadata,
  EvidenceReference,
  Provenance,
  RepositorySemanticSnapshot,
  SemanticClaim,
  SemanticDiagnostic,
  SemanticEdge,
  SemanticFact,
  SemanticNode,
  SnapshotValidationResult,
} from "./types.js";

export type ParseSnapshotResult = SnapshotValidationResult;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableStringifyValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringifyValue).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringifyValue(entry)}`).join(",")}}`;
  }
  throw new Error("semantic serialization encountered an unsupported value");
}

function compareStable(left: unknown, right: unknown): number {
  return compareText(stableStringifyValue(left), stableStringifyValue(right));
}

function canonicalizeEvidence(evidence: EvidenceReference[]): EvidenceReference[] {
  return [...evidence].sort(compareStable);
}

function canonicalizeAmbiguity(ambiguity: AmbiguityMetadata | undefined): AmbiguityMetadata | undefined {
  if (ambiguity === undefined) return undefined;
  return {
    ...ambiguity,
      ...(ambiguity.candidates === undefined ? {} : { candidates: [...ambiguity.candidates].sort(compareText) }),
  };
}

function canonicalizeProvenance(provenance: Provenance): Provenance {
  return {
    ...provenance,
    ...(provenance.evidence === undefined ? {} : { evidence: canonicalizeEvidence(provenance.evidence) }),
    ...(provenance.ambiguity === undefined ? {} : { ambiguity: canonicalizeAmbiguity(provenance.ambiguity) }),
  };
}

function canonicalizeNode(node: SemanticNode): SemanticNode {
  return {
    ...node,
    identity: {
      ...node.identity,
      ...(node.identity.aliases === undefined ? {} : { aliases: [...node.identity.aliases].sort(compareText) }),
      ...(node.identity.locators === undefined ? {} : { locators: [...node.identity.locators].sort(compareStable) }),
    },
    provenance: canonicalizeProvenance(node.provenance),
    ...(node.contract === undefined ? {} : {
      contract: {
        ...node.contract,
        outputs: {
          ...node.contract.outputs,
          effects: [...node.contract.outputs.effects].sort(compareText),
        },
      },
    }),
  };
}

function canonicalizeEdge(edge: SemanticEdge): SemanticEdge {
  return { ...edge, provenance: canonicalizeProvenance(edge.provenance) };
}

function canonicalizeFact(fact: SemanticFact): SemanticFact {
  return { ...fact, provenance: canonicalizeProvenance(fact.provenance) };
}

function canonicalizeClaim(claim: SemanticClaim): SemanticClaim {
  return { ...claim, provenance: canonicalizeProvenance(claim.provenance) };
}

function canonicalizeAnalysis(analysis: AnalysisSummary): AnalysisSummary {
  return {
    ...analysis,
    unknowns: [...analysis.unknowns]
      .map((unknown) => ({
        ...unknown,
        ...(unknown.subjects === undefined ? {} : { subjects: [...unknown.subjects].sort(compareText) }),
      }))
      .sort(compareStable),
  };
}

function canonicalizeDiagnostic(diagnostic: SemanticDiagnostic): SemanticDiagnostic {
  return { ...diagnostic };
}

export function canonicalizeSnapshot(snapshot: RepositorySemanticSnapshot): RepositorySemanticSnapshot {
  return {
    ...snapshot,
    analysis: canonicalizeAnalysis(snapshot.analysis),
    nodes: snapshot.nodes.map(canonicalizeNode).sort((left, right) => compareText(left.identity.logicalId, right.identity.logicalId)),
    edges: snapshot.edges.map(canonicalizeEdge).sort((left, right) => compareStable([left.kind, left.from, left.to, left.id], [right.kind, right.from, right.to, right.id])),
    facts: snapshot.facts.map(canonicalizeFact).sort((left, right) => compareText(left.id, right.id)),
    claims: snapshot.claims.map(canonicalizeClaim).sort((left, right) => compareText(left.id, right.id)),
    diagnostics: snapshot.diagnostics.map(canonicalizeDiagnostic).sort(compareStable),
  };
}

export function serializeSnapshot(snapshot: RepositorySemanticSnapshot): string {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    throw new Error(`cannot serialize invalid semantic snapshot: ${validation.diagnostics.map((item) => item.code).join(",")}`);
  }
  return `${stableStringifyValue(canonicalizeSnapshot(validation.snapshot))}\n`;
}

export function parseSnapshot(serialized: string): ParseSnapshotResult {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_serialized_json",
        severity: "error",
        message: error instanceof Error ? error.message : "serialized semantic snapshot is not valid JSON",
      }],
    };
  }
  const validation = validateSnapshot(value);
  return validation.ok ? { ok: true, snapshot: canonicalizeSnapshot(validation.snapshot), diagnostics: [] } : validation;
}

export function semanticEqualSnapshots(left: RepositorySemanticSnapshot, right: RepositorySemanticSnapshot): boolean {
  const leftValidation = validateSnapshot(left);
  const rightValidation = validateSnapshot(right);
  if (!leftValidation.ok || !rightValidation.ok) return false;
  return stableStringifyValue(canonicalizeSnapshot(leftValidation.snapshot)) === stableStringifyValue(canonicalizeSnapshot(rightValidation.snapshot));
}
