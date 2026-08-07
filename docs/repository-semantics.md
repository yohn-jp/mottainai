# Repository Semantics

## Foundation: canonical Repository Semantic IR

Repository Semantic IRは、リポジトリの意味情報を表すstorage-independentな正規モデルです。Semantic Source、extractor、runtime observation、semantic diff、物理インデックスは、このモデルのproducerまたはconsumerであり、独自のnode・edge・contract表現を定義しません。

### Snapshot

`RepositorySemanticSnapshot`は次を持ちます。

- `schemaVersion`: serialized schemaの明示的なバージョン
- `repositoryIdentity`: リポジトリの論理identity
- `revisionIdentity`: 入力revisionのidentity
- `analysis`: `complete` / `partial` / `unknown` と未解決事項
- `nodes`: repository、package、module、file、symbol、component、contract、invariant、decision、policy、test、document、document_section
- `edges`: v1のrelationship語彙と、将来の未知kind
- `facts` / `claims`: provenance付きの意味情報
- `diagnostics`: 構造・参照・解析状態の診断

配列順は意味を持ちません。`serializeSnapshot`はstable logical IDとedge tupleでcollectionを正規化し、object keyを決定論的に並べます。

### Identityとlocator

論理IDは`namespace:local-id`形式のstable stringです。`component:config-loader`や`invariant:startup-side-effect-free`のように意味entityの継続的なidentityを表します。content hash、line number、source rangeはlogical IDに含めません。

`SymbolLocator`はlanguage、package、module、file、symbol、signatureを表します。line/source rangeは物理位置の補助情報だけです。同じsymbolが行移動した場合、locatorのrangeが変わってもlogical symbol IDは変わりません。

### Provenanceと不確実性

facts、claims、edges、nodesはproducer/versionとsource revisionを持つprovenanceを保持します。provenance kindは次の4値です。

- `declared`: 明示的なプロジェクト authority
- `derived`: 決定論的な静的導出
- `observed`: test、runtime、toolの観測
- `inferred`: heuristicやLLMによる推論。明示的な推論として扱い、既定のenforcement authorityにはしない

必要な情報にはevidence、confidence、completeness、ambiguityを追加できます。動的callの候補が一意でない場合も、edgeを捨てず、`inferred` provenanceと`ambiguity`で不確実性を表します。

### Contractとeffects

ContractのINはlanguage signatureだけではありません。

- `inputs.parameters`
- `inputs.acceptedDomain`
- `inputs.preconditions`
- `inputs.dependencies`
- `inputs.externalResources`

OUTは次を表します。

- `outputs.returnValue`
- `outputs.postconditions`
- `outputs.errors`
- `outputs.stateTransitions`
- `outputs.externalCalls` / `outputs.externalEvents`
- `outputs.effects`

effectは`filesystem.read`、`filesystem.write`、`network`、`process.exec`などのnamespaced stringです。closed enumではないため、後続producerは`vendor.cache.refresh`のような語彙を追加できます。

### Schema validationとserialization

v1 schemaはZodで検証します。`validateSnapshot`はschema違反、malformed ID、local dangling reference、confidence範囲違反をstructured diagnosticとして返します。`parseSnapshot`はunsupported future schema versionを受理せず、`unsupported_schema_version` diagnosticを返します。

`serializeSnapshot`と`parseSnapshot`はJSON round-tripを提供します。serializationはfilesystem、SQLite、Kuzu、DuckDB、その他のstorage backendに依存しません。

このfoundationでは、TypeScript AST extractor、Semantic Source YAML loader、database schema、CLI、MCP、Semantic Diff、JSDoc生成を実装しません。
