import {
  createClaimId,
  createComponentId,
  createEdgeId,
  createExternalApiId,
  createExternalDependencyId,
  createFactId,
  createPackageId,
  createProjectId,
  createRepositoryId,
  createRevisionId,
  createSymbolId,
  createWorktreeId,
} from "../ir/ids.js";
import type {
  AnalysisState,
  ComponentEntity,
  Contract,
  ContractEntity,
  DeclaredState,
  DerivedState,
  EvidenceEntity,
  InvariantEntity,
  ObservedState,
  PackageEntity,
  ProjectEntity,
  Provenance,
  RepositorySemanticSnapshot,
  SemanticEntity,
  SemanticRelation,
  SymbolEntity,
  TestEntity,
} from "../ir/types.js";

const repositoryId = createRepositoryId("yohn-jp/mottainai");
const revisionId = createRevisionId("fixture-v2");
const sourceRevision = { repositoryId, revisionId };
const projectId = createProjectId("mottainai");
const componentId = createComponentId("semantic-core");
const contractId =
  "contract:canonical-contract" as RepositorySemanticSnapshot["declarations"]["contracts"][number]["id"];
const invariantId =
  "invariant:explicit-ownership" as RepositorySemanticSnapshot["declarations"]["invariants"][number]["id"];
const capabilityId =
  "capability:semantic-analysis" as RepositorySemanticSnapshot["declarations"]["capabilities"][number]["id"];
const decisionId = "decision:source-of-truth" as RepositorySemanticSnapshot["declarations"]["decisions"][number]["id"];
const rationaleId =
  "rationale:avoid-stale-model" as RepositorySemanticSnapshot["declarations"]["rationales"][number]["id"];
const constraintId =
  "constraint:no-guessing" as RepositorySemanticSnapshot["declarations"]["constraints"][number]["id"];
