#!/usr/bin/env bash
set -Eeuo pipefail

# Reproduce what Jinushi cancellation owns when its physical command is a
# rootless `podman exec`. The script creates and removes only its private
# rootless VFS store and full-ID/label-fenced containers. It never changes the
# host Podman policy or the default Jinushi supervisor.

PODMAN_BIN=${PODMAN_BIN:-/nix/store/ml8x1jki0s2s18923xp603wiz731s871-podman-5.8.8/bin/podman}
CRUN_BIN=${CRUN_BIN:-/nix/store/6116w8nq5ly8padymnqzvl3pw014r07h-crun-1.30.1/bin/crun}
JINUSHI_BIN=${JINUSHI_BIN:-/nix/store/a8gq62lad67pgdzyf5jp2si33zphhpq3-jinushi-13afd8f/bin/jinushi}
IMAGE=docker.io/library/debian@sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5

for tool in "$PODMAN_BIN" "$CRUN_BIN" "$JINUSHI_BIN"; do
  [[ -x $tool ]] || { printf 'BLOCKED: required executable missing: %s\n' "$tool" >&2; exit 77; }
done
for tool in python3 sha256sum systemd-detect-virt date awk sed grep wc head mktemp mkdir rm id uname; do
  command -v "$tool" >/dev/null || { printf 'BLOCKED: required command missing: %s\n' "$tool" >&2; exit 77; }
done
[[ $(id -u) != 0 ]] || { echo 'BLOCKED: this probe requires rootless Podman' >&2; exit 77; }

umask 077
probe_nonce="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
evidence=$(mktemp -d "/tmp/mottainai-oci-recovery-b-live.XXXXXXXX")
work=$(mktemp -d "/tmp/mottainai-oci-recovery-b-state.XXXXXXXX")
mkdir -m 700 "$work/storage" "$work/runroot" "$work/tmp" "$evidence/jinushi-state"
[[ $work == /tmp/mottainai-oci-recovery-b-state.* && $evidence == /tmp/mottainai-oci-recovery-b-live.* ]]
podman_args=(--root "$work/storage" --runroot "$work/runroot" --tmpdir "$work/tmp" --storage-driver=vfs --events-backend=file --runtime="$CRUN_BIN" --cgroup-manager=systemd)
container_ids=()
container_purposes=()
created_container_id=
supervisor_pid=
supervisor_start=
cleanup_failed=0

log_command() {
  printf '$' >>"$evidence/commands.txt"
  printf ' %q' "$@" >>"$evidence/commands.txt"
  printf '\n' >>"$evidence/commands.txt"
}

stop_supervisor() {
  [[ -n $supervisor_pid ]] || return 0
  python3 - "$supervisor_pid" "$supervisor_start" "$JINUSHI_BIN" "$evidence/jinushi-state" <<'PY'
import os, select, signal, sys
pid, expected_start = int(sys.argv[1]), sys.argv[2]
expected = [sys.argv[3], "supervisor", "-state-dir", sys.argv[4]]
try:
    pidfd = os.pidfd_open(pid)
except ProcessLookupError:
    raise SystemExit(0)
try:
    raw = open(f"/proc/{pid}/stat", "rb").read()
    fields = raw[raw.rfind(b")") + 2:].split()
    state, start = fields[0].decode(), fields[19].decode()
    actual = open(f"/proc/{pid}/cmdline", "rb").read()
    wanted = b"\0".join(os.fsencode(x) for x in expected) + b"\0"
    if state == "Z":
        raise SystemExit(0)
    if start != expected_start or actual != wanted or os.stat(f"/proc/{pid}").st_uid != os.getuid():
        raise SystemExit("refuse supervisor signal: process identity mismatch")
    signal.pidfd_send_signal(pidfd, signal.SIGTERM)
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    if not poller.poll(5000):
        raise SystemExit("supervisor did not exit within 5 seconds")
finally:
    os.close(pidfd)
PY
  wait "$supervisor_pid" || true
  printf 'supervisor pid=%s startTime=%s signal=SIGTERM identity=fenced\n' "$supervisor_pid" "$supervisor_start" >>"$evidence/cleanup.txt"
  supervisor_pid=
}

