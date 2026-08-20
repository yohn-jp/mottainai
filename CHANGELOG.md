# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) once it
reaches 1.0. Before 1.0, minor versions may include breaking changes.

When bumping the version, update `package.json` and the pinned package versions
in the Claude and Codex registration examples in `README.md` together.

## [Unreleased]

- **Fixed**: managed gh-inari compatibility now accepts `>=0.7.0` when the
  required `pr.create`/`pr.get` and machine-option contract is present, with
  bounded fail-closed diagnostics for missing or incompatible companions.

## [0.2.0] - 2026-08-18

Pi-backed managed-development and authority-convergence release. See
[docs/releases/0.2.0.md](docs/releases/0.2.0.md) for the full writeup.

- **Added**: Pi as a first-class Zellij Manager profile, one-command
  `task run --agent pi` orchestration, a managed Pi mutation guard, and the
  packed Issue-to-PR golden-path acceptance test reaching
  `pull-request-open`.
- **Added**: completed Context Runtime guardrails and dogfood evidence,
  state-aware validation reuse/compact receipts, and the first complete
  Repository Semantic Control Plane loop including semantic delta/impact,
  verification planning, bounded projections, and managed enforcement.
- **Changed**: Nawabari is the sole managed physical Git/worktree authority
  (`>=0.4.1` contract), managed PR mutation is gh-inari-only (`>=0.7.0`
  companion contract), and Manager is a multi-agent execution control plane
  rather than a Codex-only launcher.
- **Changed**: Runtime lifecycle is explicitly owned by `mottainai runtime
  ensure|status`, and PR CI is organized around merge-integrity/product
  contracts rather than non-authoritative informational automation.
- **Fixed**: external-effect crash/retry reconciliation for task start,
  commit, push and PR creation; authoritative validation-worktree/stable
  fingerprint correctness; typed raw-Git mutation routing; real Zellij
  inspection/version compatibility; hermetic Inari standards checks; and the
  15 pre-existing integration failures that blocked the required packed
  product-contract gate.

## [0.1.4] - 2026-08-09

Semantic workflow and CI-hardening release. See
[docs/releases/0.1.4.md](docs/releases/0.1.4.md) for the full writeup.

