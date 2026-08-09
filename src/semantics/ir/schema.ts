import { z } from "zod";
import { computeIntegrityDigestsFromValidated } from "./canonical.js";
import {
  EFFECT_ID_PATTERN,
  LOGICAL_ID_PATTERN,
  createSymbolId,
  logicalIdNamespace,
  namespaceForNodeKind as sharedNamespaceForNodeKind,
} from "./ids.js";
import type { LogicalId } from "./ids.js";
import {
  AUTHORITY_LAYERS,
  CURRENT_SCHEMA_VERSION,
  MODEL_VERSION,
  NODE_KINDS,
  REVIEW_LEVELS,
  SEMANTIC_DELTA_KINDS,
  SEMANTIC_VOCABULARY_VERSION,
  VERIFICATION_REQUIREMENT_PROVENANCES,
} from "./types.js";
import type {
  JsonValue,
  Provenance,
  RepositorySemanticSnapshot,
  SemanticClaim,
  SemanticDiagnostic,
  SemanticEntity,
  SemanticFact,
  SemanticRelation,
  SemanticTransaction,
  SnapshotValidationResult,
  SymbolEntity,
  VerificationEvidence,
  VerificationPerspective,
  VerificationRequirement,
  VerificationTarget,
} from "./types.js";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const logicalIdSchema = z.string().regex(LOGICAL_ID_PATTERN, "must be a stable logical ID");
const metadataSchema = z.record(jsonValueSchema);
const authoritySchema = z.enum(AUTHORITY_LAYERS);
const reviewLevelSchema = z.enum(REVIEW_LEVELS);
const stabilitySchema = z.enum(["experimental", "unstable", "stable", "protected", "deprecated"]);
const proseSchema = z.string().min(1);

const sourcePositionSchema = z
  .object({
    line: z.number().int().min(1),
    column: z.number().int().min(0),
  })
  .strict();

const sourceRangeSchema = z
  .object({
    start: sourcePositionSchema,
    end: sourcePositionSchema.optional(),
  })
  .strict();

const symbolLocatorSchema = z
  .object({
    kind: z.literal("symbol"),
    language: z.string().min(1),
    package: z.string().min(1).optional(),
    module: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    symbol: z.string().min(1),
    signature: z.string().min(1).optional(),
    range: sourceRangeSchema.optional(),
  })
  .strict();

const fileLocatorSchema = z
  .object({
    kind: z.literal("file"),
    path: z.string().min(1),
    package: z.string().min(1).optional(),
    module: z.string().min(1).optional(),
    language: z.string().min(1).optional(),
    range: sourceRangeSchema.optional(),
  })
  .strict();

const moduleLocatorSchema = z
  .object({
    kind: z.literal("module"),
    name: z.string().min(1),
    package: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    range: sourceRangeSchema.optional(),
  })
  .strict();

const documentLocatorSchema = z
  .object({
    kind: z.literal("document"),
    path: z.string().min(1),
    section: z.string().min(1).optional(),
    range: sourceRangeSchema.optional(),
  })
  .strict();

const physicalLocatorSchema = z.discriminatedUnion("kind", [
  symbolLocatorSchema,
  fileLocatorSchema,
  moduleLocatorSchema,
  documentLocatorSchema,
]);

const producerIdentitySchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

const sourceRevisionSchema = z
  .object({
    repositoryId: logicalIdSchema,
    revisionId: logicalIdSchema.optional(),
  })
  .strict();

const evidenceReferenceSchema = z
  .object({
    kind: z.string().min(1),
    ref: z.string().min(1),
    target: logicalIdSchema.optional(),
    locator: physicalLocatorSchema.optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

const ambiguitySchema = z
  .object({
    status: z.enum(["none", "possible", "ambiguous"]),
    reason: z.string().min(1).optional(),
    candidates: z.array(logicalIdSchema).optional(),
  })
  .strict();

const provenanceSchema = z
  .object({
    kind: z.enum(["declared", "derived", "observed", "inferred"]),
    producer: producerIdentitySchema,
    sourceRevision: sourceRevisionSchema,
    evidence: z.array(evidenceReferenceSchema).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
    completeness: z.enum(["complete", "partial", "unknown"]).optional(),
    ambiguity: ambiguitySchema.optional(),
  })
  .strict();

export const verificationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), id: logicalIdSchema }).strict(),
  z.object({ kind: z.literal("component"), id: logicalIdSchema }).strict(),
  z.object({ kind: z.literal("symbol"), id: logicalIdSchema }).strict(),
  z.object({ kind: z.literal("contract"), id: logicalIdSchema }).strict(),
  z.object({ kind: z.literal("invariant"), id: logicalIdSchema }).strict(),
]);

export const verificationPerspectiveSchema = z
  .object({
    id: logicalIdSchema,
    kind: z.string().min(1),
    category: z.string().min(1),
    name: proseSchema,
    description: proseSchema.optional(),
    known: z.boolean().optional(),
    authority: z.literal("declared"),
    provenance: provenanceSchema,
    metadata: metadataSchema.optional(),
  })
  .strict();

export const verificationRequirementSchema = z
  .object({
    id: logicalIdSchema,
    target: verificationTargetSchema,
    perspectiveId: logicalIdSchema,
    strength: z.enum(["required", "recommended"]),
    rationale: proseSchema,
    requirementProvenance: z
      .object({
        kind: z.enum(VERIFICATION_REQUIREMENT_PROVENANCES),
        sourceId: logicalIdSchema.optional(),
        ruleId: z.string().min(1).optional(),
      })
      .strict(),
    minimumEvidenceStrength: z.string().min(1).optional(),
    authority: z.enum(["declared", "derived", "analysis"]),
    provenance: provenanceSchema,
    metadata: metadataSchema.optional(),
  })
  .strict();

export const verificationEvidenceSchema = z
  .object({
    id: logicalIdSchema,
    target: verificationTargetSchema,
    perspectiveId: logicalIdSchema,
    testId: logicalIdSchema.optional(),
    kind: z.string().min(1),
    strength: z.string().min(1),
    freshness: z.enum(["current", "stale"]),
    status: z.enum(["passed", "failed", "skipped", "inadequate", "missing"]),
    reference: z.string().min(1),
    summary: proseSchema,
    coverage: z.number().finite().min(0).max(100).optional(),
    authority: z.literal("observed"),
    provenance: provenanceSchema,
    metadata: metadataSchema.optional(),
  })
  .strict();

const verificationAssessmentSchema = z
  .object({
    requirementId: logicalIdSchema,
    target: verificationTargetSchema,
    perspectiveId: logicalIdSchema,
    strength: z.enum(["required", "recommended"]),
    status: z.enum(["satisfied", "missing", "stale", "failed", "inadequate", "unknown"]),
    evidenceIds: z.array(logicalIdSchema),
    satisfyingEvidenceIds: z.array(logicalIdSchema),
    missingEvidenceKinds: z.array(z.string().min(1)).optional(),
  })
  .strict();

const verificationCountsSchema = z
  .object({
    total: z.number().int().min(0),
    satisfied: z.number().int().min(0),
    missing: z.number().int().min(0),
    stale: z.number().int().min(0),
    failed: z.number().int().min(0),
    inadequate: z.number().int().min(0),
    unknown: z.number().int().min(0),
  })
  .strict();

