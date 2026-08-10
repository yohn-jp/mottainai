# Managed Hooks dogfood report

測定日: 2026-08-10

Issue #126のdogfood証跡。決定的fixtureは
`src/e2e/managed-hooks-dogfood.spec.ts`。fixtureは一時Git repositoryを作り、
Claude/Codexのpayloadを同じ `hooks dispatch` へ送り、クライアント固有の
exit/stdout projectionまで検証する。実行コマンド:

```text
pnpm exec tsx --test src/e2e/managed-hooks-dogfood.spec.ts
```

## Deterministic result

| area | evidence | result |
| --- | --- | --- |
| client paths | Claude Code / Codex adapter → shared dispatcher | pass; both clients, 4 tests |
| rollout | observe → warn → enforce, same native process event | pass; allow 2 / warn 2 / redirect 2 |
| process bypass | `cat`, absolute `cat`, Python, Node, `rg`, unknown executor | pass; all caught at `process.exec` boundary |
| Git bypass | commit and env-prefixed push on protected `main` | pass; workflow provider returns bounded deny + `mottainai_exec` |
| read policy | broad raw read vs exact bounded range | pass; broad denied by #70, bounded read usable in observe |
| lifecycle | missing, drifted, duplicate install, repair, uninstall | pass; doctor distinguishes state; unrelated hooks preserved |
| capability fault | missing gateway/replacement | pass; configured fail-open produces empty response, no misleading `use=` |
| semantic state | current provider and stale composition fixture | explicit unavailable/stale; no fabricated enforcement |

The process fixture is intentionally not an exhaustive hostile-process test. It
proves operation-boundary classification, not OS isolation or protection from a
local process that edits configuration or skips a client hook.

## Context and overhead

The baseline recurring `AGENTS.md` file is 5,902 bytes (about 1,476 tokens at
the local 4 bytes/token estimate). Review classified its rules as repository
scope/reasoning, task/worktree lifecycle, validation, fault safety, and
authority precedence. Only the one-line instruction to treat a hook denial as
authoritative was removed; the hook boundary already makes that operation
unavailable and rollout/rollback authority is now in `docs/managed-hooks.md`.
All task/worktree, validation, destructive-operation, and authority rules
remain: the current repository fallback policy is `standard` (source
write/stage/commit are advisory), and current semantic state is unavailable.

| metric | observed value | method |
| --- | ---: | --- |
| mechanical guidance before / after | 5,902 / 5,779 bytes; 1,476 / 1,445 estimated tokens; 123 bytes / 31 tokens removed | UTF-8 byte count of tracked `AGENTS.md`; one hook-boundary duplicate removed |
| hook-visible response bytes | 527 bytes / 132 estimated tokens | six rollout responses, UTF-8 bytes and ceil(bytes/4) |
| hook counts | allow 4 / warn 2 / deny 6 / redirect 14 | rollout matrix plus bounded-read allow, protected Git/read denials, and native process redirects; client projection is Claude exit 2 or Codex structured deny |
| retries / false denials | 0 / 0 observed | no retry loop; observe bounded-read control remained usable |
| bypass attempts caught / missed | 18 / 0 in the deterministic matrix | 12 native spellings + 4 Git/client combinations + 2 broad-read client cases; see fixture |
| decision latency p50 / p95 / max | 954 / 996 / 996 ms | six isolated source CLI dispatches during the final full verification run; includes process startup and `tsx`, local operational evidence only |
| explicit explain expansions | 0 in this matrix | ordinary output stayed bounded; explanations remain an explicit separate command |

The hook-visible response is event-triggered counter-cost, not a model billing
measurement. The measured net recurring guidance reduction is therefore **123
bytes** (about 31 local-estimated tokens). A future rollout can remove only a
rule whose exact operation boundary is active, reliable, and enforce-mode tested
for every supported client.

## Fault and recovery notes

- Missing or invalid runtime capability follows the operation's configured
  `open`/`closed` failure mode. The fixture asserts that an unavailable
  replacement never appears as `use=<tool>`.
- Duplicate installation is idempotent. Drift is reported by `status`/`doctor`,
  and repair rewrites only the marker-owned entry.
- Uninstall removes the managed entry while preserving unrelated Claude and
  Codex hook configuration.
- Unknown client versions/configuration are reported as incompatible or
  unsupported by the existing doctor fixture in `src/hooks/hooks.test.ts`.
- Timeout, malformed payload, invalid policy, and dispatcher-path failures
  remain covered by the existing deterministic hook contracts; no raw fault
  output is exposed to the client.

## Semantic and real-client gate

The current main `createSemanticPolicyProvider()` returns
`semantic_authority_unavailable` for source mutation/Git events because no
repository-bound fresh pre-operation semantic authority is exposed. The stale
composition fixture verifies that stale state is not converted into an
authoritative allow. This is an explicit #125/Repository Semantics owner gap,
not evidence for removing semantic instructions or enabling general enforce.

Local executable discovery on this run found:

```text
Claude Code 2.1.195
Codex CLI 0.146.0
```

The isolated real-client runner (`node scripts/run-managed-hooks-real-client.mjs
all`) installed both managed entries, but did not produce valid dogfood
evidence:

- Claude Code exited before a tool call with the exact bounded error
  `Not logged in · Please run /login` from `--print`; the local `claude auth
  status` command reports an account, but this noninteractive runtime did not
  accept that session.
- Codex CLI completed a Luna-model invocation with the managed entry present and
  two `command_execution` items, but the explanation log contained zero hook
  evaluations. The client therefore did not consume this project hook entry or
  did not emit the adapter's expected payload on this invocation. It is not
  counted as real-client enforcement evidence.

This is the exact external/client-protocol blocker. The deterministic fixture
is the reproducible CI evidence; prompts, sessions, source, environment, and
credentials are excluded from this report. Luna Cloud availability is not
inferred from adapter or fixture execution, and no real-client success is
claimed until a client-generated hook evaluation is observed.
