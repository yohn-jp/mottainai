import {
  boundedLimit,
  FIXTURE_PROVIDER_VERSION,
  QUERY_API_VERSION,
  SemanticQueryError,
  type AgentProjection,
  type AuthorityLayer,
  type ChangeQuery,
  type ComponentQuery,
  type ComponentView,
  type DependencyQuery,
  type DependencyView,
  type EntityId,
  type EntityKind,
  type EntitySummary,
  type EntityView,
  type FactView,
  type GraphQuery,
  type GraphView,
  type HistoryEntry,
  type JsonValue,
  type KnowledgeEntry,
  type KnowledgeQuery,
  type KnowledgeView,
  type Provenance,
  type RelationKind,
  type RepositorySemanticQuery,
  type SemanticChangeEntry,
  type SemanticChangeSetView,
  type SemanticEntity,
  type SemanticRelation,
  type SourceReference,
  type ProjectView,
} from "./query.js";

const ENTITY_KINDS: readonly EntityKind[] = [
  "project",
  "component",
  "symbol",
  "capability",
  "contract",
  "invariant",
  "evidence",
  "test",
  "decision",
  "file",
  "package",
  "external-api",
];

interface FixtureModel {
  entities: readonly SemanticEntity[];
  relations: readonly SemanticRelation[];
  historyByEntity: Readonly<Record<EntityId, readonly HistoryEntry[]>>;
  changeSet: SemanticChangeSetView;
  knowledge: readonly KnowledgeEntry[];
  revision: ProjectView["revision"];
  health: ProjectView["health"];
}

function provenance(authority: AuthorityLayer, note: string): Provenance {
  return {
    authority,
    status: "fixture",
    provider: FIXTURE_PROVIDER_VERSION,
    note,
  };
}

function entity(
  id: EntityId,
  kind: EntityKind,
  name: string,
  summary: string,
  status: SemanticEntity["status"],
  authority: AuthorityLayer,
  facts: Readonly<Record<string, JsonValue>> = {},
  componentId?: EntityId,
  tags: readonly string[] = [],
): SemanticEntity {
  return {
    id,
    kind,
    name,
    summary,
    status,
    authority,
    provenance: provenance(authority, "authored deterministic fixture; not live repository analysis"),
    ...(componentId === undefined ? {} : { componentId }),
    tags,
    facts,
  };
}

function relation(
  id: string,
  kind: RelationKind,
  from: EntityId,
  to: EntityId,
  authority: AuthorityLayer,
): SemanticRelation {
  return {
    id,
    kind,
    from,
    to,
    authority,
    provenance: provenance(authority, "fixture relation; extraction deferred to later semantic issues"),
  };
}

function change(
  id: string,
  entityId: EntityId,
  kind: SemanticChangeEntry["kind"],
  summary: string,
  reviewLevel: SemanticChangeEntry["reviewLevel"],
): SemanticChangeEntry {
  return {
    id,
    entityId,
    kind,
    summary,
    reviewLevel,
    authority: "analysis",
    provenance: provenance("analysis", "fixture change set; real semantic delta belongs to Issue #54"),
  };
}

