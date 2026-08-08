# ADR-0001: Optimize agent working-set efficiency, not compression ratio

- Status: Accepted
- Date: 2026-08-08

## Context

Large model contexts create latency, context-pressure, and replay costs. Generic
compression can reduce an individual payload, but coding agents repeatedly
revisit the same semantic working set. If active working-set information is
evicted, the agent may need repeated retrieval and additional model turns to
reconstruct it.

The [2026-08-08 Headroom/Codex A/B experiment](../experiments/2026-08-08-headroom-codex-ab.md)
observed this pattern in the Issue #72 workload: local context and output
volumes improved, while wall time, model invocations, cumulative input, and
retrieval/page-in activity regressed in the CLI + Headroom run.

## Decision

Mottainai will optimize primarily for task-level context efficiency and active
working-set management, not maximum compression ratio.

Compression ratio is a local metric. Task-completion efficiency and correctness
are the optimization objective.

Mottainai should prefer:

```text
avoid unnecessary context admission
        +
persist semantic task/repository state
        +
project the active working set
        +
evict at meaningful phase boundaries
```

over indiscriminate compression of the entire live context stream.

## Consequences

- Compression ratio is not a primary standalone KPI.
- Retrieval/page-in rate must be measured.
- Repeated reads/retrievals are a cost, not a free recovery mechanism.
- Phase/task state should become explicit and resumable.
- Raw evidence may live outside context and be retrieved explicitly.
- Active working-set semantic facts should remain cheaply available.
- Generic compression remains available as a bounded/fallback mechanism.
- #73 burst budgets and #76 evaluation should measure task-level effects.
- Future checkpoint/rollover/context-runtime work should preserve locality.

The decision explicitly rejects:

```text
"compression ratio improved, therefore the system improved"
```

as an evaluation rule.

## Evaluation metrics

Future experiments should consider the following family of metrics:

```text
wall-clock task completion time
model invocations
cumulative input
uncached input
peak active context
context growth rate
compaction count
visible tool-output bytes
retrieval/page-in count
repeated-read count
reasoning/output tokens
validation success
acceptance-criteria compliance
review findings / implementation quality
```

No single weighted score is introduced here. A premature aggregate could hide
the locality and correctness failures this decision is intended to expose.
