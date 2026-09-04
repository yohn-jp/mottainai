# SSH target identity contract

Issue #298 の SSH target registry は Runtime identity とは別の transport
authority である。レコードの `targetId` は論理 target、`connectionId` は現在の
検証済み transport binding を表す。hostname、port、user の変更は Runtime identity
の変更を意味しない。

初回接続は TOFU ではない。呼び出し側が host-key fingerprint を独立に取得し、
`trustAction: "explicit"` を指定した operator trust を記録してから接続する。
再接続は保存 fingerprint と完全一致しなければ拒否する。変更された fingerprint
は自動更新せず、明示的な trust と、保存済み Runtime identity と一致する独立検証を
伴う `rebind` のみが新しい connection binding を作る。

永続状態には coordinates、fingerprint、trust provenance、Runtime identity だけを
保存し、private key、agent secret、token、command output は保存しない。