function createFixtureModel(): FixtureModel {
  return {
  revision: {
    base: "main@e8fea09",
    head: "feat/83-semantic-project-viewer",
    worktree: "fixture snapshot",
  },
  health: {
    status: "review-required",
    score: 82,
    staleEvidence: 4,
    modelGaps: 3,
    reviewRequired: 2,
  },
  entities: [
    entity(
      "project:mottainai",
      "project",
      "mottainai",
      "MCP gateway with a semantic-first local project view",
      "review-required",
      "declared",
      {
        responsibility: "Aggregate the repository model and expose bounded projections.",
        stability: "protected",
        revision: "main@e8fea09",
      },
      undefined,
      ["fixture", "semantic-first"],
    ),
    entity(
      "component:context-runtime",
      "component",
      "Context Runtime",
      "Bounded, policy-compliant context delivery",
      "healthy",
      "declared",
      {
        responsibility: "Deliver bounded context while preserving useful evidence.",
        ownedSymbolIds: ["symbol:project-result", "symbol:finalize-result"],
        capabilityIds: ["capability:context-bounded"],
        contractIds: ["contract:hard-response-budget"],
        invariantIds: ["invariant:preserve-evidence"],
        fileIds: ["file:src-context", "file:src-envelope"],
        evidenceIds: ["evidence:context-suite"],
        packageIds: [],
        metrics: { symbols: 2, files: 2, tests: 8, reviewLevel: "L1" },
        recommendedReads: [
          { path: "src/envelope.ts", symbol: "output", startLine: 30, endLine: 50, reason: "response envelope boundary" },
        ],
      },
      "component:context-runtime",
      ["managed", "bounded"],
    ),
    entity(
      "component:read-authorization",
      "component",
      "Read Authorization",
      "Authorize source disclosure against repository policy",
      "review-required",
      "declared",
      {
        responsibility: "Authorize source disclosure against repository policy.",
        ownedSymbolIds: ["symbol:decide-read", "symbol:inspect-read-file"],
        capabilityIds: ["capability:read-authorization"],
        contractIds: ["contract:read-authorization-pure"],
        invariantIds: ["invariant:no-unbounded-source"],
        fileIds: ["file:src-read-governor"],
        evidenceIds: ["evidence:read-black-box"],
        packageIds: [],
        metrics: { symbols: 2, files: 1, tests: 14, effects: "filesystem.read", reviewLevel: "L3" },
        recommendedReads: [
          { path: "src/read-governor/decide.ts", symbol: "decideRead", startLine: 1, endLine: 80, reason: "contract-relevant decision" },
          { path: "src/read-governor/inspect.ts", symbol: "inspectReadFile", startLine: 1, endLine: 60, reason: "effect origin" },
        ],
      },
      "component:read-authorization",
      ["protected", "review"],
    ),
    entity(
      "component:workflow-runtime",
      "component",
      "Workflow Runtime",
      "Task, worktree and repository guardrails",
      "healthy",
      "declared",
      {
        responsibility: "Coordinate issue-bound worktrees and lifecycle policy.",
        ownedSymbolIds: ["symbol:guard-write"],
        capabilityIds: ["capability:workflow-lifecycle"],
        contractIds: ["contract:isolated-worktree"],
        invariantIds: ["invariant:no-main-edits"],
        fileIds: ["file:src-workflow"],
        evidenceIds: ["evidence:workflow-tests"],
        packageIds: [],
        metrics: { symbols: 1, files: 1, tests: 11, reviewLevel: "L1" },
        recommendedReads: [
          { path: "src/workflow/domain/task.ts", symbol: "startTask", reason: "worktree lifecycle boundary" },
        ],
      },
      "component:workflow-runtime",
      ["managed", "guardrails"],
    ),
    entity(
      "component:semantic-core",
      "component",
      "Semantic Core",
      "Compile and query the repository semantic model",
      "partial",
      "declared",
      {
        responsibility: "Define semantic facts and projections without owning transport.",
        ownedSymbolIds: ["symbol:compile-model"],
        capabilityIds: ["capability:semantic-query"],
        contractIds: ["contract:query-read-only"],
        invariantIds: ["invariant:explicit-component-ownership"],
        fileIds: ["file:src-semantic-ir", "file:src-dashboard-query"],
        evidenceIds: ["evidence:fixture-contract"],
        packageIds: ["package:zod", "package:tree-sitter"],
        metrics: { symbols: 1, files: 2, tests: 12, reviewLevel: "L2" },
        recommendedReads: [
          { path: "src/dashboard/query.ts", symbol: "RepositorySemanticQuery", reason: "replaceable provider contract" },
        ],
      },
      "component:semantic-core",
      ["partial", "query-api"],
    ),
    entity(
      "symbol:project-result",
      "symbol",
      "projectResult()",
      "Project raw tool output into bounded model-visible data",
      "healthy",
      "derived",
      {
        symbolKind: "function",
        visibility: "public",
        path: "src/envelope.ts",
        range: "30-50",
        effects: "none",
        recommendedReads: [{ path: "src/envelope.ts", symbol: "output", reason: "projection boundary" }],
      },
      "component:context-runtime",
      ["function", "derived"],
    ),
    entity(
      "symbol:finalize-result",
      "symbol",
      "finalizeResult()",
      "Finalize a bounded response while retaining retrieval evidence",
      "healthy",
      "derived",
      {
        symbolKind: "function",
        visibility: "internal",
        path: "src/envelope.ts",
        range: "52-75",
        effects: "none",
        recommendedReads: [{ path: "src/envelope.ts", symbol: "output", reason: "envelope construction" }],
      },
      "component:context-runtime",
      ["function", "derived"],
    ),
    entity(
      "symbol:decide-read",
      "symbol",
      "decideRead()",
      "Pure authorization decision for source reads",
      "review-required",
      "derived",
      {
        symbolKind: "function",
        visibility: "public",
        path: "src/read-governor/decide.ts",
        range: "1-80",
        effects: "none",
        recommendedReads: [{ path: "src/read-governor/decide.ts", symbol: "decideRead", reason: "contract decision" }],
      },
      "component:read-authorization",
      ["function", "contract"],
    ),
    entity(
      "symbol:inspect-read-file",
      "symbol",
      "inspectReadFile()",
      "Read an approved source range as an escalation",
      "review-required",
      "derived",
      {
        symbolKind: "function",
        visibility: "internal",
        path: "src/read-governor/inspect.ts",
        range: "1-60",
        effects: "filesystem.read",
        recommendedReads: [{ path: "src/read-governor/inspect.ts", symbol: "inspectReadFile", reason: "filesystem.read origin" }],
      },
      "component:read-authorization",
      ["function", "effect"],
    ),
    entity(
      "symbol:guard-write",
      "symbol",
      "guardWrite()",
      "Prevent writes that bypass the repository workflow boundary",
      "healthy",
      "derived",
      {
        symbolKind: "function",
        visibility: "public",
        path: "src/workflow/domain/task.ts",
        range: "90-135",
        effects: "git.write",
        recommendedReads: [{ path: "src/workflow/domain/task.ts", symbol: "startTask", reason: "write guard" }],
      },
      "component:workflow-runtime",
      ["function", "guardrail"],
    ),
    entity(
      "symbol:compile-model",
      "symbol",
      "compileModel()",
      "Compile canonical declarations and derived facts into a model",
      "partial",
      "analysis",
      {
        symbolKind: "function",
        visibility: "internal",
        path: "src/dashboard/fixture.ts",
        range: "fixture",
        effects: "none",
        recommendedReads: [{ path: "src/dashboard/fixture.ts", symbol: "createFixtureQuery", reason: "fixture provider boundary" }],
      },
      "component:semantic-core",
      ["function", "fixture"],
    ),
    entity(
      "capability:context-bounded",
      "capability",
      "context.bounded",
      "Bounded context delivery with evidence retention",
      "healthy",
      "declared",
      { stability: "protected", providedBy: "component:context-runtime" },
      "component:context-runtime",
      ["capability"],
    ),
    entity(
      "capability:read-authorization",
      "capability",
      "read.authorization",
      "Source-read authorization capability",
      "review-required",
      "declared",
      { stability: "protected", providedBy: "component:read-authorization" },
      "component:read-authorization",
      ["capability", "protected"],
    ),
    entity(
      "capability:workflow-lifecycle",
      "capability",
      "workflow.lifecycle",
      "Issue-bound task and worktree lifecycle",
      "healthy",
      "declared",
      { stability: "stable", providedBy: "component:workflow-runtime" },
      "component:workflow-runtime",
      ["capability"],
    ),
    entity(
      "capability:semantic-query",
      "capability",
      "semantic.query",
      "Read-only project, graph and projection queries",
      "partial",
      "declared",
      { stability: "experimental", providedBy: "component:semantic-core" },
      "component:semantic-core",
      ["capability", "fixture"],
    ),
    entity(
      "contract:hard-response-budget",
      "contract",
      "Hard Response Budget",
      "Bound the model-visible response while retaining an artifact path",
      "protected",
      "declared",
      { expectedEffects: "none", governedEntity: "component:context-runtime" },
      "component:context-runtime",
      ["contract", "protected"],
    ),
    entity(
      "contract:read-authorization-pure",
      "contract",
      "Read Authorization Purity",
      "Authorization decision remains pure; source access is a separate escalation",
      "protected",
      "declared",
      { expectedEffects: "none", actualFixtureEffects: "filesystem.read", governedEntity: "component:read-authorization" },
      "component:read-authorization",
      ["contract", "violation"],
    ),
    entity(
      "contract:isolated-worktree",
      "contract",
      "Issue-bound Worktree",
      "Task changes occur on an isolated branch and worktree",
      "protected",
      "declared",
      { expectedEffects: "git.write", governedEntity: "component:workflow-runtime" },
      "component:workflow-runtime",
      ["contract", "protected"],
    ),
    entity(
      "contract:query-read-only",
      "contract",
      "Semantic Query Read-only",
      "Viewer queries never mutate the repository model",
      "protected",
      "declared",
      { expectedEffects: "none", governedEntity: "component:semantic-core" },
      "component:semantic-core",
      ["contract", "read-only"],
    ),
    entity(
      "invariant:preserve-evidence",
      "invariant",
      "Preserve retrieval evidence",
      "Compression may reduce presentation, not the recoverable raw result",
      "healthy",
      "declared",
      { severity: "error" },
      "component:context-runtime",
      ["invariant"],
    ),
    entity(
      "invariant:no-unbounded-source",
      "invariant",
      "No unbounded source disclosure",
      "Source reads require an explicit bounded escalation",
      "protected",
      "declared",
      { severity: "error" },
      "component:read-authorization",
      ["invariant", "protected"],
    ),
    entity(
      "invariant:no-main-edits",
      "invariant",
      "No direct main edits",
      "Issue work is isolated before source changes begin",
      "protected",
      "declared",
      { severity: "error" },
      "component:workflow-runtime",
      ["invariant", "protected"],
    ),
    entity(
      "invariant:explicit-component-ownership",
      "invariant",
      "Explicit Component ownership",
      "Managed Symbols have one declared Component owner unless explicitly shared",
      "partial",
      "declared",
      { severity: "warning", autoClustering: false },
      "component:semantic-core",
      ["invariant", "ownership"],
    ),
    entity(
      "evidence:context-suite",
      "evidence",
      "Context test suite",
      "Observed bounded projection behavior",
      "healthy",
      "observed",
      { assertions: 8, freshness: "current" },
      "component:context-runtime",
      ["evidence", "observed"],
    ),
    entity(
      "evidence:read-black-box",
      "evidence",
      "Read black-box suite",
      "Process-boundary authorization evidence",
      "stale",
      "observed",
      { assertions: 14, freshness: "stale after effect fixture" },
      "component:read-authorization",
      ["evidence", "stale"],
    ),
    entity(
      "evidence:workflow-tests",
      "evidence",
      "Workflow integration suite",
      "Worktree and lifecycle contract evidence",
      "healthy",
      "observed",
      { assertions: 11, freshness: "current" },
      "component:workflow-runtime",
      ["evidence", "observed"],
    ),
    entity(
      "evidence:fixture-contract",
      "evidence",
      "Fixture Query contract tests",
      "Deterministic provider and read-only query evidence",
      "healthy",
      "observed",
      { assertions: 12, freshness: "current" },
      "component:semantic-core",
      ["evidence", "fixture"],
    ),
    entity(
      "test:dashboard-query",
      "test",
      "dashboard query tests",
      "Unit coverage for fixture determinism and query methods",
      "healthy",
      "observed",
      { path: "src/dashboard.test.ts", status: "passing" },
      "component:semantic-core",
      ["test", "observed"],
    ),
    entity(
      "file:src-context",
      "file",
      "src/context.ts",
      "Context runtime implementation location",
      "healthy",
      "derived",
      { path: "src/context.ts", language: "typescript" },
      "component:context-runtime",
      ["file", "implementation"],
    ),
    entity(
      "file:src-envelope",
      "file",
      "src/envelope.ts",
      "Response envelope implementation location",
      "healthy",
      "derived",
      { path: "src/envelope.ts", language: "typescript" },
      "component:context-runtime",
      ["file", "implementation"],
    ),
    entity(
      "file:src-read-governor",
      "file",
      "src/read-governor/",
      "Read authorization implementation location",
      "review-required",
      "derived",
      { path: "src/read-governor/", language: "typescript" },
      "component:read-authorization",
      ["file", "implementation"],
    ),
    entity(
      "file:src-workflow",
      "file",
      "src/workflow/",
      "Workflow implementation location",
      "healthy",
      "derived",
      { path: "src/workflow/", language: "typescript" },
      "component:workflow-runtime",
      ["file", "implementation"],
    ),
    entity(
      "file:src-semantic-ir",
      "file",
      "src/semantics/ir/",
      "Storage-independent semantic IR location",
      "partial",
      "derived",
      { path: "src/semantics/ir/", language: "typescript" },
      "component:semantic-core",
      ["file", "implementation"],
    ),
    entity(
      "file:src-dashboard-query",
      "file",
      "src/dashboard/query.ts",
      "Transport-independent Query API location",
      "partial",
      "derived",
      { path: "src/dashboard/query.ts", language: "typescript" },
      "component:semantic-core",
      ["file", "implementation"],
    ),
    entity(
      "package:mcp-sdk",
      "package",
      "@modelcontextprotocol/sdk",
      "Runtime MCP protocol dependency",
      "healthy",
      "derived",
      { version: "^1.11.0", dependencyType: "runtime", componentCount: 3 },
      undefined,
      ["package", "runtime"],
    ),
    entity(
      "package:tree-sitter",
      "package",
      "tree-sitter",
      "Syntax-analysis runtime dependency",
      "review-required",
      "derived",
      { version: "^0.22.4", dependencyType: "runtime", componentCount: 2 },
      undefined,
      ["package", "runtime"],
    ),
    entity(
      "package:zod",
      "package",
      "zod",
      "Runtime schema-validation dependency",
      "healthy",
      "derived",
      { version: "^3.24.4", dependencyType: "runtime", componentCount: 4 },
      undefined,
      ["package", "runtime"],
    ),
    entity(
      "external-api:mcp-server",
      "external-api",
      "Server",
      "MCP SDK server API used by the gateway",
      "healthy",
      "derived",
      { packageId: "package:mcp-sdk", api: "Server" },
      undefined,
      ["external", "api"],
    ),
    entity(
      "decision:working-set",
      "decision",
      "Optimize working-set efficiency",
      "Use bounded retrieval and evidence rather than maximizing compression ratio",
      "healthy",
      "declared",
      { status: "accepted", linked: "component:context-runtime" },
      "component:context-runtime",
      ["decision", "accepted"],
    ),
    entity(
      "decision:source-escape-hatch",
      "decision",
      "Source is an escape hatch",
      "Agent projections prefer semantic facts and recommend bounded source reads only when needed",
      "partial",
      "declared",
      { status: "draft", linked: "component:read-authorization" },
      "component:read-authorization",
      ["decision", "draft"],
    ),
  ],
  relations: [
    relation("r-project-context", "contains", "project:mottainai", "component:context-runtime", "declared"),
    relation("r-project-read", "contains", "project:mottainai", "component:read-authorization", "declared"),
    relation("r-project-workflow", "contains", "project:mottainai", "component:workflow-runtime", "declared"),
    relation("r-project-semantic", "contains", "project:mottainai", "component:semantic-core", "declared"),
    relation("r-context-project-result", "owns", "component:context-runtime", "symbol:project-result", "declared"),
    relation("r-context-finalize-result", "owns", "component:context-runtime", "symbol:finalize-result", "declared"),
    relation("r-read-decide", "owns", "component:read-authorization", "symbol:decide-read", "declared"),
    relation("r-read-inspect", "owns", "component:read-authorization", "symbol:inspect-read-file", "declared"),
    relation("r-workflow-guard", "owns", "component:workflow-runtime", "symbol:guard-write", "declared"),
    relation("r-semantic-compile", "owns", "component:semantic-core", "symbol:compile-model", "declared"),
    relation("r-context-cap", "provides", "component:context-runtime", "capability:context-bounded", "declared"),
    relation("r-read-cap", "provides", "component:read-authorization", "capability:read-authorization", "declared"),
    relation("r-workflow-cap", "provides", "component:workflow-runtime", "capability:workflow-lifecycle", "declared"),
    relation("r-semantic-cap", "provides", "component:semantic-core", "capability:semantic-query", "declared"),
    relation("r-context-contract", "governs", "contract:hard-response-budget", "component:context-runtime", "declared"),
    relation("r-read-contract", "governs", "contract:read-authorization-pure", "component:read-authorization", "declared"),
    relation("r-workflow-contract", "governs", "contract:isolated-worktree", "component:workflow-runtime", "declared"),
    relation("r-query-contract", "governs", "contract:query-read-only", "component:semantic-core", "declared"),
    relation("r-read-workflow", "depends-on", "component:read-authorization", "component:workflow-runtime", "derived"),
    relation("r-semantic-context", "depends-on", "component:semantic-core", "component:context-runtime", "derived"),
    relation("r-project-calls", "calls", "symbol:project-result", "symbol:finalize-result", "derived"),
    relation("r-decide-inspect", "calls", "symbol:decide-read", "symbol:inspect-read-file", "derived"),
    relation("r-guard-workflow", "references", "symbol:guard-write", "component:workflow-runtime", "derived"),
    relation("r-context-file", "imports", "symbol:project-result", "file:src-envelope", "derived"),
    relation("r-read-file", "imports", "symbol:decide-read", "file:src-read-governor", "derived"),
    relation("r-workflow-file", "imports", "symbol:guard-write", "file:src-workflow", "derived"),
    relation("r-semantic-file", "imports", "symbol:compile-model", "file:src-dashboard-query", "derived"),
    relation("r-semantic-zod", "uses-package", "component:semantic-core", "package:zod", "derived"),
    relation("r-semantic-tree", "uses-package", "component:semantic-core", "package:tree-sitter", "derived"),
    relation("r-runtime-sdk", "uses-package", "component:context-runtime", "package:mcp-sdk", "derived"),
    relation("r-sdk-api", "imports-api", "package:mcp-sdk", "external-api:mcp-server", "derived"),
    relation("r-context-evidence", "evidence-for", "evidence:context-suite", "symbol:project-result", "observed"),
    relation("r-read-evidence", "evidence-for", "evidence:read-black-box", "contract:read-authorization-pure", "observed"),
    relation("r-workflow-evidence", "evidence-for", "evidence:workflow-tests", "contract:isolated-worktree", "observed"),
    relation("r-query-evidence", "evidence-for", "evidence:fixture-contract", "contract:query-read-only", "observed"),
    relation("r-dashboard-test", "tests", "test:dashboard-query", "symbol:compile-model", "observed"),
  ],
  historyByEntity: {
    "component:context-runtime": [
      { id: "history-context-72", label: "#72", summary: "Progressive source disclosure introduced bounded context delivery", authority: "observed", provenance: provenance("observed", "fixture history") },
    ],
    "component:read-authorization": [
      { id: "history-read-current", label: "Current branch", summary: "Filesystem read effect is present in the fixture delta", authority: "analysis", provenance: provenance("analysis", "fixture history") },
      { id: "history-read-adr", label: "ADR", summary: "Working-set efficiency governs source disclosure strategy", authority: "declared", provenance: provenance("declared", "fixture history") },
    ],
    "component:workflow-runtime": [
      { id: "history-workflow-71", label: "#71", summary: "Issue-bound lifecycle and audit history established", authority: "observed", provenance: provenance("observed", "fixture history") },
    ],
    "component:semantic-core": [
      { id: "history-semantic-83", label: "#83", summary: "Fixture-backed Query API is the replaceable provider seam", authority: "declared", provenance: provenance("declared", "fixture history") },
    ],
  },
  changeSet: {
    apiVersion: QUERY_API_VERSION,
    baseRevision: "main@e8fea09",
    headRevision: "feat/83-semantic-project-viewer",
    filesChanged: 11,
    symbolsChanged: 14,
    componentsChanged: 2,
    contractsTouched: 1,
    staleEvidence: 4,
    recommendedReads: [
      { path: "src/read-governor/decide.ts", symbol: "decideRead", reason: "changed contract-relevant symbol" },
      { path: "src/read-governor/inspect.ts", symbol: "inspectReadFile", reason: "filesystem.read effect origin" },
    ],
    entries: [
      change("change-read-effect", "component:read-authorization", "effect", "actual effects changed from none to filesystem.read", "L3"),
      change("change-read-contract", "contract:read-authorization-pure", "contract", "protected purity contract is violated by the fixture effect", "L3"),
      change("change-context-symbols", "component:context-runtime", "public-surface", "three implementation symbols changed without public semantic change", "L0"),
      change("change-semantic-query", "component:semantic-core", "capability", "read-only semantic.query capability is introduced", "L1"),
      change("change-ownership", "invariant:explicit-component-ownership", "responsibility", "Component ownership is explicit, not auto-clustered", "L2"),
      change("change-ownership-invariant", "invariant:explicit-component-ownership", "invariant", "auto-clustering remains disabled by the ownership invariant", "L2"),
      change("change-package-policy", "component:semantic-core", "dependency-policy", "package usage remains an explicit graph relation", "L1"),
    ],
    impactPaths: [
      { entityIds: ["component:read-authorization", "component:workflow-runtime", "project:mottainai"], stopReason: "propagation stops at the protected response boundary" },
      { entityIds: ["component:semantic-core", "component:context-runtime"], stopReason: "fixture graph records dependency; real impact calculation is deferred" },
    ],
    provenance: provenance("analysis", "authored fixture; semantic delta calculation belongs to Issue #54"),
  },
  knowledge: [
    {
      id: "decision:working-set",
      kind: "decision",
      title: "Optimize working-set efficiency",
      summary: "Retrieval evidence matters more than compression ratio alone.",
      status: "accepted",
      linkedEntityIds: ["component:context-runtime"],
      authority: "declared",
      provenance: provenance("declared", "fixture knowledge entry"),
    },
    {
      id: "decision:source-escape-hatch",
      kind: "decision",
      title: "Source is an escape hatch",
      summary: "Agent projection prefers semantic facts and bounded source escalation.",
      status: "draft",
      linkedEntityIds: ["component:read-authorization"],
      authority: "declared",
      provenance: provenance("declared", "fixture knowledge entry"),
    },
    {
      id: "policy:no-canonical-edits",
      kind: "policy",
      title: "No direct semantic YAML edits",
      summary: "Future mutations must use a semantic API boundary.",
      status: "protected",
      linkedEntityIds: ["contract:query-read-only", "component:semantic-core"],
      authority: "declared",
      provenance: provenance("declared", "fixture knowledge entry"),
    },
    {
      id: "policy:explicit-ownership",
      kind: "policy",
      title: "Component ownership is explicit",
      summary: "Shared symbols require explicit classification; no auto-clustering.",
      status: "accepted",
      linkedEntityIds: ["invariant:explicit-component-ownership"],
      authority: "declared",
      provenance: provenance("declared", "fixture knowledge entry"),
    },
    {
      id: "experiment:fixture-query",
      kind: "experiment",
      title: "Fixture Query vertical slice",
      summary: "A single provider can drive every viewer surface through one read-only contract.",
      status: "observed",
      linkedEntityIds: ["component:semantic-core", "contract:query-read-only"],
      authority: "observed",
      provenance: provenance("observed", "fixture knowledge entry"),
    },
    {
      id: "evidence:raw-source",
      kind: "evidence",
      title: "Raw source read behavior",
      summary: "Source remains a lower-level escalation and is absent from agent projections.",
      status: "stale",
      linkedEntityIds: ["invariant:no-unbounded-source"],
      authority: "observed",
      provenance: provenance("observed", "fixture knowledge entry"),
    },
  ],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sourceReferences(value: JsonValue | undefined): SourceReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.reason !== "string") return [];
    return [
      {
        path: item.path,
        ...(typeof item.symbol === "string" ? { symbol: item.symbol } : {}),
        ...(typeof item.startLine === "number" ? { startLine: item.startLine } : {}),
        ...(typeof item.endLine === "number" ? { endLine: item.endLine } : {}),
        reason: item.reason,
      },
    ];
  });
}

