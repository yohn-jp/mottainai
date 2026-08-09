# CodeQL analysis

Mottainai uses one repository-owned CodeQL advanced setup:

- Workflow: `.github/workflows/codeql.yml`
- Configuration: `.github/codeql/codeql-config.yml`
- Languages: `javascript-typescript` and `actions`
- Queries: `security-extended`

`security-extended` includes the default security queries plus lower-severity
or lower-precision security queries. `security-and-quality` is intentionally
not selected: lint, TypeScript, architecture, coverage, and tests remain the
canonical authorities for maintainability and reliability. CodeQL is a static
verification layer over those existing boundaries, not a replacement for the
workflow, Context Runtime, Repository Semantics, or Managed Hooks authority.

## Triggers and permissions

The workflow analyzes pull requests targeting `main`, pushes to `main`, and
the default branch once each week. The weekly scan is useful because CodeQL's
query and vulnerability knowledge can change without a repository commit.

The workflow has no secrets and does not use `pull_request_target`. Its token
permissions are limited to `contents: read` for checkout and
`security-events: write` for uploading SARIF results. Fork pull requests run
under GitHub's normal `pull_request` fork restrictions: repository secrets are
not available and write permissions are downgraded. `persist-credentials: false`
also prevents checkout credentials from remaining in the workspace.

No analysis paths are restricted, so `src/**`, relevant `scripts/**`, and
`.github/workflows/**` remain in the corresponding language's analysis scope.

## Running and inspecting the baseline

A pull request or push to `main` runs one matrix job per language. Maintainers
can inspect the configuration in the two paths above, list runs with
`gh run list --workflow codeql.yml --repo yohn-jp/mottainai`, and inspect a run
with `gh run view RUN_ID --repo yohn-jp/mottainai --log-failed`. Results appear
in the pull request checks and under the repository's **Security → Code
scanning** view. The checks are named `Analyze (javascript-typescript)` and
`Analyze (actions)`.

### Initial baseline (2026-08-09)

- PR head `d943c687a99077c5ba4c2e2effb67c226bae6b06` (Issue #135, merging
  `main` at `fad552f6e9681b771c5503586837289057146a10`): `Analyze
  (javascript-typescript)` — success; `Analyze (actions)` — success;
  `Governance / validate-pr` — success.
- Code scanning alerts: 0 open alerts for the repository at merge time.
  A successful job means both matrix jobs completed without error, not that
  zero findings is guaranteed for all future commits; check **Security → Code
  scanning** for the current alert state.
- The weekly scheduled scan and the `push` trigger on `main` first run after
  this PR merges, since `main` had no CodeQL workflow before it.

An alert is handled by fixing the code, dismissing it in GitHub only with
reviewable evidence and a documented reason, or filing a bounded follow-up
Issue. Findings must not be suppressed generically to restore a green check.

## Mottainai trust-boundary candidates

These are candidate source/sink classes for future local CodeQL modeling. The
candidate names describe existing runtime boundaries; they do not create new
runtime or policy authorities.

| Candidate flow                                               | Existing boundary                                                                                       | Why it is not a custom query here                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP/client value → process or shell execution                | `mottainai_exec` and the bounded child-process wrappers in `src/local-tools.ts` and `src/subprocess.ts` | `mottainai_exec` is an explicitly trusted-user primitive documented in `SECURITY.md`; a useful query must distinguish that contract from an unintended path. |
| MCP/client value → filesystem path or write                  | read authorization in `src/read-governor/` and configuration/workflow persistence                       | The read boundary and the workflow/persistence authorities already own path and state validation; a broad query would duplicate them.                        |
| MCP/client value → network destination/request               | configured upstream transports in `src/upstream.ts`                                                     | Destinations come from gateway configuration rather than an arbitrary client URL in the normal routing path.                                                 |
| MCP/client value → Git mutation                              | validated task/branch/worktree operations in `src/workflow/`                                            | Branch, protected-branch, hook, and worktree rules are canonical workflow authorities.                                                                       |
| Untrusted upstream result → privileged operation             | proxy routing, normalization, compression, and output projection                                        | The current path returns upstream data; no stable, security-specific privileged sink is exposed for a precise independent model.                             |
| Sensitive configuration/credential → LLM/tool-visible output | configuration loading plus logging redaction and envelope/output paths                                  | A query would need a precise credential source and output sink without treating all tool data as secret.                                                     |
| Untrusted metadata → persisted canonical state               | GitHub provider normalization and workflow state records                                                | Provider/state schemas and provenance are the existing authority; no concrete injection path is established.                                                 |

Custom queries are explicitly deferred for this baseline. The current code
does not expose a high-confidence source-to-sink path that can be modeled
cheaply without re-encoding one of those authorities, and no positive/negative
CodeQL regression fixture exists to prove such a model. Do not add an empty
query pack or speculative `.ql` abstraction. A future query requires a named
source, named sink, safe path, unsafe path, and regression evidence; it must
remain a verification projection over real code behavior.
