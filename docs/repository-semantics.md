# Repository Semantics

## Canonical Repository Semantic IR

Repository Semantic IRは、リポジトリの意味情報を表すstorage-independentな正規モデルです。Semantic Source、extractor、runtime observation、semantic diff、物理インデックスは、このモデルのproducerまたはconsumerであり、独自のnode・edge・contract表現を定義しません。

### Symbol-first v1

`RepositorySemanticSnapshot`は`schemaVersion: 2`と`modelVersion: "symbol-first-v1"`を持ちます。#48のnumeric schema v1とは別世代です。旧shapeを新shapeへ暗黙coercionせず、`unsupported_schema_version`またはschema diagnosticで拒否します。

Snapshotのcanonical stateは次の5層です。

```text
RepositorySemanticSnapshot
  declarations
  derived
  observed
  analysis
  integrity
```

authority layerとprovenanceは別概念です。entity、relation、factは`authority`を持ち、producerと証拠の出所は`provenance`に保持します。`inferred` provenanceは明示的な推論であり、既定のenforcement authorityを持ちません。

### Canonical entities

Domain IRは次のentityを持ちます。

- Project、Component、Symbol
- Capability、Contract、Invariant
- Decision、Rationale、Constraint
- Evidence、Test
- File、Package、ExternalDependency、ExternalApi

UI view、HTTP response、browser state、dashboard固有型はIRに含めません。#83のquery/fixture contractは、このdomain entityとuniversal relation graphのprojectionです。

`Symbol`は詳細分析の第一級単位です。`SymbolLocator`のlanguage、package、module、file、symbol、signatureからlogical IDを生成し、line、source range、content fingerprintはlogical identityに含めません。

`Component`はownership / aggregation boundaryです。`graph.relations`の`owns`はComponentからSymbolへ向き、managed Symbolはexactly one ownerを要求します。Shared Symbolは`classification: "shared"`を明示し、`shares`を使います。Component clustering、directory layoutからの推測、推測ownershipの補完は行いません。

### Universal relation graph

内部Symbol graphとPackage/API dependencyを別subsystemに分けず、`graph.relations`で統一します。既知のrelation vocabularyは次のとおりです。

`contains`、`owns`、`shares`、`defines`、`references`、`calls`、`imports`、`provides`、`requires`、`depends_on`、`implements`、`tests`、`verifies`、`documents`、`governs`、`constrained_by`、`uses_package`、`imports_api`、`evidence_for`

未知のrelation kindは将来拡張のため文字列として保持できます。relation targetはProject、Component、Symbol、Contract、Evidence、Package、ExternalApiなど全domain entityから解決します。

### Declared semantics

`declarations`は明示的なproject authorityです。責務、capability、contract、invariant、rationale、constraint、effect policy、dependency policy、review guidance、stability、terminology、decision link、formal-English comment policyを保持します。

Contractはparametersだけでなくaccepted domain、preconditions、dependencies、external resources、postconditions、errors、state transitions、external calls/events、effectsを分離して表現します。

### Derived / observed / analysis

`derived`はrepository stateから決定論的に再生成可能なFile、Symbol、Package、ExternalDependency、ExternalApi、factを持ちます。`observed`はEvidence、Test、実行・CI・runtime観測factを持ちます。

`analysis`はhealth、review level、semantic delta、claims、unknowns、recommended source reads、diagnosticsを持ちます。semantic-neutral transactionが実際のdeltaを生成した場合、`unauthorized: true`で表現できます。

Transaction vocabularyはversion 1です。

- intent: `semantic-neutral` / `semantic-change`
- delta kind: `responsibility` / `capability` / `contract` / `effect` / `invariant` / `dependency-policy` / `public-surface`
- review level: `L0` implementation-only、`L1` compatible semantic change、`L2` review-required semantic change、`L3` protected/breaking/violation

### Repository integrity

`integrity`はsemantic stateが記述するsource identityを明示します。

- repository identity
- Git revision/tree identity（取得可能な場合）
- worktree identity
- tracked file set
- fileごとのphysical content fingerprint
- fileごとのsemantic/extractor fingerprint（取得可能な場合）
- schema version
- extractor ID/version/options fingerprint
- canonical semantic-state digest
- model digest
- snapshot digest
- `fresh` / `stale` / `invalid`

`mtime`はcorrectness authorityではありません。staleまたはinvalidには理由を必須とし、freshnessはcontent identity、Git identity、worktree、extractor configurationに結び付けます。

### Canonical prose policy

