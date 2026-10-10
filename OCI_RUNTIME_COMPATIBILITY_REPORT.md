# OCI Runtime Compatibility — Wave 1

**最終判定: FAIL。** 認証対象として承認された `nixos-dev` 上で、rootless Podman + Debian + Nawabari 0.14.0のstrict session実行が `/proc` mountの `EPERM` で失敗した。ホストJinushiからのOCI exec出力・終了観測は動作したが、最終キャンセル検証ではcleanup complete後にも子PID項目が残った。要求された統合経路は成立していない。Podman採用は保留とする。この結果は検証した構成の判定であり、全てのrootless Podman構成が不可能という判定ではない。

## Authority and revision

- Repository: `yohn-jp/mottainai`.
- BASE_SHA: `152da3c3a61900fa65db8b0abce44fdcb170b73b` (2026-10-10 UTCにfetchした `origin/main`).
- HEAD_SHA: `152da3c3a61900fa65db8b0abce44fdcb170b73b`.
- Integration branch: `nawabari/session/01a12372-e920-777f-88bb-37aa12f167b1`.
- Worker A branch: `nawabari/session/01a12372-f8b9-7846-b002-c6e38ba9361a`.
- Worker B branch: `nawabari/session/01a12372-f9d5-73c4-828b-88156360b7c7`.
- 3つの独立worktreeは公開 `nawabari session create` で同じbaseから作成した。既存ローカルmain (`3d84e97fd72992b0d768a8a4ac2139585653481a`) は変更していない。
- Wave 1終了時の成果物は未commitのローカル変更であり、上記HEAD_SHAには成果物を含まない。Recovery Phase 0の保全は [Issue #994](https://github.com/yohn-jp/mottainai/issues/994) に記録する。
- ユーザーの指示でInariを凍結し、その後のGitHub確認には `gh` を使用した。Wave 1終了時点ではIssue/PRを新規作成していない。

## Target environment

| Item | Observation |
| --- | --- |
| Hostname | `nixos-dev` |
| OS | NixOS 26.05 (Yarara), `26.05.10304.6d663c0533ff` |
| Architecture / kernel | `x86_64` / Linux `6.18.52` |
| Virtualization | `systemd-detect-virt` → `vmware` |
| User | `sophia`, uid 1000; rootとして実行していない |
| systemd | `260 (260.4)` |
| cgroup filesystem | `/sys/fs/cgroup`: `cgroup2fs` |
| Initial Podman / crun | PATHに存在しない |
| Ephemeral Podman / crun | `5.8.8` / `1.30.1`, Nix storeから実行 |
| Nawabari | Host CLI `0.13.0`; repository devDependency/Nix companion pin `0.6.1` |
| OCI Nawabari / Node | Released `0.14.0` / `24.17.0` |
| OCI OS / bubblewrap / Git | Debian 13.7 (trixie) stable-slim / Debian package `0.12.0-1~deb13u1` / `2.47.3` |
| Jinushi tested build | Nix `jinushi-13afd8f`, source `13afd8f0c284b28a2899ab41721aaee1fab67389` |
| Jinushi binary SHA-256 | `f5ba762f019cf3f4a1a1502823d24ae46064b129a6f5db08d00a12419515e007` |

ユーザーは現在のVMware上の `nixos-dev` をWave 1の認証対象として明示的に承認した。SSHによる同名hostへの接続は `Host key verification failed` で停止し、鍵・known_hostsは変更せず、現在のホストで検証した。

## Existing contracts and CI

- `docs/contracts/runtime/linux-runtime.md` は `mottainai.linux-runtime.v1`, schema 2のcanonical NixOS guest契約である。Debianコンテナをこの契約を満たす本番Runtimeとは認定しない。
- `docs/architecture/runtime/appliance-oci.md` のOCIは非コンテナRuntime Appliance artifactである。今回のDebian OCI containerとは用途が異なる。
- `docs/architecture/runtime/lima-orchestration.md` の既存production経路はLima/QEMUによるcanonical Applianceの起動であり、今回変更していない。
- `src/manager/tsukai-integration.ts` はadmitted Nawabari workspaceをそのままTsukaiに渡し、Tsukai `agentRunId` を保存する。TsukaiがAgentRun lifecycle、Jinushiがphysical process、Nawabariがworkspaceを所有する。PoCでもこの責務を移さない。
- [Issue #984](https://github.com/yohn-jp/mottainai/issues/984) はOPEN。現在mainにはTsukai統合seamが存在するため、Issue状態だけから未実装とは判断しない。
- [Issue #433](https://github.com/yohn-jp/mottainai/issues/433) (protected-session boundary composition) と [Issue #435](https://github.com/yohn-jp/mottainai/issues/435) (parallel protected-session overhead) はOPEN。今回その既存Runtime認証やbenchmark全体を完了したとは扱わない。
- 最新mainの [CI run 37011692816](https://github.com/yohn-jp/mottainai/actions/runs/37011692816) は `completed / startup_failure`, `jobs: []`。原因は今回の照会では確定していない。CodeQLはsuccessだったがRuntime認証を代替しない。
- 既存CIはNix Runtime evaluation/image/VM/applianceのcontractを検証する。今回のローカルOCI PoCを検証するremote CI結果はない。

## Scope

本番Runtime設定、QEMU/KVM経路、秘密鍵、既存コンテナ、永続データは変更しない。Podman/crunの一時的なNix tool provisioningはNix store/cacheの追加のみで、NixOS generationやhost service設定を変更しない。特権コンテナ、host PID namespace共有、host root昇格、host Jinushi socketのcontainerへの公開は行わない。

Podman 5.8.8はpull時に既定policyを必要とし、XDG_CONFIG_HOMEだけではpolicy pathを変更できなかった。`--signature-policy` はglobal/pull flagとして使えない。ユーザーは `/home/sophia/.config/containers/policy.json` の一時作成を明示的に許可した。候補はdefault拒否、`docker.io/library/debian` だけ `insecureAcceptAnything` であり、Debian image署名の認証は行わない。この設定は同じユーザーのPodmanにも一時的に影響する。既存fileがないことを確認して排他的に作成し、終了時に作成fileの同一性を確認して削除する方針である。

ユーザーは最新リリースをPoC前提としてよいと明示した。repositoryの旧pinを今回の互換性判定の上限にはしない。productionのpin更新はこのPoCの変更には含めない。

永続化基盤、Resource Grant、Manager UI、本番Runtime Primary切替は対象外。

## Immutable inputs and measured identity

- Nixpkgs tools: `github:NixOS/nixpkgs/39ad350a0602fa0a58a544344e3e9187526ea45c`, Podman 5.8.8 + crun 1.30.1.
- Debian RepoDigest: `docker.io/library/debian@sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5`.
- Original image config ID: `sha256:787cd32c15da653c63f8689246f8199870afdbe8d822b7e560d651e20d6def02`.
- Original container full ID: `ceec5d45cf30440832a587318dac3adbf36c0dcc47a3b9389f791652939082ea` (削除済み).
- [Nawabari v0.14.0](https://github.com/yohn-jp/nawabari/releases/tag/v0.14.0) のnpm integrity: `sha512-zCPsnYBf9jyR98vZ7MtX0tZyXAI5xxhhGg540Y+8Lz2e4Wc4jJQChv5P5xyXvwsmtfazkQFSTpUN99yCjiyEvg==`.
- Node 24.17.0はofficial tarballを同versionのSHASUMS256と照合した。Debian image署名を検証したとは扱わない。
- Jinushiは `--version` 非対応。上記の実行binaryのsource revisionとhashで特定した。[latest release v0.1.1](https://github.com/yohn-jp/jinushi/releases/tag/v0.1.1) とtested buildは別物である。確認時latest main `f24d62a073a6933acba0a3416efc1087423efd64` との差分は `.github/workflows/gofmt-autofix.yml` の追加だけで、source/public APIの差分はなかった。

## Worker A acceptance matrix

| # | Result | 実測範囲と未成立範囲 |
| --- | --- | --- |
| 1. 非特権create/start/stop/remove | PASS | rootless=true、crun、privileged=false、private PID、default seccomp。専用storageで起動・停止・再起動・kill・削除を実測。 |
| 2. Nawabari起動/session作成 | PASS | 0.14.0のdoctorと2つのsession createが成功。これはprotected process起動成功を意味しない。 |
| 3. 2 session並列実行 | BLOCKED | strict launchが失敗し、2つのprotected workloadを並列実行できなかった。 |
| 4. worktree/filesystem隔離 | BLOCKED | 異なるsession/branch/worktreeの作成を確認。protected workloadからのsibling access拒否は未検証。 |
| 5. bwrap/Landlock/user namespace | FAIL | `unshare -Ur true` は成功。実際のNawabari strict runのbwrap `/proc` mountはEPERM。LandlockはABI null、unavailable/reduced-defenseと報告された。 |
| 6. cgroup委譲/CPU/memory/PID制限 | BLOCKED | host cgroup v2、user service Delegate=yes、containerの設定値を確認。Nawabari sessionへの委譲と各制限のstress/enforcementは未検証。 |
| 7. 未許可host fileアクセス拒否 | PASS | running containerから実在するhost canaryを読めずexit 1/ENOENT。Podman mount namespaceで非公開だった。Nawabari workloadからの追加確認はblocked。 |
| 8. container破棄/一時状態回収 | PASS | 原実測・最終再実行の対象container、専用storage、workspace copy/archiveを回収。一時policyを同一性確認後に削除。最終supervisorとcanaryも不存在を確認。raw evidenceのみ保持した。 |

container uid mapは `0 → host uid 1000`, `1..65536 → 100000..165535`。host rootとして実行していない。デモ設定はmemory 512 MiB、1 CPU、128 PIDsであり、要求された性能閾値ではない。kernel readbackはそれぞれ `memory.max=536870912`, `cpu.max=100000 100000`, `pids.max=128`。設定readbackを制限enforcementのPASSにはしない。

## Worker B acceptance matrix

| # | Result | 実測範囲と未成立範囲 |
| --- | --- | --- |
| 1. 公開API/Supervisor | PASS | 専用state-dir supervisorでrun/inspect/await/events/output/cancelを使用。default supervisorの拒否されたsocket/DBは変更しない。 |
| 2. container/PID/cgroup/session対応 | BLOCKED | full CID、container init PID/cgroup、inner PIDとhost PID、Jinushi Run ID/startTime/processGroupを観測。実行されたNawabari session/Tsukai AgentRunとの完全対応は未成立。 |
| 3. OCI processの開始/終了観測 | PASS | host Jinushiが `podman exec` を実行し、container内shellのstart/endとterminal outcomeを観測。 |
| 4. stdout/stderr/exit/cancel | FAIL | 最終再実行でstdout/stderr各50 bytes、exit 23は成功。generation付きcancelはterminal/cleanup completeを返したが、直後の一覧にchild PID 3332が残り、消失assertionが失敗した。原実測の消失成功だけではPASSにしない。 |
| 5. container停止/異常終了 | PASS | stopはtimeout後KILLで137、明示KILLも137としてJinushiがterminalを観測。停止原因は外部Podman観測との照合であり、Jinushi固有のcontainer eventではない。 |
| 6. PID再利用/stale CID誤操作防止 | BLOCKED | 操作はRun ID/generation、containerは64桁full CIDを使用。削除済みCIDは125で拒否。PID再利用を意図的に発生させたrace testとtyped clientによるstart identity保証は未検証。 |
| 7. Tsukai統合の最小契約特定 | PASS | 下記の不足するcontainer execution/binding契約を特定した。Tsukai AgentRunの実行統合をPASSとしたものではない。 |

Jinushiは物理的にはhostのPodman CLIを監督する。手動計測ではJinushi ownershipがPID `126812`, startTime `1561073`, processGroup `126812`、container shell/child PIDが `3412/3413`、host側PIDが `126833/126834` だった。container cgroupは `.../libpod-<full CID>.scope`。Jinushiのprocess telemetryやcleanup receiptをcontainer全体のresource enforcementに読み替えない。host envelopeはunconfigured、CPU/memory/PID/task enforcement capabilityはfalseだった。

原実測Run IDs:

- output/exit: `run_74b9a7347ccba43bd4b6adfa7e19e1ed839eea1c`.
- cancel: `run_31e0dd4311b43784b92c0146a748966fa4cc8416` (`cancelled`, cleanup complete, evidenceIncomplete=false、約21秒).
- stop: `run_de852d08f3674739d55a5c21de5bc96fb971d319` (exit 137).
- kill: `run_f75659ed8b854e9d8c2518fea92ed761a06315ee` (exit 137).
- stale CID: `run_0bce9f99129151ac509a9930bf6ba1c914e1a934` (exit 125, evidenceIncomplete=true。このflagは保持する).

## Integration gate and failure reproduction

確認した実際の経路は `Mottainai PoC → rootless Podman → Debian → Nawabari session create → strict session runの拒否` までである。Agent Processには到達していない。別経路の `host Jinushi → podman exec → Debian shell` は出力・終了を観測できたが、最終cancel後のchild PID消失は失敗した。Nawabari Session/AgentRunまでの統合PASSにはしない。

実際のlatest Nawabari commandは、managed worktree内で次のとおり失敗した:

```sh
nawabari --json session run --session 01a12384-f260-73d4-9d1e-42535cd66f8d -- /bin/true
```

exit 3、`SANDBOX_EXECUTION_FAILED`、stderr `bwrap: Can't mount proc on /proc: Operation not permitted`。公開CLIと実装のmandatory namespace/proc mount経路が一致した。Podman内での単なるuser namespace作成成功やdoctorのready表示は、このmount成功を証明しない。kernel側のproc mount条件とOCIの制約のどれが決定的な拒否原因かは、このPoCでは切り分けていない。seccompやcapabilityを緩める比較実験は行わなかった。

Solが同じ実行中containerで独立にversion/doctor/strict session runを再実行し、同じexit 3を確認した。doctorはsandbox.ready=true、strict_ready=true、managed_execution.ready=false、process_tracking requiredと返した。host Jinushi control socketはcontainerに公開していない。したがってproc mount問題が解消しても、host JinushiだけでNawabariのprocess tracking契約を満たす経路は未成立である。

## Public API gaps and Wave 2 decisions

Tsukai 0.2.2の公開Jinushi adapterはhost Pi RPCのargvを組み立て、`tsukai.agentRunId` をcorrelationに渡す。現在のproduction factoryにPodman executor、container ID、container内cwd/commandのbindingはない。CLI inspectのPID/startTime/processGroup/spec/correlationは、Tsukaiの公開 `JinushiRun` 型に全て投影されていない。generic argvのexec成功だけで、container/session/AgentRunの耐久bindingを保証できない。

Wave 2前に必要な決定:

1. 非特権のままNawabariのmandatory proc mountを成立させる、受け入れ可能なPodman/kernel構成。default制約との拒否原因を切り分け、隔離を維持して再認証する。
2. host socket公開や隔離のdowngradeなしで、Nawabariのprocess trackingをhost Jinushiに委譲できる公開契約。
3. Tsukai AgentRun → admitted Nawabari session → immutable full CID → physical Jinushi Runのbinding、restart/recovery、generation/start identityによる誤操作防止。container create/remove/resourceのAuthorityはMottainaiに保持する。
4. container stop/crashとprocess exit/cancelの観測・原因区別。wrapperの観測をfirst-class container lifecycleと混同しない。
5. repository Nawabari pinを検証済みリリースへ更新する別のbounded変更、Landlock reduced-defenseの扱い、session cgroup委譲とCPU/memory/PID enforcementの未実測項目を解消する。
6. Jinushiのwrapper cleanup completeとcontainer内child PID項目の残留の関係を調査する。生存processとzombieを区別し、即時cancelを含めてcontainer内cleanupを保証する公開契約を決める。

Podmanは暫定のまま採用保留。Docker/privilegedへの切替、Primary変更、後続の本実装には進まない。

## Reproduction and local evidence

変更ファイルはこのreportと `scripts/poc/oci-worker-a.sh`、`scripts/poc/oci-worker-b.sh` の3つだけである。本番コードとCI設定は変更しない。

認証対象hostの非rootユーザーで、今回承認された一時policy作成を明示して実行する:

```sh
bash -n scripts/poc/oci-worker-a.sh scripts/poc/oci-worker-b.sh
MOTTAINAI_OCI_TEMP_POLICY_APPROVED=debian-only bash scripts/poc/oci-worker-a.sh
```

Aは専用Podman storage、digest指定のDebian、latest released Nawabariを用意し、mandatory strict session起動を再現したあと、同じfull CIDをBへ渡す。Bはhost Jinushiの専用supervisorを起動し、stdout/stderr・exit 23・generation付きcancelとcontainer内対象PID消失を検証する。Bはcontainer作成・停止・削除を所有しない。Aがcontainerと専用storageを、Bが自分のsupervisorを回収し、raw evidenceは表示された専用 `/tmp` directoryに残す。最終実行ではBの消失assertionが失敗して全体exit 1となった。

スクリプトのexit 0は既知のstrict session失敗とJinushi component動作を再現できたことを示す。Wave 1統合PASSを意味しない。異なるhostでpolicy作成・権限拡大を承認したものでもない。

原実測の詳細は `/tmp/mottainai-oci-worker-a-report.txt`、`/tmp/oci-worker-b-report.md`、Solによる公開API再確認は `/tmp/mottainai-oci-root-verification-8le9e6yo/` に保存した。stop/kill/stale CIDは `podman stop --time 1 <full CID>`、`podman start <full CID>`、`podman kill <full CID>`、`podman rm <full CID>` 後のJinushi run/await/inspectで観測した。これらの操作は専用storageの対象containerだけに限定した。

## Final verification at current HEAD

最終の実機再実行は `/tmp/mottainai-oci-wave1-final-4.log`、A evidenceは `/tmp/mottainai-oci-worker-a-evidence.CDfghcyI/`、B evidenceは `/tmp/mottainai-oci-worker-b-live.RIjtCAsr/` に保存した。rootが現在HEADと実際の統合スクリプトから起動し、以下を直接確認した:

- full CID: `ed05a1408020ce0c4d142077631da513ac8c30e1ecad794e5e855f5c61e7af48` (削除済み)。pull指定は上記index digest、Podmanが表示したplatform RepoDigestは `sha256:d405c1e1d9eecbf30022d23766a0eea235e7f499aa33e357dfd29271a839f82a`。
- Nawabari/Node: `0.14.0` / `v24.17.0`。session IDs: `01a1239b-71c9-7a09-97fa-92d71c104f0d`, `01a1239b-7310-7e23-a35d-7c77ee1f236d`。strict runはexit 3/同じproc mount EPERM。
- Jinushi exit Run: `run_d6bdf5bd1f3cb2af4788eacfe02222d759322e39`, exit 23, stdout/stderr各50 bytes。
- cancel Run: `run_0f7ad9ab2834ee91a9390f8215943dcde95ae843`, generation付きcancel後 `cancelled`, `cleanup=complete`, `evidenceIncomplete=false`。container shell PID 3331は消え、child PID 3332の`COMMAND=sleep`項目は残った (`HPID=?`)。状態列は採取していないため、残留項目が生存processかzombieかは確定できない。両PIDの消失を要求するスクリプトはexit 1で停止した。container削除後は対応するhost PID 145992も不存在を確認した。
- B supervisor PID 145824はSIGTERMで停止し不存在を確認。最終専用state `/tmp/mottainai-oci-worker-a-state.8oP2He2R`、原専用state、policy file、host canaryはいずれも不存在。policy directoryは原作成時と異なるinodeの既存directoryとして保護し、削除しなかった。

最終実行に先立つ3回の試行では、Podman template field、Node tarball展開先、crunの名前と絶対pathの表現差というスクリプト不備を修正した。各停止時のcontainer/storage/policy cleanupも記録した。最終実行後は検証条件やassertionを変更していない。

ローカル検証は両スクリプトの `bash -n`、3ファイルのwhitespace確認、変更範囲確認、および上記実機実行。実機実行の結果はexit 1/FAILであり、テストPASSとは報告しない。production変更がないため既存Runtimeのテスト追加・full suite実行は行わなかった。Wave 1終了時点では成果物のremote CI/PR/commitはなかった。Wave 1の判定と成果物を残して停止した。
