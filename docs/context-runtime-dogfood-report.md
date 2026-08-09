# Context Runtime dogfood report

測定日: 2026-08-09T15:00:54.163Z

## 判定方法

本レポートは、build済み `dist/index.js` を外部stdio MCP clientから起動する決定的シナリオの実測値。一次ゲートはagent-visible JSONのbytes、4 bytes/tokenの保守的推定、tool call数、expansion数、正確性・診断保持。elapsed timeは補助値。

Beforeは、2026-08-08に観測したpathologyを再現する「全raw/full-inline」または反復status応答の合成基準。モデル課金額・client内部cache/replayは測定していない。AfterはMCP応答のJSON bytes合計。

成功基準（測定前に固定）: verbose-success reduction >=70%、unchanged repeat reduction >=80%、selected await/watchの反復外向き応答を0（await <=1 call）。

## Scenario results

| scenario | before visible bytes | after visible bytes | before visible tokens | after visible tokens | reduction | calls before/after | expansions | retries/diagnostics |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| verbose success + explicit retrieval | 28524 | 1359 | 7131 | 340 | 95.2% | 1/2 | 1 | TAP success counts retained; full output omitted then retrieved |
| broad raw read denied + exact range allowed | 27144 | 3335 | 6786 | 834 | 87.7% | 1/2 | 0 | deny metadata/actionable next actions; exact lines remain usable |
| four-call concurrent burst | 25404 | 10459 | 6351 | 2615 | 58.8% | 4/4 | 0 | four parallel reads; at least one response reduced by burst_budget |
| local start + await | 1087 | 1087 | 272 | 272 | 0.0% | 2/2 | 0 | opaque handle plus one terminal await response |
| provider watch replaces repeated status | 284 | 598 | 71 | 150 | -110.6% | 4/1 | 0 | one await/watch response; internal polls replace four outward status responses |
| unchanged repeat | 7300 | 753 | 1825 | 189 | 89.7% | 1/1 | 0 | repeat transfer only; setup read and later change check are excluded from the threshold |
| changed-content miss | 7300 | 840 | 1825 | 210 | 88.5% | 1/1 | 0 | changed file returns normal bounded content with a new identity |
| actionable failure diagnostics | 17126 | 1213 | 4282 | 304 | 92.9% | 1/1 | 0 | classification, first cause, TAP failure, bounded diagnostic, result_id retained |

## Telemetry evidence

`MOTTAINAI_TELEMETRY=1` のsummary toolとsummary fileから取得。本文・source・command・secretは記録されていない。

```json
{
  "projection": {
    "raw_bytes": 102299,
    "stored_bytes": 101831,
    "returned_bytes": 26944,
    "omitted_bytes": 75996,
    "projected_tokens": 6743,
    "omitted_tokens": 18996
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
    "pressure_total": 17.982666015625,
    "pressure_max": 3.65625,
    "projected_tokens": 18866,
    "projected_bytes": 75436,
    "omitted_tokens": 11901,
    "omitted_bytes": 47592,
    "responses_reduced": 6,
    "responses_would_reduce": 0
  },
  "await": {
    "awaits": 2,
    "poll_count": 3,
    "elapsed_ms": 283,
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

## 2026-08-08 observationsとの方向比較

- 大きなraw source/resultと成功burstは、projection/read governor/burstでagent-visible payloadを縮小し、full evidenceはresult_idから取得可能。
- source readの反復はdedupe hitでunchanged metadataへ縮小。
- status確認の外向き反復はselected gh awaitで内部pollへ移し、terminal/change時の1応答へ集約。
- したがって、観測されたall-raw、30–40KB burst、反復read、41 waitsと約5.15M wait直後inputという方向に対し、bytes/calls/expansionの方向は逆。43.15M cumulative model-input numberの再現は行わない。

## Privacy and correctness

- telemetry summaryにscenario本文、fixture source、raw command output、environment dump、credentialを含めないことをassert。
- failure scenarioはfailure classification、first cause、structured TAP failure、bounded diagnostic、result_idを保持。
- exact raw range、変更後dedupe miss、full result retrievalをassert。
