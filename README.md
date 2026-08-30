# Mottainai

**Mottainai** is a coding-agent orchestration and MCP context runtime for governed repository work.
It coordinates bounded agent sessions, preserves the evidence that matters, and keeps physical Git/worktree authority behind explicit runtime boundaries instead of letting each agent improvise its own workflow.

> **Status: pre-1.0 (`0.x`).** Mottainai is in active dogfood. Minor releases may change interfaces while the operational model is hardened.

## What Mottainai does

Mottainai combines four concerns that normally end up fragmented across agent prompts, shell scripts, and CI:

- **Managed coding-agent sessions** — launch and track Codex, Claude Code, or Pi work through the Manager and Zellij-backed session runtime.
- **Governed repository execution** — task intent and semantic policy stay in Mottainai while physical worktree/branch/claim authority is delegated to Nawabari.
- **Bounded context runtime** — tool output is projected into deterministic summaries, diagnostics, facts, metrics, and retrieval references instead of flooding model context with raw output.
- **MCP gateway and routing** — upstream MCP tools can still be aggregated, capability-routed, compressed, and exposed through one stdio endpoint.

The product is therefore broader than an MCP compression proxy. Compression remains a capability; the primary boundary is now **safe, bounded, recoverable agent execution**.

## Authority model

```text
LLM / coding agent
        │
        ▼
   Mottainai
   orchestration, semantic policy,
   context/runtime projection, Manager
        │
        ├────────► Nawabari
        │          physical Git/worktree/session/claim authority
        │
        └────────► gh-inari
                   governed GitHub Issue/PR mutation authority
```

Mottainai does not silently replace these authorities when they are unavailable. Managed operations fail closed with bounded diagnostics.

## Quick start

Requires Node.js >= 22.13 and `rg` (ripgrep) on `PATH`.

Initialize a workspace:

```bash
npx -y mottainai@0.7.1 init
```

Check the runtime, configuration, repository state, and managed companions:

```bash
npx -y mottainai@0.7.1 doctor
npx -y mottainai@0.7.1 doctor --json
```

For governed development, start work through the task boundary rather than creating an ad-hoc branch/worktree:

```bash
npx -y mottainai@0.7.1 task run my-fix \
  --type fix \
  --issue 123 \
  --agent pi
```

Or launch the local Manager UI for durable parallel sessions:

```bash
npx -y mottainai@0.7.1 manager
npx -y mottainai@0.7.1 manager --no-open --port 4318
```

The Manager previews bounded resource scope, performs Nawabari claim preflight, and keeps UI state non-authoritative. Nawabari remains the owner of the physical worktree, branch, and claims.

## MCP client registration

The bare command is the MCP stdio entry point:

```bash
npx -y mottainai@0.7.1
```

Claude Code:

```bash
claude mcp add -s user mottainai -- npx -y mottainai@0.7.1 serve --config /absolute/path/to/mottainai.config.json
```

Codex:

```bash
codex mcp add mottainai -- npx -y mottainai@0.7.1 serve --config /absolute/path/to/mottainai.config.json
```

`mottainai init` can generate the registration command for the detected client. Use `--latest` only when intentionally following the newest npm release rather than a pinned version.

When registering an upstream with `mottainai add`, every value-taking option must be followed by a value; another option token is rejected as a missing value before the configuration is changed. Stdio argv is supplied as one JSON array of strings, such as `--args='["hello world","--flag",""]'`; each array element remains one subprocess argument, including whitespace, quotes, backslashes, and empty strings. Legacy whitespace-separated values such as `--args "one two"` are rejected with a migration diagnostic and do not change the configuration. For other value-taking options, use explicit `--option=value` when the value begins with `--`.

## Native harness-delegation MCP

The packaged `mottainai-mcp` executable exposes Mottainai's native, high-level harness surface over standard MCP stdio. It does not require `tsx`, a source checkout, Majiwari, or Nawabari client code in the MCP consumer.

Example client configuration:

```json
{
  "mcpServers": {
    "mottainai": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "mottainai@0.7.1",
        "mottainai-mcp",
        "--config",
        "/absolute/path/to/mottainai.config.json"
      ]
    }
  }
}
```

The four delegation tools are `mottainai_delegate_work`, `mottainai_inspect_work`, `mottainai_continue_work`, and `mottainai_cancel_work`. `mottainai_harness_capabilities` returns the versioned status/error vocabulary and the same launch/discovery contract. Delegation returns an opaque stable `workId`; later operations use only that ID. Inspect results are bounded and contain lifecycle/evidence/PR metadata, never raw logs, private registry state, credentials, runtime names, or filesystem paths.

Majiwari can optionally launch the installed `mottainai-mcp` entrypoint and publish this surface transparently. It remains a transport/publication layer, is not a runtime dependency, and does not own Mottainai orchestration. See [the native delegation contract](docs/mcp-harness-delegation.md).

## Managed workflow

The CLI lifecycle is:

```bash
mottainai policy explain [--workspace path]
mottainai task start <slug> --type type --issue ref [--workspace path] [--dry-run]
mottainai task run <slug> --type type --issue ref --agent pi [--model model] [--workspace path]
mottainai task list [--workspace path]
mottainai task status [--task-id id] [--workspace path]
mottainai task commit --message subject [--workspace path]
mottainai task push [--workspace path]
mottainai task open-pr --title title [--repo owner/name] [--workspace path]
mottainai task finish [--workspace path]
mottainai task abandon [--workspace path]
mottainai task cleanup [--workspace path]
mottainai workflow doctor [--workspace path] [--reconcile-closures]
```

