# Context Runtime rollout and telemetry

Context Runtime controls the agent-visible projection at the MCP boundary. Full command/result evidence remains in the existing result store and is retrieved explicitly by `result_id`; local token estimates are sizing signals, not model billing or provider accounting.

## Recommended rollout

1. Start with `readGovernor.mode: "observe"` and `burstBudget.mode: "observe"`. Keep the default telemetry opt-in disabled while validating a representative workload.
2. Enable local telemetry for a bounded dogfood window, inspect `mottainai_telemetry_summary`, and compare returned/omitted bytes, projected token estimates, governor decisions, burst pressure, await polls, and dedupe savings.
3. Move selected read paths to `warn` after retries and actionable diagnostics remain stable. Use `enforce` only for broad raw reads after exact range/outline/symbol fallbacks are verified.
4. Move selected burst policies to `warn`, then `enforce`, only when the per-response hard cap and result retrieval path are known to preserve failure diagnostics. Keep failure projections protected and retain the backing `result_id`.

The staged controls are runtime approximations of context pressure. They cannot observe client-internal model-turn boundaries, context caching, replay, or billing.

## Inspecting local telemetry

Telemetry is disabled unless explicitly opted in:

```sh
MOTTAINAI_TELEMETRY=1 \
MOTTAINAI_TELEMETRY_FILE=/path/to/telemetry-summary.json \
mottainai --config /path/to/mottainai.config.json
```

Call the local `mottainai_telemetry_summary` tool during the same MCP session. The response exposes `projection_totals`, `expansion`, `read_governor`, `burst`, `await`, and `dedupe`; `metrics` contains their compact headline counters. The persisted summary JSON contains aggregate counters only and is written with restricted file permissions. No source text, command output, prompts, environment dump, credential, or conversation log is retained.

Important fields:

- `projection_totals`: raw/stored/returned/omitted bytes, projected tokens, and omitted token estimates.
- `expansion`: explicit result-expansion count, bytes, and estimated tokens. `retrievals` also includes retrieval/search operations and is not the expansion denominator.
- `read_governor`: allow/observe/warn/deny decisions and returned raw line/byte volume by requested mode and rule.
- `burst`: pressure samples, projected/omitted bytes/tokens, and responses reduced or only observed as reducible.
- `await`: internal polls, elapsed wait, state changes, terminal/timeout/cancelled outcomes, and outward responses avoided.
- `dedupe`: identity hits/misses and estimated bytes/tokens avoided. This is session-local result identity, not Repository Semantics (#52) or a canonical fact cache.

## Measurement discipline

Use deterministic bytes, conservative `4 bytes/token` estimates, call count, expansion count, and correctness/diagnostic assertions as primary evidence. Wall-clock time is supplementary. A full result is always available only while the configured artifact retention permits it; an omitted projection must expose a retrieval path rather than silently claiming that raw content was returned.
