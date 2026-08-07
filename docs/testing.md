# Testing

This document explains how tests in this repository are organized by
responsibility, what shared fixtures exist, and where a new test should go.
It complements [`coding-standards.md`](coding-standards.md) (which owns the
production dependency-direction rules, including the `testInfrastructure`
layer) rather than duplicating it.

Tests are colocated with the code they cover (`foo.ts` / `foo.test.ts`) and
run with Node's built-in test runner via `tsx`. This document does not move
any existing test file — classification is by convention and by the fixtures
a test imports, not by directory reshuffling. New tests should follow the
convention below; existing tests can adopt shared fixtures incrementally as
they're touched.

## Layers

| Layer | What it guarantees | Lives where | Depends on |
|---|---|---|---|
| **Unit** | Pure logic: parsers, policy resolution, state transitions, IR schema. No process/filesystem/git/MCP transport. | `*.test.ts` next to the module, e.g. `src/workflow/policy/resolve.test.ts`, `src/semantics/ir/schema.test.ts`, `src/compress/*.test.ts` | Nothing external |
| **Integration** | A contract between two or more real components: config+runtime, policy+executor, state store+repository identity, git adapter+workflow logic. | `*.test.ts` next to the module, e.g. `src/workflow/domain/task.test.ts`, `src/workflow/git/hooks.test.ts`, `src/state/sqlite-store.test.ts` | Real git subprocess, real filesystem, real (in-memory or temp-file) sqlite — never the developer's real environment (see Determinism below) |
| **Contract / Boundary** | Mottainai's external boundary: MCP tool schema, structured input/output, error contract, (de)serialization, config boundary, CLI/runtime entrypoint. | `*.test.ts` next to the module, e.g. `src/catalog.test.ts`, `src/envelope.test.ts`, `src/local-tools.test.ts`, `src/config.test.ts`, `src/semantics/ir/serialize.test.ts` | Same as integration; asserts on the shape of what crosses the boundary, not just the internal result |
| **E2E / black-box** | The gateway process itself, spoken to over real stdio MCP protocol, from outside. | `src/e2e/*.e2e.spec.ts` | A real child process (see below) |

Unit, integration, and contract tests all end in `.test.ts` and all run
under the default `pnpm test`. The distinction between the three is
responsibility, not tooling — a given file's docstring/test names should
make clear which boundary it's pinning down. When a new test clearly adds a
new tier to an existing file (e.g. a boundary-shape assertion added to a
file that was previously pure unit tests), a short comment saying so is
enough; you don't need to split the file.

## Where to add a new test

- Extending existing behavior in a module: add to that module's existing
  `*.test.ts`.
- New module: create `<module>.test.ts` next to it. This is the default and
  covers unit, integration, and contract/boundary tests alike.
- New black-box, real-process, real-stdio-protocol coverage (the tier #22
  builds out): add to `src/e2e/`, filename ending in `.e2e.spec.ts`.

### Why E2E uses `.spec.ts`, not `.test.ts`

`pnpm test` runs `node --import tsx --test "src/**/*.test.ts"`. A file
ending in `.e2e.spec.ts` does not match that glob, so it does not run as
part of the fast default suite — only `pnpm run test:e2e` (glob
`src/e2e/**/*.spec.ts`) picks it up. This is deliberate: E2E tests spawn a
real subprocess and talk real MCP protocol over stdio, so they're slower
and more failure-prone than everything else, and CI keeps `pnpm test` fast
by design. `scripts/architecture-check.mjs` still exempts `*.spec.ts` from
production-file rules (its `testFilePattern` matches `.test.` and `.spec.`
alike), so these files are free to import test-only helpers and call `test()`
at the top level like any other test file.

Do not use the `.spec.ts` suffix for anything other than this E2E tier —
it exists specifically to opt a file out of the default `pnpm test` run.

## Shared fixtures and helpers (`src/test-support/`)