const verificationSummarySchema = z
  .object({
    scope: z.enum(["symbol", "component", "project"]),
    targetId: logicalIdSchema,
    status: z.enum(["healthy", "incomplete", "failed", "unknown"]),
    score: z.number().finite().min(0).max(100),
    required: verificationCountsSchema,
    recommended: verificationCountsSchema,
    gapRequirementIds: z.array(logicalIdSchema),
  })
  .strict();

const verificationAnalysisSchema = z
  .object({
    authority: z.literal("analysis"),
    assessments: z.array(verificationAssessmentSchema),
    summaries: z.array(verificationSummarySchema),
    inferredRequirements: z.array(verificationRequirementSchema).optional(),
  })
  .strict();

const contractAssertionSchema = z
  .object({
    expression: proseSchema,
    description: proseSchema.optional(),
  })
  .strict();

const contractParameterSchema = z
  .object({
    name: z.string().min(1),
    type: proseSchema.optional(),
    required: z.boolean().optional(),
    domain: proseSchema.optional(),
  })
  .strict();

const capabilityRequirementSchema = z
  .object({
    name: z.string().min(1),
    description: proseSchema.optional(),
  })
  .strict();

const externalResourceSchema = z
  .object({
    name: z.string().min(1),
    kind: z.string().min(1),
    access: z.string().min(1),
    description: proseSchema.optional(),
  })
  .strict();

const contractErrorSchema = z
  .object({
    type: z.string().min(1),
    condition: proseSchema.optional(),
    description: proseSchema.optional(),
  })
  .strict();

const stateTransitionSchema = z
  .object({
    from: z.string().min(1).optional(),
    to: z.string().min(1),
    trigger: proseSchema.optional(),
    description: proseSchema.optional(),
  })
  .strict();

const externalCallSchema = z
  .object({
    target: z.string().min(1),
    operation: z.string().min(1).optional(),
    description: proseSchema.optional(),
  })
  .strict();

const externalEventSchema = z
  .object({
    name: z.string().min(1),
    payload: proseSchema.optional(),
    description: proseSchema.optional(),
  })
  .strict();

const contractSchema = z
  .object({
    inputs: z
      .object({
        parameters: z.array(contractParameterSchema),
        acceptedDomain: z.array(contractAssertionSchema),
        preconditions: z.array(contractAssertionSchema),
        dependencies: z.array(capabilityRequirementSchema),
        externalResources: z.array(externalResourceSchema),
      })
      .strict(),
    outputs: z
      .object({
        returnValue: proseSchema.optional(),
        postconditions: z.array(contractAssertionSchema),
        errors: z.array(contractErrorSchema),
        stateTransitions: z.array(stateTransitionSchema),
        externalCalls: z.array(externalCallSchema),
        externalEvents: z.array(externalEventSchema),
        effects: z.array(z.string().regex(EFFECT_ID_PATTERN, "must be a namespaced effect ID")),
      })
      .strict(),
  })
  .strict();

const entityBaseShape = {
  id: logicalIdSchema,
  name: z.string().min(1),
  description: proseSchema.optional(),
  authority: authoritySchema,
  provenance: provenanceSchema,
  metadata: metadataSchema.optional(),
};

const projectEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("project"),
    canonicalName: z.string().min(1),
    responsibility: proseSchema,
    stability: stabilitySchema,
    reviewLevel: reviewLevelSchema,
  })
  .strict();

const componentEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("component"),
    responsibility: proseSchema,
    stability: stabilitySchema,
    reviewLevel: reviewLevelSchema,
  })
  .strict();

const symbolEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("symbol"),
    locator: symbolLocatorSchema,
    classification: z.enum(["managed", "shared"]),
  })
  .strict();

const capabilityEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("capability"),
    meaning: proseSchema,
    stability: stabilitySchema,
    reviewLevel: reviewLevelSchema,
  })
  .strict();

const contractEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("contract"),
    definition: contractSchema,
    stability: stabilitySchema,
    reviewLevel: reviewLevelSchema,
  })
  .strict();

const invariantEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("invariant"),
    statement: proseSchema,
    severity: z.enum(["info", "warning", "error"]),
    stability: stabilitySchema,
  })
  .strict();

const decisionEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("decision"),
    statement: proseSchema,
    status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
    rationaleIds: z.array(logicalIdSchema),
    constraintIds: z.array(logicalIdSchema),
  })
  .strict();

const rationaleEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("rationale"),
    statement: proseSchema,
    decisionIds: z.array(logicalIdSchema),
  })
  .strict();

const constraintEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("constraint"),
    statement: proseSchema,
    scope: proseSchema,
    enforcement: z.enum(["advisory", "required", "protected"]),
  })
  .strict();

const fileEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("file"),
    path: z.string().min(1),
    language: z.string().min(1).optional(),
    tracked: z.boolean(),
  })
  .strict();

const packageEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("package"),
    packageName: z.string().min(1),
    dependencyType: z.enum(["internal", "external"]),
    version: z.string().min(1).optional(),
  })
  .strict();

const externalDependencyEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("external_dependency"),
    packageName: z.string().min(1),
    version: z.string().min(1).optional(),
    registry: z.string().min(1).optional(),
  })
  .strict();

const externalApiEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("external_api"),
    packageId: logicalIdSchema,
    apiName: z.string().min(1),
    version: z.string().min(1).optional(),
  })
  .strict();

const evidenceEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("evidence"),
    evidenceKind: z.string().min(1),
    reference: z.string().min(1),
    summary: proseSchema,
  })
  .strict();

const testEntitySchema = z
  .object({
    ...entityBaseShape,
    kind: z.literal("test"),
    testName: z.string().min(1),
    status: z.enum(["passed", "failed", "skipped", "unknown"]),
    evidenceIds: z.array(logicalIdSchema),
  })
  .strict();

const semanticEntitySchema = z.discriminatedUnion("kind", [
  projectEntitySchema,
  componentEntitySchema,
  symbolEntitySchema,
  capabilityEntitySchema,
  contractEntitySchema,
  invariantEntitySchema,
  decisionEntitySchema,
  rationaleEntitySchema,
  constraintEntitySchema,
  fileEntitySchema,
  packageEntitySchema,
  externalDependencyEntitySchema,
  externalApiEntitySchema,
  evidenceEntitySchema,
  testEntitySchema,
]);

const semanticRelationSchema = z
  .object({
    id: logicalIdSchema,
    kind: z.string().min(1),
    from: logicalIdSchema,
    to: logicalIdSchema,
    authority: authoritySchema,
    provenance: provenanceSchema,
    metadata: metadataSchema.optional(),
  })
  .strict();

const semanticFactSchema = z
  .object({
    id: logicalIdSchema,
    subject: logicalIdSchema,
    predicate: z.string().min(1),
    value: jsonValueSchema,
    authority: authoritySchema,
    provenance: provenanceSchema,
    metadata: metadataSchema.optional(),
  })
  .strict();

const semanticClaimSchema = z
  .object({
    id: logicalIdSchema,
    subject: logicalIdSchema,
    statement: proseSchema,
    object: logicalIdSchema.optional(),
    status: z.enum(["supported", "uncertain", "rejected", "open"]),
    authority: authoritySchema,
    enforcement: z.enum(["none", "advisory", "authoritative"]),
    provenance: provenanceSchema,
    metadata: metadataSchema.optional(),
  })
  .strict();

