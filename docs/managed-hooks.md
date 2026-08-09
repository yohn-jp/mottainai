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
settings and hooks. Repeated install and repair are idempotent.

The rollout policy is stored in `.mottainai/hooks.json`. Its default is
`observe`. Failure behavior is configured per operation class: read/search are
fail-open by default, while write/process/Git classes are fail-closed when a
strict policy is enabled. Event metadata cannot change either setting.

## Capability availability

Anti-bypass decisions use the runtime capability surface, not the existence of a
source module and not a list of executable names. The initial exposed local
replacements are `mottainai_read`, `mottainai_search`, and `mottainai_exec`.
Write/edit and Git mutation replacements remain unavailable until an actual
managed tool is exposed, so those native operations are not denied solely by
this hook layer.

The process operation is classified at the native process boundary. Once
`process.exec` is governed, `cat`, an absolute path, Python, Node, and other
spellings are the same class; no executable-name deny list is consulted.

Ordinary results are compact and carry stable reason codes such as
`managed_capability_available` and `managed_capability_unavailable`. Detailed
bounded records are available through `hooks explain` by decision id.