- **Added**: TypeScript semantic fact extractor, Symbol-level effect and
  policy conformance analysis, a semantic mutation API (plan/bind/
  validate/persist boundary, closes #49), a semantic verification
  adequacy model, and a reconciliation doctor audit/export (Issue #38).
- **Added**: live Repository Model compiler for the Semantic Project
  Viewer, safe task cleanup and crash recovery (Issue #37), runtime
  build identity domain object, and path-aware governance gates
  (Issue #26).
- **Added**: Managed Hooks review gate first vertical slice (transport-
  independent `HookEvent`/`HookDecision`, capability-based anti-bypass).
- **Added**: CodeQL advanced analysis, mutation/property test
  effectiveness harness (Issue #24), fault-injection test boundaries
  (closes #23), OpenCodeReview parallel evaluation workflow, dual LLM
  review budget bounds (closes #119), and PR CI critical path reduced
  below two minutes (closes #139).
- **Fixed**: runtime diagnostic `git_sha` no longer leaks an unrelated
  consumer checkout's commit hash; more credential shapes redacted in
  `sanitizeUpstreamError`; stale `failed` verification evidence no
  longer permanently blocks a requirement after a newer pass;
  OpenCodeReview trigger/routing gaps closed.

## [0.1.3] - 2026-08-09

Git workflow governance release. Publishes the workflow-task engine
(policy schema, repository identity, SQLite state store, protected-branch
decisions, task/worktree lifecycle — Issue #34 family) that accumulated on
`main` since `0.1.2`, plus the read governor, burst budget, context/result
response budgets, symbol-first semantic IR, and retirement of native
Windows support. See [docs/releases/0.1.3.md](docs/releases/0.1.3.md) for
the full writeup.

- **Platform support policy**: Linux is Tier 1 / canonical, WSL2 is supported
  as a Linux runtime, macOS is best effort / Tier 2, and native Windows is
  unsupported. `v0.1.2` remains the historical final native-Windows
  release/tag; Windows users should use WSL2.
- **Added**: `mottainai_workflow_policy_explain`, `mottainai_workflow_task_start`,
  `mottainai_workflow_task_status` MCP tools, gated behind
  `gateway.workflowTasks` (default `false`).
- **Added**: read governor, burst budget, context/result response budgets,
  symbol-first semantic IR, await/watch primitives.
- **Fixed**: worktree creation collision/race conditions, task worktree path
  canonicalization, advisory decision reason codes, repo-state fail-closed
  detection, `recordPullRequest` TOCTOU.

## [0.1.2] - 2026-08-06

Distribution and initialization hardening release. Not a fix for the
0.1.0/0.1.1 `npx` execution reports — those turned out to be a packed-package
verification gap (see below), not a broken published package.

### Fixed

- **Client registration no longer breaks after `init`**: the registration
  command `mottainai init` prints and runs for `--client claude`/`--client
  codex` now passes `serve --config <absolute path>` explicitly. Previously
  it registered `npx -y mottainai` with no `--config` and no
  `MOTTAINAI_CONFIG`, so a client that starts the server from a different
  working directory than the one `init` ran in (a very likely case for
  `claude mcp add -s user`) would fail with `ENOENT` on config resolution and
  the client would report a closed connection.
- **Explicit client registration failures now fail the run**: `mottainai
  init --client claude` (or `codex`) now sets `summary.ok = false` and exits
  non-zero if the client binary is missing, `mcp list` fails, or the
  registration command itself fails. Previously these were warnings only,
  and the exit code depended solely on `doctor`/the internal handshake.
  `--client none` and `--no-register`/`--dry-run` are unaffected.
- **Registration command display no longer breaks on paths with spaces**:
  the `--config <path>` printed/JSON registration command now quotes the
  path when it contains whitespace or double quotes. The actual
  registration process was unaffected (it spawns the client with an argv
  array, not a shell string); only the copy-pasteable string shown to the
  user was broken for such paths.
- **Secret sanitization on `init --import` is deny-by-default**: URLs are
  now rejected unless they are a plain `http:`/`https:` URL with no
  userinfo, query string, or fragment (previously only known credential-like
  query *keys* were checked, and the fragment wasn't checked at all).
  Argument lists containing any credential-like token now cause the entire
  upstream registration to be rejected, instead of silently dropping a
  `--flag`/value pair and importing a mangled argument list.

### Added

- **Packed-package smoke test** (`scripts/smoke-test.mjs`): packs the
  package, installs the tarball into an isolated directory, and runs the
  installed `mottainai`/`mtnai` binaries — covering `init --json` and the
  bare stdio entry point. Runs in CI on Ubuntu and Windows across Node 22
  and 24, and gates publishing.
- CI now also runs the full test suite on Windows in addition to Ubuntu.

### Changed

- `package.json` no longer declares `main`/`types`/`exports`; this is a
  CLI-only package and `bin` is now the sole public entry point. Importing
  it as a library previously had the side effect of starting the MCP server
  or parsing `process.argv`.
- `bin` paths in `package.json` no longer have a leading `./`.
- The publish workflow now packs once, smoke-tests that exact tarball across
  the OS/Node matrix, and publishes that same tarball — rather than
  rebuilding independently at each step.

## [0.1.1] - 2026-08-05

### Added

- **Workspace initialization**: `mottainai init` creates a portable v2
  configuration, supports non-interactive defaults, dry-run/JSON output,
  personal Git exclusion, atomic writes, backups, and pinned client
  registration commands. It runs `doctor` and a stdio MCP handshake after
  writing the configuration.
- **Safe stdio startup**: a missing configuration produces an initialization
  hint without writing anything to MCP stdout.

## [0.1.0] - 2026-08-05

Initial feature set, developed incrementally on `main` prior to the first
tagged release. Summarized by capability rather than by commit — see `git
log` for full history.

### Added

- **Proxy core (Step 1)**: aggregate multiple upstream MCP servers behind one
  stdio endpoint, routing `listTools`/`callTool` with `<upstream>__<tool>`
  name-prefixing to avoid collisions.
- **Result compression (Step 2)**: deterministic, rule-based compression of
  `callTool` results — ANSI stripping, JSON sampling, line filtering, and
  known-CLI-output compression (test runners, build tools, linters, `git
  status`/`git diff`). Pre-compression originals are retained in a
  short-lived in-memory store and retrievable via `mottainai_retrieve`.
- **Tool definition compression (Step 3)**: pre-compression of `description`
  and `inputSchema` for every tool the gateway exposes (upstream and local).
- **Local tools**: `mottainai_exec`, `mottainai_read`, `mottainai_search`,
  `mottainai_list`, `mottainai_result_get`, `mottainai_result_search`,
  `mottainai_runtime_status`, sharing a common structured output envelope.
- **Config v2 and upstream lifecycle**: `mottainai.config.json` schema v2,
  lazy upstream startup, per-upstream failure isolation, and a management CLI
  (`pnpm run mcp list|add|remove|enable|disable|profile|doctor`).
- **Tool catalog and brokered mode**: searchable tool catalog
  (`mottainai_tool_search`/`_describe`/`_call`) so large upstream tool sets
  don't have to be listed up front, plus `gateway.activeProfile` to narrow
  the exposed surface by capability/risk.
- **Deterministic routing and token budgets**: capability→provider ranking
  (`preferredFor`/`fallbackFor`/priority), automatic fallback on provider
  failure, and optional per-capability/tool/profile token budgets.
- **Logical capability tools**: `mottainai_code_search` and
  `mottainai_code_symbol`, which pick among available backends (codegraph,
  ripgrep, ast-grep, etc.) for the same logical request.
- **Caller-supervised routing**: `mottainai_plan`, `mottainai_review`,
  `mottainai_execution_review`, `mottainai_policy_stats`,
  `mottainai_policy_propose` — callers classify tasks and report whether
  expected evidence was found; routing policy proposals are generated from
  that feedback but require explicit human approval
  (`pnpm run policy approve`) before taking effect.
- **Read Governor (experimental, observe/warn stage only)**: file-class-aware
  read policy and evidence-based read authorization, currently
  advisory-only — it does not deny reads yet.
- **Telemetry (opt-in, local-only)**: token-savings and usage summaries via
  `mottainai_telemetry_summary`, disabled by default
  (`MOTTAINAI_TELEMETRY=1` to enable).
- Raw-data logging of upstream requests/responses to `.mottainai/log/*.jsonl`
  with secret-key redaction, retention limits, and per-tool exclusion.

[Unreleased]: https://github.com/yohn-jp/mottainai/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/yohn-jp/mottainai/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/yohn-jp/mottainai/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/yohn-jp/mottainai/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/yohn-jp/mottainai/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yohn-jp/mottainai/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yohn-jp/mottainai/releases/tag/v0.1.0
