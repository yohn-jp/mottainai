# SSH target identity contract

Issue #298 の SSH target registry は Runtime identity とは別の transport
authority である。レコードの `targetId` は論理 target、`connectionId` は現在の
検証済み transport binding を表す。hostname、port、user の変更は Runtime identity
の変更を意味しない。

初回接続は TOFU ではない。呼び出し側が host-key の OpenSSH public-key material と
SHA-256 fingerprint を独立に取得し、material から算出した fingerprint/algorithm と
一致することを確認したうえで `trustAction: "explicit"` を指定した operator trust
を記録してから接続する。再接続は保存 fingerprint と一致しなければ拒否する。
実 SSH process には registry の material だけから生成した一時 known_hosts を渡し、
`StrictHostKeyChecking=yes` と `GlobalKnownHostsFile=/dev/null` を強制する。変更された
fingerprint は自動更新せず、明示的な trust と、保存済み Runtime identity と一致する
独立検証を伴う `rebind` のみが新しい connection binding を作る。

永続状態には coordinates、公開 host-key material/fingerprint、trust provenance、
Runtime identity だけを保存し、private key、agent secret、token、command output は
保存しない。Runtime の binding/rebind evidence は既存の
`RuntimeCapabilityResultSchema` で parse し、raw identity string を authority にしない。