function summary(entity: SemanticEntity): EntitySummary {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    summary: entity.summary,
    status: entity.status,
    authority: entity.authority,
    provenance: clone(entity.provenance),
    ...(entity.componentId === undefined ? {} : { componentId: entity.componentId }),
    tags: [...entity.tags],
  };
}

function factViews(entity: SemanticEntity): FactView[] {
  return Object.entries(entity.facts).map(([name, value]) => ({
    name,
    value: clone(value),
    authority: entity.authority,
    provenance: clone(entity.provenance),
  }));
}

function emptyCounts(): Record<EntityKind, number> {
  return Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, 0])) as Record<EntityKind, number>;
}

function countEntities(entities: readonly SemanticEntity[]): Record<EntityKind, number> {
  const counts = emptyCounts();
  for (const item of entities) counts[item.kind] += 1;
  return counts;
}

function componentView(entity: SemanticEntity): ComponentView {
  const facts = entity.facts;
  const metrics = isRecord(facts.metrics) ? facts.metrics : {};
  return {
    ...summary(entity),
    responsibility: typeof facts.responsibility === "string" ? facts.responsibility : entity.summary,
    ownedSymbolIds: stringArray(facts.ownedSymbolIds),
    capabilityIds: stringArray(facts.capabilityIds),
    contractIds: stringArray(facts.contractIds),
    invariantIds: stringArray(facts.invariantIds),
    fileIds: stringArray(facts.fileIds),
    evidenceIds: stringArray(facts.evidenceIds),
    packageIds: stringArray(facts.packageIds),
    metrics: clone(metrics),
  };
}

