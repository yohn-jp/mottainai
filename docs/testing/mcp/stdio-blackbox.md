# Stdio MCP black-box suite

Issue #22 starts the public entrypoint as a real process without importing
Mottainai internals. The observable surfaces are stdin, stdout, stderr, exit
status, signals, cwd, environment, and filesystem state.

## Execution layers

| Suite | Target | Command | Responsibility |
| --- | --- | --- | --- |
| E2E / black-box | Built `dist/index.js` | `pnpm run test:e2e` (after build) | MCP protocol, lifecycle, malformed input, configuration/provider faults, and cleanup |
| Package | Same packed artifact | `pnpm run test:package` | Explicit build, `npm pack --ignore-scripts`, package protocol subset, and existing package smoke |
| Harness integration | Child fixture | `pnpm run test:integration` | stdout fragments/blanks, partial responses, timeout diagnostics, stderr tails, and forced cleanup |

`test:e2e` runs `src/e2e/mcp-stdio.e2e.spec.ts` in the formal E2E tier. The
former standalone command has been retired and integrated into the official
taxonomy.

`test:package` uses a runner that builds once, packs one artifact, and passes
the same tarball to the package protocol subset and `scripts/smoke-test.mjs`.
Smoke tests own installation into an isolated consumer, the launcher, init,
and missing-config behavior. The package subset owns the extracted artifact's
binary and MCP protocol. Its dependency symlinks are for protocol observation,
not evidence of installation correctness.

`npm pack` does not use `prepack`. The build is explicit, and the `dist` at
that point is verified as an `--ignore-scripts` artifact.

## Runtime/build identity (Issue #27)

`pnpm run build` runs
[`scripts/generate-build-metadata.mjs`](../../../scripts/generate-build-metadata.mjs)
and generates `dist/runtime-build-metadata.json`. Metadata contains the schema,
package name/version, `build_id`, source state, and `artifact: "npm"`. A clean
source includes the Git SHA in the build ID; dirty or unavailable sources state
that condition. This is build identity before packing and does not mean the
package test passed.

The runtime canonical projection is produced by
[`src/runtime-diagnostic.ts`](../../../src/runtime-diagnostic.ts), a versioned
bounded allowlist. When packed metadata is readable from the entrypoint's
package root, it reports `distribution_kind: "packed/npm"` and the
package/version/build ID as build provenance. Source execution has development
identity; repacking without metadata is `unknown/repackaged`. An unrelated Git
checkout in the consumer's cwd is never adopted as artifact identity.
Diagnostics include the config path source, Node/platform, entrypoint,
workspace/state, and bounded upstream health/failure, but no secret or raw
credential.

`doctor --json`, early-startup `Runtime diagnostic` errors, and MCP
`mottainai_runtime_status` use this same identity projection. Release and
consumer proof therefore records one artifact chain through the tarball's
package-test-verified `build_id`, package version, and `distribution_kind`,
then reconfirms them in runtime diagnostics. Runtime status alone, or only
source-level `build`/`test`, is not package or release proof.

`scripts/mcp-stdio-package.test.mjs` verifies that metadata is included in the
tarball, packing does not rebuild the tested `dist`, packed identity survives
consumer cwd/config resolution, and `runtime_status` returns the same identity.
The release workflow stores the built tarball as an artifact and publishes the
same tarball after it passes the isolated Node 24 consumer smoke test.

## Black-box harness

The shared `McpStdioClient` owns:

- child-process spawning, request IDs, newline-delimited JSON-RPC, and
  notifications;
- raw strings/Buffers, partial writes, stdin EOF/disconnect;
- response/process-close deadlines, stdout/stderr capture, bounded transcripts,
  and stdin error containment;
- unterminated stdout fragments at close, blank lines, and JSON-RPC purity; and
- child-tree cleanup, forced kill, and spawn-failure diagnostics.

Timeout diagnostics include operation/method, request ID, process exit state,
the recent stdout transcript, and a bounded stderr tail. They do not expose all
environment variables or secrets. Upstream startup failures include only a
redacted provider, phase, deadline, and stderr/transcript summary in the
JSON-RPC error; raw stderr remains on the gateway process's stderr. Status and
trace retain only the base error.

