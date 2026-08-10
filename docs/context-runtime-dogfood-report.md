# Context Runtime dogfood report

測定日: 2026-08-10T05:25:16.560Z

## 判定方法

本レポートは、build済み `dist/index.js` を外部stdio MCP clientから起動する決定的シナリオの実測値。一次ゲートはagent-visible JSONのbytes、4 bytes/tokenの保守的推定、tool call数、expansion数、正確性・診断保持。elapsed timeは補助値。

Beforeは、2026-08-08に観測したpathologyを再現する「全raw/full-inline」または反復status応答の合成基準。モデル課金額・client内部cache/replayは測定していない。AfterはMCP応答のJSON bytes合計。

成功基準（測定前に固定）: verbose-success reduction >=70%、unchanged repeat reduction >=80%、selected await/watchの反復外向き応答を0（await <=1 call）。

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

`MOTTAINAI_TELEMETRY=1` のsummary toolとsummary fileから取得。本文・source・command・secretは記録されていない。

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

## 2026-08-08 observationsとの方向比較

- 大きなraw source/resultと成功burstは、projection/read governor/burstでagent-visible payloadを縮小し、full evidenceはresult_idから取得可能。
- source readの反復はdedupe hitでunchanged metadataへ縮小。
- status確認の外向き反復はselected gh awaitで内部pollへ移し、terminal/change時の1応答へ集約。bytesはpoll応答が単一のawait応答へ置き換わるため増加し得る（観測: 284→478 bytes）が、外向きcall数は4→1へ縮小する。
- したがって、観測されたall-raw、30–40KB burst、反復readという方向に対し、bytes/expansionの方向は逆。status pollの反復という方向に対しては、outward call数の方向が逆（bytesはscenario依存で増加する場合がある）。41 waitsと約5.15M wait直後input、43.15M cumulative model-input numberの再現は行わない。

## Counter-cost gate

- 明示的な `result_get` expansion は 1 件で、自動retry・mandatory expansionは観測されなかった。expansion/retry rateがmaterially増加した場合は、enforceを一般defaultへ進める前にprojection/read policyの原因を特定・解決し、observe/warnへ戻す。
- この測定の `enforce` はisolated fixture設定のみ。一般defaultは変更していない。

## Privacy and correctness

- telemetry summaryにscenario本文、fixture source、raw command output、environment dump、credentialを含めないことをassert。
- failure scenarioはfailure classification、first cause、structured TAP failure、bounded diagnostic、result_idを保持。
- exact raw range、変更後dedupe miss、full result retrievalをassert。
