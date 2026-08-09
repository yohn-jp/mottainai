# Managed hooks

Mottainai managed hooks provide one pre-operation decision path for Claude Code and
Codex. Client payloads are normalized into the versioned `HookEvent` contract in
`src/hooks/types.ts`; policy is evaluated by `src/hooks/dispatcher.ts`; adapters
only parse and project the client protocol.

## Lifecycle

```text
mottainai hooks install [--client claude|codex|all] [--mode observe|warn|enforce]
mottainai hooks status
mottainai hooks doctor
mottainai hooks repair [--client claude|codex|all]
mottainai hooks uninstall [--client claude|codex|all]
mottainai hooks explain <decision-id>
```

Project-scoped entries are managed in `.claude/settings.json` and
`.codex/hooks.json`. Install, repair, and uninstall recognize the structured
`statusMessage: "mottainai-managed-hook-v1"` entry and preserve all unrelated
settings and hooks. The owned command invokes `mottainai hooks dispatch` with
the selected client, so installed hooks reach the same dispatcher used by the
CLI. Repeated install and repair are idempotent.

The rollout policy is stored in `.mottainai/hooks.json`. Its default is
`observe`. Failure behavior is configured per operation class: read/search are
fail-open by default, while write/process/Git classes are fail-closed by
default. A missing managed replacement therefore follows that configured
failure mode; event metadata cannot change either setting. The policy timeout
is installed as the client command-hook timeout.

## Capability availability

Anti-bypass decisions use the runtime capability surface, not the existence of a
source module and not a list of executable names. The exposed local
replacements are `mottainai_read`, `mottainai_search`, and `mottainai_exec`;
the exec gateway is the managed mutation surface for native write, process, and
Git operations as well. An invalid or missing gateway configuration makes all
replacements unavailable, after which each operation follows its explicit
configured fail-open/fail-closed mode.

The process operation is classified at the native process boundary. Once
`process.exec` is governed, `cat`, an absolute path, Python, Node, unknown
native tools, and other spellings are the same class; no executable-name deny
list is consulted.

Ordinary results are compact and carry stable reason codes such as
`managed_capability_available` and `managed_capability_unavailable`. Detailed
bounded records are available through `hooks explain` by decision id.

## Domain policy providers

After generic anti-bypass evaluation, the dispatcher evaluates the applicable
domain providers in this fixed order: workflow (`#28`), context (`#70`), then
semantic (`#47/#56`). The result with the strongest decision wins using
`allow < warn < redirect < deny`; equal-strength results use the provider order.
A lower-priority allow or warning cannot weaken a stronger blocker.

The workflow provider resolves repository identity, current worktree state, the
effective workflow document, and protected-branch decisions through the
workflow domain. It never trusts a branch or repository identity supplied by a
client event, and it does not contain a `main` rule. The context provider passes
file metadata and normalized read ranges to the existing read governor; it does
not define hook-local line or byte thresholds. Read denials point to
`mottainai_read` as the bounded replacement.

Provider states are recorded as compact identifiers. `unavailable`,
`unsupported`, and `stale` are not authoritative allows; if no stronger
decision already applies, the state is surfaced in the bounded decision and
later `hooks explain` record. The current main baseline exposes no
repository-bound fresh semantic pre-operation decision, so the semantic
provider reports `semantic_authority_unavailable` for semantic mutation
events. It does not infer semantic scope from hook paths or source text.

When telemetry is enabled, `.mottainai/telemetry/summary.json` records only
provider, state, decision, and reason counters under `hooks`; client payloads,
commands, paths, and source contents are not stored.
