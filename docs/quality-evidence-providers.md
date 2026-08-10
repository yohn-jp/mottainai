# External quality analyzers as evidence providers

Issue #141 research record. This document is a bounded evaluation of the
current-main baseline, not an analyzer rollout plan or a new architecture
authority.

## Scope and baseline

- Baseline: bounded tool runs were captured against `origin/main` at
  `6dff23b10b5db068801ba476f08e39ec32c05c1e` (2026-08-09). This record was
  rebased onto `origin/main` at `6b3844e43f75ddaafed5f45b9ad505f1dc120186`
  (2026-08-10); the intervening commits are Actions SHA-pinning, a
  Dependabot/release CI exclusion filter, workflow CLI/context-runtime
  features, and a dashboard error-message fix. None change `src/` policy
  surface, the CI job topology, or a referenced authority doc in a way that
  invalidates the bounded observations below, so the tool findings are
  unchanged.
- Environment for the bounded runs: Linux WSL2, Node `v22.22.1`, pnpm
  `11.18.0`. Candidate tools were executed from temporary package/tool
  environments; they were not added to `package.json` or `pnpm-lock.yaml`.
- The raw reports were written outside the repository and summarized below.
  They are not an agent-facing output contract.
- Configuration-sensitive inputs are versioned as research fixtures: the
  dependency-cruiser config and Semgrep rules under
  [`docs/quality-evidence-providers/fixtures/v1`](quality-evidence-providers/fixtures/v1).
  These files are evidence inputs only; they are not loaded by CI and do not
  define Repository Semantics, governance, or another policy authority.
- This PR changes no workflow and adds no candidate analyzer to a required
  CI context.

Bounded invocation record (temporary configs/reports only):

| Candidate          | Invocation shape                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Knip               | `knip@6.32.0 --production --reporter json`                                                                                                 |
| dependency-cruiser | `dependency-cruiser@18.1.1` + TypeScript `5.9.3`, fixture-v1 `no-circular` config, JSON output over `src/`                                 |
| Semgrep            | `semgrep@1.172.0 scan --config <fixture-v1> --json --metrics=off`, two fixture-v1 rules, `--include '*.ts' --exclude '*.d.ts' src scripts` |
| zizmor             | `zizmor@1.29.0 --format=json --offline --no-progress .github/workflows`                                                                    |
| OSV-Scanner        | `osv-scanner@2.5.0 scan source -L pnpm-lock.yaml --format json`                                                                            |
| type-coverage      | `type-coverage@2.30.1` against current main's TypeScript `5.9.3`                                                                           |

The timing convention for every row and cost table below is process wall-clock
from the analyzer invocation to the captured machine-readable report, rounded
to one decimal place; temporary-environment setup and wrapper/report
collection are excluded. A `~` value is rounded, not a second measurement.
Consequently, zizmor is `0.1 s` in both places. A future wrapper measurement
may report its own value only when it labels the wrapper and collection
overhead separately.

### Reproducible input manifest

The two configuration-sensitive runs use the following immutable fixture bytes.
The hash is over the file's exact UTF-8 bytes, including its final newline.
The command is an argv-equivalent invocation from the repository root; no
shell glob or ambient configuration is part of the run. Replaying a result
requires the listed source revision, tool/runtime versions, fixture digest,
target paths, output format, and include/exclude arguments. A normalized report
digest should additionally sort findings by path, line, column, rule id, and
message before hashing, so timestamps or object order cannot change identity.

| Analyzer           | Versioned input                                                                                                                    | SHA-256                                                            | Complete invocation inputs                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dependency-cruiser | [`dependency-cruiser.no-circular.json`](quality-evidence-providers/fixtures/v1/dependency-cruiser.no-circular.json) (`fixture-v1`) | `e53af1f3476d0cdd2aebce6e13f44f8556735fe181155ce70d7c42e3b69c26b5` | cwd `repo root`; `pnpm dlx dependency-cruiser@18.1.1 --config docs/quality-evidence-providers/fixtures/v1/dependency-cruiser.no-circular.json --output-type json src`; resolver `tsconfig.json`; source revision and Node/pnpm versions above |
| Semgrep            | [`semgrep.custom-rules.yml`](quality-evidence-providers/fixtures/v1/semgrep.custom-rules.yml) (`fixture-v1`)                       | `f9e4aabb9ce137496fa58149f9655c190c19ed7ab5435e0e5d3b24ab64e41d41` | cwd `repo root`; `semgrep@1.172.0 scan --config docs/quality-evidence-providers/fixtures/v1/semgrep.custom-rules.yml --json --metrics=off --include '*.ts' --exclude '*.d.ts' src scripts`; source revision and Node/pnpm versions above      |

