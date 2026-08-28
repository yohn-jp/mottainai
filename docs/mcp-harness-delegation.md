# Native harness-delegation MCP contract

Mottainai exposes a thin northbound MCP adapter over the existing task, Manager, workflow, Nawabari, governance, verification, and evidence authorities. The adapter does not implement a second orchestration engine.

## Launch and discovery

The packaged entrypoint is `mottainai-mcp` and its transport is standard MCP JSON-RPC over stdin/stdout. It accepts:

```text
mottainai-mcp [--config <path>]
```

`MOTTAINAI_CONFIG` may select the configuration when `--config` is omitted. The executable is published in the package `bin` map and runs from `dist/mcp.js`; clients must not depend on a repository checkout or `tsx`. A future optional Majiwari gateway can consume this command/args pair and standard `tools/list` without importing Mottainai internals or depending on Majiwari at runtime.

`mottainai-mcp` (`src/mcp.ts` → `src/mcp-server.ts`) is a distinct server from the legacy gateway (`mottainai serve`, `src/server.ts`/`src/proxy.ts`). It registers only the five tools below - never the legacy gateway's local tools, workflow-command tools, adaptive tools, broker tools, or code-search tools. Legacy `mottainai serve` behavior is unchanged and continues to expose its existing broader catalog for existing consumers.

The stable discovery tool is `mottainai_harness_capabilities`. The delegation tools are:

- `mottainai_delegate_work`
- `mottainai_inspect_work`
- `mottainai_continue_work`
- `mottainai_cancel_work`

All delegation tool inputs and outputs use `schemaVersion: 1` (omitted input version means 1). Public statuses are `accepted`, `running`, `completed`, `failed`, `cancelled`, `blocked`, and `missing`. Structured errors use exactly one of `invalid_input`, `unavailable_capability`, `lifecycle_conflict`, `governed_refusal`, `execution_failure`, or `internal_failure`.

## Work identity and selectors

`mottainai_delegate_work` accepts a bounded `goal`, an optional explicit `workspace`/`repository` selector, optional task/agent/scope constraints, and an optional `idempotencyKey`. It returns the durable task's opaque `workId`. Repeating a supported request with the same key reuses the existing keyed Manager operation or returns an explicit conflict; it does not silently create another active work item.

`mottainai_inspect_work`, `mottainai_continue_work`, and `mottainai_cancel_work` accept only `workId` (plus the bounded follow-up/reason). They never infer a repository from prose or fall back to the MCP process cwd after identity selection. Continue reuses the same task, Nawabari execution, worktree, branch, and Manager session. Cancel transitions the task through the lifecycle authority and calls the identity-gated Manager stop operation; it never kills an unrelated process.

## Bounded result projection

Results contain the schema version, status, lifecycle state, opaque identity, bounded latest evidence/receipts, and safe pull-request metadata. They omit prompts, raw process output, argv, runtime/session names, private registries, credentials, and filesystem paths. Ordering is deterministic and collection sizes are bounded. Terminal continue/cancel conflicts are returned as structured lifecycle errors rather than starting a new operation.