const effectPolicySchema = z
  .object({
    id: logicalIdSchema,
    subject: logicalIdSchema,
    allow: z.array(z.string().regex(EFFECT_ID_PATTERN)),
    deny: z.array(z.string().regex(EFFECT_ID_PATTERN)),
    rationaleIds: z.array(logicalIdSchema),
  })
  .strict();

const dependencyPolicySchema = z
  .object({
    id: logicalIdSchema,
    subject: logicalIdSchema,
    allowedPackageIds: z.array(logicalIdSchema),
    deniedPackageIds: z.array(logicalIdSchema),
    rationaleIds: z.array(logicalIdSchema),
  })
  .strict();

const reviewGuidanceSchema = z
  .object({
    id: logicalIdSchema,
    subject: logicalIdSchema,
    level: reviewLevelSchema,
    guidance: proseSchema,
  })
  .strict();

const stabilityDeclarationSchema = z
  .object({
    subject: logicalIdSchema,
    stability: stabilitySchema,
    rationaleId: logicalIdSchema.optional(),
  })
  .strict();

const terminologyLinkSchema = z
  .object({
    term: z.string().min(1),
    definition: proseSchema,
    relatedEntityIds: z.array(logicalIdSchema),
  })
  .strict();

const decisionLinkSchema = z
  .object({
    subject: logicalIdSchema,
    decisionId: logicalIdSchema,
    relation: z.enum(["motivated_by", "constrained_by", "supersedes"]),
  })
  .strict();

const canonicalProsePolicySchema = z
  .object({
    canonicalLanguage: z.literal("en"),
    canonicalForm: z.literal("formal-english"),
    humanLocalization: z.literal("projection"),
    llmTokenCompression: z.literal("projection"),
    sourceCodeSemantics: z.literal("implementation-only"),
    semanticCommentKinds: z.array(
      z.enum(["rationale", "todo-debt-intent", "review-note", "constraint", "api-meaning"]),
    ),
    inlineDirectives: z.array(z.string().min(1)),
    jsdoc: z.literal("projection"),
  })
  .strict();

const symbolOwnershipDeclarationSchema = z
  .object({
    id: logicalIdSchema,
    symbolId: logicalIdSchema,
    classification: z.enum(["managed", "shared"]),
    componentId: logicalIdSchema.optional(),
  })
  .strict()
  .superRefine((ownership, context) => {
    if (ownership.classification === "managed" && ownership.componentId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["componentId"],
        message: "managed Symbol ownership requires exactly one Component",
      });
    }
    if (ownership.classification === "shared" && ownership.componentId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["componentId"],
        message: "Shared Symbol ownership cannot name a single Component",
      });
    }
  });

const semanticDebtIntentSchema = z
  .object({
    id: logicalIdSchema,
    subject: logicalIdSchema,
    statement: proseSchema,
    status: z.enum(["open", "accepted", "resolved"]),
    priority: z.enum(["low", "medium", "high"]),
  })
  .strict();

const declaredStateSchema = z
  .object({
    project: projectEntitySchema,
    components: z.array(componentEntitySchema),
    capabilities: z.array(capabilityEntitySchema),
    contracts: z.array(contractEntitySchema),
    invariants: z.array(invariantEntitySchema),
    decisions: z.array(decisionEntitySchema),
    rationales: z.array(rationaleEntitySchema),
    constraints: z.array(constraintEntitySchema),
    facts: z.array(semanticFactSchema),
    effectPolicies: z.array(effectPolicySchema),
    dependencyPolicies: z.array(dependencyPolicySchema),
    reviewGuidance: z.array(reviewGuidanceSchema),
    stability: z.array(stabilityDeclarationSchema),
    terminology: z.array(terminologyLinkSchema),
    decisionLinks: z.array(decisionLinkSchema),
    commentPolicy: canonicalProsePolicySchema,
    symbolOwnership: z.array(symbolOwnershipDeclarationSchema).optional(),
    semanticDebt: z.array(semanticDebtIntentSchema).optional(),
    verificationPerspectives: z.array(verificationPerspectiveSchema).optional(),
    verificationRequirements: z.array(verificationRequirementSchema).optional(),
  })
  .strict();

const derivedStateSchema = z
  .object({
    files: z.array(fileEntitySchema),
    symbols: z.array(symbolEntitySchema),
    packages: z.array(packageEntitySchema),
    externalDependencies: z.array(externalDependencyEntitySchema),
    externalApis: z.array(externalApiEntitySchema),
    facts: z.array(semanticFactSchema),
    verificationRequirements: z.array(verificationRequirementSchema).optional(),
  })
  .strict();

const observedStateSchema = z
  .object({
    evidences: z.array(evidenceEntitySchema),
    tests: z.array(testEntitySchema),
    facts: z.array(semanticFactSchema),
    verificationEvidence: z.array(verificationEvidenceSchema).optional(),
  })
  .strict();

const semanticDeltaEntrySchema = z
  .object({
    id: logicalIdSchema,
    subject: logicalIdSchema,
    kind: z.enum(SEMANTIC_DELTA_KINDS),
    summary: proseSchema,
    reviewLevel: reviewLevelSchema,
  })
  .strict();

export const semanticDeltaSchema = z
  .object({
    version: z.literal(SEMANTIC_VOCABULARY_VERSION),
    intent: z.enum(["semantic-neutral", "semantic-change"]),
    entries: z.array(semanticDeltaEntrySchema),
    unauthorized: z.boolean(),
  })
  .strict()
  .superRefine((delta, context) => {
    if (delta.intent === "semantic-neutral" && delta.entries.length > 0 && !delta.unauthorized) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unauthorized"],
        message: "semantic-neutral delta must be marked unauthorized",
      });
    }
  });

