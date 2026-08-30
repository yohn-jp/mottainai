# Managed Hooks dogfood report

測定日: 2026-08-30

Issue #126のdogfood証跡。決定的fixtureは
`src/e2e/managed-hooks-dogfood.spec.ts`。fixtureは一時Git repositoryを作り、
Claude/Codexのpayloadを同じ `hooks dispatch` へ送り、クライアント固有の
exit/stdout projectionまで検証する。実行コマンド:

```text
node --import tsx --test src/e2e/managed-hooks-dogfood.spec.ts
```

## Deterministic result

| area             | evidence                                                    | result                                                                   |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| client paths     | Claude Code / Codex adapter → shared dispatcher             | pass; both clients, 4 tests                                              |
| rollout          | observe → warn → enforce, same native process event         | pass; allow 2 / warn 2 / redirect 2                                      |
| process bypass   | `cat`, absolute `cat`, Python, Node, `rg`, unknown executor | pass; all caught at `process.exec` boundary                              |
| Git bypass       | commit and env-prefixed push on protected `main`            | pass; workflow provider returns bounded deny + `mottainai_exec`          |
| read policy      | broad raw read vs exact bounded range                       | pass; broad denied by #70, bounded read usable in observe                |
| lifecycle        | missing, drifted, duplicate install, repair, uninstall      | pass; doctor distinguishes state; unrelated hooks preserved              |
| capability fault | missing gateway/replacement                                 | pass; configured fail-open produces empty response, no misleading `use=` |
| semantic state   | current provider and stale composition fixture              | explicit unavailable/stale; no fabricated enforcement                    |

The process fixture is intentionally not an exhaustive hostile-process test. It
proves operation-boundary classification, not OS isolation or protection from a
local process that edits configuration or skips a client hook.

## Context and overhead

The baseline recurring `AGENTS.md` file is 5,902 bytes (about 1,476 tokens at
the local 4 bytes/token estimate). The bounded review classified the guidance
as follows:

| classification                    | current guidance                                                                                 | rollout result                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| reasoning/project knowledge       | scope, authority precedence, architecture, and validation rationale (`AGENTS.md` §§1, 3, 5–6, 9) | retain                                                                               |
| hook-enforceable mechanical rules | broad-read response and hook-denial boundary (`AGENTS.md` lines 40, 55, 96)                      | retain until both client paths and semantic authority are proven; no removal claimed |
| transitional/duplicated guidance  | task/worktree lifecycle and completion safety (`AGENTS.md` §§2, 4, 7–8)                          | retain; these are not equivalent to the current pre-operation hook path              |

The hook-denial authority rule therefore remains in recurring guidance because
fresh semantic state and valid real-client hook evidence are unavailable;
deterministic adapter coverage does not prove equivalent enforcement for every
supported client. The current repository fallback policy is `standard` (source
write/stage/commit are advisory), and current semantic state is unavailable.

| metric                             |                                                       observed value | method                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mechanical guidance before / after | 5,902 / 5,902 bytes; 1,476 / 1,476 estimated tokens; 0 bytes removed | UTF-8 byte count of tracked `AGENTS.md`; no rule removed while real-client and fresh-semantic evidence remain unavailable                                     |
| hook-visible response bytes        |                                     527 bytes / 132 estimated tokens | six rollout responses, UTF-8 bytes and ceil(bytes/4)                                                                                                          |
| hook counts                        |                              allow 4 / warn 2 / deny 6 / redirect 14 | rollout matrix plus bounded-read allow, protected Git/read denials, and native process redirects; client projection is Claude exit 2 or Codex structured deny |
| retries / false denials            |                                                       0 / 0 observed | no retry loop; observe bounded-read control remained usable                                                                                                   |
| bypass attempts caught / missed    |                                   18 / 0 in the deterministic matrix | 12 native spellings + 4 Git/client combinations + 2 broad-read client cases; see fixture                                                                      |
| decision latency p50 / p95 / max   |                                                   873 / 908 / 908 ms | six isolated source CLI dispatches during the final `pnpm run test:e2e` run; includes process startup and `tsx`, local operational evidence only              |
| explicit explain expansions        |                                                     0 in this matrix | ordinary output stayed bounded; explanations remain an explicit separate command                                                                              |

The hook-visible response is event-triggered counter-cost, not a model billing
measurement. The measured net recurring guidance reduction is therefore **0
bytes**. A future rollout can remove only a rule whose exact operation boundary
is active, reliable, and enforce-mode tested for every supported client.

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

The Issue #316 real-client proof selected Claude Code as one genuinely
supported client. Local executable discovery found:

```text
Claude Code 2.1.251
Codex CLI 0.150.1
```

Mottainai version: `0.7.0`. The isolated runner command was:

```text
node scripts/run-managed-hooks-real-client.mjs claude
```

It installed the project-managed Claude entry in `enforce`, then `status` and
the Claude-specific `doctor` projection reported an installed, compatible,
healthy managed entry and a resolvable dispatcher. The client used its normal
project settings/MCP path with `--permission-mode auto` and an explicit tool
allow-list; no permission, sandbox, hook-trust, or session bypass flag was
used. The bounded live aggregate was:

```json
{
  "status": "completed",
  "client": "claude",
  "clientVersion": "2.1.251 (Claude Code)",
  "mode": "enforce",
  "hookEvaluations": 3,
  "decisions": {
    "redirect:managed_capability_available": 2,
    "allow:managed_capability_path": 1
  },
  "toolCalls": {
    "Bash": 1,
    "mcp__mottainai__mottainai_exec": 1
  },
  "toolResultErrors": { "Bash": 1 },
  "managedSuccesses": 1,
  "evidenceStatus": "proved",
  "cleanup": { "uninstallExitCode": 0, "configValid": true, "managedEntryPresent": false }
}
```

The controlled native `Bash` process attempt was denied by the live hook with
`redirect:managed_capability_available`; the equivalent bounded
`mcp__mottainai__mottainai_exec` call completed successfully through the managed
path. The adapter now recognizes that registered managed MCP path so enforce
mode does not redirect a replacement back into itself. Unknown MCP/native tools
remain on the governed `process.exec` boundary.

The deterministic hook contract test also passes the timeout and invalid-policy
fail-closed cases. Cleanup removed only the Mottainai-owned entry and left a
valid disposable client configuration without the managed marker. Prompts,
sessions, source, environment, and credentials are excluded from this report;
the deterministic fixture remains the reproducible CI evidence. Codex's own
trust flow remains a separate blocker when it is selected without client-side
approval, and is never counted as Claude proof or silently treated as enforced.