Changing either fixture requires a new fixture version and a new digest; it is
not a silent modification of the historical evidence. The fixture digest is
also an identity input below, so a changed rule/config cannot overwrite facts
from the previous run. The historical report remains outside the repository;
the manifest makes a bounded repeat run auditable without routing raw output to
an agent.

The current repository already has distinct, repository-owned authorities:

| Concern                                     | Current authority and evidence                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type/build/test correctness                 | `package.json` scripts; `tsconfig.json`; CI typecheck, fast, integration, build/e2e/package, and coverage jobs                                                                |
| Architecture and dependency direction       | `scripts/architecture-check.mjs`, `docs/coding-standards.md`, and the TypeScript-resolved architecture checks                                                                 |
| Governance and PR/Issue contract            | `scripts/governance-lib.mjs`, `scripts/governance-rules.json`, and `docs/governance.md`                                                                                       |
| Security/code scanning                      | CodeQL `javascript-typescript` + `actions` with `security-extended`; see [`docs/codeql.md`](codeql.md)                                                                        |
| Repository meaning and dependency relations | Repository Semantic IR and its `imports`, `depends_on`, `uses_package`, and `imports_api` relations; see [`docs/repository-semantics.md`](repository-semantics.md)            |
| Bounded evidence retention and projection   | `ArtifactStore`, `result_id`, Context Runtime projection/budget, and read-evidence state; see [`docs/read-governor.md`](read-governor.md) and [`docs/testing.md`](testing.md) |
| Agent/client operation policy               | Managed Hooks dispatcher and operation-specific fail-open/fail-closed policy; see [`docs/managed-hooks.md`](managed-hooks.md)                                                 |
| Mutation/effectiveness                      | The repository-owned property/mutation runner and baseline, scheduled or manually dispatched by `.github/workflows/test-effectiveness.yml`                                    |
| LLM review                                  | Bounded PR-Agent preflight and disabled-until-bounded OpenCodeReview path; see [`docs/llm-review.md`](llm-review.md)                                                          |