canonical semantic proseはformal Englishです。人間向けlocalizationとLLM token compressionはprojectionであり、canonical authoring stateではありません。fully managed source scopeのsource commentはimplementationに限定し、rationale、TODO/debt intent、review note、constraint、API meaningはsemantic entityへ置きます。inlineにはallowlisted machine/compiler/legal directiveだけ残し、JSDocはprojectionです。

### Validation and serialization

Zod schemaはschema version、model version、entity namespace、local reference、Symbol locator identity、Component ownership、inferred claim authority、integrity metadataを検証します。旧#48 schemaを受理せず、unknown relation kindは許容します。

entity・fact・claimの`authority`はそれが属するcontainer layer（`declarations`→`declared`、`derived`→`derived`、`observed`→`observed`、`analysis`→`analysis`）と一致しなければならず、不一致はfail-closedでrejectします。`decision.rationaleIds`、`decision.constraintIds`、`rationale.decisionIds`、`test.evidenceIds`、`externalApi.packageId`、dependency policyのpackage IDsのようなtyped referenceは、参照先が存在するだけでなく期待するentity kindであることも検証します。`integrity.status`が`fresh`の場合、`semanticStateDigest` / `modelDigest` / `snapshotDigest`をsnapshotから再計算し、格納値と一致しなければrejectします（snapshot内で検証可能な範囲のfreshness保証であり、filesystem/Gitとの整合性はこの検証の対象外です）。

`serializeSnapshot` / `parseSnapshot`はdeterministic JSONとparse → serialize → parse round-tripを提供します。配列順に意味がないstate collectionとrelation graphはlogical ID、relation tuple、pathなどで正規化します。`computeSemanticStateDigest`、`computeModelDigest`、`computeSnapshotDigest`はcanonical inputへSHA-256を適用します。

### Declared mutation boundary

Declared semantics have one supported programmatic write boundary: `createSemanticMutationService`. Dashboard, CLI, and MCP adapters submit typed mutations to `plan`, inspect binding requirements, affected entities, protected changes, blockers, and expected writes, then call `apply` for the validated transaction. The service changes only `declarations` and declared graph relations; derived, observed, and analysis facts remain extractor/tool-owned.

Canonical source files live under `.mottainai/semantics/`. Declaration entities and declared relations are stored in deterministic per-entity files, while versioned transaction events are stored as content-addressed files under `.mottainai/semantics/transactions/`; repository, derived, observed, and analysis state is read through the source adapter. A mutation patch therefore does not require a central declaration registry edit. `persistSemanticMutation` accepts only a successful service result whose writes remain canonical and inside the declared/relation/transaction boundary. Symbol bindings report `resolved`, `missing`, `ambiguous`, or `stale`; no binding or Component ownership is guessed. Canonical prose is formal English, and semantic-change transactions carry a reason, authorized delta kinds, protected changes, and structured issue/task/ref provenance.

### Staged enforcement and managed adoption

`src/semantics/enforcement/` is the single bounded enforcement coordinator. It consumes the existing source serializer/store, live model compiler/query, #51 effect analysis, #54 Semantic Change Set, and #87 verification plan; it does not classify effects, recompute impact/review levels, or write declarations itself. The only declaration write path remains `createSemanticMutationService` → `persistSemanticMutation`.

The rollout mode is explicit and monotonic: `off`, `observe`, `warn`, or `enforce`. `off` preserves the report for diagnostics but allows the caller; `observe` records blockers without failing; `warn` exposes the same bounded blockers as a warning; `enforce` returns a blocking decision for any unresolved blocker. The report contains exact blocker codes and bounded navigation data rather than raw model JSON. Stale or invalid snapshots are never marked authoritative for agent context or review.

Managed scope is opt-in by explicit source path or Symbol ID. A managed Symbol must have one declared Component owner or an explicit Shared declaration and matching declared relation; no clustering or directory inference is used. Fully managed paths use comment-zero validation: human semantic comments, hand-authored JSDoc, and TODO/FIXME/TBD debt comments fail the scope, while only narrow compiler/lint/coverage, generated, and legal directives are allowlisted. `semantic migrate` is proposal-only; structured debt must be applied and reviewed through an explicit transaction before a source comment is removed.

Canonical declaration metadata retains the integrity digest anchor. A valid semantic JSON edit therefore fails closed even when hooks are bypassed; recovery requires the supported mutation or explicit migration path. CI invokes `semantic:validate` in observe mode, and the managed dogfood proof runs enforce mode over a narrow explicit Symbol slice.

このfoundationでは、effect propagation、cache、live model compiler、Semantic Diff、dashboard redesign、permanent database、automatic Component clustering、LLM authority inferenceを実装しません。