Gateway shutdown starts on stdin EOF, client disconnect, SIGINT, or SIGTERM. It
closes each ready upstream within `UPSTREAM_CLOSE_TIMEOUT_MS` before closing the
server. Harness forced kill is a safety net, not a success condition. On child
`exit`, pending requests are not rejected; on `close`, stdout fragments are
flushed before unresolved requests are rejected.

The assertion path does not import the production server object. Fixture
upstreams are local processes only and do not depend on network, ports, or the
developer's HOME/configuration.

## Protocol matrix

| Case | Expected contract |
| --- | --- |
| initialize / initialized | Valid JSON-RPC handshake and stdout purity |
| tools/list / tools/call | Deterministic catalog, representative local call, and EOF shutdown |
| Malformed complete JSON | No uncontrolled crash; subsequent requests stay synchronized |
| Partial JSON / partial then EOF | Frame buffering and bounded shutdown |
| Pre-init request | SDK-contract response without crash or desynchronization |
| Duplicate initialize | SDK-contract response and subsequent request continuity |
| Unsupported method / unknown tool / invalid args | Deterministic JSON-RPC error and process continuity |
| Missing / malformed config | Deterministic stderr, non-zero exit, and no stdout contamination |
| Client disconnect / stdin EOF | Bounded gateway shutdown and upstream cleanup |
| SIGINT / SIGTERM | Graceful shutdown using the actual signal |
| Unterminated stdout / blank stdout | Retained as a protocol violation after close |

## Upstream fault matrix

Fixture modes are `normal`, `exit-immediately`, `hang-startup`, `large-stderr`,
`fail-list`, `fail-list-secret`, `malformed-result`, and
`ignore-termination`. Each case verifies provider identity, phase, cleanup, and
stdout purity.

- Immediate exit: provider error, no permanent hang, and child cleanup.
- Startup hang: `2_000ms` initialize deadline, provider/phase/stderr/transcript
  diagnostics, and forced cleanup.
- Large stderr: drain `768KiB` through the pipe, keep it out of gateway stdout,
  and bound the stderr tail.
- `listTools` failure: provider error, preserved MCP error code, and continued
  gateway requests and shutdown.
- Secret stderr: keep the raw marker on local stderr only; omit it from the
  JSON-RPC response, runtime status, and trace.

## Failure taxonomy

| Taxonomy | Observable surface | Exit behavior | stdout/stderr |
| --- | --- | --- | --- |
| Protocol error | JSON-RPC error response and subsequent request | Process continues and exits normally at EOF | stdout contains valid protocol only; stderr may contain auxiliary diagnostics |
| Configuration error | stderr and exit status | Non-zero, bounded exit | No non-protocol string on stdout |
| Provider/upstream error | JSON-RPC provider error, runtime status, redacted phase diagnostics | Gateway may continue; shutdown closes child | stdout remains protocol-only; raw stderr stays local |
| Expected process exit | EOF, disconnect, signal, close | Bounded graceful exit | Existing stdout frames are finalized at close |
| Timeout | Operation deadline, process state, redacted transcript | Server closes after upstream close timeout; harness forced cleanup only when needed | Raw stderr is not returned to caller/status/trace |
| Forced cleanup | Graceful close deadline exceeded | Harness safety net; never treated as natural-exit success | Cleanup failure is attached to the original error |

stderr itself is not a protocol violation; only stdout is protocol-reserved.

## Time budgets

Shared values are managed by
[`scripts/lib/mcp-blackbox-timeouts.mjs`](../../../scripts/lib/mcp-blackbox-timeouts.mjs).

| Operation | Budget |
| --- | ---: |
| Process startup | 3s |
| Request | 5s |
| Upstream initialize/listTools | 2s |
| Graceful shutdown | 5s |
| Forced cleanup/process disappearance | 5s |
| Fixture readiness | 3s |
| Test case | 30s |

Polling is reserved for observing fixture filesystem state. Do not use
arbitrary sleep to decide protocol readiness.

## Platform

Linux is Tier 1 and the canonical runtime. WSL2 is supported as a Linux
runtime. macOS is best effort and Tier 2. Native Windows is unsupported;
Windows users should use WSL2. `v0.1.2` is the historical final native-Windows
release/tag.

PR CI uses Ubuntu and Node 24 for canonical full validation. EOF, disconnect,
built-dist protocol, package subset, SIGINT/SIGTERM, and bounded cleanup are
verified on the supported Linux path. Packing and extraction must also work
when generated paths contain spaces.
