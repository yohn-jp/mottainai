---
experiment: headroom-codex-ab
date: 2026-08-08
repository: yohn-jp/mottainai
issue: 72
base_sha: e8fea09d32cb6426480bf12fbc7e2e7dacf0659f

baseline:
  harness: codex-vscode
  model: gpt-5.6-luna
  reasoning_effort: max

candidate:
  harness: codex-cli
  middleware:
    - headroom
  model: gpt-5.6-luna
  reasoning_effort: max

decision:
  outcome: rejected-as-default-wrapper
  reason: task-level-regression
---

# Headroom/Codex A/B experiment

## Question

Does the independent CLI + Headroom configuration improve the practical
efficiency of the Issue #72 coding-agent workload compared with the VS Code
baseline?

This is an empirical report of one A/B experiment. It is not a benchmark claim
about every Headroom configuration or every coding task.

## Observed measurements

| Metric                     | VS Code baseline | CLI + Headroom |
| -------------------------- | ---------------: | -------------: |
| Wall time                  |        28.54 min |      44.13 min |
| Model invocations          |              113 |            193 |
| Cumulative input tokens    |       18,553,208 |        ~29.98M |
| Cached input tokens        |       18,054,144 |        ~29.61M |
| Uncached input tokens      |            ~499k |          ~363k |
| Output tokens              |           70,355 |         ~96.9k |
| Reasoning output tokens    |           38,017 |         ~49.1k |
| Median per-turn context    |          ~189.6k |        ~169.4k |
| Peak context               |          244,777 |       ~243,346 |
| Context compactions        |                1 |              1 |
| Visible custom-tool output |      ~570k chars |    ~459k chars |
| `mottainai_result_get`     |                1 |             47 |
| `mottainai_exec`           |               36 |             63 |
| `mottainai_read`           |               34 |             36 |
| `mottainai_search`         |               33 |             23 |
| Custom-tool outputs >20KB  |               10 |              4 |

Values prefixed with `~` are rounded values from the prior analysis and do not
claim exact precision. Cumulative input includes cached context; it is not a
fresh-token or billing measure.

## Interpretation

Headroom improved several local and context-stream measurements:

- median per-turn context was lower;
- uncached input was lower;
- visible custom-tool output was lower;
- fewer custom-tool responses exceeded 20KB.

Those improvements did not translate into better task-level efficiency. The
CLI + Headroom run took roughly 55% longer, used roughly 71% more model
invocations, and increased cumulative input by roughly 62%. Reasoning and
output tokens also increased, while peak context stayed almost unchanged.

Retrieval/page-in activity increased sharply:

```text
mottainai_result_get: 1 -> 47
```

The pattern is consistent with working-set thrashing:

```text
compress / evict
    -> needed information becomes unavailable
    -> retrieve / page in
    -> additional model turn
    -> repeat
```

Compression ratio alone is therefore an insufficient optimization objective.
The VS Code implementation was retained as the canonical #72 implementation
because it more closely preserves the intended semantics: observe-first
rollout, explicit repository/user whole-file authority, policy denial as a
partial structured outcome, no automatic raw fallback after semantic
extraction failure, and direct tests/documentation for progressive disclosure.

This result does not prove a universal Headroom quality regression. It records
the practical result of this CLI + Headroom configuration on this task.

## Limitations

- Codex VS Code and CLI builds were not exactly identical.
- This was one issue/task, not a broad benchmark suite.
- Headroom configuration may be tunable.
- The experiment evaluates the practical `CLI + Headroom` configuration, not
  every possible use of Headroom.
- Cumulative input includes cached context and must not be interpreted as
  fresh or billed tokens.
- The conclusion concerns task-level efficiency in this coding-agent
  workload.

## Resulting design implications

Generic compression remains appropriate in bounded situations such as:

- low-locality large logs;
- large JSON/API responses;
- emergency oversized-result fallback;
- batch workloads where latency is secondary;
- cases where context overflow would otherwise cause task failure.

It should not currently be Mottainai's default long-lived coding-agent context
strategy. The default should instead prioritize active working-set locality,
semantic state, and explicit retrieval. #73 burst budgets and #76 evaluation
are future follow-ups; this report does not implement them.