Post-#142 CI is intentionally parallel: independent typecheck, fast,
standards, integration, artifact, compatibility, and coverage roles remain
visible. The merged #142 evidence reports a required critical path of
223--228 seconds in representative runs, with fast correctness feedback
available independently in 21--23 seconds. An external provider must not
collapse these roles into one opaque command or silently become a new required
gate. See [PR #142](https://github.com/yohn-jp/mottainai/pull/142).

## Adoption decisions

The three decision classes mean:

- **adopt now**: justify a small follow-up that starts with a non-required,
  report-only or advisory run. It does not authorize rollout in this PR.
- **integrate only through a Mottainai provider later**: the signal is useful,
  but execution, rule ownership, selection, or normalization must first be
  bounded and connected to existing authorities.
- **do not add / redundant**: the current repository already owns the signal
  with a stronger or more targeted implementation, and the candidate would
  add a second authority without a demonstrated gap.

| Candidate            | Distinct signal                                                                             | Current-main overlap and evidence                                                                                                                                                                                                                                                                                                  | Bounded result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Decision                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Knip                 | Unused files, exports, types, dependencies, and unlisted dependencies                       | Typecheck, lint, architecture, tests, and coverage do not prove reachability/dead-code absence. It must instead infer entry points across the CLI, scripts, tests, package bin, dynamic child-process paths, and published files.                                                                                                  | Knip `6.32.0`, `--production --reporter json`: 1.0 s, 68,297-byte report, exit 1; 90 unused files, 172 exports, 229 types, 3 duplicates, 0 unlisted dependencies, 0 unresolved imports. The first unused files include `scripts/architecture-check.mjs`, `scripts/benchmark-artifact-bounding.mjs`, and `scripts/mcp.ts`, demonstrating that an unconfigured run treats operational entry points as dead.                                                                                                                                                                                    | **integrate only through a Mottainai provider later**                                                                    |
| dependency-cruiser   | Configurable forbidden/allowed/required dependency rules, cycles, orphans, and graph output | Architecture checks already resolve the TypeScript import graph and enforce layer direction. Semantics already owns the canonical package/API/dependency relation vocabulary. A second hand-authored boundary rule set would drift.                                                                                                | dependency-cruiser `18.1.1` with TypeScript `5.9.3`, JSON output, and fixture-v1 `no-circular` rule over `src/`: ~2.7 s, 307 modules, 1,092 dependencies, 0 cycles, 0 rule violations. The raw graph was 642,069 bytes; 23 dependencies were unresolved and need explicit interpretation rather than blind CI failure.                                                                                                                                                                                                                                                                       | **integrate only through a Mottainai provider later**                                                                    |
| Semgrep custom rules | Small, selective AST/pattern rules for project-specific forbidden API/policy patterns       | Architecture/governance/CodeQL/Managed Hooks already own several policy boundaries. A Semgrep rule must therefore be a verification projection over a named semantic/policy decision, not a second policy file that silently becomes canonical.                                                                                    | Semgrep `1.172.0`, fixture-v1 rules (`eval` and `new Function`), JSON output over `src scripts` with tracked TypeScript and declaration files excluded: ~2.3 s, 275 tracked / 275 scanned targets, 2 rules, 0 findings, 0 errors, 10,278-byte report. The output is machine-readable and selective, but rule quality and false-positive control remain repository maintenance work.                                                                                                                                                                                                          | **integrate only through a Mottainai provider later**                                                                    |
| zizmor               | GitHub Actions-specific hardening and workflow security audits                              | CodeQL scans the `actions` language and current governance checks workflow structure, but neither is a specialized Actions audit for pinning, permissions, cache, or workflow idioms. The gap is especially visible in the current workflow set.                                                                                   | zizmor `1.29.0`, offline JSON v1 over `.github/workflows`: 0.1 s, 82,323-byte report, exit 14, 47 findings across 6 paths: 43 `unpinned-uses`, 1 `excessive-permissions`, 2 `cache-poisoning`, and 1 `adhoc-packages`.                                                                                                                                                                                                                                                                                                                                                                       | **adopt now** as a non-required advisory/report-only follow-up, then expose bounded findings through a provider          |
| OSV-Scanner          | Versioned dependency vulnerability matching against OSV data                                | Current CodeQL configuration is code/workflow security analysis; no OSV/Dependabot job or lockfile vulnerability authority exists in current main. This is a materially distinct supply-chain signal.                                                                                                                              | OSV-Scanner `2.5.0`, JSON scan of `pnpm-lock.yaml`: ~1.6 s, 28,468-byte report, 3 affected packages and 6 vulnerability records, exit 1. Affected packages were `@hono/node-server@1.19.17`, `fast-uri@3.1.4`, and `hono@4.12.32`; the six IDs were `GHSA-frvp-7c67-39w9`, `GHSA-7p8r-x3mc-p8w7`, `GHSA-54fx-42gc-7vw4`, `GHSA-79qm-7rj5-m7r9`, `GHSA-8j4g-w8fx-2239`, and `GHSA-f23p-vx2j-j53r`. The scanner report did not carry an OSV data-source/snapshot identity, so this historical observation is `inadequate` under the provenance contract below until that metadata is captured. | **adopt now** as a non-required advisory/security follow-up; remediation and required-gate policy are separate decisions |
| StrykerJS            | General-purpose JavaScript/TypeScript mutation testing, including incremental mutation      | The repository already has a bounded property/mutation backend, explicit mutation catalog, equivalent-mutant handling, fixed seed/timeout, baseline score, and a manual/weekly effectiveness workflow. Stryker's incremental mode is useful in general, but replacing the current targeted authority has no demonstrated gap here. | No Stryker package was installed or added. Current `scripts/mutation-test.mjs` and `docs/testing.md` provide the baseline evidence and execution contract.                                                                                                                                                                                                                                                                                                                                                                                                                                   | **do not add / redundant** for the current baseline                                                                      |
| type-coverage        | Type annotation/`any` coverage, which is not identical to compiler correctness              | `strict: true` improves type safety but is not a type-coverage threshold. However, current main has no declared type-coverage target or public-surface policy to make a percentage actionable. A provider would need a semantic target rather than an arbitrary repository-wide number.                                            | The bounded `type-coverage@2.30.1` invocation failed before producing a report with `TypeError: Cannot read properties of undefined (reading 'Unknown')` in `type-coverage-core` while loading current main's TypeScript `5.9.3` API. This is a compatibility/maintenance signal, not a pass.                                                                                                                                                                                                                                                                                                | **integrate only through a Mottainai provider later**, only after a declared public-surface/type policy exists           |

### Primary candidate execution and cost assessment

The table above records the bounded observations; the following makes the
selection and cost dimensions explicit. All four primary tools have a
machine-readable reporter, but none has permission to define a Mottainai
policy merely by returning a non-zero exit code. Report byte counts are the
deterministic token/context-pressure proxy here; exact token counts are
model-dependent, and no raw report was sent to an agent.

| Candidate            | Selective / incremental execution                                                                                                                                                                                                             | Latency, context, maintenance, and false-positive assessment                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knip                 | `--production` narrows the analysis to declared production entry/project patterns. A safe diff-only run was not demonstrated: entry points must cover the CLI, scripts, tests, package bin, dynamic child-process paths, and published files. | ~1.0 s and 68,297 bytes for JSON. The signal is valuable for reachability/dead code, but unconfigured entry-point inference produced 90 apparent unused files including operational scripts; configuration and dynamic-path ownership are the principal maintenance/false-positive costs. |
| dependency-cruiser   | The CLI supports `--affected`, `--include-only`, `--focus`, and `--reaches`; a provider can select the semantic delta's affected source graph instead of cruising all `src/`.                                                                 | ~2.7 s and 642,069 bytes for the full bounded `src/` graph. The graph cannot be sent to an agent as raw context; rules must remain aligned with Repository Semantics, and 23 unresolved dependencies require explicit parser policy.                                                      |
| Semgrep custom rules | Rules and path includes can be limited to named policy targets; the bounded run used only tracked TypeScript targets. Incremental reuse is not assumed, so a provider must bound target bytes and rule count.                                 | ~2.3 s and 10,278 bytes for two rules. It is the most selective primary candidate, but every rule needs an owner, severity rationale, positive/negative fixtures, and false-positive review; zero findings proves only those two patterns matched nothing.                                |
| zizmor               | The input can be limited to `.github/workflows` and run offline; CI can select it only when workflow, permission, cache, or action-reference scope changes.                                                                                   | 0.1 s and 82,323 bytes for JSON v1. The 47 findings are immediately reviewable, but pinning, cache, permissions, and package-install findings require repository-policy triage; advisory output must not become a required failure without that decision.                                 |

The two immediate recommendations are deliberately advisory. The observed
zizmor and OSV results justify follow-up work, but this PR does not add either
tool to required CI, change branch protection, or convert a raw external exit
code into a repository policy decision.

## Minimum Quality Fact / evidence-provider contract

This is a transport-independent design contract, not a new TypeScript schema in
this PR. An adapter may consume JSON, SARIF, text, or a native API, but it must
produce the same bounded logical record.

### Provider run

Every provider run must expose:

| Field           | Requirement                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | Versioned contract identifier, independent of the analyzer's output version                                                                                                                             |
| `provider`      | Stable provider id, tool version, adapter version, and capability (`unused`, `dependency-graph`, `pattern`, `workflow-security`, or `dependency-vulnerability`)                                         |
| `subject`       | Repository identity, source revision, and optional diff base; never an unverified path-only identity                                                                                                    |
| `selection`     | Scope paths/semantic targets, risk or delta class, and the reason this provider was selected                                                                                                            |
| `status`        | `passed`, `findings`, `error`, `inadequate`, or `skipped`; only `passed`/`findings` are complete observations, and a finding is not automatically a policy failure                                      |
| `summary`       | Bounded finding count, severity counts, duration, exit classification, omitted count, and `truncated` flag                                                                                              |
| `provenance`    | Exact argv and cwd, configuration/ruleset and input-snapshot digests, source revision, tool/runtime/adapter versions, timestamp, and any required data-source/snapshot identity; no raw stdout required |
| `artifactRef`   | Optional `result_id`, byte count, retention/expiry, and retrieval selector for the bounded raw report                                                                                                   |

### Deterministic identity and replay

IDs are hashes, not timestamps or generated UUIDs. Canonical serialization is
UTF-8 JSON with object keys sorted by Unicode code point, no insignificant
whitespace, omitted absent fields (no implicit `null`), `/`-normalized
repository-relative paths, 1-based line/column numbers, and arrays ordered by
the contract (paths and selected targets are sorted; argv retains invocation
order; finding arrays are sorted by path, line, column, rule id, and normalized
fingerprint). The hash
domain separator is included to prevent a run hash from being interpreted as a
fact hash.

- `providerRunId` is
  `pr_` plus SHA-256 of
  `mottainai/provider-run/v1\n` followed by the canonical JSON of
  `schemaVersion`, provider id/name/version, adapter version, subject
  repository id and source revision, diff base, normalized selection, exact
  argv and cwd, tool/runtime versions, fixture/config/ruleset digest, input
  snapshot digest, network mode, and data-source/snapshot identity when
  required. `startedAt`, host name, process id, and `attemptId` are excluded.
- An `attemptId` is unique execution metadata linked under the same
  `providerRunId`; it is not an identity input. A retry with exactly the same
  inputs therefore has the same run id, even if it starts at another time.
- `factId` is `qf_` plus SHA-256 of
  `mottainai/quality-fact/v1\n` followed by the canonical JSON of subject
  repository id, provider id, adapter version, fixture/config/ruleset digest,
  selection target, controlled fact kind, rule id, and a normalized finding
  key. The key uses a stable external identifier when available; otherwise it
  uses the normalized semantic target/path and code or dependency fingerprint.
  Message wording, severity, line-only movement, timestamp, run id, and source
  revision are not keys. Source revision is retained in provenance so the same
  finding can be reconciled across revisions without making a line number the
  identity or colliding across repositories.

Writes are idempotent and reconciliation is explicit:

1. Upsert a run by `providerRunId`, retaining each `attemptId` and its exit,
   timing, and diagnostic metadata. Upsert facts by `factId`; a retry or replay
   cannot append a duplicate fact.
2. Replaying the same complete run reasserts the same fact set and produces no
   new identity. A changed revision, selection, fixture/ruleset, input
   snapshot, tool, or adapter version creates a new run id. A parser or
   contract change must never overwrite the old run; it gets a new adapter or
   schema identity.
3. A new run may reconcile only within the same provider, adapter/ruleset,
   subject repository/selection scope (the repository identity, not its
   revision), and only when its evidence is complete
   (`status=passed` or `findings`, `truncated=false`, no omitted target or
   parser error). Facts observed again are updated to the new run; facts in
   the previous complete set that are absent are marked `resolved` with the
   resolving run id, not deleted. Resolved facts remain audit-only under
   retention limits and are excluded from the active Context Runtime facts
   projection.
4. `error`, `inadequate`, `skipped`, timeout, cancellation, or truncated/omitted
   output never resolves an earlier fact. The prior fact remains retained with
   stale/unknown or inadequate freshness and a bounded reason; the incomplete
   run is linked for audit. This prevents a retry failure or an unavailable
   data source from erasing a real finding.

The run/evidence mapping is exact and one-way; no non-complete state is a pass:

| Provider run status | Required condition                                                                                                      | Evidence state                        | Fact/reconciliation behavior                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `passed`            | Invocation, collection, parsing, target selection, and required provenance complete; zero normalized findings           | `observed` with conclusion `passed`   | Reconcile the complete empty set; absent prior facts in scope become `resolved` |
| `findings`          | Same completeness conditions; one or more normalized findings                                                           | `observed` with conclusion `findings` | Upsert facts and reconcile the complete set                                     |
| `error`             | Invocation, transport, timeout, or parser failure prevents a trustworthy complete observation                           | `unknown`                             | Emit only a bounded diagnostic; retain prior facts; no reconciliation           |
| `inadequate`        | The provider ran or returned data, but required provenance, target coverage, parser completeness, or bounds are missing | `inadequate`                          | Do not claim pass or resolve facts; retain prior facts and the reason           |
| `skipped`           | Selection, budget, cancellation, or explicit disablement prevented a run                                                | `unknown`                             | Emit no quality facts and perform no reconciliation                             |

`unknown` means that no quality conclusion can be made; `inadequate` means the
missing requirement is known. Neither is equivalent to zero findings. If an
OSV scan lacks the required data-source or snapshot identity, it is explicitly
`inadequate`, even when the scanner exit code and parsed findings look valid.

OSV provenance is mandatory: record the exact source (for example the OSV.dev
endpoint or offline database origin), an immutable snapshot/revision or the
SHA-256 of the local database archive, acquisition time, and scan time. The
standard OSV-Scanner JSON does not supply this database identity. If any
required source or snapshot field is unavailable, the adapter must set
`status=inadequate` and evidence state `inadequate`, retain the bounded report
only as supporting evidence, and prohibit `passed`/`findings` reconciliation.

### Quality Fact

Each fact must carry only the information needed for selection, review, or
navigation:

- stable fact id and a controlled `kind`;
- bounded severity, confidence, message, and remediation hint;
- subject: path plus optional Repository Semantics logical target or dependency
  endpoints;
- navigation: start/end line and column where available, plus an optional
  external documentation URL;
- provenance link to the provider run and, when needed, the retained artifact;
- `unknown`/`inadequate` information instead of an invented pass when parsing,
  timeout, or collection was incomplete.

The adapter maps each run according to the status table into the existing
observed/evidence model:

- `VerificationEvidence` carries observed, unknown, or inadequate state with
  current/stale freshness, status, reference, summary, and provenance; only
  observed `passed`/`findings` is a quality conclusion;
- individual analyzer findings remain bounded facts linked by
  `evidence_for`; they do not become declared contracts, derived semantic
  entities, or policy rules;
- `ArtifactStore` retains the raw report only behind `result_id`, TTL, byte,
  and entry limits;
- Context Runtime projects `facts`, `diagnostics`, `metrics`, navigation, and
  `result_id` under the existing response budget. Successful verbose output is
  omitted by default and remains explicitly retrievable.

The minimum safe projection is therefore a bounded summary such as “47
findings across 6 workflow files, 43 unpinned uses, report available as
`result_id`,” not the 82,323-byte zizmor report or the 642,069-byte dependency
graph. A provider must record omitted/truncated detail and must never pass
large analyzer stdout directly to an agent.

## Selection and authority boundaries

Selection is a cross-layer projection, not a replacement authority:

1. **Repository Semantics** supplies component ownership, dependency/API
   relations, declared decisions/constraints, semantic delta kind, and
   provenance. It may select a dependency or public-surface validator, but an
   analyzer may not redefine those relations.
2. **Policy** supplies risk class, changed-path scope, required/advisory mode,
   timeout, finding/byte limits, and whether a finding is blocking. A provider
   exit code alone cannot escalate an advisory run to a protected-branch or CI
   denial.
3. **Managed Hooks** supplies the operation class and the pre-operation
   boundary. Read/write/process/Git hooks may select only cheap, local,
   relevant validators; network-backed OSV and full graph scans belong outside
   latency-sensitive hook paths unless explicitly selected and budgeted. The
   dispatcher remains the enforcement authority.
4. **CI** supplies changed-file/diff context and parallel job scheduling. A
   provider should receive the smallest relevant scope and publish bounded JSON
   or SARIF plus an artifact. Existing required contexts remain unchanged until
   a separate maintainer decision promotes an observed provider.
5. **PR-Agent/OpenCodeReview** may receive the provider summary and navigation
   facts after the provider bound is proven. They must not receive the raw
   analyzer report; the current review preflight and Context Runtime budgets
   remain in force.

The first follow-up should use a report-only matrix, for example:

| Trigger scope/risk                                          | Candidate                                                           | Bounded execution                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `.github/workflows/**` or workflow permission/cache change  | zizmor                                                              | offline/local workflow collection, JSON v1, timeout and finding cap, advisory artifact               |
| `pnpm-lock.yaml` or dependency update/security scope        | OSV-Scanner                                                         | lockfile-only or diff-aware scan, versioned JSON, network/DB failure as explicit inadequate evidence |
| `src/**` public-surface or dependency-policy semantic delta | dependency-cruiser/Knip only when the semantic selector requests it | scoped files/entrypoints, fixed timeout, config/ruleset digest, no raw graph projection              |
| named policy/invariant with a bounded AST pattern           | Semgrep custom rule provider                                        | rule tests, selective paths, max target bytes, bounded JSON facts                                    |

No candidate should run for every hook or every PR by default. A selection
record must be explainable by changed scope, risk, semantic target, and budget;
otherwise the provider is noise and its maintenance cost is not justified.

## Smallest consolidated follow-up

If maintainers approve implementation, use one follow-up Issue/PR for the
provider boundary rather than one Issue per analyzer. That change should add
only the transport-independent run/fact normalization, bounded ArtifactStore
and Context Runtime projection, selection explanation, and two report-only
adapters for zizmor and OSV-Scanner. It should publish advisory artifacts and
record provenance without adding a required status. Knip, dependency-cruiser,
Semgrep, and type-coverage remain deferred until that boundary demonstrates a
real scope/risk consumer and a named authority for their rules.

## Cost, false positives, and maintenance conclusions

The measured reports show why normalization is necessary. Knip and
dependency-cruiser produced useful machine-readable output but larger than the
Context Runtime hard byte budget and required entry/parser/rule configuration.
Their counts cannot be treated as defects without understanding this
repository's executable scripts, test infrastructure, dynamic process paths,
published `dist` boundary, and semantic graph.

Semgrep was fast and selective, but a zero-result custom scan proves only that
the two fixture-v1 patterns matched nothing; it does not prove a complete
policy or security analysis. Every adopted rule set needs rule tests, a named owner,
severity rationale, and positive/negative fixtures. CodeQL remains the
security source/sink authority where such a path is modeled.

Zizmor's 47 findings are actionable evidence, not an automatic green/red
decision. The 43 unpinned-use findings require triage against the repository's
pinning policy and existing action updates; cache, permissions, and ad-hoc
package findings require separate review. OSV's six lockfile vulnerabilities
are a stronger immediate signal, but vulnerability status is time-dependent,
database-dependent, and the historical report is `inadequate` until its exact
OSV data source and immutable snapshot are recorded alongside the scan date.

Stryker would duplicate the current targeted mutation/effectiveness contract.
Type-coverage has a potentially distinct signal but no declared target and did
not produce a compatible report in this environment. Neither is justified as a
new required path from this research alone.

## References

Tool contracts consulted for this bounded evaluation:

Links without a version tag are pinned by the access date shown here.

- [Knip production mode](https://knip.dev/features/production-mode) and
  [JSON/SARIF reporters](https://knip.dev/features/reporters) (accessed 2026-08-10)
- [dependency-cruiser CLI and JSON output](https://github.com/sverweij/dependency-cruiser/blob/v18.1.1/doc/cli.md)
- [Semgrep CLI JSON output](https://semgrep.dev/docs/cli-reference/) and
  [custom rule syntax](https://semgrep.dev/docs/writing-rules/rule-syntax) (accessed 2026-08-10)
- [zizmor usage and versioned JSON v1](https://github.com/zizmorcore/zizmor/blob/v1.29.0/docs/usage.md)
- [OSV-Scanner usage](https://google.github.io/osv-scanner/usage/) and
  [supported lockfiles](https://google.github.io/osv-scanner/supported-languages-and-lockfiles/) (accessed 2026-08-10)
- [StrykerJS incremental mode](https://stryker-mutator.io/docs/stryker-js/incremental/) (accessed 2026-08-10)
- [type-coverage 2.30.1](https://www.npmjs.com/package/type-coverage/v/2.30.1)