function entityMap(entities: readonly SemanticEntity[]): Map<EntityId, SemanticEntity> {
  return new Map(entities.map((item) => [item.id, item]));
}

export class DeterministicFixtureQuery implements RepositorySemanticQuery {
  private readonly model: FixtureModel;
  private readonly entitiesById: Map<EntityId, SemanticEntity>;

  constructor(model?: FixtureModel) {
    const resolvedModel = model ?? createFixtureModel();
    this.model = resolvedModel;
    this.entitiesById = entityMap(resolvedModel.entities);
  }

  getProject(): ProjectView {
    const project = this.requireEntity("project:mottainai");
    return clone({
      apiVersion: QUERY_API_VERSION,
      project: summary(project),
      revision: this.model.revision,
      health: this.model.health,
      counts: countEntities(this.model.entities),
      componentIds: this.model.entities.filter((item) => item.kind === "component").map((item) => item.id),
      entityIds: this.model.entities.map((item) => item.id),
      provenance: provenance("integrity", "fixture revision and health are explicit product data, not live status"),
    });
  }

  getGraph(query: GraphQuery = {}): GraphView {
    const limit = boundedLimit(query.limit, 80);
    const relationKinds = query.relationKinds === undefined ? undefined : new Set(query.relationKinds);
    let nodes = [...this.model.entities];
    if (query.entityId !== undefined) {
      this.requireEntity(query.entityId);
      const relatedIds = new Set(
        this.model.relations
          .filter((item) => item.from === query.entityId || item.to === query.entityId)
          .flatMap((item) => [item.from, item.to]),
      );
      nodes = nodes.filter((item) => relatedIds.has(item.id));
    } else if (query.componentId !== undefined) {
      this.requireEntity(query.componentId);
      const relatedIds = new Set(
        this.model.relations
          .filter((item) => item.from === query.componentId || item.to === query.componentId)
          .flatMap((item) => [item.from, item.to]),
      );
      nodes = nodes.filter((item) => relatedIds.has(item.id));
    }
    const truncated = nodes.length > limit;
    nodes = nodes.slice(0, limit);
    const nodeIds = new Set(nodes.map((item) => item.id));
    const relations = this.model.relations.filter(
      (item) =>
        nodeIds.has(item.from) &&
        nodeIds.has(item.to) &&
        (relationKinds === undefined || relationKinds.has(item.kind)),
    );
    return clone({
      apiVersion: QUERY_API_VERSION,
      query,
      nodes: nodes.map(summary),
      relations,
      truncated,
      provenance: provenance("derived", "fixture graph uses one universal relation collection"),
    });
  }

