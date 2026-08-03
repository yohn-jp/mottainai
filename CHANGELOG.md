# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) once it
reaches 1.0. Before 1.0, minor versions may include breaking changes.

No version has been tagged or published yet — everything below is tracked
under `Unreleased` against `package.json` version `0.1.0`.

## [Unreleased]

Nothing yet.

## [0.1.0] - in development

Initial feature set, developed incrementally on `main` (no tagged releases
yet). Summarized by capability rather than by commit — see `git log` for
full history.

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

[Unreleased]: https://github.com/yohn-jp/mottainai/compare/main...HEAD
[0.1.0]: https://github.com/yohn-jp/mottainai/commits/main