`task start` delegates worktree creation to Nawabari and returns the canonical worktree path in `execution.worktree`. Follow-up operations must use that returned path. Mottainai does not reconstruct or take ownership of the physical worktree. `--dry-run` validates the same inputs and read-only readiness blockers, then returns a `plan` preview (branch, base, worktree, and claims) without creating a task, Git worktree/branch, Nawabari session, claim, or persistent state. The plan marks final claim acquisition as excluded because it requires an external Nawabari mutation.

`task list` is the read-only discovery surface for registered workspaces. It returns a bounded snapshot suitable for external consumers and UIs. Resolve a selected task again with `task status --task-id <id>` immediately before acting; that fresh resolve, rather than the earlier list snapshot, is the authoritative view. Consumers such as Majiwari therefore do not need to read Mottainai or Nawabari internal persistence directly.

`workflow doctor` is read-only by default. `--reconcile-closures` may request Nawabari's normal safe-close path for already integrated executions and reports bounded per-task closure outcomes, including reasons for tasks that remain unreconciled; Mottainai still does not edit Nawabari registry or claim state directly.

Managed pull-request creation uses gh-inari as its mutation authority. Mottainai probes the companion contract before mutation and does not fall back to direct GitHub PR creation.

## Manager

The Manager is the operational console for concurrent coding-agent work:

- bounded scope preview before launch;
- Nawabari claim preflight;
- explicit running / needs-attention / recent-session views;
- session detail and controlled terminal actions;
- stale async-response rejection and bounded polling;
- non-authoritative UI projection over the underlying task/runtime state.

Zellij remains terminal transport and persistence; Nawabari remains Git/worktree authority.

## Context runtime and MCP gateway

Mottainai still exposes a standard MCP stdio server and can aggregate upstream MCP servers. Tool results pass through deterministic retention and projection so the model receives bounded structured output while full evidence remains retrievable when a `result_id` is available.

Typical projection flow:

```text
raw tool/process result
  → retain full local evidence
  → deterministic parsing/compression
  → summary / facts / diagnostics / metrics
  → token + byte budget
  → bounded structured response
```

Important local tools include:

- `mottainai_read`, `mottainai_search`, `mottainai_list`
- `mottainai_exec`, `mottainai_exec_start`, `mottainai_exec_await`
- `mottainai_result_get`, `mottainai_result_search`
- `mottainai_code_search`, `mottainai_code_symbol`
- `mottainai_runtime_status`
- workflow task tools when `gateway.workflowTasks` is enabled

Search and producer failures are fail-closed: command/parse failures are not reported as genuine zero-match results.

## Configuration

The v2 configuration has three primary sections:

- `mcpServers` — upstream MCP registrations.
- `profiles` — named capability/risk views.
- `gateway` — cross-cutting runtime policy such as response budgets, read governor, managed process limits, workflow enablement, routing metadata, and companion configuration.

Closed configuration objects reject unknown keys so misspelled safety/governance settings cannot silently fall back to defaults.

Example:

```json
{
  "version": 2,
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp", "--path", "."]
    }
  },
  "gateway": {
    "workflowTasks": true
  }
}
```

Do not put credentials in `mottainai.config.json`. Remote authentication should reference environment-variable names or the configured OAuth provider boundary. See [SECURITY.md](SECURITY.md).

## Await and managed processes

Polling is orchestration, not reasoning. `mottainai_exec_start` and `mottainai_exec_await` let one bounded MCP operation wait for terminal state rather than repeatedly consuming model turns.

Managed process handles are connection-local and finite. Active process count, retained terminal handles, and lifetime are bounded through `gateway.managedProcesses`; connection shutdown cleans up owned children.

## Supported runtime model

- Linux: Tier 1.
- Windows 11: local Runtime uses QEMU + WHPX.
- macOS: local Runtime uses QEMU + HVF, with Apple Silicon as the primary target.

The `mottainai runtime` namespace is the local Runtime lifecycle authority. Missing required acceleration fails closed instead of silently changing the execution model.

## Development

```bash
pnpm install
pnpm run build
pnpm test
pnpm run test:integration
pnpm run test:e2e
pnpm run test:package
pnpm run test:coverage
pnpm run verify
pnpm run typecheck
```

`pnpm run verify` is the authoritative local verification aggregate. Test layering and classification are documented in [docs/testing.md](docs/testing.md).

The bounded agent execution contract lives in [AGENTS.md](AGENTS.md). Contributor workflow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [0.7.1 release notes](docs/releases/0.7.1.md)
- [0.7.0 release notes](docs/releases/0.7.0.md)
- [0.6.0 release notes](docs/releases/0.6.0.md)
- [0.5.0 release notes](docs/releases/0.5.0.md)
- [0.4.0 release notes](docs/releases/0.4.0.md)
- [0.3.1 release notes](docs/releases/0.3.1.md)
- [0.3.0 release notes](docs/releases/0.3.0.md)
- [Nawabari execution boundary](docs/nawabari-execution.md)
- [Workflow policy](docs/workflow-policy.md)
- [Read Governor](docs/read-governor.md)
- [MCP stdio black-box contract](docs/mcp-stdio-blackbox.md)
- [Security model](SECURITY.md)

## License

[MIT](LICENSE)