`src/test-support/` is a `testInfrastructure` layer (see
[`coding-standards.md`](coding-standards.md#boundary-model)): it may import
from any production layer to build fixtures, but no production code may
import from it. It is excluded from the published `dist` build
(`tsconfig.build.json`).

| Export | From | Purpose |
|---|---|---|
| `createTempDir(t, prefix?)` | `tmp-dir.ts` | Isolated temp directory under `os.tmpdir()`, `realpathSync`-resolved, removed in `t.after()` even on failure. |
| `createTempGitRepo(t, options?)` | `tmp-git-repo.ts` | `git init` in a `createTempDir`, isolated from developer global/system git config, committed by default (`options.initialCommit = false` to skip). |
| `runGit(args, cwd, env?)` | `tmp-git-repo.ts` | Runs `git` with the same isolated env as `createTempGitRepo`; use for any git call beyond the initial repo setup (clone, push, worktree, checkout, ...). |
| `isolatedGitEnv(extra?)` | `tmp-git-repo.ts` | The env object itself, for tests that need to layer one more override (e.g. a broken `PATH`) on top of the isolation. |
| `createWorkflowStore(t)` | `workflow-store.ts` | In-memory (`:memory:`) `WorkflowSqliteStateStore`, opened and closed via `t.after()`. |
| `withEnv(t, overrides)` | `env.ts` | Temporarily sets/unsets `process.env` keys, restores the previous values in `t.after()` even on failure. |
| `withDeterministicEnv(t, overrides?)` | `env.ts` | `withEnv` pre-loaded with `TZ=UTC`, `LANG=C`, `LC_ALL=C`. |
| `isolatedHomeDir(t, prefix?)` | `env.ts` | A temp dir wired up as `HOME`/`USERPROFILE` for the duration of the test. |
| `buildTestConfig(options?)` / `writeTestConfig(dir, options?)` | `config-fixture.ts` | Minimal `MottainaiConfig` (empty `mcpServers`, `gateway.workspaceRoot: "."`) with no network/upstream dependency; `writeTestConfig` also serializes it to disk. |
| `assertOk(result)` / `assertErr(result)` | `assertions.ts` | Narrowing assertions for this repo's pervasive `{ ok: true, ... } \| { ok: false, ... }` result unions. |
| `assertEnvelopeShape(value)` | `assertions.ts` | Asserts an object satisfies the shared `OUTPUT_SCHEMA` contract (`src/envelope.ts`) — for contract/boundary tests. |
| `resolveTsxLoaderUrl()` | `tsx-loader.ts` | Resolves the `tsx` ESM loader to an absolute `file://` URL from this module's own location, independent of the caller's `cwd`. Used to spawn `src/index.ts` from an arbitrary black-box workspace (see E2E below). |

All of the above are also re-exported from `src/test-support/index.ts` for
convenience; importing the specific file is equally fine and keeps the
per-test dependency list explicit.

`isolatedGitEnv` and `env.ts` are the only two files in `src/test-support/`
listed in `scripts/architecture-check.mjs`'s `environmentBoundaryFiles`
allowlist — they are the ones that legitimately read/write `process.env` to
build isolation. Everything else in `src/test-support/` should stay outside
that allowlist; if a new fixture needs `process.env`, add it there with a
one-line reason, matching the existing entries.

## Determinism and environment isolation

Tests must not depend on:

- the real `HOME`, the developer's real `~/.gitconfig` / system git config,
  or an ambient `git` identity — `createTempGitRepo` / `runGit` isolate
  `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` to a null destination and set a
  fixed commit identity; `isolatedHomeDir` isolates `HOME` for tests that
  touch config/init/doctor code paths.
- the developer's real user config, npm/global installation, or network —
  `buildTestConfig`/`writeTestConfig` never reference a real upstream MCP
  server or a real network endpoint; nothing in `src/test-support/` shells
  out to `npm`/`pnpm` global state.
- execution order, machine, timezone, or locale — use `withDeterministicEnv`
  when a test's assertions could vary with `TZ`/`LANG`/`LC_ALL`. Prefer
  passing explicit values into pure functions (see `src/state/paths.ts`'s
  `env`/`platform` parameters) over touching `process.env` at all wherever
  the function under test already supports injection.
- current working directory or branch name — `createTempDir` /
  `createTempGitRepo` always mint a fresh temp path and a fixed default
  branch (`main` unless overridden); don't assert against `process.cwd()`
  or an ambient branch name.

Every fixture that creates something (a temp dir, a temp repo, an in-memory
store, an env override) registers its own cleanup via `t.after()`, which
runs even when the test fails — there is no fixture in
`src/test-support/` that leaks state on failure.

## E2E / black-box (`src/e2e/`)

`src/e2e/stdio-client.ts` exports `startGatewayViaStdio({ cwd, configPath,
env? })`: it spawns `node --import <resolved tsx loader> src/index.ts serve
--config <configPath>` and connects an MCP `Client` over
`StdioClientTransport`. It does **not** depend on a `dist/` build — it runs
`src/index.ts` directly through `tsx`, resolved via `resolveTsxLoaderUrl()`
so it works regardless of the spawned process's `cwd` (this mirrors the
pattern already proven in `src/init.test.ts`'s client-registration
round-trip test). When `env` is omitted, the MCP SDK's own safe default
env (a filtered allowlist, not the full host environment) is inherited.

`src/e2e/gateway.e2e.spec.ts` is a single smoke test: start the gateway
against a `writeTestConfig` fixture, `listTools()`, and `callTool()` one
read-only local tool, asserting the structured envelope contract via
`assertEnvelopeShape`. It exists to prove the connection point works, not
to be an exhaustive black-box suite.

**#22 should build its stdio black-box suite on top of
`startGatewayViaStdio` and the fixtures in `src/test-support/`** —
`writeTestConfig` for the workspace's `mottainai.config.json`,
`createTempDir`/`createTempGitRepo` for the workspace itself,
`assertEnvelopeShape` for contract assertions on tool results — and should
add new cases to `src/e2e/` as `*.e2e.spec.ts` files so they stay in the
`test:e2e` tier rather than growing `pnpm test`.

## Running tests

```bash
pnpm test           # fast tier: unit + integration + contract/boundary (src/**/*.test.ts)
pnpm run test:e2e    # black-box tier: src/e2e/**/*.spec.ts (real subprocess, real stdio)
pnpm run test:all    # both, sequentially
```

CI runs `pnpm test` and `pnpm run test:e2e` as separate steps in the same
job (`.github/workflows/ci.yml`), on both supported Node versions, right
before the build step. Keeping them separate means a black-box failure and
a fast-suite failure are never conflated, and the fast suite's runtime
stays representative of what `pnpm test` costs a contributor locally.
