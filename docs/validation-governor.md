# Validation Governor（issue #184 Phase 1）

state-aware な検証実行の管理層。「同じ repository/worktree の状態に対して既に成功した検証を、決定論的に一致する場合だけ再利用する」ことで、実行コストと model-visible な出力トークンを削減する。不確実なら必ず実行する — 推測的なキャッシュ再利用は行わない。

対象は `src/workflow/validation/`（governor 本体）、`src/workflow/commands/check.ts`（task selector 経由の呼び出し口）、`src/workflow/commands/mcp-tools.ts` の `mottainai_workflow_check_run` / `mottainai_workflow_validation_receipt`。

## 設計不変条件

1. Mottainai は検証の実行を最適化するだけで、要求される検証そのものを弱めない。
2. 再利用された PASS は、特定の過去実行と一致した state に必ず帰属する（receipt の `runId`/`fingerprint` と、`provenance.reasonCode`/`provenance.explanation` に一致した実行の詳細を残す）。
3. state/configuration が確立できない、または一致しない場合は必ず実行する（不確実性は実行を強制する）。
4. raw な stdout/stderr は成功時に model へ渡さない。`ArtifactStore` へ bounded 保存し、失敗時のみ bounded な診断行を返す。
5. repository/worktree をまたいで結果が漏れない（`instance_id` + `worktree_id` で分離）。
6. FAILED な記録は決して再利用しない — 「失敗を静かに成功へ変換する」ことは絶対にしない。unchanged な失敗状態は再実行して確認する。

## 構成要素

| ファイル | 責務 |
| --- | --- |
| `src/workflow/validation/registry.ts` | Managed check の identity/configuration。呼び出し側が任意のコマンドを渡すことはできない — `DEFAULT_MANAGED_CHECKS`（lint/typecheck/test/build/verify）が唯一の定義元 |
| `src/workflow/validation/fingerprint.ts` | 保守的な決定論的 state fingerprint。HEAD commit + `git status` の変更パス（宣言された `scope` glob で絞り込み）+ `configPaths` の blob hash から算出する。git コマンドが失敗する場合は `ok: false` を返し、呼び出し側は必ず実行にフォールバックする |
| `src/workflow/validation/identity.ts` | command/args/cwd の digest（`commandDigest`）と、Node/OS/宣言された env/config file 内容を折り込んだ `configDigest` |
| `src/workflow/validation/scope.ts` | `scope` に使う最小限の glob matcher（`*`/`**`/`?`）。依存関係の推論は一切行わない — 宣言された literal pattern の機械的突き合わせのみ |
| `src/workflow/validation/governor.ts` | `runManagedCheck`（実行 or 再利用）と `assessManagedCheck`/`assessManagedChecks`（read-only の状態判定、プロセスを起動しない） |
| `src/workflow/state/store.ts` / `sqlite-store.ts` | `check_runs` テーブル（migration v13）。`instance_id, worktree_id, check_id, state_fingerprint, config_digest` で分離し、`status='passed'` の行だけが再利用対象 |

## State fingerprint

`scope` を宣言しない（既定）場合は worktree 全体の変更を対象にする — 最も保守的な既定値。`scope` を宣言した check は、その glob に一致する変更パスだけを fingerprint に含める。パス名だけでなく、各変更パスの内容（`git hash-object` の blob digest）を折り込むため、同じパスでも内容が変われば fingerprint は必ず変わる。宣言された `configPaths`（例: `tsconfig.json`）は scope に関わらず常に内容を折り込む。

これは issue #184 が明示的に除外する「投機的な依存グラフ」ではない — 宣言された literal path pattern を `git status` の出力へ機械的に突き合わせるだけで、意味解析・依存推論を行わない。

## Receipt

`runManagedCheck` は次の 5 状態のいずれかを `state` として返す:

- `executed-pass` — 実行して成功
- `executed-fail` — 実行して失敗（`diagnostics` に bounded な失敗行、`artifactRef` に完全な raw ログの参照）
- `reused-pass` — 一致する過去の成功実行を再利用（プロセスを起動しない）
- `stale` — 一致する証拠がなく、実行が必要（read-only な `assessManagedCheck` のみが返す）
- `not-required` — repository policy 上 optional で、現在の証拠もない（read-only のみ）

成功時の receipt は `{ check, status, execution, duration_ms, fingerprint }` 相当の compact な形で、既定では stdout/stderr を含まない。`artifactRef` から `mottainai_result_get` 相当の手段で明示的に取得できる。

`getWorkflowValidationReceipt`（`mottainai_workflow_validation_receipt`）は複数 check を一括で read-only 判定し、`satisfied` と `requiredPending` を返す — プロセスを一切起動せずに「今 push して良いか」を判断できる。

## 既存の validation_evidence との統合

`src/workflow/git/push.ts` の push gate が信頼する `validation_evidence` テーブル（migration v6）を新しい authority で置き換えない。managed check が `evidenceName` を宣言していて、かつ worktree 全体が clean（`git status` が空）な場合のみ、governor は PASS/FAIL を `recordValidationEvidence` 経由でそのテーブルへ橋渡しする。dirty な worktree では書き込まない — headCommit が実際にテストされた内容を正確に表さない可能性があるため、既存の push gate の信頼境界を弱めない。

## Benchmark / fixture

`pnpm run benchmark:validation-governor`（`scripts/benchmark-validation-governor.mjs`）は issue #184 が例示するセッション（テスト実行→無関係な編集→再実行→再度無関係な編集→再実行→実コードの変更→再実行→full verify→PRの前にfull verifyを再実行）を、素朴な「毎回実行して raw stdout をそのまま model に渡す」経路と governed 経路の両方で再生し、実行回数と model-visible byte数を比較する。

代表的な観測値（一時 git repository、決定論的な合成コマンド。数値は実行環境依存だが execution/byte 削減比はロジック上安定）:

```json
{
  "sessionSteps": 6,
  "totalNaiveExecutions": 6,
  "totalGovernedExecutions": 3,
  "executionReductionRatio": 0.5,
  "totalNaiveBytes": 107740,
  "totalGovernedBytes": 3940,
  "modelVisibleByteReductionRatio": 0.963
}
```

6 回の呼び出しのうち 3 回がプロセスを起動しない reuse になる（うち2回は無関係な変更後の再実行、1回は変更なしでの再実行）。model-visible な byte 数は約 96% 削減される。
