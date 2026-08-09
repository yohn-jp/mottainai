# Mottainai

**Mottainai** ("wasteful" / "what a waste" in Japanese) is a proxy gateway
that sits between an LLM client and one or more upstream
[MCP](https://modelcontextprotocol.io/) servers, and **compresses tool
definitions and tool call results before they reach the model context**.

> **Status: pre-1.0 (`0.x`).** The core proxy and compression pipeline are
> in daily use, but APIs, config shape, and tool names may still change
> between minor versions. See [Experimental features](#experimental-features)
> for pieces that are further out. Longer-form docs (architecture, config
> schema, per-feature guides) are being cleaned up before they're added back
> to this repository — this README is the full reference for now.

## The problem

MCP servers are great at surfacing tools and data to an LLM, but most of them
return **raw, unbounded output**: full command stdout, entire files, deeply
nested JSON, ANSI color codes, generated tool descriptions written for
humans rather than token budgets. Every one of those bytes counts against
the model's context window, and that context is the scarcest resource in an
agentic session.

A few tools (structural code indexes, for example) already return
pre-compressed, structured results. Most don't. Mottainai's job is to close
that gap for the tools that don't, without changing what they do or
silently discarding information you might need later.

### Non-goals

- **No custom search engine.** Mottainai connects to and selects among
  existing MCP servers; it doesn't reimplement code search, file indexing,
  etc.
- **No default LLM summarization.** Compression is deterministic
  (rule-based) by default. A semantic/LLM-based extractor for logs is on the
  roadmap as an explicit opt-in, not a default.
- **No built-in OS sandbox for arbitrary execution.** Isolation for
  `mottainai_exec` is left to an external sandbox (container, `bubblewrap`,
  `sandbox-exec`, etc.) — see [Security model](#security-model).

## How it fits together

```text
                 ┌───────────────────────────┐
  LLM client  ⇄  │         mottainai          │  ⇄  upstream MCP servers
 (Claude Code,   │  (this project, one stdio  │     (codegraph, fff-mcp,
  Codex, etc.)   │      MCP endpoint)         │      GitHub MCP, ...)
                 └───────────────────────────┘
```

Every upstream tool is exposed under a prefixed name
(`<upstream>__<tool>`) to avoid collisions. Tool call results pass through a
compression pipeline before being returned to the client; the pre-compression
original is kept for a short time and can be retrieved on demand instead of
being lost.

```
callTool result
  → strip ANSI escapes
  → known-CLI compression (test runners, linters, git status/diff, ...)
  → JSON sampling (long arrays/strings/deep nesting)
  → line filtering (dedupe, cap length)
  → tool-local targetTokens hint
  → retain full local evidence in ArtifactStore
  → Context Runtime projection (summary/facts/diagnostics/metrics)
  → authoritative final response token/byte budget
→ bounded structured result to the LLM, original retrievable via mottainai_result_get
```

### Architecture layers

| Layer | File(s) | Role |
|---|---|---|
| Startup | `src/index.ts` | load config → connect upstreams → run stdio server |
| Relay | `src/proxy.ts` | routes `listTools` / `callTool`, applies the `<upstream>__<tool>` prefix |
| Upstream connections | `src/upstream.ts` | spawns/connects upstream MCP servers (stdio or Streamable HTTP) |
| Config | `src/config.ts` | loads `mottainai.config.json` (`mcpServers`, `profiles`, `gateway`) |
| Compression | `src/compress/*` | ANSI strip, JSON sampling, line filter, known-CLI rules, code-skeleton (tree-sitter), tool-description compression |
| Context Runtime | `src/context-runtime/*` | projects local results, applies deterministic retention priority and final token/byte budget |
| Upstream execution | `src/upstream-call.ts` | shared start → call → log → compress → retain-original pipeline |
| Tool catalog | `src/catalog.ts`, `src/broker.ts` | builds searchable `CatalogTool` entries; profile-based surface narrowing |
| Adaptive routing | `src/adaptive/*` | task classification intake, capability→provider index, trace recording, stats, policy proposals |
| Original retention | `src/retrieve.ts` | TTL-bounded in-memory store for pre-compression text (15 min / 200 entries by default) |
| Local tools | `src/local-tools.ts` | gateway's own tools: `mottainai_exec`, `mottainai_read`, `mottainai_search`, `mottainai_list`, etc. |
| Read Governor | `src/context-runtime/read-policy.ts`, `src/local-tools.ts` | progressive source disclosure for `mottainai_read`; `off` / `observe` / `warn` / `enforce` |
| Logging | `src/logging.ts` | writes pre-compression raw records to `.mottainai/log/*.jsonl` |

Context Runtime treats model context as a managed working set, not a byte
stream to be maximally compressed. The durable rationale is in
[ADR-0001](docs/decisions/0001-optimize-working-set-not-compression-ratio.md), with
the supporting [2026-08-08 Headroom/Codex experiment](docs/experiments/2026-08-08-headroom-codex-ab.md).

## Supported clients

Mottainai speaks standard MCP over stdio, so any MCP-compatible client
should be able to use it. Actual verification is limited so far:

| Client | stdio connection | Brokered/Materialized mode | Notes |
|---|---|---|---|
| Claude Code | ✅ verified | not yet verified | reconnect via `/mcp reconnect mottainai` after config changes |
| Codex | not yet verified | not yet verified | |
| Cursor | not yet verified | not yet verified | |

"Not yet verified" means untested, not known-broken. Reports from other
clients are welcome via PR.

## Supported platforms

- Linux: Tier 1 and the canonical runtime.
- WSL2: supported as a Linux runtime for Windows users.
- macOS: best effort / Tier 2.
- Native Windows: unsupported. The historical final native-Windows release/tag
  is `v0.1.2`; use WSL2 for the supported Windows-user path.

## Installation

Requires Node.js >= 22.13 and
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on `PATH` — used by
`mottainai_search` and the `code.search` backend fallback.

Initialize a workspace first. The initializer writes a portable v2
configuration and keeps personal files out of the repository's Git index:

```bash
npx -y mottainai init
```

The bare command is the MCP stdio server entry point. It never starts an
interactive wizard, because stdout is reserved for the MCP protocol:

```bash
npx -y mottainai
```

For CI or other non-interactive environments, use safe defaults explicitly:

```bash
npx -y mottainai init --yes --no-register
```

Register it with your MCP client. A user-level registration keeps personal
configuration out of a shared project file. The client may start the server
from any working directory, so the registration command must point at the
generated configuration with an absolute path:

```bash
claude mcp add -s user mottainai -- npx -y mottainai@0.1.3 serve --config /absolute/path/to/mottainai.config.json
```

For Codex, register the same way:

```bash
codex mcp add mottainai -- npx -y mottainai@0.1.3 serve --config /absolute/path/to/mottainai.config.json
```

`mottainai init` prints the exact registration command for your detected
client after writing the configuration.

If you had upstream MCP servers (e.g. `codegraph`) registered directly with
your client, remove the direct registration once they're behind the gateway,
to avoid duplicates:

```bash
claude mcp remove -s user codegraph
```

## Quick start

```bash
# Create mottainai.config.json in the workspace.
npx -y mottainai init
```

Minimal example:

```json
{
  "version": 2,
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp", "--path", "."]
    },
    "fff": {
      "command": "fff-mcp",
      "args": ["."]
    }
  }
}
```

Validate the local runtime, configuration, workspace, and upstream commands
before registering the MCP server:

```bash
npx -y mottainai doctor
npx -y mottainai doctor --json  # machine-readable output
```

Management commands use the same executable:

```bash
npx -y mottainai list
npx -y mottainai inspect codegraph
```

### Semantic Project Viewer (Issue #83)

Launch the local fixture-backed, read-only Semantic Project Viewer:

```bash
npx -y mottainai dashboard
npx -y mottainai dashboard --no-open --port 4317
```

The dashboard binds loopback, serves the versioned `/api/v1/*` Query API from
the same process, and opens a browser where practical. The canonical visual
reference is `docs/mockups/semantic-project-viewer-v2.html`; the design
contract is `docs/design/repository-semantic-model-v1.ts`. Fixture values are
explicitly marked as fixture data and are not live repository analysis.

### Git workflow task lifecycle (early exposure, Issue #34)

Behind `gateway.workflowTasks: true` in `mottainai.config.json`, the MCP
tools `mottainai_workflow_policy_explain`, `mottainai_workflow_task_start`,
and `mottainai_workflow_task_status` expose the Git workflow engine
(`src/workflow/*`, Issue #28) for early dogfooding. `task start` always
creates a governance-validated `<type>/<issue>-<slug>` branch below the
canonical repository root's `.mottainai/worktrees/` directory — never the
current branch itself, even on `main`. This is observation/dogfooding only:
no commit/push/PR/cleanup exposure yet, and Mottainai's own managed write/edit
tools don't yet enforce protected-branch rules (generated `pre-commit`/`pre-push`
Git hooks may already block protected-branch operations independently of this;
see `docs/workflow-policy.md`). The former `mottainai_worktree_new` tool has
been removed; use `mottainai_workflow_task_start` instead.

The same three operations are available from the CLI, independent of
`mottainai.config.json` (they act on a Git repository, given by `--workspace`
or the current Git repository's top level):

```bash
npx -y mottainai policy explain [--workspace path]
npx -y mottainai task start <slug> --type type --issue ref [--workspace path]
npx -y mottainai task status [--workspace path]
```

Initialization options include `--workspace`, `--scope personal|project`,
`--client claude|codex|none`, `--import claude|codex|none`, `--force`,
`--dry-run`, `--json`, `--no-register`, and `--no-doctor`. The default client
registration is pinned to the package version; use `--latest` only when
following the latest npm release is intentional. Secrets are never copied
into `mottainai.config.json`; remote authentication uses environment-variable
names or an OAuth profile. After writing the file, `init` runs `doctor` and a
stdio `initialize`/`tools/list` handshake; source checkouts without a built
entry point report that handshake as skipped.

Restart your MCP client (or reconnect) so it picks up the gateway. From here
your client sees `codegraph__*` / `fff__*` tools, plus the gateway's own
`mottainai_*` tools, all passing through compression.

At runtime, call `mottainai_runtime_status` from the MCP client to inspect
registered upstreams and their health.

### Await/watch primitives (Issue #74)

Polling is orchestration, not reasoning. Instead of an agent looping
`wait -> model turn -> status check`, Mottainai can wait on an
observable process or provider state itself, inside a single bounded MCP
call, and return once on terminal state, a meaningful change, or timeout.

- `mottainai_exec_start(command, cwd?, maxOutputBytes?)` starts a shell
  command and immediately returns an opaque `handle` — stdout/stderr are
  never inlined into this response.
- `mottainai_exec_await(handle, timeoutMs?)` blocks inside the call, up to
  a runtime-bounded timeout, until the process reaches a terminal state.
  A timeout does **not** kill the process — the started process's
  lifecycle and the `await` call's lifecycle are independent. The started
  process is force-terminated when its owning MCP connection/process
  shuts down, so an abandoned await never orphans a child process
  silently. Output continues to go through the same
  `mottainai_result_get`-backed retrieval and response-budget projection
  as `mottainai_exec`.
- `mottainai_gh_checks_await(number, timeoutMs?)` (available alongside the
  other `worktree`-gated GitHub tools) waits for a pull request's CI
  checks to reach a terminal state or change, and returns a semantic
  delta (`changed: [{ name, from, to }]`) instead of repeating a full
  snapshot on every call.

Handles are opaque, unguessable, and scoped to the MCP
connection/process that created them — a handle from one connection is
not resolvable from another, and all handles are cleaned up when their
owning connection/process shuts down. Poll interval, backoff, and jitter
are centrally bounded by the gateway (`gateway.await` in
`mottainai.config.json`); callers cannot request an arbitrary polling
frequency. This is **not** a persistent background job system — waiting
only happens inside an active MCP tool call, and nothing survives a
gateway process restart.

## Development installation

Contributors need [pnpm](https://pnpm.io/) 11.18.0:

```bash
git clone https://github.com/yohn-jp/mottainai.git
cd mottainai
pnpm install
# If pnpm reports ERR_PNPM_IGNORED_BUILDS for tree-sitter packages:
pnpm approve-builds
pnpm run build
```

At runtime, `mottainai_runtime_status` reports per-upstream state
(`disabled` / `registered` / `starting` / `ready` / `unhealthy` / `stopped`).

## Configuration

- `mcpServers` — upstream servers, by name. `transport` defaults to `stdio`;
  set `transport: "streamableHttp"` with a `url` for remote servers.
- `profiles` — named views that narrow the exposed tool surface by
  `includeCapabilities` / `denyRisk`.
- `gateway` — cross-cutting settings: `workspaceRoot`, `activeProfile`,
  `capabilityMap`, `toolMetadata`, `tokenBudgets`, `responseBudget`, `readGovernor`,
  `oauthProviderModule`.

`gateway.responseBudget` is the authoritative boundary for Mottainai-owned
local-tool responses. Defaults: soft target 1,500 tokens, hard target 3,000
tokens, and 12,000 bytes. `hardBytes` is the deterministic safety ceiling;
invalid values fail configuration validation. `tokenBudgets` and the
`mottainai_exec` `targetTokens` argument remain tool-local compression hints,
not final response limits.

`gateway.readGovernor` controls progressive `mottainai_read` disclosure. The
default `gateway.readGovernor.mode` is `"observe"`. Set
`gateway.readGovernor.mode` to `"enforce"` to deny unrestricted raw reads of
large files before source content is read. Pass `mode: "auto"` to
`mottainai_read` to select a bounded representation for large files. See
[`docs/read-governor.md`](docs/read-governor.md) for the policy modes and
range examples.

Projection retention priority, from highest to lowest: operation/status/result
identity, summary, blocking diagnostics, actionable facts, structured test and
failure data, retrieval references, essential metrics, bounded excerpts, then
verbose/raw fields. Omitted fields carry versioned projection metadata and a
retrieval-available flag. Full evidence is retained before projection when a
`result_id` is available; explicit `mottainai_result_get` is the expansion path.

Credentials: never write tokens into the config file. Remote upstreams read
header values from environment variables via `headersFromEnv` (which takes
env var **names**, not the secret values themselves), or resolve an
authenticated broker endpoint via `gateway.oauthProviderModule` for OAuth
flows. See [SECURITY.md](SECURITY.md) for what this does and doesn't
isolate.

Environment variables that tune runtime behavior. Highlights:

```bash
MOTTAINAI_COMPRESS=0                      # disable the whole compression pipeline
MOTTAINAI_COMPRESS_TOOL_DESCRIPTIONS=0    # disable only Step 3 (tool description compression)
MOTTAINAI_LOG=0                           # disable raw request/response logging
MOTTAINAI_LOG_REDACT=0                    # disable secret redaction in logs (debug only)
MOTTAINAI_TELEMETRY=1                     # enable local-only usage/savings telemetry (default off)
```

`mottainai.config.json` and `.mottainai/` (logs, traces, routing policy
state) are gitignored — they can contain upstream command paths,
environment variable names, and raw execution output. Don't commit them.
The one exception is `.mottainai/workflow.json`, the tracked Git workflow
guardrail policy — see [docs/workflow-policy.md](docs/workflow-policy.md).

## Tool space: search, describe, call

As the number of upstream tools grows, listing everything up front burns
context on its own. Mottainai exposes a searchable catalog instead:

| Tool | Purpose |
|---|---|
| `mottainai_tool_search` | search the catalog by capability / tag / name / description |
| `mottainai_tool_describe` | fetch a tool's original description and input schema, unmodified |
| `mottainai_tool_call` | call a tool by catalog id, through the same compression/retention pipeline as prefixed calls |

Search uses deterministic scoring, not a semantic/embedding model.

## Development

```bash
pnpm install
pnpm run build          # tsc → dist/
pnpm test                # fast unit + contract tier
pnpm run test:integration # filesystem/git/SQLite/CLI/process tier
pnpm run test:e2e        # stdio black-box tier, excluded from `pnpm test`
pnpm run test:package    # build + packed tarball smoke
pnpm run test:coverage   # line/function/branch coverage + gate
pnpm run verify          # all test layers + standards + build/package
pnpm run typecheck       # tsc --noEmit
pnpm run mcp <cmd>       # upstream management CLI
pnpm run policy <cmd>    # routing policy CLI
```

Test layers, mechanical suite classification, shared fixtures under
`src/test-support/`, coverage baseline/threshold policy, and the black-box
connection point under `src/e2e/` are documented in
[`docs/testing.md`](docs/testing.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow,
commit conventions, and compression-change rules (every compression change
needs both a "gets shortened" test and a "must NOT be transformed" test).

The bounded agent execution contract lives in [AGENTS.md](AGENTS.md). It
points to the authoritative documents and executable rules for exploration,
self-dogfooding, Git workflow, testing, governance, and coding standards;
`CLAUDE.md` only sets response style.

## Security model

`mottainai_exec` runs arbitrary shell commands with the privileges of the
gateway process. **There is no OS-level sandbox today.**
`gateway.workspaceRoot` constrains path resolution for the read/search/list
tools and the initial working directory for `mottainai_exec` — it does not
isolate what a command run through `mottainai_exec` can reach (`cd`,
absolute paths, child processes, and network access are not blocked).
Treat this gateway as a trusted-user, trusted-workspace tool until an
external sandbox story lands. Full details: [SECURITY.md](SECURITY.md).

## Experimental features

These are implemented and tested but not yet relied on for enforcement or
production decisions — expect rough edges and interface changes:

- **Read Governor** — active with `off`, `observe`, `warn`, and `enforce`
  modes. In `enforce` mode, reads that exceed configured limits are denied.
  Default mode is `observe` (telemetry only, no denial).
- **Caller-supervised routing policy proposals** — `mottainai_policy_propose`
  generates candidate routing policies from recorded feedback, but nothing
  is applied automatically; a human must run
  `pnpm run policy approve <version>`.
- **Telemetry** — local-only, opt-in (`MOTTAINAI_TELEMETRY=1`, default off).

## Roadmap

Implemented:

- **Step 1** — transparent pass-through proxy (handshake + relay foundation)
- **Step 2** — deterministic `callTool` result compression + TTL-bounded
  original retrieval
- **Step 3** — tool definition (`description`/`inputSchema`) pre-compression
- **Caller-supervised routing** — task classification, `request_id`,
  structured review, capability-oriented policy with human-gated updates

Planned / exploratory:

- Additional per-command output parsers
- Applying the same compression pipeline to script/skill execution mediation
- Opt-in lightweight LLM extraction for unrecognized log formats
- OS-level sandboxing story for `mottainai_exec`
- Read Governor `enforce`/`tighten` stages

## License

[MIT](LICENSE)
