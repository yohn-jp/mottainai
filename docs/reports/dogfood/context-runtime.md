# Context Runtime dogfood report

Measurement date: 2026-08-10T05:25:16.560Z

## Method

This report records a deterministic scenario that starts built `dist/index.js`
from an external stdio MCP client. Primary gates are agent-visible JSON bytes,
the conservative estimate of four bytes per token, tool-call count, expansion
count, and preservation of correctness and diagnostics. Elapsed time is
auxiliary evidence.

Before is a synthetic baseline reproducing the pathology observed on
2026-08-08: all-raw/full-inline output or repeated status responses. Model
cost and client-internal cache/replay are not measured. After is the total JSON
byte count of MCP responses.

Success criteria fixed before measurement: verbose-success reduction >=70%,
unchanged-repeat reduction >=80%, and zero repeated outward responses for the
selected await/watch case (await <=1 call).

## Scenario results

| scenario | before visible bytes | after visible bytes | before visible tokens | after visible tokens | reduction | calls before/after | expansions | retries/diagnostics |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| verbose success + explicit retrieval | 28524 | 1356 | 7131 | 339 | 95.2% | 1/2 | 1 | TAP success counts retained; full output omitted then retrieved |
| broad raw read denied + exact range allowed | 27144 | 3335 | 6786 | 834 | 87.7% | 1/2 | 0 | deny metadata/actionable next actions; exact lines remain usable |
| four-call concurrent burst | 25404 | 3928 | 6351 | 982 | 84.5% | 4/4 | 0 | four parallel reads; at least one response reduced by burst_budget |
| local start + await | 1087 | 1087 | 272 | 272 | 0.0% | 2/2 | 0 | opaque handle plus one terminal await response |
| provider watch replaces repeated status | 284 | 478 | 71 | 120 | -68.3% | 4/1 | 0 | one await/watch response; internal polls replace four outward status responses |
| unchanged repeat | 7300 | 753 | 1825 | 189 | 89.7% | 1/1 | 0 | repeat transfer only; setup read and later change check are excluded from the threshold |
| changed-content miss | 7300 | 840 | 1825 | 210 | 88.5% | 1/1 | 0 | changed file returns normal bounded content with a new identity |
| actionable failure diagnostics | 17126 | 1210 | 4282 | 303 | 92.9% | 1/1 | 0 | classification, first cause, TAP failure, bounded diagnostic, result_id retained |

## Telemetry evidence

Collected from the summary tool and summary file with
`MOTTAINAI_TELEMETRY=1`. Scenario bodies, source, commands, and secrets were
not recorded.

```json
{
  "projection": {
    "raw_bytes": 102293,
    "stored_bytes": 101389,
    "returned_bytes": 20287,
    "omitted_bytes": 82458,
    "projected_tokens": 5078,
    "omitted_tokens": 20612
  },
  "expansion": {
    "count": 1,
    "bytes": 243,
    "estimated_tokens": 61
  },
  "read_governor": {
    "allow": 8,
    "observe": 0,
    "warn": 0,
    "deny": 1,
    "raw_lines_returned": 369,
    "raw_bytes_returned": 44855,
    "by_mode": {
      "raw": 9
    },
    "by_rule": {
      "WHOLE_FILE_RAW_LINE_LIMIT": 1,
      "NONE": 8
    },
    "by_reason_category": {
      "line_limit": 1,
      "within_policy": 8
    }
  },
  "burst": {
    "pressure_samples": 15,
    "pressure_total": 21.353271484375,
    "pressure_max": 3.65625,
    "projected_tokens": 18864,
    "projected_bytes": 75430,
    "omitted_tokens": 13652,
    "omitted_bytes": 54597,
    "responses_reduced": 6,
    "responses_would_reduce": 0
  },
  "await": {
    "awaits": 2,
    "poll_count": 3,
    "elapsed_ms": 228,
    "state_changes": 2,
    "avoided_responses": 2,
    "terminal": 2,
    "timeouts": 0,
    "cancelled": 0
  },
  "dedupe": {
    "hits": 1,
    "misses": 7,
    "bytes_avoided": 6611,
    "estimated_tokens_avoided": 1652
  },
  "totals": {
    "calls": 0,
    "errors": 0,
    "original_bytes": 0,
    "compressed_bytes": 0,
    "retrievals": 1
  }
}
```

## Directional comparison with 2026-08-08 observations

- Large raw source/results and successful bursts are reduced to an
  agent-visible payload by projection, the read governor, and burst handling;
  full evidence remains available through `result_id`.
- Repeated source reads are reduced to unchanged metadata by a deduplication
  hit.
- Outward status repetition is replaced by internal polling through selected
  `gh await`, consolidating terminal/change results into one response. Bytes
  may increase when several poll responses become one await response (observed:
  284 → 478 bytes), while outward calls decrease from 4 to 1.
- Therefore bytes and expansions move opposite to the observed all-raw,
  30–40KB burst, and repeated-read directions. For repeated status polling,
  outward call count moves opposite; bytes may increase depending on the
  scenario. The 41 waits, approximately 5.15M post-wait input, and 43.15M
  cumulative model-input number are not reproduced.

## Counter-cost gate

- There was one explicit `result_get` expansion; no automatic retry or
  mandatory expansion was observed. If the expansion/retry rate materially
  increases, identify and resolve the projection/read-policy cause and return
  to observe/warn before making enforce a general default.
- `enforce` in this measurement applies only to an isolated fixture
  configuration. The general default is unchanged.

## Privacy and correctness

- Assert that the telemetry summary contains no scenario body, fixture source,
  raw command output, environment dump, or credentials.
- Failure scenarios retain failure classification, first cause, structured TAP
  failure, bounded diagnostics, and `result_id`.
- Assert exact raw ranges, a deduplication miss after a change, and full result
  retrieval.