const fileId = "file:src-semantic-ir" as RepositorySemanticSnapshot["derived"]["files"][number]["id"];
const packageId = createPackageId("zod");
const externalDependencyId = createExternalDependencyId("zod");
const externalApiId = createExternalApiId("zod-parse");
const evidenceId = "evidence:semantic-unit" as RepositorySemanticSnapshot["observed"]["evidences"][number]["id"];
const testId = "test:semantic-ir" as RepositorySemanticSnapshot["observed"]["tests"][number]["id"];
const worktreeId = createWorktreeId("fixture");
const digest = {
  algorithm: "sha256",
  value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

function provenance(kind: Provenance["kind"], options: Partial<Provenance> = {}): Provenance {
  return {
    kind,
    producer: { name: "repository-semantics-fixture", version: "2.0.0" },
    sourceRevision,
    ...options,
  };
}

function baseEntity(
  kind: SemanticEntity["kind"],
  id: SemanticEntity["id"],
  name: string,
  authority: SemanticEntity["authority"],
  description: string,
): SemanticEntity {
  return {
    kind,
    id,
    name,
    description,
    authority,
    provenance: provenance(authority === "analysis" ? "derived" : authority === "integrity" ? "observed" : authority),
  } as SemanticEntity;
}

function project(): ProjectEntity {
  return {
    ...baseEntity("project", projectId, "mottainai", "declared", "Repository semantic project fixture"),
    kind: "project",
    canonicalName: "yohn-jp/mottainai",
    responsibility: "Aggregate repository semantics without making storage or transport part of the domain contract.",
    stability: "protected",
    reviewLevel: "L3",
  };
}

function component(id = componentId, name = "Semantic Core"): ComponentEntity {
  return {
    ...baseEntity("component", id, name, "declared", "Symbol ownership and semantic aggregation boundary"),
    kind: "component",
    responsibility: "Own explicitly classified Symbols and aggregate their semantic facts.",
    stability: "stable",
    reviewLevel: "L2",
  };
}

const canonicalContract: Contract = {
  inputs: {
    parameters: [{ name: "value", type: "string", required: true, domain: "finite text" }],
    acceptedDomain: [{ expression: "value is text" }],
    preconditions: [{ expression: "value is available" }],
    dependencies: [{ name: "semantic-analysis" }],
    externalResources: [],
  },
  outputs: {
    returnValue: "normalized semantic value",
    postconditions: [{ expression: "result preserves semantic identity" }],
    errors: [],
    stateTransitions: [],
    externalCalls: [],
    externalEvents: [],
    effects: [],
  },
};

function declarations(components: ComponentEntity[] = [component()]): DeclaredState {
  const capability = {
    ...baseEntity("capability", capabilityId, "semantic-analysis", "declared", "Detailed symbol analysis capability"),
    kind: "capability" as const,
    meaning: "Represent deterministic repository semantic facts and explicit uncertainty.",
    stability: "stable" as const,
    reviewLevel: "L2" as const,
  };
  const contract: ContractEntity = {
    ...baseEntity("contract", contractId, "Canonical semantic contract", "declared", "Contract and evidence boundary"),
    kind: "contract",
    definition: canonicalContract,
    stability: "protected",
    reviewLevel: "L3",
  };
  const invariant: InvariantEntity = {
    ...baseEntity(
      "invariant",
      invariantId,
      "Explicit Component ownership",
      "declared",
      "Ownership must not be guessed",
    ),
    kind: "invariant",
    statement: "Every managed Symbol has exactly one Component owner; Shared classification is explicit.",
    severity: "error",
    stability: "protected",
  };
  return {
    project: project(),
    components,
    capabilities: [capability],
    contracts: [contract],
    invariants: [invariant],
    decisions: [
      {
        ...baseEntity("decision", decisionId, "Source bytes are authority", "declared", "Integrity policy decision"),
        kind: "decision",
        statement: "Content identity and extractor configuration determine semantic freshness.",
        status: "accepted",
        rationaleIds: [rationaleId],
        constraintIds: [constraintId],
      },
    ],
    rationales: [
      {
        ...baseEntity(
          "rationale",
          rationaleId,
          "Avoid stale model authority",
          "declared",
          "Rationale for integrity binding",
        ),
        kind: "rationale",
        statement: "A semantic model must not appear fresh after executable source or extractor configuration changes.",
        decisionIds: [decisionId],
      },
    ],
    constraints: [
      {
        ...baseEntity(
          "constraint",
          constraintId,
          "No guessed ownership",
          "declared",
          "Constraint on Component boundaries",
        ),
        kind: "constraint",
        statement: "Component boundaries and ownership require explicit declarations.",
        scope: "repository semantic model",
        enforcement: "protected",
      },
    ],
    facts: [
      {
        id: createFactId("project-stability"),
        subject: projectId,
        predicate: "semantic.stability",
        value: "protected",
        authority: "declared",
        provenance: provenance("declared"),
      },
    ],
    effectPolicies: [
      {
        id: "policy:semantic-effects" as RepositorySemanticSnapshot["declarations"]["facts"][number]["id"],
        subject: componentId,
        allow: [],
        deny: [],
        rationaleIds: [rationaleId],
      },
    ],
    dependencyPolicies: [
      {
        id: "policy:semantic-dependencies" as RepositorySemanticSnapshot["declarations"]["facts"][number]["id"],
        subject: componentId,
        allowedPackageIds: [packageId],
        deniedPackageIds: [],
        rationaleIds: [rationaleId],
      },
    ],
    reviewGuidance: [
      {
        id: "guidance:semantic-ir" as RepositorySemanticSnapshot["declarations"]["facts"][number]["id"],
        subject: componentId,
        level: "L2",
        guidance: "Review ownership, integrity, and relation direction as semantic contract changes.",
      },
    ],
    stability: [{ subject: componentId, stability: "stable", rationaleId }],
    terminology: [
      {
        term: "Shared Symbol",
        definition: "A Symbol explicitly classified as shared and not assigned through a single owns relation.",
        relatedEntityIds: [componentId, invariantId],
      },
    ],
    decisionLinks: [{ subject: componentId, decisionId, relation: "motivated_by" }],
    commentPolicy: {
      canonicalLanguage: "en",
      canonicalForm: "formal-english",
      humanLocalization: "projection",
      llmTokenCompression: "projection",
      sourceCodeSemantics: "implementation-only",
      semanticCommentKinds: ["rationale", "todo-debt-intent", "review-note", "constraint", "api-meaning"],
      inlineDirectives: ["compiler", "legal", "machine"],
      jsdoc: "projection",
    },
  };
}

function symbol(
  locator: SymbolEntity["locator"],
  classification: SymbolEntity["classification"] = "managed",
  name = locator.symbol,
): SymbolEntity {
  return {
    ...baseEntity("symbol", createSymbolId(locator), name, "derived", "Detailed symbol fact unit"),
    kind: "symbol",
    locator,
    classification,
  };
}

const normalizeLocator: SymbolEntity["locator"] = {
  kind: "symbol",
  language: "typescript",
  package: "mottainai",
  file: "src/semantics/fixtures/pure.ts",
  symbol: "normalizeInput",
  signature: "(value: string): string",
  range: { start: { line: 4, column: 1 }, end: { line: 8, column: 2 } },
};

const readConfigLocator: SymbolEntity["locator"] = {
  kind: "symbol",
  language: "typescript",
  package: "mottainai",
  module: "runtime",
  file: "src/semantics/fixtures/effectful.ts",
  symbol: "readConfig",
};

function derived(symbols: SymbolEntity[] = [symbol(normalizeLocator)]): DerivedState {
  const file: SemanticEntity = {
    ...baseEntity("file", fileId, "src/semantics/fixtures", "derived", "Tracked semantic IR fixture file"),
    kind: "file",
    path: "src/semantics/fixtures",
    language: "typescript",
    tracked: true,
  };
  const packageEntity: PackageEntity = {
    ...baseEntity("package", packageId, "zod", "derived", "Schema validation package"),
    kind: "package",
    packageName: "zod",
    dependencyType: "external",
    version: "3.24.4",
  };
  return {
    files: [file as DerivedState["files"][number]],
    symbols,
    packages: [packageEntity],
    externalDependencies: [
      {
        ...baseEntity(
          "external_dependency",
          externalDependencyId,
          "zod dependency",
          "derived",
          "External package dependency",
        ),
        kind: "external_dependency",
        packageName: "zod",
        version: "3.24.4",
        registry: "npm",
      },
    ],
    externalApis: [
      {
        ...baseEntity("external_api", externalApiId, "zod.parse", "derived", "External package API"),
        kind: "external_api",
        packageId,
        apiName: "parse",
        version: "3.24.4",
      },
    ],
    facts: symbols.map((item) => ({
      id: createFactId(`${item.id}-visibility`),
      subject: item.id,
      predicate: "symbol.visibility",
      value: "public",
      authority: "derived" as const,
      provenance: provenance("derived"),
    })),
  };
}

function observed(): ObservedState {
  const evidence: EvidenceEntity = {
    ...baseEntity(
      "evidence",
      evidenceId,
      "Semantic unit evidence",
      "observed",
      "Execution evidence for the semantic contract",
    ),
    kind: "evidence",
    evidenceKind: "test-run",
    reference: "test-run:semantic-ir-fixture",
    summary: "The semantic fixture contract was validated by a deterministic unit test.",
  };
  const test: TestEntity = {
    ...baseEntity("test", testId, "semantic IR fixture test", "observed", "Observed test execution"),
    kind: "test",
    testName: "semantic IR fixture",
    status: "passed",
    evidenceIds: [evidenceId],
  };
  return {
    evidences: [evidence],
    tests: [test],
    facts: [
      {
        id: createFactId("semantic-test-passed"),
        subject: testId,
        predicate: "test.status",
        value: "passed",
        authority: "observed",
        provenance: provenance("observed", {
          evidence: [{ kind: "test", ref: "test-run:semantic-ir-fixture", target: testId }],
        }),
      },
    ],
  };
}

function analysis(overrides: Partial<AnalysisState> = {}): AnalysisState {
  return {
    health: { status: "healthy", score: 96, staleEvidence: 0, modelGaps: 0 },
    reviewLevel: "L2",
    semanticDelta: { version: 1, intent: "semantic-neutral", entries: [], unauthorized: false },
    facts: [],
    claims: [],
    unknowns: [],
    recommendedSourceReads: [],
    diagnostics: [],
    ...overrides,
  };
}

function relation(
  id: string,
  kind: SemanticRelation["kind"],
  from: SemanticRelation["from"],
  to: SemanticRelation["to"],
  authority: SemanticRelation["authority"],
): SemanticRelation {
  return {
    id: createEdgeId(id),
    kind,
    from,
    to,
    authority,
    provenance: provenance(authority === "analysis" || authority === "integrity" ? "inferred" : authority),
  };
}

function snapshot(
  options: {
    components?: ComponentEntity[];
    symbols?: SymbolEntity[];
    relations?: SemanticRelation[];
    analysis?: Partial<AnalysisState>;
    status?: "fresh" | "stale" | "invalid";
    statusReason?: string;
  } = {},
): RepositorySemanticSnapshot {
  const symbols = options.symbols ?? [symbol(normalizeLocator)];
  const components = options.components ?? [component()];
  const ownershipRelations = symbols
    .filter((item) => item.classification === "managed")
    .map((item) => relation(`owns-${item.id}`, "owns", componentId, item.id, "declared"));
  const relations = options.relations ?? [
    ...ownershipRelations,
    relation("defines-contract", "defines", componentId, contractId, "declared"),
    relation("symbol-uses-package", "uses_package", symbols[0]!.id, packageId, "derived"),
    relation("package-imports-api", "imports_api", packageId, externalApiId, "derived"),
    relation("test-verifies-contract", "verifies", testId, contractId, "observed"),
    relation("evidence-for-contract", "evidence_for", evidenceId, contractId, "observed"),
  ];
  return {
    schemaVersion: 2,
    modelVersion: "symbol-first-v1",
    repositoryIdentity: {
      id: repositoryId,
      canonicalName: "yohn-jp/mottainai",
      remote: "https://github.com/yohn-jp/mottainai",
    },
    revisionIdentity: { id: revisionId, revision: "fixture-v2", tree: "b".repeat(40), kind: "fixture" },
    declarations: declarations(components),
    derived: derived(symbols),
    observed: observed(),
    analysis: analysis(options.analysis),
    integrity: {
      repositoryId,
      git: { revision: "fixture-v2", tree: "b".repeat(40) },
      worktree: { id: worktreeId, root: "/fixture", branch: "fixture", dirty: false },
      trackedFiles: [
        {
          path: "src/semantics/fixtures",
          physicalFingerprint: digest,
          semanticFingerprint: digest,
          extractorFingerprint: digest,
        },
      ],
      extractors: [{ id: "fixture-extractor", version: "2.0.0", optionsFingerprint: digest }],
      schemaVersion: 2,
      semanticStateDigest: digest,
      modelDigest: digest,
      snapshotDigest: digest,
      status: options.status ?? "fresh",
      ...(options.statusReason === undefined ? {} : { statusReason: options.statusReason }),
    },
    graph: { relations },
  };
}

export const pureFunctionFixture = snapshot();
export const effectfulFunctionFixture = snapshot({
  symbols: [symbol(readConfigLocator)],
  relations: [
    relation("owns-read-config", "owns", componentId, createSymbolId(readConfigLocator), "declared"),
    relation("read-config-uses-package", "uses_package", createSymbolId(readConfigLocator), packageId, "derived"),
    relation("package-imports-api-effectful", "imports_api", packageId, externalApiId, "derived"),
    relation("evidence-for-contract-effectful", "evidence_for", evidenceId, contractId, "observed"),
  ],
});

const secondLocator: SymbolEntity["locator"] = {
  kind: "symbol",
  language: "typescript",
  package: "mottainai",
  file: "src/semantics/fixtures/pure.ts",
  symbol: "normalizeOutput",
};
export const logicalComponentFixture = snapshot({ symbols: [symbol(normalizeLocator), symbol(secondLocator)] });
export const invariantFixture = snapshot({
  analysis: {
    health: { status: "protected", score: 88, staleEvidence: 0, modelGaps: 1 },
    reviewLevel: "L3",
  },
});
export const testEvidenceFixture = snapshot();
export const callsAndPackageFixture = snapshot({
  symbols: [symbol(normalizeLocator), symbol(secondLocator)],
  relations: [
    relation("owns-normalize-input", "owns", componentId, createSymbolId(normalizeLocator), "declared"),
    relation("owns-normalize-output", "owns", componentId, createSymbolId(secondLocator), "declared"),
    relation(
      "normalize-calls-output",
      "calls",
      createSymbolId(normalizeLocator),
      createSymbolId(secondLocator),
      "derived",
    ),
    relation("normalize-uses-package", "uses_package", createSymbolId(normalizeLocator), packageId, "derived"),
    relation("package-imports-api", "imports_api", packageId, externalApiId, "derived"),
    relation("evidence-for-contract", "evidence_for", evidenceId, contractId, "observed"),
  ],
});

const sharedLocator: SymbolEntity["locator"] = {
  kind: "symbol",
  language: "typescript",
  package: "mottainai",
  file: "src/semantics/fixtures/shared.ts",
  symbol: "sharedHelper",
};
export const sharedOwnershipFixture = snapshot({
  components: [component(), component(createComponentId("other"), "Other Component")],
  symbols: [symbol(normalizeLocator), symbol(sharedLocator, "shared")],
  relations: [
    relation("owns-normalize-input", "owns", componentId, createSymbolId(normalizeLocator), "declared"),
    relation("shares-shared-helper-core", "shares", componentId, createSymbolId(sharedLocator), "declared"),
    relation(
      "shares-shared-helper-other",
      "shares",
      createComponentId("other"),
      createSymbolId(sharedLocator),
      "declared",
    ),
    relation("evidence-for-contract-shared", "evidence_for", evidenceId, contractId, "observed"),
  ],
});

export const ambiguousDynamicCallFixture = snapshot({
  analysis: {
    health: { status: "partial", score: 64, staleEvidence: 0, modelGaps: 2 },
    reviewLevel: "L2",
    unknowns: [
      {
        code: "dynamic_call_target",
        message: "Runtime dispatch prevents a unique static target",
        subjects: [createSymbolId(normalizeLocator)],
      },
    ],
  },
});

export const inferredClaimFixture = snapshot({
  analysis: {
    claims: [
      {
        id: createClaimId("retries-transient-failure"),
        subject: createSymbolId(normalizeLocator),
        statement: "normalizeInput retries transient failures",
        status: "uncertain",
        authority: "analysis",
        enforcement: "none",
        provenance: provenance("inferred", { confidence: 0.35, completeness: "unknown" }),
      },
    ],
  },
});

export const allSemanticFixtures = {
  pureFunction: pureFunctionFixture,
  effectfulFunction: effectfulFunctionFixture,
  logicalComponent: logicalComponentFixture,
  invariant: invariantFixture,
  testEvidence: testEvidenceFixture,
  callsAndPackage: callsAndPackageFixture,
  sharedOwnership: sharedOwnershipFixture,
  ambiguousDynamicCall: ambiguousDynamicCallFixture,
  inferredClaim: inferredClaimFixture,
} as const;