remove_container() {
  local cid=$1 purpose=$2 observed_id label status actual_name remaining
  if ! observed_id=$("$PODMAN_BIN" "${podman_args[@]}" inspect "$cid" --format '{{.Id}}' 2>/dev/null); then
    log_command "$PODMAN_BIN" "${podman_args[@]}" ps --all --no-trunc --format '{{.ID}}'
    if ! remaining=$("$PODMAN_BIN" "${podman_args[@]}" ps --all --no-trunc --format '{{.ID}}'); then
      echo 'FAIL: cannot verify container state after inspect failed' >&2
      return 1
    fi
    if grep -Fxq "$cid" <<<"$remaining"; then
      printf 'FAIL: container inspect failed but full ID remains listed: %s\n' "$cid" >&2
      return 1
    fi
    return 0
  fi
  actual_name=$("$PODMAN_BIN" "${podman_args[@]}" inspect "$cid" --format '{{.Name}}')
  actual_name=${actual_name#/}
  label=$("$PODMAN_BIN" "${podman_args[@]}" inspect "$cid" --format '{{index .Config.Labels "io.mottainai.oci-recovery-probe"}}')
  status=$("$PODMAN_BIN" "${podman_args[@]}" inspect "$cid" --format '{{.State.Status}}')
  [[ $observed_id == "$cid" && $actual_name == "oci-recovery-b-${probe_nonce}-${purpose}" && $label == "$probe_nonce" ]] || {
    printf 'refuse container cleanup: identity mismatch id=%s name=%s label=%s\n' "$observed_id" "$actual_name" "$label" >&2
    return 1
  }
  if [[ $status == running ]]; then
    log_command "$PODMAN_BIN" "${podman_args[@]}" stop --time 2 "$cid"
    "$PODMAN_BIN" "${podman_args[@]}" stop --time 2 "$cid" >>"$evidence/cleanup.txt" 2>&1 || return 1
  fi
  log_command "$PODMAN_BIN" "${podman_args[@]}" rm "$cid"
  "$PODMAN_BIN" "${podman_args[@]}" rm "$cid" >>"$evidence/cleanup.txt" 2>&1 || return 1
  printf 'container name=%s fullID=%s removed=yes priorStatus=%s\n' "$actual_name" "$cid" "$status" >>"$evidence/cleanup.txt"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if ! stop_supervisor; then
    cleanup_failed=1
    printf 'KEEP supervisor pid=%s: identity-fenced stop failed\n' "$supervisor_pid" | tee -a "$evidence/cleanup.txt" >&2
  fi
  local i remaining
  for ((i=${#container_ids[@]}-1; i>=0; i--)); do
    if ! remove_container "${container_ids[i]}" "${container_purposes[i]}"; then
      cleanup_failed=1
    fi
  done
  if (( cleanup_failed == 0 )); then
    log_command "$PODMAN_BIN" "${podman_args[@]}" ps --all --no-trunc --format '{{.ID}}'
    if ! remaining=$("$PODMAN_BIN" "${podman_args[@]}" ps --all --no-trunc --format '{{.ID}}'); then
      cleanup_failed=1
      printf 'KEEP private storage: cannot verify isolated Podman container list\n' | tee -a "$evidence/cleanup.txt" >&2
    elif [[ -n $remaining ]]; then
      cleanup_failed=1
      printf 'KEEP private storage: unexpected containers remain: %s\n' "$remaining" | tee -a "$evidence/cleanup.txt" >&2
    else
      rm -rf -- "$work"
      printf 'privateStorage=%s removed=yes\n' "$work" >>"$evidence/cleanup.txt"
    fi
  fi
  if (( cleanup_failed != 0 )); then
    printf 'privateStorage=%s retained=yes\n' "$work" >>"$evidence/cleanup.txt"
    rc=1
  fi
  printf 'EVIDENCE=%s\nRESULT=%s\n' "$evidence" "$rc"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run() {
  log_command "$@"
  "$@"
}

json_value() {
  python3 - "$1" "$2" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value[key]
print(value)
PY
}

new_container() {
  local purpose=$1 init_mode=${2:-no-init} name cid observed_id
  local -a init_args=()
  case "$init_mode" in
    no-init) ;;
    init) init_args=(--init) ;;
    *) echo "FAIL: invalid init mode: $init_mode" >&2; return 2 ;;
  esac
  name="oci-recovery-b-${probe_nonce}-${purpose}"
  log_command "$PODMAN_BIN" "${podman_args[@]}" run -d --name "$name" --label "io.mottainai.oci-recovery-probe=$probe_nonce" --memory=512m --cpus=1 --pids-limit=128 "${init_args[@]}" "$IMAGE" sleep infinity
  "$PODMAN_BIN" "${podman_args[@]}" run -d --name "$name" --label "io.mottainai.oci-recovery-probe=$probe_nonce" --memory=512m --cpus=1 --pids-limit=128 "${init_args[@]}" "$IMAGE" sleep infinity >"$evidence/$purpose-create.txt"
  cid=$(cat "$evidence/$purpose-create.txt")
  [[ $cid =~ ^[0-9a-f]{64}$ ]]
  container_ids+=("$cid")
  container_purposes+=("$purpose")
  created_container_id=$cid
  printf '%s\n' "$cid" >"$evidence/$purpose-container-id.txt"
  observed_id=$("$PODMAN_BIN" "${podman_args[@]}" inspect "$cid" --format '{{.Id}}')
  [[ $cid =~ ^[0-9a-f]{64}$ && $observed_id == "$cid" ]]
  [[ $("$PODMAN_BIN" "${podman_args[@]}" inspect "$cid" --format '{{index .Config.Labels "io.mottainai.oci-recovery-probe"}}') == "$probe_nonce" ]]
}

run_exec() {
  local name=$1 cid=$2 submission=$3
  shift 3
  run "$JINUSHI_BIN" run -state-dir "$evidence/jinushi-state" -submission-id "oci-recovery-b-$probe_nonce-$submission" \
    -cwd / -wall-time-ms 120000 -output-bytes 65536 \
    -correlation "containerId=$cid" -correlation "probe=oci-recovery-b-$name" -- \
    "$PODMAN_BIN" "${podman_args[@]}" exec "$cid" "$@" >"$evidence/$name-submit.json"
  json_value "$evidence/$name-submit.json" run.runId
}

wait_output() {
  local name=$1 run_id=$2 marker=$3
  local output="$evidence/$name-live-stdout.txt" i
  for i in {1..100}; do
    "$JINUSHI_BIN" output -state-dir "$evidence/jinushi-state" --stream stdout "$run_id" >"$output" || true
    if grep -Fq "$marker" "$output"; then
      date +%s%N >"$evidence/$name-output-ready-ns"
      return 0
    fi
    sleep 0.05
  done
  printf 'FAIL: output marker did not appear: %s\n' "$marker" >&2
  return 1
}

top_host_pid() {
  local top_file=$1 inner_pid=$2
  awk -v target="$inner_pid" 'NR > 1 && $2 == target {print $1; exit}' "$top_file"
}

capture_top() {
  local name=$1 cid=$2
  log_command "$PODMAN_BIN" "${podman_args[@]}" top "$cid" hpid pid ppid pgid state comm
  "$PODMAN_BIN" "${podman_args[@]}" top "$cid" hpid pid ppid pgid state comm >"$evidence/$name-top.txt"
}

capture_proc() {
  local name=$1 inner_shell=$2 shell_host=$3 shell_start=$4 inner_child=$5 child_host=$6 child_start=$7 wrapper_pid=$8 wrapper_start=$9
  python3 - "$evidence/$name-proc.json" "$inner_shell" "$shell_host" "$shell_start" "$inner_child" "$child_host" "$child_start" "$wrapper_pid" "$wrapper_start" <<'PY'
import datetime, json, os, sys
out, inner_shell, shell_host, shell_start, inner_child, child_host, child_start, wrapper_pid, wrapper_start = sys.argv[1:]

def read(pid, inner, expected):
    if not pid or pid == "?":
        return {"innerPid": int(inner), "hostPid": None, "classification": "unmapped"}
    path = f"/proc/{pid}"
    try:
        raw = open(path + "/stat", "rb").read()
        fields = raw[raw.rfind(b")") + 2:].split()
        state, ppid, pgrp, session, start = fields[0].decode(), int(fields[1]), int(fields[2]), int(fields[3]), fields[19].decode()
        status = open(path + "/status", encoding="utf-8").read().splitlines()
        nspid = next((line.split()[1:] for line in status if line.startswith("NSpid:")), [])
        cgroup = open(path + "/cgroup", encoding="utf-8").read().splitlines()
        cmd = open(path + "/cmdline", "rb").read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
        if expected != "?" and start != expected:
            classification = "pid-reused"
        elif state == "Z":
            classification = "zombie"
        elif state in {"X", "x"}:
            classification = "exiting"
        else:
            classification = "live"
        return {"innerPid": int(inner) if inner != "-" else None, "hostPid": int(pid), "classification": classification,
                "state": state, "ppid": ppid, "processGroup": pgrp, "session": session, "startTimeTicks": start,
                "expectedStartTimeTicks": None if expected == "?" else expected, "nspid": nspid, "cgroup": cgroup, "cmdline": cmd}
    except FileNotFoundError:
        return {"innerPid": int(inner) if inner != "-" else None, "hostPid": int(pid), "classification": "absent"}

sample = {"observedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "shell": read(shell_host, inner_shell, shell_start), "child": read(child_host, inner_child, child_start),
          "jinushiOwnedWrapper": read(wrapper_pid, "-", wrapper_start)}
with open(out, "w", encoding="utf-8") as stream:
    json.dump(sample, stream, indent=2)
    stream.write("\n")
PY
}

record_baseline() {
  local name=$1 cid=$2 run_id=$3 shell_inner=$4 child_inner=$5
  local wrapper_pid wrapper_start shell_host child_host shell_start child_start
  "$JINUSHI_BIN" inspect -state-dir "$evidence/jinushi-state" "$run_id" >"$evidence/$name-running-inspect.json"
  wrapper_pid=$(json_value "$evidence/$name-running-inspect.json" run.ownership.pid)
  wrapper_start=$(json_value "$evidence/$name-running-inspect.json" run.ownership.startTime)
  capture_top "$name-before" "$cid"
  shell_host=$(top_host_pid "$evidence/$name-before-top.txt" "$shell_inner")
  child_host=$(top_host_pid "$evidence/$name-before-top.txt" "$child_inner")
  [[ $shell_host =~ ^[0-9]+$ && $child_host =~ ^[0-9]+$ ]]
  capture_proc "$name-before" "$shell_inner" "$shell_host" '?' "$child_inner" "$child_host" '?' "$wrapper_pid" "$wrapper_start"
  shell_start=$(json_value "$evidence/$name-before-proc.json" shell.startTimeTicks)
  child_start=$(json_value "$evidence/$name-before-proc.json" child.startTimeTicks)
  printf '%s\n' "$wrapper_pid" "$wrapper_start" "$shell_host" "$shell_start" "$child_host" "$child_start" >"$evidence/$name-identities.txt"
  printf '%s\n' "$shell_inner" "$child_inner" >"$evidence/$name-inner-pids.txt"
}

capture_after_container_removal() {
  local name=$1
  local -a identities inner
  readarray -t identities <"$evidence/$name-identities.txt"
  readarray -t inner <"$evidence/$name-inner-pids.txt"
  capture_proc "$name-after-container-removal" "${inner[0]}" "${identities[2]}" "${identities[3]}" \
    "${inner[1]}" "${identities[4]}" "${identities[5]}" "${identities[0]}" "${identities[1]}"
}

cancel_case() {
  local name=$1 cid=$2 delay_ms=$3 submission=$4
  local run_id marker inner_shell inner_child wrapper_pid wrapper_start shell_host shell_start child_host child_start generation request_id now ready elapsed
  marker="OCI_RECOVERY_READY_${name}"
  run_id=$(run_exec "$name" "$cid" "$submission" /bin/sh -c "sleep 600 & child=\$!; echo $marker shell=\$\$ child=\$child; wait")
  wait_output "$name" "$run_id" "$marker shell="
  read -r inner_shell inner_child < <(sed -n "s/^${marker} shell=\\([0-9][0-9]*\\) child=\\([0-9][0-9]*\\)$/\\1 \\2/p" "$evidence/$name-live-stdout.txt")
  [[ $inner_shell =~ ^[0-9]+$ && $inner_child =~ ^[0-9]+$ ]]
  if (( delay_ms > 0 )); then sleep "0.$(printf '%03d' "$delay_ms")"; fi
  record_baseline "$name" "$cid" "$run_id" "$inner_shell" "$inner_child"
  readarray -t identities <"$evidence/$name-identities.txt"
  wrapper_pid=${identities[0]}; wrapper_start=${identities[1]}; shell_host=${identities[2]}; shell_start=${identities[3]}; child_host=${identities[4]}; child_start=${identities[5]}
  generation=$(json_value "$evidence/$name-running-inspect.json" run.generation)
  request_id="oci-recovery-b-$probe_nonce-$name-cancel"
  ready=$(cat "$evidence/$name-output-ready-ns")
  now=$(date +%s%N)
  elapsed=$(( (now-ready)/1000000 ))
  printf 'cancelRequestedMsAfterOutput=%s delayPolicyMs=%s\n' "$elapsed" "$delay_ms" >"$evidence/$name-timing.txt"
  log_command "$JINUSHI_BIN" cancel -state-dir "$evidence/jinushi-state" -request-id "$request_id" -expected-generation "$generation" "$run_id"
  "$JINUSHI_BIN" cancel -state-dir "$evidence/jinushi-state" -request-id "$request_id" -expected-generation "$generation" "$run_id" >"$evidence/$name-cancel.json"
  capture_proc "$name-after-immediate" "$inner_shell" "$shell_host" "$shell_start" "$inner_child" "$child_host" "$child_start" "$wrapper_pid" "$wrapper_start"
  sleep 0.1
  capture_proc "$name-after-100ms" "$inner_shell" "$shell_host" "$shell_start" "$inner_child" "$child_host" "$child_start" "$wrapper_pid" "$wrapper_start"
  sleep 0.9
  capture_proc "$name-after-1s" "$inner_shell" "$shell_host" "$shell_start" "$inner_child" "$child_host" "$child_start" "$wrapper_pid" "$wrapper_start"
  sleep 4
  capture_proc "$name-after-5s" "$inner_shell" "$shell_host" "$shell_start" "$inner_child" "$child_host" "$child_start" "$wrapper_pid" "$wrapper_start"
  "$JINUSHI_BIN" await -state-dir "$evidence/jinushi-state" "$run_id" >"$evidence/$name-await.json" 2>&1 || printf '%s\n' "$?" >"$evidence/$name-await-exit"
  "$JINUSHI_BIN" inspect -state-dir "$evidence/jinushi-state" "$run_id" >"$evidence/$name-terminal-inspect.json"
  "$JINUSHI_BIN" events -state-dir "$evidence/jinushi-state" "$run_id" >"$evidence/$name-events.json"
  capture_top "$name-after-5s" "$cid"
  printf 'case=%s runId=%s innerPids=%s,%s hostPids=%s,%s wrapperPid=%s generation=%s requestId=%s\n' \
    "$name" "$run_id" "$inner_shell" "$inner_child" "$shell_host" "$child_host" "$wrapper_pid" "$generation" "$request_id"
}

printf 'evidence=%s\nprivate_state=%s\nprobe_nonce=%s\nimage=%s\n' "$evidence" "$work" "$probe_nonce" "$IMAGE" | tee "$evidence/identity.txt"
{
  uname -a
  id
  systemd-detect-virt || true
  "$PODMAN_BIN" --version
  "$CRUN_BIN" --version | head -n 1
  "$JINUSHI_BIN" --help | head -n 3
  sha256sum "$JINUSHI_BIN"
} >"$evidence/versions.txt" 2>&1
"$JINUSHI_BIN" supervisor -state-dir "$evidence/jinushi-state" >"$evidence/supervisor.log" 2>&1 &
supervisor_pid=$!
for _ in {1..100}; do
  supervisor_start=$(python3 - "$supervisor_pid" <<'PY'
import sys
try:
    raw = open(f"/proc/{sys.argv[1]}/stat", "rb").read()
    print(raw[raw.rfind(b")") + 2:].split()[19].decode())
except OSError:
    pass
PY
  )
  [[ -n $supervisor_start ]] && break
  sleep 0.05
done
[[ -n $supervisor_start ]] || { echo 'FAIL: isolated Jinushi supervisor exited during startup' >&2; exit 1; }
for _ in {1..100}; do
  if "$JINUSHI_BIN" status -state-dir "$evidence/jinushi-state" >"$evidence/status.json" 2>&1; then break; fi
  sleep 0.05
done
"$JINUSHI_BIN" capabilities -state-dir "$evidence/jinushi-state" >"$evidence/capabilities.json"

log_command "$PODMAN_BIN" "${podman_args[@]}" info
"$PODMAN_BIN" "${podman_args[@]}" info >"$evidence/podman-info.txt" 2>&1
log_command "$PODMAN_BIN" "${podman_args[@]}" pull "$IMAGE"
if ! "$PODMAN_BIN" "${podman_args[@]}" pull "$IMAGE" >"$evidence/pull.txt" 2>&1; then
  echo 'BLOCKED: approved exact Debian digest pull failed; see pull.txt' >&2
  exit 77
fi
"$PODMAN_BIN" "${podman_args[@]}" image inspect "$IMAGE" >"$evidence/image-inspect.json"

new_container normal-exit
normal_cid=$created_container_id
"$PODMAN_BIN" "${podman_args[@]}" inspect "$normal_cid" >"$evidence/normal-container-inspect.json"
exit_run=$(run_exec normal-exit "$normal_cid" normal-exit /bin/sh -c 'printf "stdout-start pid=%s\n" "$$"; printf "stderr-start pid=%s\n" "$$" >&2; printf "stdout-end pid=%s\n" "$$"; printf "stderr-end pid=%s\n" "$$" >&2; exit 23')
if "$JINUSHI_BIN" await -state-dir "$evidence/jinushi-state" "$exit_run" >"$evidence/normal-exit-await.json" 2>&1; then normal_exit=0; else normal_exit=$?; fi
"$JINUSHI_BIN" output -state-dir "$evidence/jinushi-state" --stream stdout "$exit_run" >"$evidence/normal-exit-stdout.txt"
"$JINUSHI_BIN" output -state-dir "$evidence/jinushi-state" --stream stderr "$exit_run" >"$evidence/normal-exit-stderr.txt"
"$JINUSHI_BIN" inspect -state-dir "$evidence/jinushi-state" "$exit_run" >"$evidence/normal-exit-inspect.json"
"$JINUSHI_BIN" events -state-dir "$evidence/jinushi-state" "$exit_run" >"$evidence/normal-exit-events.json"
[[ $normal_exit == 23 ]] || { echo "FAIL: expected container exit 23, observed Jinushi await exit $normal_exit" >&2; exit 1; }
grep -Fq 'stdout-start pid=' "$evidence/normal-exit-stdout.txt" && grep -Fq 'stdout-end pid=' "$evidence/normal-exit-stdout.txt"
grep -Fq 'stderr-start pid=' "$evidence/normal-exit-stderr.txt" && grep -Fq 'stderr-end pid=' "$evidence/normal-exit-stderr.txt"
printf 'normalExit runId=%s awaitExit=%s stdoutBytes=%s stderrBytes=%s\n' "$exit_run" "$normal_exit" "$(wc -c <"$evidence/normal-exit-stdout.txt")" "$(wc -c <"$evidence/normal-exit-stderr.txt")"
remove_container "$normal_cid" "normal-exit"

new_container immediate-cancel
immediate_cid=$created_container_id
cancel_case immediate "$immediate_cid" 0 immediate-cancel
remove_container "$immediate_cid" "immediate-cancel"
capture_after_container_removal immediate

new_container delayed-cancel
delayed_cid=$created_container_id
cancel_case delayed "$delayed_cid" 800 delayed-cancel
remove_container "$delayed_cid" "delayed-cancel"
capture_after_container_removal delayed

new_container init-immediate-cancel init
init_immediate_cid=$created_container_id
"$PODMAN_BIN" "${podman_args[@]}" inspect "$init_immediate_cid" >"$evidence/init-immediate-container-inspect.json"
capture_top init-immediate-before "$init_immediate_cid"
init_immediate_pid1=$(awk 'NR > 1 && $2 == 1 {print $6; exit}' "$evidence/init-immediate-before-top.txt")
printf 'initImmediatePid1=%s\n' "$init_immediate_pid1" >"$evidence/init-comparison.txt"
cancel_case init-immediate "$init_immediate_cid" 0 init-immediate-cancel
remove_container "$init_immediate_cid" "init-immediate-cancel"
capture_after_container_removal init-immediate

new_container init-delayed-cancel init
init_delayed_cid=$created_container_id
"$PODMAN_BIN" "${podman_args[@]}" inspect "$init_delayed_cid" >"$evidence/init-delayed-container-inspect.json"
capture_top init-delayed-before "$init_delayed_cid"
init_delayed_pid1=$(awk 'NR > 1 && $2 == 1 {print $6; exit}' "$evidence/init-delayed-before-top.txt")
printf 'initDelayedPid1=%s\n' "$init_delayed_pid1" >>"$evidence/init-comparison.txt"
cancel_case init-delayed "$init_delayed_cid" 800 init-delayed-cancel
remove_container "$init_delayed_cid" "init-delayed-cancel"
capture_after_container_removal init-delayed

new_container container-stop
stop_cid=$created_container_id
stop_run=$(run_exec container-stop "$stop_cid" container-stop /bin/sh -c 'echo OCI_STOP_READY=$$; exec sleep 600')
wait_output container-stop "$stop_run" OCI_STOP_READY=
"$PODMAN_BIN" "${podman_args[@]}" inspect "$stop_cid" >"$evidence/container-stop-before.json"
log_command "$PODMAN_BIN" "${podman_args[@]}" stop --time 1 "$stop_cid"
if "$PODMAN_BIN" "${podman_args[@]}" stop --time 1 "$stop_cid" >"$evidence/container-stop-command.txt" 2>&1; then stop_rc=0; else stop_rc=$?; fi
if "$JINUSHI_BIN" await -state-dir "$evidence/jinushi-state" "$stop_run" >"$evidence/container-stop-await.json" 2>&1; then stop_await_rc=0; else stop_await_rc=$?; fi
"$JINUSHI_BIN" inspect -state-dir "$evidence/jinushi-state" "$stop_run" >"$evidence/container-stop-jinushi-inspect.json"
"$JINUSHI_BIN" events -state-dir "$evidence/jinushi-state" "$stop_run" >"$evidence/container-stop-events.json"
"$PODMAN_BIN" "${podman_args[@]}" inspect "$stop_cid" >"$evidence/container-stop-after.json"
printf 'containerStop fullID=%s podmanExit=%s jinushiAwaitExit=%s\n' "$stop_cid" "$stop_rc" "$stop_await_rc"
remove_container "$stop_cid" "container-stop"

new_container container-kill
kill_cid=$created_container_id
kill_run=$(run_exec container-kill "$kill_cid" container-kill /bin/sh -c 'echo OCI_KILL_READY=$$; exec sleep 600')
wait_output container-kill "$kill_run" OCI_KILL_READY=
"$PODMAN_BIN" "${podman_args[@]}" inspect "$kill_cid" >"$evidence/container-kill-before.json"
log_command "$PODMAN_BIN" "${podman_args[@]}" kill --signal KILL "$kill_cid"
if "$PODMAN_BIN" "${podman_args[@]}" kill --signal KILL "$kill_cid" >"$evidence/container-kill-command.txt" 2>&1; then kill_rc=0; else kill_rc=$?; fi
if "$JINUSHI_BIN" await -state-dir "$evidence/jinushi-state" "$kill_run" >"$evidence/container-kill-await.json" 2>&1; then kill_await_rc=0; else kill_await_rc=$?; fi
"$JINUSHI_BIN" inspect -state-dir "$evidence/jinushi-state" "$kill_run" >"$evidence/container-kill-jinushi-inspect.json"
"$JINUSHI_BIN" events -state-dir "$evidence/jinushi-state" "$kill_run" >"$evidence/container-kill-events.json"
"$PODMAN_BIN" "${podman_args[@]}" inspect "$kill_cid" >"$evidence/container-kill-after.json"
printf 'containerKill fullID=%s podmanExit=%s jinushiAwaitExit=%s\n' "$kill_cid" "$kill_rc" "$kill_await_rc"
remove_container "$kill_cid" "container-kill"

echo 'Probe complete; classify each cancellation sample and retained Jinushi receipt before interpreting cleanup.'
