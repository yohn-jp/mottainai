# Deterministic fault-injection contract

This is the authority for the boundary tests introduced by Issue #23.
Production defaults use Node's direct implementations; only tests replace
`BoundaryOperations`. Fault control is unreachable through configuration files,
environment variables, or MCP/CLI arguments. Tests give `FaultInjector` an
operation name and failure count, and do not depend on sleep, randomness, or
real-process races.

## Boundaries

The three operation groups in `src/boundary.ts` are used:

| Kind | Representative operations | Primary targets |
| --- | --- | --- |
| `file` | `config.temp.write`, `config.temp.permission`, `config.rename`, `logging.write`, `logging.rotate`, `telemetry.write` | Configuration, logs, telemetry, and SQLite filesystem/transaction boundaries |
| `process` | `process.spawn`, `process.group.sigterm`, `process.group.sigkill` | Child-process startup and termination |
| `storage` | `artifact.id`, `artifact.insert` | Artifact ID issuance and single-commit storage |

Existing `UpstreamConnector`, deferred promises, and explicit state
transitions are reused as process-lifecycle injection points. Do not add tests
that make a race reproducible only by shortening a timeout.

## Invariant table

| Operation | Fault point | Expected post-state |
| --- | --- | --- |
| Configuration replace | temp write / close / permission / backup copy / rename | Original file unchanged; no temporary directory. If cleanup also fails, primary error and secondary diagnostic remain separate. |
| Configuration replace | Backup collision | Existing `.bak` is not overwritten; a numbered backup is used. |
| Logging | directory / write / rotate / retention | MCP process continues; fallback diagnostics contain no raw error or secret. |
| Telemetry | read / directory / write | Aggregation API continues; failed snapshots do not create unresolvable results; `flush()` emits deterministically. |
| Migration | partial DDL / version record / commit / rollback | Transaction rolls back, version is not recorded, handle closes, and a later retry applies cleanly while retaining the primary cause. |
| Artifact | ID / insert / oversize | A failed insert returns no new ID and preserves existing entries and byte/TTL/count limits; a marker is exposed only after successful storage. |
| Process | spawn / termination | Bounded structured result, no handle on failure, and existing cleanup is not blocked. |
| Upstream | connector / start-close race / client close | No ready handle is resurrected; close failure does not hide the primary failure; child and transport are not reused. |

For new critical persistent or process-boundary code, add a fault case to the
same integration/process suite in addition to the success case. The case must
table the failure operation, pre-state, post-state, cleanup, and retry
semantics. Fault tests perform termination in `finally` or `after` and never
pass secret values into error messages.