const sourceReferenceSchema = z
  .object({
    path: z.string().min(1),
    symbol: z.string().min(1).optional(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    reason: proseSchema,
  })
  .strict();

const analysisSchema = z
  .object({
    health: z
      .object({
        status: z.enum(["healthy", "partial", "review-required", "protected", "unknown"]),
        score: z.number().finite().min(0).max(100),
        staleEvidence: z.number().int().min(0),
        modelGaps: z.number().int().min(0),
      })
      .strict(),
    reviewLevel: reviewLevelSchema,
    semanticDelta: semanticDeltaSchema,
    facts: z.array(semanticFactSchema),
    claims: z.array(semanticClaimSchema),
    unknowns: z.array(
      z
        .object({
          code: z.string().min(1),
          message: proseSchema,
          subjects: z.array(logicalIdSchema).optional(),
        })
        .strict(),
    ),
    recommendedSourceReads: z.array(sourceReferenceSchema),
    diagnostics: z.array(
      z
        .object({
          code: z.string().min(1),
          severity: z.enum(["error", "warning", "info"]),
          message: proseSchema,
          subject: logicalIdSchema.optional(),
          path: z.string().min(1).optional(),
          details: jsonValueSchema.optional(),
        })
        .strict(),
    ),
    verification: verificationAnalysisSchema.optional(),
  })
  .strict();

const digestValueSchema = z.string().regex(/^[0-9a-f]{64,128}$/i, "must be a hexadecimal cryptographic digest");
const contentDigestSchema = z
  .object({
    algorithm: z.string().min(1),
    value: digestValueSchema,
  })
  .strict();

const worktreeIdentitySchema = z
  .object({
    id: logicalIdSchema,
    root: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    gitCommonDir: z.string().min(1).optional(),
    dirty: z.boolean().optional(),
  })
  .strict();

const repositoryIntegritySchema = z
  .object({
    repositoryId: logicalIdSchema,
    git: z
      .object({
        revision: z.string().min(1).optional(),
        tree: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    worktree: worktreeIdentitySchema,
    trackedFiles: z.array(
      z
        .object({
          path: z.string().min(1),
          physicalFingerprint: contentDigestSchema,
          semanticFingerprint: contentDigestSchema.optional(),
          extractorFingerprint: contentDigestSchema.optional(),
        })
        .strict(),
    ),
    extractors: z.array(
      z
        .object({
          id: z.string().min(1),
          version: z.string().min(1),
          optionsFingerprint: contentDigestSchema.optional(),
        })
        .strict(),
    ),
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    semanticStateDigest: contentDigestSchema,
    modelDigest: contentDigestSchema,
    snapshotDigest: contentDigestSchema,
    status: z.enum(["fresh", "stale", "invalid"]),
    statusReason: proseSchema.optional(),
  })
  .strict()
  .superRefine((integrity, context) => {
    if (integrity.status !== "fresh" && integrity.statusReason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["statusReason"],
        message: "stale or invalid integrity requires statusReason",
      });
    }
  });

const repositoryIdentitySchema = z
  .object({
    id: logicalIdSchema,
    canonicalName: z.string().min(1),
    remote: z.string().min(1).optional(),
  })
  .strict();

const revisionIdentitySchema = z
  .object({
    id: logicalIdSchema,
    revision: z.string().min(1),
    tree: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    parentIds: z.array(logicalIdSchema).optional(),
  })
  .strict();

export const repositorySemanticSnapshotSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    modelVersion: z.literal(MODEL_VERSION),
    repositoryIdentity: repositoryIdentitySchema,
    revisionIdentity: revisionIdentitySchema.optional(),
    declarations: declaredStateSchema,
    derived: derivedStateSchema,
    observed: observedStateSchema,
    analysis: analysisSchema,
    integrity: repositoryIntegritySchema,
    graph: z.object({ relations: z.array(semanticRelationSchema) }).strict(),
  })
  .strict();

