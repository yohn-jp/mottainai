import { z } from "zod";
import {
  EFFECT_ID_PATTERN,
  LOGICAL_ID_PATTERN,
  logicalIdNamespace,
} from "./ids.js";
import { NODE_KINDS } from "./types.js";
import type {
  JsonValue,
  RepositorySemanticSnapshot,
  SemanticDiagnostic,
  SemanticNode,
  SnapshotValidationResult,
} from "./types.js";
import { CURRENT_SCHEMA_VERSION } from "./types.js";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

const logicalIdSchema = z.string().regex(LOGICAL_ID_PATTERN, "must be a stable logical ID");
const metadataSchema = z.record(jsonValueSchema);

const sourcePositionSchema = z.object({
  line: z.number().int().min(1),
  column: z.number().int().min(0),
}).strict();

const sourceRangeSchema = z.object({
  start: sourcePositionSchema,
  end: sourcePositionSchema.optional(),
}).strict();

const symbolLocatorSchema = z.object({
  kind: z.literal("symbol"),
  language: z.string().min(1),
  package: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  symbol: z.string().min(1),
  signature: z.string().min(1).optional(),
  range: sourceRangeSchema.optional(),
}).strict();

const fileLocatorSchema = z.object({
  kind: z.literal("file"),
  path: z.string().min(1),
  package: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  range: sourceRangeSchema.optional(),
}).strict();

const moduleLocatorSchema = z.object({
  kind: z.literal("module"),
  name: z.string().min(1),
  package: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  range: sourceRangeSchema.optional(),
}).strict();

const documentLocatorSchema = z.object({
  kind: z.literal("document"),
  path: z.string().min(1),
  section: z.string().min(1).optional(),
  range: sourceRangeSchema.optional(),
}).strict();

const physicalLocatorSchema = z.discriminatedUnion("kind", [
  symbolLocatorSchema,
  fileLocatorSchema,
  moduleLocatorSchema,
  documentLocatorSchema,
]);

const nodeIdentitySchema = z.object({
  logicalId: logicalIdSchema,
  locators: z.array(physicalLocatorSchema).optional(),
  aliases: z.array(logicalIdSchema).optional(),
}).strict();

const repositoryIdentitySchema = z.object({
  id: logicalIdSchema,
  canonicalName: z.string().min(1),
  remote: z.string().min(1).optional(),
}).strict();

const revisionIdentitySchema = z.object({
  id: logicalIdSchema,
  revision: z.string().min(1),
  kind: z.string().min(1).optional(),
  parentIds: z.array(logicalIdSchema).optional(),
}).strict();

const producerIdentitySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
}).strict();

const sourceRevisionSchema = z.object({
  repositoryId: logicalIdSchema,
  revisionId: logicalIdSchema,
}).strict();

const evidenceReferenceSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
  target: logicalIdSchema.optional(),
  locator: physicalLocatorSchema.optional(),
  note: z.string().min(1).optional(),
}).strict();

const ambiguitySchema = z.object({
  status: z.enum(["none", "possible", "ambiguous"]),
  reason: z.string().min(1).optional(),
  candidates: z.array(logicalIdSchema).optional(),
}).strict();

const provenanceSchema = z.object({
  kind: z.enum(["declared", "derived", "observed", "inferred"]),
  producer: producerIdentitySchema,
  sourceRevision: sourceRevisionSchema,
  evidence: z.array(evidenceReferenceSchema).optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
  completeness: z.enum(["complete", "partial", "unknown"]).optional(),
  ambiguity: ambiguitySchema.optional(),
}).strict();

const contractAssertionSchema = z.object({
  expression: z.string().min(1),
  description: z.string().min(1).optional(),
}).strict();

const contractParameterSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1).optional(),
  required: z.boolean().optional(),
  domain: z.string().min(1).optional(),
}).strict();

const capabilityRequirementSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
}).strict();

const externalResourceSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  access: z.string().min(1),
  description: z.string().min(1).optional(),
}).strict();

const contractErrorSchema = z.object({
  type: z.string().min(1),
  condition: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
}).strict();

const stateTransitionSchema = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1),
  trigger: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
}).strict();

const externalCallSchema = z.object({
  target: z.string().min(1),
  operation: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
}).strict();

const externalEventSchema = z.object({
  name: z.string().min(1),
  payload: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
}).strict();

const contractSchema = z.object({
  inputs: z.object({
    parameters: z.array(contractParameterSchema),
    acceptedDomain: z.array(contractAssertionSchema),
    preconditions: z.array(contractAssertionSchema),
    dependencies: z.array(capabilityRequirementSchema),
    externalResources: z.array(externalResourceSchema),
  }).strict(),
  outputs: z.object({
    returnValue: z.string().min(1).optional(),
    postconditions: z.array(contractAssertionSchema),
    errors: z.array(contractErrorSchema),
    stateTransitions: z.array(stateTransitionSchema),
    externalCalls: z.array(externalCallSchema),
    externalEvents: z.array(externalEventSchema),
    effects: z.array(z.string().regex(EFFECT_ID_PATTERN, "must be a namespaced effect ID")),
  }).strict(),
}).strict();

const semanticNodeSchema = z.object({
  kind: z.string().min(1),
  identity: nodeIdentitySchema,
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  provenance: provenanceSchema,
  contract: contractSchema.optional(),
  metadata: metadataSchema.optional(),
}).strict();

const semanticEdgeSchema = z.object({
  id: logicalIdSchema,
  kind: z.string().min(1),
  from: logicalIdSchema,
  to: logicalIdSchema,
  provenance: provenanceSchema,
  metadata: metadataSchema.optional(),
}).strict();

