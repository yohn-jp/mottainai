# Repository Semantics

## Canonical Repository Semantic IR

Repository Semantic IR is the storage-independent canonical model for
repository meaning. Semantic Source, extractors, runtime observations,
semantic diffs, and physical indexes are producers or consumers of this model;
they do not define their own node, edge, or contract representations.

### Symbol-first v1

`RepositorySemanticSnapshot` has `schemaVersion: 2` and
`modelVersion: "symbol-first-v1"`. It is a different generation from the
numeric schema v1 of Issue #48. Old shapes are not implicitly coerced into the
new shape; they are rejected with `unsupported_schema_version` or a schema
diagnostic.

The canonical snapshot state has five layers:

```text
RepositorySemanticSnapshot
  declarations
  derived
  observed
  analysis
  integrity
```

Authority layer and provenance are separate concepts. Entities, relations, and
facts carry `authority`; producer and evidence origin are kept in `provenance`.
`inferred` provenance is explicit inference and does not have enforcement
authority by default.

### Canonical entities

The domain IR contains these entities:

- Project, Component, and Symbol;
- Capability, Contract, and Invariant;
- Decision, Rationale, and Constraint;
- Evidence and Test; and
- File, Package, ExternalDependency, and ExternalApi.

UI views, HTTP responses, browser state, and dashboard-specific types are not
part of the IR. The query/fixture contract of Issue #83 is a projection of
these domain entities and the universal relation graph.

`Symbol` is the first-class unit of detailed analysis. Its logical ID is
derived from the `language`, `package`, `module`, `file`, `symbol`, and
`signature` of `SymbolLocator`; line, source range, and content fingerprint are
not part of logical identity.

`Component` is an ownership and aggregation boundary. The `owns` relation in
`graph.relations` points from a Component to a Symbol, and a managed Symbol
requires exactly one owner. A Shared Symbol declares
`classification: "shared"` and uses `shares`. The model does not infer
component clusters from directory layout or fill in guessed ownership.

### Universal relation graph

The internal Symbol graph and Package/API dependencies are unified in
`graph.relations` rather than split into separate subsystems. The known
relation vocabulary is:

`contains`, `owns`, `shares`, `defines`, `references`, `calls`, `imports`,
`provides`, `requires`, `depends_on`, `implements`, `tests`, `verifies`,
`documents`, `governs`, `constrained_by`, `uses_package`, `imports_api`, and
`evidence_for`.

Unknown relation kinds may be retained as strings for future extension.
Relation targets resolve against all domain entities, including Project,
Component, Symbol, Contract, Evidence, Package, and ExternalApi.

### Declared semantics

`declarations` is explicit project authority. It stores responsibility,
capability, contract, invariant, rationale, constraint, effect policy,
dependency policy, review guidance, stability, terminology, decision links,
and formal-English comment policy.

Contracts represent more than parameters: accepted domain, preconditions,
dependencies, external resources, postconditions, errors, state transitions,
external calls/events, and effects are separate fields.

### Derived, observed, and analysis

`derived` contains File, Symbol, Package, ExternalDependency, ExternalApi, and
fact values that can be deterministically regenerated from repository state.
`observed` contains Evidence, Test, and execution, CI, and runtime observation
facts.

`analysis` contains health, review level, semantic delta, claims, unknowns,
recommended source reads, and diagnostics. If a semantic-neutral transaction
produces an actual delta, it is represented as `unauthorized: true`.

Transaction vocabulary is version 1:

- intent: `semantic-neutral` or `semantic-change`;
- delta kind: `responsibility`, `capability`, `contract`, `effect`, `invariant`,
  `dependency-policy`, or `public-surface`; and
- review level: `L0` implementation-only, `L1` compatible semantic change,
  `L2` review-required semantic change, or `L3` protected/breaking/violation.

### Repository integrity

`integrity` makes the source identity described by semantic state explicit:

- repository identity;
- Git revision/tree identity, when available;
- worktree identity;
- tracked file set;
- physical content fingerprint per file;
- semantic/extractor fingerprint per file, when available;
- schema version;
- extractor ID/version/options fingerprint;
- canonical semantic-state digest;
- model digest;
- snapshot digest; and
- `fresh`, `stale`, or `invalid` status.

`mtime` is not a correctness authority. Stale or invalid state requires a
reason, and freshness is tied to content identity, Git identity, worktree, and
extractor configuration.

### Canonical prose policy