  getEntity(id: EntityId): EntityView | undefined {
    const entity = this.entitiesById.get(id);
    if (entity === undefined) return undefined;
    const relations = this.model.relations.filter((item) => item.from === id || item.to === id);
    const history = this.model.historyByEntity[id] ?? [];
    const agentProjection = this.agentProjection(entity, relations);
    return clone({
      ...summary(entity),
      facts: factViews(entity),
      relations,
      history,
      agentProjection,
    });
  }

  listComponents(query: ComponentQuery = {}): ComponentView[] {
    const limit = boundedLimit(query.limit, 50);
    const search = query.search?.trim().toLowerCase();
    const components = this.model.entities
      .filter((item) => item.kind === "component")
      .filter((item) => query.status === undefined || item.status === query.status)
      .filter((item) => {
        if (search === undefined || search.length === 0) return true;
        return `${item.name} ${item.summary} ${String(item.facts.responsibility ?? "")}`.toLowerCase().includes(search);
      })
      .map(componentView);
    return clone(components.slice(0, limit));
  }

  getDependencies(query: DependencyQuery = {}): DependencyView {
    const limit = boundedLimit(query.limit, 50);
    const dependencyKinds = new Set<RelationKind>(["depends-on", "uses-package", "imports-api"]);
    const items = this.model.relations
      .filter((item) => dependencyKinds.has(item.kind))
      .filter((item) => query.componentId === undefined || item.from === query.componentId)
      .map((item) => {
        const from = this.entitiesById.get(item.from);
        const to = this.entitiesById.get(item.to);
        return from === undefined || to === undefined ? undefined : { from: summary(from), to: summary(to), relation: item };
      })
      .filter((item): item is { from: EntitySummary; to: EntitySummary; relation: SemanticRelation } => item !== undefined)
      .slice(0, limit);
    const packageUsage = this.model.entities
      .filter((item) => item.kind === "package")
      .map((pkg) => {
        const packageRelations = this.model.relations.filter((item) => item.to === pkg.id || item.from === pkg.id);
        return {
          package: summary(pkg),
          componentIds: packageRelations
            .map((item) => (item.from.startsWith("component:") ? item.from : undefined))
            .filter((item): item is EntityId => item !== undefined),
          importedApiIds: packageRelations
            .map((item) => (item.kind === "imports-api" ? item.to : undefined))
            .filter((item): item is EntityId => item !== undefined),
        };
      });
    return clone({
      apiVersion: QUERY_API_VERSION,
      items,
      packageUsage,
      provenance: provenance("derived", "fixture dependency surface is a graph projection"),
    });
  }

