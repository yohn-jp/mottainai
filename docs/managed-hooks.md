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