Canonical semantic prose is formal English. Human-facing localization and LLM
token compression are projections, not canonical authoring state. In a fully
managed source scope, source comments are limited to implementation details;
rationale, TODO/debt intent, review notes, constraints, and API meaning belong
in semantic entities. Inline comments may retain only allowlisted
machine/compiler/legal directives, and JSDoc is a projection.

### Validation and serialization

The Zod schema validates schema and model versions, entity namespaces, local
references, Symbol locator identity, Component ownership, inferred-claim
authority, and integrity metadata. It rejects the old Issue #48 schema and
allows unknown relation kinds.

The `authority` of an entity, fact, or claim must match its container layer
(`declarations` → `declared`, `derived` → `derived`, `observed` → `observed`,
`analysis` → `analysis`); a mismatch is rejected fail-closed. Typed references
such as `decision.rationaleIds`, `decision.constraintIds`,
`rationale.decisionIds`, `test.evidenceIds`, `externalApi.packageId`, and
dependency-policy package IDs must point not only to an existing entity but to
the expected entity kind. When `integrity.status` is `fresh`,
`semanticStateDigest`, `modelDigest`, and `snapshotDigest` are recomputed from
the snapshot and must match the stored values. This guarantees freshness only
within the snapshot's verifiable range; filesystem and Git consistency are
outside this validation.

`serializeSnapshot` and `parseSnapshot` provide deterministic JSON and a
parse → serialize → parse round trip. Collections and relation graphs whose
array order has no meaning are normalized by logical ID, relation tuple, path,
or another canonical key. `computeSemanticStateDigest`, `computeModelDigest`,
and `computeSnapshotDigest` apply SHA-256 to canonical input.

### Declared mutation boundary

`createSemanticMutationService` is the only supported programmatic write
boundary for declared semantics. Dashboard, CLI, and MCP adapters submit typed
mutations to `plan`, inspect binding requirements, affected entities, protected
changes, blockers, and expected writes, and then call `apply` for the validated
transaction. The service changes only `declarations` and declared graph
relations; extractors and tools own derived, observed, and analysis facts.

Canonical source files live under `.mottainai/semantics/`. Declaration entities
and declared relations are stored in deterministic per-entity files, while
versioned transaction events are content-addressed files under
`.mottainai/semantics/transactions/`. Repository, derived, observed, and
analysis state is read through the source adapter, so a mutation patch does not
require editing a central declaration registry. `persistSemanticMutation`
accepts only a successful service result whose writes remain canonical and
inside the declared/relation/transaction boundary. Symbol bindings report
`resolved`, `missing`, `ambiguous`, or `stale`; no binding or Component
ownership is guessed. Canonical prose is formal English, and semantic-change
transactions carry a reason, authorized delta kinds, protected changes, and
structured issue/task/ref provenance.

### Staged enforcement and managed adoption

`src/semantics/enforcement/` is the single bounded enforcement coordinator. It
consumes the existing source serializer/store, live model compiler/query, #51
effect analysis, #54 Semantic Change Set, and #87 verification plan. It does
not classify effects, recompute impact or review levels, or write declarations
itself. The only declaration write path remains
`createSemanticMutationService` → `persistSemanticMutation`.

Rollout mode is explicit and monotonic: `off`, `observe`, `warn`, or `enforce`.
`off` preserves the report for diagnostics but allows the caller; `observe`
records blockers without failing; `warn` exposes the same bounded blockers as a
warning; `enforce` returns a blocking decision for every unresolved blocker.
The report contains exact blocker codes and bounded navigation data rather than
raw model JSON. Stale or invalid snapshots are never authoritative for agent
context or review.

Managed scope is opt-in by explicit source path or Symbol ID. A managed Symbol
must have one declared Component owner or an explicit Shared declaration and
matching declared relation; no clustering or directory inference is used.
Fully managed paths use comment-zero validation: human semantic comments,
hand-authored JSDoc, and TODO/FIXME/TBD debt comments fail the scope, while
only narrow compiler/lint/coverage, generated, and legal directives are
allowlisted. `semantic migrate` is proposal-only; structured debt must be
applied and reviewed through an explicit transaction before a source comment is
removed.

Canonical declaration metadata retains the integrity digest anchor. A valid
semantic JSON edit therefore fails closed even when hooks are bypassed;
recovery requires the supported mutation or explicit migration path. CI invokes
`semantic:validate` in observe mode, and the managed dogfood proof runs enforce
mode over a narrow explicit Symbol slice.

This foundation does not implement effect propagation, caching, a live model
compiler, Semantic Diff, dashboard redesign, a permanent database, automatic
Component clustering, or LLM authority inference.