const semanticFactSchema = z.object({
  id: logicalIdSchema,
  subject: logicalIdSchema,
  predicate: z.string().min(1),
  value: jsonValueSchema,
  provenance: provenanceSchema,
  metadata: metadataSchema.optional(),
}).strict();

const semanticClaimSchema = z.object({
  id: logicalIdSchema,
  subject: logicalIdSchema,
  statement: z.string().min(1),
  object: logicalIdSchema.optional(),
  status: z.enum(["supported", "uncertain", "rejected", "open"]),
  provenance: provenanceSchema,
  metadata: metadataSchema.optional(),
}).strict();

const semanticDiagnosticSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string().min(1),
  subject: logicalIdSchema.optional(),
  path: z.string().min(1).optional(),
  details: jsonValueSchema.optional(),
}).strict();

const analysisUnknownSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  subjects: z.array(logicalIdSchema).optional(),
}).strict();

const analysisSchema = z.object({
  completeness: z.enum(["complete", "partial", "unknown"]),
  unknowns: z.array(analysisUnknownSchema),
}).strict();

export const repositorySemanticSnapshotSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  repositoryIdentity: repositoryIdentitySchema,
  revisionIdentity: revisionIdentitySchema,
  analysis: analysisSchema,
  nodes: z.array(semanticNodeSchema),
  edges: z.array(semanticEdgeSchema),
  facts: z.array(semanticFactSchema),
  claims: z.array(semanticClaimSchema),
  diagnostics: z.array(semanticDiagnosticSchema),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(code: string, message: string, path?: string, details?: JsonValue): SemanticDiagnostic {
  return {
    code,
    severity: "error",
    message,
    ...(path === undefined ? {} : { path }),
    ...(details === undefined ? {} : { details }),
  };
}

function zodDiagnostics(error: z.ZodError): SemanticDiagnostic[] {
  return error.issues.map((issue) => diagnostic(
    "schema_validation_failed",
    issue.message,
    issue.path.length === 0 ? undefined : issue.path.map(String).join("."),
  ));
}

function namespaceForNodeKind(kind: string): string | undefined {
  if (kind === "repository") return "repo";
  return (NODE_KINDS as readonly string[]).includes(kind) ? kind : undefined;
}

function validateReferences(snapshot: RepositorySemanticSnapshot): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const nodeIds = new Set(snapshot.nodes.map((node) => node.identity.logicalId));
  const validTargets = new Set<string>([
    ...nodeIds,
    snapshot.repositoryIdentity.id,
    snapshot.revisionIdentity.id,
  ]);
  const seenNodeIds = new Set<string>();

  if (logicalIdNamespace(snapshot.repositoryIdentity.id) !== "repo") {
    diagnostics.push(diagnostic("invalid_repository_id", "repository identity must use the repo namespace", "repositoryIdentity.id"));
  }
  if (logicalIdNamespace(snapshot.revisionIdentity.id) !== "revision") {
    diagnostics.push(diagnostic("invalid_revision_id", "revision identity must use the revision namespace", "revisionIdentity.id"));
  }

  snapshot.nodes.forEach((node, index) => {
    const id = node.identity.logicalId;
    const path = `nodes.${index}.identity.logicalId`;
    if (seenNodeIds.has(id)) diagnostics.push(diagnostic("duplicate_node_id", `duplicate node ID: ${id}`, path));
    seenNodeIds.add(id);
    const expectedNamespace = namespaceForNodeKind(node.kind);
    if (expectedNamespace !== undefined && logicalIdNamespace(id) !== expectedNamespace) {
      diagnostics.push(diagnostic("node_id_kind_mismatch", `node ID namespace must match kind ${node.kind}`, path));
    }
  });

  const checkReference = (value: string, path: string): void => {
    if (!validTargets.has(value)) diagnostics.push(diagnostic("dangling_reference", `reference does not resolve locally: ${value}`, path));
  };

  snapshot.edges.forEach((edge, index) => {
    checkReference(edge.from, `edges.${index}.from`);
    checkReference(edge.to, `edges.${index}.to`);
  });
  snapshot.facts.forEach((fact, index) => {
    checkReference(fact.subject, `facts.${index}.subject`);
    fact.provenance.evidence?.forEach((evidence, evidenceIndex) => {
      if (evidence.target !== undefined) checkReference(evidence.target, `facts.${index}.provenance.evidence.${evidenceIndex}.target`);
    });
  });
  snapshot.claims.forEach((claim, index) => {
    checkReference(claim.subject, `claims.${index}.subject`);
    if (claim.object !== undefined) checkReference(claim.object, `claims.${index}.object`);
    claim.provenance.evidence?.forEach((evidence, evidenceIndex) => {
      if (evidence.target !== undefined) checkReference(evidence.target, `claims.${index}.provenance.evidence.${evidenceIndex}.target`);
    });
  });

  return diagnostics;
}

export function validateSnapshot(input: unknown): SnapshotValidationResult {
  if (isRecord(input) && typeof input.schemaVersion === "number" && input.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        "unsupported_schema_version",
        `unsupported semantic schema version: ${String(input.schemaVersion)}`,
        "schemaVersion",
        { supported: [CURRENT_SCHEMA_VERSION], received: input.schemaVersion },
      )],
    };
  }

  const parsed = repositorySemanticSnapshotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, diagnostics: zodDiagnostics(parsed.error) };

  const snapshot = parsed.data as RepositorySemanticSnapshot;
  const diagnostics = validateReferences(snapshot);
  return diagnostics.length === 0
    ? { ok: true, snapshot, diagnostics: [] }
    : { ok: false, diagnostics };
}

export type RepositorySemanticSnapshotSchema = z.infer<typeof repositorySemanticSnapshotSchema>;
export { jsonValueSchema };