export const semanticTransactionSchema = z
  .object({
    version: z.literal(SEMANTIC_VOCABULARY_VERSION),
    sequence: z.number().int().positive().optional(),
    intent: z.enum(["semantic-neutral", "semantic-change"]),
    delta: semanticDeltaSchema,
    provenance: provenanceSchema,
    reason: proseSchema.optional(),
    authorizedDeltaKinds: z.array(z.enum(SEMANTIC_DELTA_KINDS)).optional(),
    protectedChanges: z.array(logicalIdSchema).optional(),
    transactionProvenance: z
      .object({
        actor: z.string().min(1).optional(),
        issue: z.string().min(1).optional(),
        task: z.string().min(1).optional(),
        ref: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((transaction, context) => {
    if (transaction.intent !== transaction.delta.intent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delta", "intent"],
        message: "transaction and delta intent must match",
      });
    }
  });

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
  return error.issues.map((issue) =>
    diagnostic(
      "schema_validation_failed",
      issue.message,
      issue.path.length === 0 ? undefined : issue.path.map(String).join("."),
    ),
  );
}

function namespaceForNodeKind(kind: string): string | undefined {
  return (NODE_KINDS as readonly string[]).includes(kind) ? sharedNamespaceForNodeKind(kind) : undefined;
}

type ContainerLayer = "declarations" | "derived" | "observed" | "analysis";

/** Container layer name doubles as its only permitted `authority` value; see AUTHORITY_LAYERS. */
const CONTAINER_EXPECTED_AUTHORITY: Record<ContainerLayer, string> = {
  declarations: "declared",
  derived: "derived",
  observed: "observed",
  analysis: "analysis",
};

function snapshotEntities(
  snapshot: RepositorySemanticSnapshot,
): Array<{ entity: SemanticEntity; layer: ContainerLayer }> {
  return [
    { entity: snapshot.declarations.project, layer: "declarations" as const },
    ...snapshot.declarations.components.map((entity) => ({ entity, layer: "declarations" as const })),
    ...snapshot.declarations.capabilities.map((entity) => ({ entity, layer: "declarations" as const })),
    ...snapshot.declarations.contracts.map((entity) => ({ entity, layer: "declarations" as const })),
    ...snapshot.declarations.invariants.map((entity) => ({ entity, layer: "declarations" as const })),
    ...snapshot.declarations.decisions.map((entity) => ({ entity, layer: "declarations" as const })),
    ...snapshot.declarations.rationales.map((entity) => ({ entity, layer: "declarations" as const })),
    ...snapshot.declarations.constraints.map((entity) => ({ entity, layer: "declarations" as const })),
    ...snapshot.derived.files.map((entity) => ({ entity, layer: "derived" as const })),
    ...snapshot.derived.symbols.map((entity) => ({ entity, layer: "derived" as const })),
    ...snapshot.derived.packages.map((entity) => ({ entity, layer: "derived" as const })),
    ...snapshot.derived.externalDependencies.map((entity) => ({ entity, layer: "derived" as const })),
    ...snapshot.derived.externalApis.map((entity) => ({ entity, layer: "derived" as const })),
    ...snapshot.observed.evidences.map((entity) => ({ entity, layer: "observed" as const })),
    ...snapshot.observed.tests.map((entity) => ({ entity, layer: "observed" as const })),
  ];
}

function validateReferences(snapshot: RepositorySemanticSnapshot): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const entities = snapshotEntities(snapshot);
  const entityById = new Map<LogicalId, SemanticEntity>();
  const validTargets = new Set<LogicalId>([snapshot.repositoryIdentity.id]);
  if (snapshot.revisionIdentity !== undefined) validTargets.add(snapshot.revisionIdentity.id);

  if (logicalIdNamespace(snapshot.repositoryIdentity.id) !== "repo") {
    diagnostics.push(
      diagnostic("invalid_repository_id", "repository identity must use the repo namespace", "repositoryIdentity.id"),
    );
  }
  if (snapshot.revisionIdentity !== undefined && logicalIdNamespace(snapshot.revisionIdentity.id) !== "revision") {
    diagnostics.push(
      diagnostic("invalid_revision_id", "revision identity must use the revision namespace", "revisionIdentity.id"),
    );
  }
  if (snapshot.integrity.repositoryId !== snapshot.repositoryIdentity.id) {
    diagnostics.push(
      diagnostic(
        "integrity_repository_mismatch",
        "integrity repositoryId must match repositoryIdentity.id",
        "integrity.repositoryId",
      ),
    );
  }
  if (snapshot.integrity.schemaVersion !== snapshot.schemaVersion) {
    diagnostics.push(
      diagnostic(
        "integrity_schema_mismatch",
        "integrity schemaVersion must match snapshot schemaVersion",
        "integrity.schemaVersion",
      ),
    );
  }
  if (logicalIdNamespace(snapshot.integrity.worktree.id) !== "worktree") {
    diagnostics.push(
      diagnostic("invalid_worktree_id", "worktree identity must use the worktree namespace", "integrity.worktree.id"),
    );
  }

  const seenEntityIds = new Set<LogicalId>();
  entities.forEach(({ entity, layer }, index) => {
    const path = entity.kind === "project" ? "declarations.project.id" : `entities.${index}.id`;
    if (seenEntityIds.has(entity.id))
      diagnostics.push(diagnostic("duplicate_entity_id", `duplicate entity ID: ${entity.id}`, path));
    seenEntityIds.add(entity.id);
    entityById.set(entity.id, entity);
    validTargets.add(entity.id);
    const expectedNamespace = namespaceForNodeKind(entity.kind);
    if (expectedNamespace !== undefined && logicalIdNamespace(entity.id) !== expectedNamespace) {
      diagnostics.push(
        diagnostic("entity_id_kind_mismatch", `entity ID namespace must match kind ${entity.kind}`, path),
      );
    }
    if (entity.authority !== CONTAINER_EXPECTED_AUTHORITY[layer]) {
      diagnostics.push(
        diagnostic(
          "authority_layer_mismatch",
          `entity in ${layer} must carry authority ${CONTAINER_EXPECTED_AUTHORITY[layer]}, got ${entity.authority}`,
          `${path.replace(/\.id$/, "")}.authority`,
        ),
      );
    }
    if (entity.provenance.kind === "inferred" && entity.authority === "declared") {
      diagnostics.push(
        diagnostic("inferred_claim_not_authoritative", "inferred data cannot carry declared authority", path),
      );
    }
    if (entity.kind === "symbol") {
      try {
        if (createSymbolId(entity.locator) !== entity.id) {
          diagnostics.push(
            diagnostic(
              "symbol_id_locator_mismatch",
              "symbol ID must be derived from its line-independent locator",
              path,
            ),
          );
        }
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "symbol_id_locator_invalid",
            error instanceof Error ? error.message : "symbol locator cannot create a logical ID",
            path,
          ),
        );
      }
    }
  });

  const checkReference = (value: LogicalId, path: string): void => {
    if (!validTargets.has(value))
      diagnostics.push(diagnostic("dangling_reference", `reference does not resolve locally: ${value}`, path));
  };

  const checkReferenceKind = (value: LogicalId, expectedKinds: readonly string[], path: string): void => {
    checkReference(value, path);
    const target = entityById.get(value);
    if (target === undefined) return;
    if (!expectedKinds.includes(target.kind)) {
      diagnostics.push(
        diagnostic(
          "reference_kind_mismatch",
          `reference must target ${expectedKinds.join(" or ")}, got ${target.kind}: ${value}`,
          path,
        ),
      );
    }
  };

  const checkProvenance = (provenance: Provenance, path: string): void => {
    provenance.evidence?.forEach((evidence, index) => {
      if (evidence.target !== undefined) checkReference(evidence.target, `${path}.evidence.${index}.target`);
    });
    provenance.ambiguity?.candidates?.forEach((candidate, index) =>
      checkReference(candidate, `${path}.ambiguity.candidates.${index}`),
    );
  };

  const perspectives = snapshot.declarations.verificationPerspectives ?? [];
  const perspectiveIds = new Set<LogicalId>();
  perspectives.forEach((perspective: VerificationPerspective, index) => {
    const path = `declarations.verificationPerspectives.${index}`;
    if (perspectiveIds.has(perspective.id)) {
      diagnostics.push(
        diagnostic(
          "duplicate_verification_perspective_id",
          `duplicate perspective ID: ${perspective.id}`,
          `${path}.id`,
        ),
      );
    }
    perspectiveIds.add(perspective.id);
    if (perspective.authority !== "declared" || perspective.provenance.kind !== "declared") {
      diagnostics.push(
        diagnostic(
          "verification_authority_mismatch",
          "verification perspectives in declarations must carry declared authority and provenance",
          path,
        ),
      );
    }
    checkProvenance(perspective.provenance, `${path}.provenance`);
  });

  const checkVerificationTarget = (target: VerificationTarget, path: string): void => {
    checkReferenceKind(target.id, [target.kind], `${path}.id`);
  };

  const allRequirements = new Map<LogicalId, VerificationRequirement>();
  const authoritativeRequirementIds = new Set<LogicalId>();
  const checkVerificationRequirement = (
    requirement: VerificationRequirement,
    path: string,
    expectedAuthority: "declared" | "derived" | "analysis",
  ): void => {
    if (allRequirements.has(requirement.id)) {
      diagnostics.push(
        diagnostic(
          "duplicate_verification_requirement_id",
          `duplicate requirement ID: ${requirement.id}`,
          `${path}.id`,
        ),
      );
    }
    allRequirements.set(requirement.id, requirement);
    if (expectedAuthority !== "analysis") authoritativeRequirementIds.add(requirement.id);
    if (requirement.authority !== expectedAuthority) {
      diagnostics.push(
        diagnostic(
          "verification_authority_mismatch",
          `verification requirement in ${expectedAuthority} must carry authority ${expectedAuthority}, got ${requirement.authority}`,
          `${path}.authority`,
        ),
      );
    }
    const expectedProvenance = expectedAuthority === "analysis" ? "inferred" : expectedAuthority;
    if (requirement.provenance.kind !== expectedProvenance) {
      diagnostics.push(
        diagnostic(
          "verification_provenance_mismatch",
          `verification requirement in ${expectedAuthority} must carry provenance ${expectedProvenance}, got ${requirement.provenance.kind}`,
          `${path}.provenance.kind`,
        ),
      );
    }
    if (expectedAuthority === "analysis" && requirement.requirementProvenance.kind !== "inferred") {
      diagnostics.push(
        diagnostic(
          "analysis_requirement_not_inferred",
          "analysis verification requirements must remain explicitly non-authoritative inferred suggestions",
          `${path}.requirementProvenance.kind`,
        ),
      );
    }
    if (requirement.requirementProvenance.kind === "inferred" && expectedAuthority !== "analysis") {
      diagnostics.push(
        diagnostic(
          "inferred_requirement_not_authoritative",
          "inferred verification requirements cannot carry declared or derived authority",
          path,
        ),
      );
    }
    if (requirement.requirementProvenance.kind === "deterministic-derived-rule") {
      if (expectedAuthority !== "derived" || requirement.requirementProvenance.ruleId === undefined) {
        diagnostics.push(
          diagnostic(
            "invalid_deterministic_requirement",
            "deterministic-derived-rule requirements must be derived and carry ruleId",
            `${path}.requirementProvenance`,
          ),
        );
      }
    }
    if (requirement.requirementProvenance.kind === "project-policy") {
      if (requirement.requirementProvenance.sourceId === undefined)
        diagnostics.push(
          diagnostic(
            "missing_requirement_source",
            "project-policy requirements require sourceId",
            `${path}.requirementProvenance`,
          ),
        );
      else
        checkReferenceKind(
          requirement.requirementProvenance.sourceId,
          ["project"],
          `${path}.requirementProvenance.sourceId`,
        );
    }
    if (requirement.requirementProvenance.kind === "component-policy") {
      if (requirement.requirementProvenance.sourceId === undefined)
        diagnostics.push(
          diagnostic(
            "missing_requirement_source",
            "component-policy requirements require sourceId",
            `${path}.requirementProvenance`,
          ),
        );
      else
        checkReferenceKind(
          requirement.requirementProvenance.sourceId,
          ["component"],
          `${path}.requirementProvenance.sourceId`,
        );
    }
    if (requirement.requirementProvenance.kind === "contract") {
      if (requirement.requirementProvenance.sourceId === undefined)
        diagnostics.push(
          diagnostic(
            "missing_requirement_source",
            "contract requirements require sourceId",
            `${path}.requirementProvenance`,
          ),
        );
      else
        checkReferenceKind(
          requirement.requirementProvenance.sourceId,
          ["contract"],
          `${path}.requirementProvenance.sourceId`,
        );
    }
    if (requirement.requirementProvenance.kind === "invariant") {
      if (requirement.requirementProvenance.sourceId === undefined)
        diagnostics.push(
          diagnostic(
            "missing_requirement_source",
            "invariant requirements require sourceId",
            `${path}.requirementProvenance`,
          ),
        );
      else
        checkReferenceKind(
          requirement.requirementProvenance.sourceId,
          ["invariant"],
          `${path}.requirementProvenance.sourceId`,
        );
    }
    if (
      requirement.requirementProvenance.sourceId !== undefined &&
      requirement.requirementProvenance.kind === "explicit-declaration"
    ) {
      checkReference(requirement.requirementProvenance.sourceId, `${path}.requirementProvenance.sourceId`);
    }
    checkVerificationTarget(requirement.target, `${path}.target`);
    if (!perspectiveIds.has(requirement.perspectiveId)) {
      diagnostics.push(
        diagnostic(
          "dangling_verification_perspective",
          `verification requirement perspective does not resolve locally: ${requirement.perspectiveId}`,
          `${path}.perspectiveId`,
        ),
      );
    }
    checkProvenance(requirement.provenance, `${path}.provenance`);
  };

  (snapshot.declarations.verificationRequirements ?? []).forEach((requirement, index) =>
    checkVerificationRequirement(requirement, `declarations.verificationRequirements.${index}`, "declared"),
  );
  (snapshot.derived.verificationRequirements ?? []).forEach((requirement, index) =>
    checkVerificationRequirement(requirement, `derived.verificationRequirements.${index}`, "derived"),
  );

  const verificationEvidence = snapshot.observed.verificationEvidence ?? [];
  const evidenceById = new Map<LogicalId, VerificationEvidence>();
  const seenVerificationEvidenceIds = new Set<LogicalId>();
  verificationEvidence.forEach((evidence: VerificationEvidence, index) => {
    const path = `observed.verificationEvidence.${index}`;
    if (seenVerificationEvidenceIds.has(evidence.id)) {
      diagnostics.push(
        diagnostic(
          "duplicate_verification_evidence_id",
          `duplicate verification evidence ID: ${evidence.id}`,
          `${path}.id`,
        ),
      );
    }
    seenVerificationEvidenceIds.add(evidence.id);
    evidenceById.set(evidence.id, evidence);
    if (evidence.authority !== "observed" || evidence.provenance.kind !== "observed") {
      diagnostics.push(
        diagnostic(
          "verification_authority_mismatch",
          "verification evidence in observed must carry observed authority and provenance",
          path,
        ),
      );
    }
    checkVerificationTarget(evidence.target, `${path}.target`);
    if (evidence.testId !== undefined) checkReferenceKind(evidence.testId, ["test"], `${path}.testId`);
    if (!perspectiveIds.has(evidence.perspectiveId)) {
      diagnostics.push(
        diagnostic(
          "dangling_verification_perspective",
          `verification evidence perspective does not resolve locally: ${evidence.perspectiveId}`,
          `${path}.perspectiveId`,
        ),
      );
    }
    checkProvenance(evidence.provenance, `${path}.provenance`);
  });

  const verification = snapshot.analysis.verification;
  if (verification !== undefined) {
    if (verification.authority !== "analysis") {
      diagnostics.push(
        diagnostic(
          "verification_authority_mismatch",
          "verification analysis must carry analysis authority",
          "analysis.verification.authority",
        ),
      );
    }
    const inferredRequirements = verification.inferredRequirements ?? [];
    inferredRequirements.forEach((requirement, index) =>
      checkVerificationRequirement(requirement, `analysis.verification.inferredRequirements.${index}`, "analysis"),
    );
    const assessmentIds = new Set<string>();
    verification.assessments.forEach((assessment, index) => {
      const path = `analysis.verification.assessments.${index}`;
      if (!authoritativeRequirementIds.has(assessment.requirementId)) {
        diagnostics.push(
          diagnostic(
            "dangling_verification_requirement",
            `verification assessment requirement does not resolve locally: ${assessment.requirementId}`,
            `${path}.requirementId`,
          ),
        );
      }
      const requirement = allRequirements.get(assessment.requirementId);
      if (requirement !== undefined && authoritativeRequirementIds.has(assessment.requirementId)) {
        if (
          requirement.target.kind !== assessment.target.kind ||
          requirement.target.id !== assessment.target.id ||
          requirement.perspectiveId !== assessment.perspectiveId ||
          requirement.strength !== assessment.strength
        ) {
          diagnostics.push(
            diagnostic(
              "verification_assessment_mismatch",
              "verification assessment must retain the requirement target, perspective, and strength",
              path,
            ),
          );
        }
      }
      checkVerificationTarget(assessment.target, `${path}.target`);
      if (!perspectiveIds.has(assessment.perspectiveId)) {
        diagnostics.push(
          diagnostic(
            "dangling_verification_perspective",
            `verification assessment perspective does not resolve locally: ${assessment.perspectiveId}`,
            `${path}.perspectiveId`,
          ),
        );
      }
      assessment.evidenceIds.forEach((id, evidenceIndex) => {
        if (!evidenceById.has(id))
          diagnostics.push(
            diagnostic(
              "dangling_verification_evidence",
              `verification assessment evidence does not resolve locally: ${id}`,
              `${path}.evidenceIds.${evidenceIndex}`,
            ),
          );
      });
      assessment.satisfyingEvidenceIds.forEach((id, evidenceIndex) => {
        if (!evidenceById.has(id))
          diagnostics.push(
            diagnostic(
              "dangling_verification_evidence",
              `verification assessment evidence does not resolve locally: ${id}`,
              `${path}.satisfyingEvidenceIds.${evidenceIndex}`,
            ),
          );
      });
      const assessmentKey = `${assessment.requirementId}:${assessment.target.id}`;
      if (assessmentIds.has(assessmentKey))
        diagnostics.push(
          diagnostic("duplicate_verification_assessment", `duplicate verification assessment: ${assessmentKey}`, path),
        );
      assessmentIds.add(assessmentKey);
    });
    verification.summaries.forEach((summary, index) => {
      const path = `analysis.verification.summaries.${index}`;
      checkReferenceKind(summary.targetId, [summary.scope], `${path}.targetId`);
      summary.gapRequirementIds.forEach((id, gapIndex) => {
        if (!authoritativeRequirementIds.has(id))
          diagnostics.push(
            diagnostic(
              "dangling_verification_requirement",
              `verification summary gap does not resolve locally: ${id}`,
              `${path}.gapRequirementIds.${gapIndex}`,
            ),
          );
      });
    });
  }

  const checkFact = (fact: SemanticFact, path: string): void => {
    checkReference(fact.subject, `${path}.subject`);
    checkProvenance(fact.provenance, `${path}.provenance`);
  };
  const checkClaim = (claim: SemanticClaim, path: string): void => {
    checkReference(claim.subject, `${path}.subject`);
    if (claim.object !== undefined) checkReference(claim.object, `${path}.object`);
    checkProvenance(claim.provenance, `${path}.provenance`);
    if (
      claim.provenance.kind === "inferred" &&
      (claim.authority === "declared" || claim.enforcement === "authoritative")
    ) {
      diagnostics.push(
        diagnostic("inferred_claim_not_authoritative", "inferred claims cannot have enforcement authority", path),
      );
    }
  };

  const seenFactIds = new Set<LogicalId>();
  const checkFacts = (facts: SemanticFact[], pathPrefix: string, layer: ContainerLayer): void => {
    const expectedAuthority = CONTAINER_EXPECTED_AUTHORITY[layer];
    facts.forEach((fact, index) => {
      if (seenFactIds.has(fact.id))
        diagnostics.push(diagnostic("duplicate_fact_id", `duplicate fact ID: ${fact.id}`, `${pathPrefix}.${index}.id`));
      seenFactIds.add(fact.id);
      if (fact.authority !== expectedAuthority) {
        diagnostics.push(
          diagnostic(
            "authority_layer_mismatch",
            `fact in ${layer} must carry authority ${expectedAuthority}, got ${fact.authority}`,
            `${pathPrefix}.${index}.authority`,
          ),
        );
      }
      checkFact(fact, `${pathPrefix}.${index}`);
    });
  };
  checkFacts(snapshot.declarations.facts, "declarations.facts", "declarations");
  checkFacts(snapshot.derived.facts, "derived.facts", "derived");
  checkFacts(snapshot.observed.facts, "observed.facts", "observed");
  checkFacts(snapshot.analysis.facts, "analysis.facts", "analysis");

  const seenClaimIds = new Set<LogicalId>();
  snapshot.analysis.claims.forEach((claim, index) => {
    if (seenClaimIds.has(claim.id))
      diagnostics.push(
        diagnostic("duplicate_claim_id", `duplicate claim ID: ${claim.id}`, `analysis.claims.${index}.id`),
      );
    seenClaimIds.add(claim.id);
    if (claim.authority !== "analysis") {
      diagnostics.push(
        diagnostic(
          "authority_layer_mismatch",
          `claim in analysis must carry authority analysis, got ${claim.authority}`,
          `analysis.claims.${index}.authority`,
        ),
      );
    }
    checkClaim(claim, `analysis.claims.${index}`);
  });

  const seenRelationIds = new Set<LogicalId>();
  snapshot.graph.relations.forEach((relation: SemanticRelation, index) => {
    if (seenRelationIds.has(relation.id))
      diagnostics.push(
        diagnostic("duplicate_relation_id", `duplicate relation ID: ${relation.id}`, `graph.relations.${index}.id`),
      );
    seenRelationIds.add(relation.id);
    checkReference(relation.from, `graph.relations.${index}.from`);
    checkReference(relation.to, `graph.relations.${index}.to`);
    checkProvenance(relation.provenance, `graph.relations.${index}.provenance`);
    if (relation.provenance.kind === "inferred" && relation.authority === "declared") {
      diagnostics.push(
        diagnostic(
          "inferred_claim_not_authoritative",
          "inferred relation cannot carry declared authority",
          `graph.relations.${index}`,
        ),
      );
    }
  });

  const symbols = new Map(snapshot.derived.symbols.map((symbol) => [symbol.id, symbol]));
  const declaredOwnership = new Map<LogicalId, { classification: "managed" | "shared"; componentId?: LogicalId }>();
  snapshot.declarations.symbolOwnership?.forEach((ownership, index) => {
    if (declaredOwnership.has(ownership.symbolId)) {
      diagnostics.push(
        diagnostic(
          "duplicate_symbol_ownership",
          `duplicate declared ownership for Symbol: ${ownership.symbolId}`,
          `declarations.symbolOwnership.${index}.symbolId`,
        ),
      );
    }
    declaredOwnership.set(ownership.symbolId, ownership);
    checkReferenceKind(ownership.symbolId, ["symbol"], `declarations.symbolOwnership.${index}.symbolId`);
    if (ownership.componentId !== undefined) {
      checkReferenceKind(ownership.componentId, ["component"], `declarations.symbolOwnership.${index}.componentId`);
    }
    if (symbols.has(ownership.symbolId) === false) {
      diagnostics.push(
        diagnostic(
          "symbol_ownership_target_missing",
          `declared ownership targets a missing Symbol: ${ownership.symbolId}`,
          `declarations.symbolOwnership.${index}.symbolId`,
        ),
      );
    }
  });
  const classificationFor = (symbol: SymbolEntity): "managed" | "shared" =>
    declaredOwnership.get(symbol.id)?.classification ?? symbol.classification;
  const ownedBy = new Map<LogicalId, LogicalId[]>();
  snapshot.graph.relations.forEach((relation) => {
    if (relation.kind !== "owns" && relation.kind !== "shares") return;
    const from = entityById.get(relation.from);
    const to = entityById.get(relation.to);
    if (from?.kind !== "component" || to?.kind !== "symbol") {
      diagnostics.push(
        diagnostic(
          "invalid_ownership_relation",
          `${relation.kind} must connect Component to Symbol`,
          `graph.relations.${relation.id}`,
        ),
      );
      return;
    }
    const symbol = symbols.get(to.id);
    if (symbol === undefined) return;
    if (relation.kind === "owns") {
      const owners = ownedBy.get(symbol.id) ?? [];
      owners.push(from.id);
      ownedBy.set(symbol.id, owners);
      if (classificationFor(symbol) === "shared")
        diagnostics.push(
          diagnostic(
            "shared_symbol_has_owner",
            "Shared Symbol cannot use owns; use explicit shares relations",
            `graph.relations.${relation.id}`,
          ),
        );
    } else if (classificationFor(symbol) === "managed") {
      diagnostics.push(
        diagnostic("managed_symbol_shared", "managed Symbol cannot use shares", `graph.relations.${relation.id}`),
      );
    }
  });
  symbols.forEach((symbol) => {
    const owners = ownedBy.get(symbol.id) ?? [];
    const declared = declaredOwnership.get(symbol.id);
    const classification = classificationFor(symbol);
    if (classification === "managed" && owners.length !== 1) {
      diagnostics.push(
        diagnostic(
          "invalid_symbol_ownership",
          "managed Symbol must have exactly one Component owner",
          `derived.symbols.${symbol.id}`,
          { ownerCount: owners.length },
        ),
      );
    }
    if (classification === "shared" && owners.length > 0) {
      diagnostics.push(
        diagnostic(
          "shared_symbol_has_owner",
          "Shared Symbol must not have a single owns owner",
          `derived.symbols.${symbol.id}`,
        ),
      );
    }
    if (declared?.componentId !== undefined && owners.length === 1 && owners[0] !== declared.componentId) {
      diagnostics.push(
        diagnostic(
          "declared_symbol_owner_mismatch",
          `declared Symbol owner does not match the owns relation: ${symbol.id}`,
          `declarations.symbolOwnership.${symbol.id}`,
        ),
      );
    }
  });

  const checkEntityIdList = (ids: LogicalId[], path: string): void =>
    ids.forEach((id, index) => checkReference(id, `${path}.${index}`));
  const checkEntityIdListKind = (ids: LogicalId[], expectedKinds: readonly string[], path: string): void =>
    ids.forEach((id, index) => checkReferenceKind(id, expectedKinds, `${path}.${index}`));
  snapshot.declarations.decisions.forEach((decision, index) => {
    checkEntityIdListKind(decision.rationaleIds, ["rationale"], `declarations.decisions.${index}.rationaleIds`);
    checkEntityIdListKind(decision.constraintIds, ["constraint"], `declarations.decisions.${index}.constraintIds`);
  });
  snapshot.declarations.rationales.forEach((rationale, index) =>
    checkEntityIdListKind(rationale.decisionIds, ["decision"], `declarations.rationales.${index}.decisionIds`),
  );
  snapshot.declarations.effectPolicies.forEach((policy, index) => {
    checkReference(policy.subject, `declarations.effectPolicies.${index}.subject`);
    checkEntityIdListKind(policy.rationaleIds, ["rationale"], `declarations.effectPolicies.${index}.rationaleIds`);
  });
  snapshot.declarations.dependencyPolicies.forEach((policy, index) => {
    checkReference(policy.subject, `declarations.dependencyPolicies.${index}.subject`);
    checkEntityIdListKind(
      policy.allowedPackageIds,
      ["package"],
      `declarations.dependencyPolicies.${index}.allowedPackageIds`,
    );
    checkEntityIdListKind(
      policy.deniedPackageIds,
      ["package"],
      `declarations.dependencyPolicies.${index}.deniedPackageIds`,
    );
    checkEntityIdListKind(policy.rationaleIds, ["rationale"], `declarations.dependencyPolicies.${index}.rationaleIds`);
  });
  snapshot.declarations.reviewGuidance.forEach((guidance, index) =>
    checkReference(guidance.subject, `declarations.reviewGuidance.${index}.subject`),
  );
  snapshot.declarations.stability.forEach((item, index) => {
    checkReference(item.subject, `declarations.stability.${index}.subject`);
    if (item.rationaleId !== undefined)
      checkReferenceKind(item.rationaleId, ["rationale"], `declarations.stability.${index}.rationaleId`);
  });
  snapshot.declarations.terminology.forEach((item, index) =>
    checkEntityIdList(item.relatedEntityIds, `declarations.terminology.${index}.relatedEntityIds`),
  );
  snapshot.declarations.decisionLinks.forEach((item, index) => {
    checkReference(item.subject, `declarations.decisionLinks.${index}.subject`);
    checkReferenceKind(item.decisionId, ["decision"], `declarations.decisionLinks.${index}.decisionId`);
  });
  snapshot.derived.externalApis.forEach((api, index) =>
    checkReferenceKind(api.packageId, ["package"], `derived.externalApis.${index}.packageId`),
  );
  snapshot.observed.tests.forEach((test, index) =>
    checkEntityIdListKind(test.evidenceIds, ["evidence"], `observed.tests.${index}.evidenceIds`),
  );
  snapshot.analysis.unknowns.forEach((unknown, index) => {
    if (unknown.subjects !== undefined) checkEntityIdList(unknown.subjects, `analysis.unknowns.${index}.subjects`);
  });
  snapshot.analysis.semanticDelta.entries.forEach((entry, index) =>
    checkReference(entry.subject, `analysis.semanticDelta.entries.${index}.subject`),
  );

  const trackedPaths = new Set<string>();
  snapshot.integrity.trackedFiles.forEach((file, index) => {
    if (trackedPaths.has(file.path))
      diagnostics.push(
        diagnostic(
          "duplicate_tracked_file",
          `duplicate tracked file: ${file.path}`,
          `integrity.trackedFiles.${index}.path`,
        ),
      );
    trackedPaths.add(file.path);
  });

  if (snapshot.integrity.status === "fresh") {
    const recomputed = computeIntegrityDigestsFromValidated(snapshot);
    const digestMismatch = (
      field: "semanticStateDigest" | "modelDigest" | "snapshotDigest",
    ): SemanticDiagnostic | undefined => {
      const stored = snapshot.integrity[field];
      const expected = recomputed[field];
      if (stored.algorithm !== expected.algorithm || stored.value !== expected.value) {
        return diagnostic(
          "integrity_digest_mismatch",
          `integrity.${field} does not match the recomputed digest for a snapshot marked fresh`,
          `integrity.${field}`,
          { algorithm: expected.algorithm, expected: expected.value, received: stored.value },
        );
      }
      return undefined;
    };
    (["semanticStateDigest", "modelDigest", "snapshotDigest"] as const).forEach((field) => {
      const mismatch = digestMismatch(field);
      if (mismatch !== undefined) diagnostics.push(mismatch);
    });
  }

  return diagnostics;
}