  getChangeSet(query: ChangeQuery = {}): SemanticChangeSetView {
    const entries = query.reviewLevel === undefined
      ? this.model.changeSet.entries
      : this.model.changeSet.entries.filter((item) => item.reviewLevel === query.reviewLevel);
    return clone({ ...this.model.changeSet, entries });
  }

  getKnowledge(query: KnowledgeQuery = {}): KnowledgeView {
    const entries = this.model.knowledge.filter(
      (item) => (query.kind === undefined || item.kind === query.kind) && (query.status === undefined || item.status === query.status),
    );
    const counts: Record<KnowledgeEntry["kind"], number> = { decision: 0, policy: 0, experiment: 0, evidence: 0 };
    for (const entry of entries) counts[entry.kind] += 1;
    return clone({
      apiVersion: QUERY_API_VERSION,
      entries,
      counts,
      provenance: provenance("declared", "fixture knowledge is explicit product data"),
    });
  }

  getAgentProjection(id: EntityId): AgentProjection {
    const entity = this.requireEntity(id);
    const relations = this.model.relations.filter((item) => item.from === id || item.to === id);
    return clone(this.agentProjection(entity, relations));
  }

  private requireEntity(id: EntityId): SemanticEntity {
    const entity = this.entitiesById.get(id);
    if (entity === undefined) throw new SemanticQueryError("not_found", `unknown semantic entity: ${id}`);
    return entity;
  }

  private agentProjection(entity: SemanticEntity, relations: readonly SemanticRelation[]): AgentProjection {
    return {
      entityId: entity.id,
      status: entity.provenance.status,
      summary: entity.summary,
      facts: factViews(entity),
      relations,
      recommendedReads: sourceReferences(entity.facts.recommendedReads),
      source: {
        available: false,
        reason: "source is an escalation; this fixture projection contains metadata and ranges only",
      },
    };
  }
}

export function createFixtureQuery(): RepositorySemanticQuery {
  return new DeterministicFixtureQuery();
}

export function createDeterministicFixtureQuery(): DeterministicFixtureQuery {
  return new DeterministicFixtureQuery();
}