export function validateSnapshot(input: unknown): SnapshotValidationResult {
  if (isRecord(input) && typeof input.schemaVersion === "number" && input.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "unsupported_schema_version",
          input.schemaVersion === 1
            ? "the completed #48 semantic schema is incompatible with symbol-first v1; explicit migration is required"
            : `unsupported semantic schema version: ${String(input.schemaVersion)}`,
          "schemaVersion",
          { supported: [CURRENT_SCHEMA_VERSION], received: input.schemaVersion, migrationRequired: true },
        ),
      ],
    };
  }
  if (
    isRecord(input) &&
    input.schemaVersion === CURRENT_SCHEMA_VERSION &&
    input.modelVersion !== undefined &&
    input.modelVersion !== MODEL_VERSION
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "unsupported_model_version",
          `unsupported semantic model version: ${String(input.modelVersion)}`,
          "modelVersion",
          { supported: [MODEL_VERSION] },
        ),
      ],
    };
  }

  const parsed = repositorySemanticSnapshotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, diagnostics: zodDiagnostics(parsed.error) };
  const snapshot = parsed.data as RepositorySemanticSnapshot;
  const diagnostics = validateReferences(snapshot);
  return diagnostics.length === 0 ? { ok: true, snapshot, diagnostics: [] } : { ok: false, diagnostics };
}

export function validateSemanticTransaction(
  input: unknown,
): { ok: true; transaction: SemanticTransaction } | { ok: false; diagnostics: SemanticDiagnostic[] } {
  if (isRecord(input) && typeof input.version === "number" && input.version !== SEMANTIC_VOCABULARY_VERSION) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "unsupported_semantic_vocabulary_version",
          `unsupported semantic vocabulary version: ${String(input.version)}`,
          "version",
          { supported: [SEMANTIC_VOCABULARY_VERSION] },
        ),
      ],
    };
  }
  const parsed = semanticTransactionSchema.safeParse(input);
  return parsed.success
    ? { ok: true, transaction: parsed.data as SemanticTransaction }
    : { ok: false, diagnostics: zodDiagnostics(parsed.error) };
}

export type RepositorySemanticSnapshotSchema = z.infer<typeof repositorySemanticSnapshotSchema>;
export type SemanticTransactionSchema = z.infer<typeof semanticTransactionSchema>;
export type CanonicalProsePolicySchema = z.infer<typeof canonicalProsePolicySchema>;
export type AnalysisSchema = z.infer<typeof analysisSchema>;
export { canonicalProsePolicySchema, semanticEntitySchema, semanticRelationSchema };
