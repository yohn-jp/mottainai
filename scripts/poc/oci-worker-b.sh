#!/usr/bin/env bash
set -Eeuo pipefail

# No arguments: read-only host/API preflight. Live mode: use a caller-owned
# rootless Podman store and an existing disposable container; never create,
# stop, kill, or remove that container.
JINUSHI_BIN=${JINUSHI_BIN:-jinushi}

probe() {
  local label=$1 rc
  shift
  printf '\n[%s]\nCOMMAND:' "$label"
  printf ' %q' "$@"
  printf '\n'
  "$@" 2>&1 || rc=$?
  rc=${rc:-0}
  if (( rc == 0 )); then printf 'RESULT=PASS EXIT=%s\n' "$rc"; else printf 'RESULT=BLOCKED EXIT=%s\n' "$rc"; fi
}

preflight() {
  printf 'time_utc=%s\nhost=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)"
  probe kernel uname -srmo
  probe identity id
  probe virtualization systemd-detect-virt
  probe os-release cat /etc/os-release
  if ! command -v "$JINUSHI_BIN" >/dev/null 2>&1; then
    printf '\n[jinushi]\nRESULT=BLOCKED REASON=not-on-PATH BINARY=%s\n' "$JINUSHI_BIN"
    return 0
  fi
  probe 'jinushi executable' command -v "$JINUSHI_BIN"
  probe 'jinushi help' "$JINUSHI_BIN" --help
  probe 'jinushi version' "$JINUSHI_BIN" --version
  local -a state_args=()
  if [[ -n ${MOTTAINAI_JINUSHI_STATE_DIR:-} ]]; then
    [[ $MOTTAINAI_JINUSHI_STATE_DIR == /* ]] || { echo 'BLOCKED: state dir must be absolute'; return 0; }
    state_args=(-state-dir "$MOTTAINAI_JINUSHI_STATE_DIR")
  fi
  probe 'jinushi capabilities' "$JINUSHI_BIN" capabilities "${state_args[@]}"
  probe 'jinushi status' "$JINUSHI_BIN" status "${state_args[@]}"
  for tool in podman crun; do
    if command -v "$tool" >/dev/null 2>&1; then probe "$tool version" "$tool" --version
    else printf '\n[%s]\nRESULT=BLOCKED REASON=not-on-PATH\n' "$tool"; fi
  done
}

json_field() {
  python3 - "$1" "$2" <<'PY'
import json, sys
obj = json.load(open(sys.argv[1]))
path = sys.argv[2].split('.')
for part in path:
    obj = obj[part]
print(obj)
PY
}

if (( $# == 0 )); then
  preflight
  exit 0
fi
if (( $# != 2 )); then
  echo 'Usage: oci-worker-b.sh [<podman-state-dir> <full-container-id>]' >&2
  exit 2
fi

oci_state=$1
container_id=$2
[[ $container_id =~ ^[0-9a-f]{64}$ ]] || { echo 'BLOCKED: require exact 64-character lowercase container ID' >&2; exit 2; }
[[ $oci_state == /tmp/* && -d $oci_state && ! -L $oci_state ]] || { echo 'BLOCKED: require a caller-owned, nonsymlink /tmp Podman state directory' >&2; exit 2; }
[[ $(realpath -- "$oci_state") == "$oci_state" ]] || { echo 'BLOCKED: Podman state path must be canonical' >&2; exit 2; }
for dir in storage runroot tmp; do [[ -d "$oci_state/$dir" && ! -L "$oci_state/$dir" ]] || { echo "BLOCKED: missing safe Podman $dir directory" >&2; exit 2; }; done
for tool in python3 podman crun; do command -v "$tool" >/dev/null || { echo "BLOCKED: required tool missing: $tool" >&2; exit 2; }; done
jinushi_bin=$(type -P "$JINUSHI_BIN") || { echo "BLOCKED: Jinushi not found: $JINUSHI_BIN" >&2; exit 2; }
podman_bin=$(type -P podman)
crun_bin=$(type -P crun)
[[ $(id -u) != 0 ]] || { echo 'BLOCKED: run Podman rootless as an unprivileged user' >&2; exit 2; }

podman_args=(--root "$oci_state/storage" --runroot "$oci_state/runroot" --tmpdir "$oci_state/tmp" --storage-driver=vfs --events-backend=file --runtime="$crun_bin" --cgroup-manager=systemd)
observed_id=$("$podman_bin" "${podman_args[@]}" inspect "$container_id" --format '{{.Id}}') || { echo 'BLOCKED: exact container ID is unavailable in supplied Podman store' >&2; exit 2; }
[[ $observed_id == "$container_id" ]] || { echo 'BLOCKED: Podman resolved a different container ID' >&2; exit 2; }
container_status=$("$podman_bin" "${podman_args[@]}" inspect "$container_id" --format '{{.State.Status}}')
[[ $container_status == running ]] || { echo "BLOCKED: caller-owned container is not running (status=$container_status)" >&2; exit 2; }
container_pid=$("$podman_bin" "${podman_args[@]}" inspect "$container_id" --format '{{.State.Pid}}')
rootless=$("$podman_bin" "${podman_args[@]}" info --format '{{.Host.Security.Rootless}}')
runtime=$("$podman_bin" "${podman_args[@]}" info --format '{{.Host.OCIRuntime.Name}}')
[[ $rootless == true && ( $runtime == crun || $runtime == "$crun_bin" ) ]] || { echo "BLOCKED: expected rootless crun Podman (rootless=$rootless runtime=$runtime)" >&2; exit 2; }

umask 077
evidence=$(mktemp -d /tmp/mottainai-oci-worker-b-live.XXXXXXXX)
jinushi_state=$evidence/jinushi
mkdir -m 700 "$jinushi_state"
printf 'EVIDENCE=%s\nCONTAINER id=%s status=%s host_pid=%s podman=%s runtime=%s\n' "$evidence" "$container_id" "$container_status" "$container_pid" "$("$podman_bin" --version)" "$("$crun_bin" --version | head -n1)"
printf 'JINUSHI=%s\n' "$jinushi_bin"

supervisor_pid=''
supervisor_start=''
cleanup() {
  local rc=$?
  trap - EXIT
  if [[ -n $supervisor_pid ]]; then
    if python3 - "$supervisor_pid" "$supervisor_start" "$jinushi_bin" "$jinushi_state" <<'PY'
import os, select, signal, sys
pid, expected_start = int(sys.argv[1]), sys.argv[2]
expected_argv = [sys.argv[3], "supervisor", "-state-dir", sys.argv[4]]
expected_cmd = b"\0".join(os.fsencode(arg) for arg in expected_argv) + b"\0"
try:
    pidfd = os.pidfd_open(pid)
except ProcessLookupError:
    raise SystemExit(0)
try:
    with open(f"/proc/{pid}/stat", "r") as f:
        fields = f.read().split()
        start, state = fields[21], fields[2]
    if state == "Z":
        raise SystemExit(0)
    with open(f"/proc/{pid}/cmdline", "rb") as f:
        cmd = f.read()
    if start != expected_start or cmd != expected_cmd or os.stat(f"/proc/{pid}").st_uid != os.getuid():
        raise SystemExit("refuse supervisor signal: process identity changed")
    signal.pidfd_send_signal(pidfd, signal.SIGTERM)
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    if not poller.poll(5000):
        raise SystemExit("supervisor did not exit after SIGTERM within 5 seconds")
finally:
    os.close(pidfd)
PY
    then
      wait "$supervisor_pid" || true
      printf 'SUPERVISOR_STOP pid=%s signal=SIGTERM\n' "$supervisor_pid"
    else
      rc=1
      printf 'KEEP supervisor pid=%s; identity check or SIGTERM failed\n' "$supervisor_pid" >&2
    fi
  fi
  printf 'EVIDENCE=%s\nRESULT=%s\n' "$evidence" "$rc"
  exit "$rc"
}
trap cleanup EXIT

"$jinushi_bin" supervisor -state-dir "$jinushi_state" >"$evidence/supervisor.log" 2>&1 &
supervisor_pid=$!
for _ in {1..100}; do
  supervisor_start=$(awk '{print $22}' "/proc/$supervisor_pid/stat" 2>/dev/null || true)
  [[ -n $supervisor_start ]] && break
  sleep 0.05
done
[[ -n $supervisor_start ]] || { echo 'FAIL: Jinushi supervisor exited before startup' >&2; exit 1; }
ready=0
for _ in {1..100}; do
  if "$jinushi_bin" status -state-dir "$jinushi_state" >"$evidence/status.json" 2>&1; then ready=1; break; fi
  sleep 0.05
done
[[ $ready == 1 ]] || { cat "$evidence/supervisor.log" >&2; echo 'FAIL: isolated Jinushi supervisor did not become ready' >&2; exit 1; }
"$jinushi_bin" capabilities -state-dir "$jinushi_state" >"$evidence/capabilities.json"

nonce="$(date -u +%Y%m%dT%H%M%SZ)-$$"
run_exec() {
  local name=$1 submission=$2; shift 2
  "$jinushi_bin" run -state-dir "$jinushi_state" -submission-id "oci-b-$nonce-$submission" \
    -cwd / -wall-time-ms 120000 -output-bytes 65536 \
    -correlation "containerId=$container_id" -correlation "probe=oci-wave1-b" -- "$@" \
    >"$evidence/$name-submit.json"
  json_field "$evidence/$name-submit.json" run.runId
}
await_run() {
  local name=$1 run_id=$2; local rc
  if "$jinushi_bin" await -state-dir "$jinushi_state" "$run_id" >"$evidence/$name-await.json" 2>&1; then rc=0; else rc=$?; fi
  printf '%s' "$rc" >"$evidence/$name-await-exit"
}

exit_command='printf "oci-start stdout pid=%s\n" "$$"; printf "oci-start stderr pid=%s\n" "$$" >&2; printf "oci-end stdout pid=%s\n" "$$"; printf "oci-end stderr pid=%s\n" "$$" >&2; exit 23'
exit_run=$(run_exec exit exit "$podman_bin" "${podman_args[@]}" exec "$container_id" /bin/sh -c "$exit_command")
await_run exit "$exit_run"
"$jinushi_bin" output -state-dir "$jinushi_state" --stream stdout "$exit_run" >"$evidence/exit-stdout.txt"
"$jinushi_bin" output -state-dir "$jinushi_state" --stream stderr "$exit_run" >"$evidence/exit-stderr.txt"
[[ $(cat "$evidence/exit-await-exit") == 23 ]] || { cat "$evidence/exit-await.json"; echo 'FAIL: expected supervised OCI exit 23' >&2; exit 1; }
grep -Fq 'oci-start stdout pid=' "$evidence/exit-stdout.txt" && grep -Fq 'oci-end stdout pid=' "$evidence/exit-stdout.txt" || { echo 'FAIL: incomplete stdout markers' >&2; exit 1; }
grep -Fq 'oci-start stderr pid=' "$evidence/exit-stderr.txt" && grep -Fq 'oci-end stderr pid=' "$evidence/exit-stderr.txt" || { echo 'FAIL: incomplete stderr markers' >&2; exit 1; }
printf 'PASS exit_run=%s exit=23 stdout_bytes=%s stderr_bytes=%s\n' "$exit_run" "$(wc -c <"$evidence/exit-stdout.txt")" "$(wc -c <"$evidence/exit-stderr.txt")"
"$jinushi_bin" inspect -state-dir "$jinushi_state" "$exit_run" >"$evidence/exit-inspect.json"

cancel_run=$(run_exec cancel cancel "$podman_bin" "${podman_args[@]}" exec "$container_id" /bin/sh -c 'sleep 600 & echo OCI_ACTIVE=$$ CHILD=$!; wait')
cancel_output=$evidence/cancel-running-stdout.txt
for _ in {1..100}; do
  "$jinushi_bin" output -state-dir "$jinushi_state" --stream stdout "$cancel_run" >"$cancel_output" || true
  grep -q '^OCI_ACTIVE=[0-9][0-9]* CHILD=[0-9][0-9]*$' "$cancel_output" && break
  sleep 0.05
done
read -r inner_shell inner_child < <(sed -n 's/^OCI_ACTIVE=\([0-9][0-9]*\) CHILD=\([0-9][0-9]*\)$/\1 \2/p' "$cancel_output") || true
[[ -n ${inner_shell:-} && -n ${inner_child:-} ]] || { echo 'FAIL: did not observe in-container cancellation target PIDs' >&2; exit 1; }
"$jinushi_bin" inspect -state-dir "$jinushi_state" "$cancel_run" >"$evidence/cancel-running-inspect.json"
generation=$(json_field "$evidence/cancel-running-inspect.json" run.generation)
state=$(json_field "$evidence/cancel-running-inspect.json" run.state)
[[ $state == running ]] || { echo "FAIL: cancel target state is $state" >&2; exit 1; }
"$podman_bin" "${podman_args[@]}" top "$container_id" hpid pid comm >"$evidence/cancel-top-before.txt"
request_id="oci-b-$nonce-cancel"
"$jinushi_bin" cancel -state-dir "$jinushi_state" -request-id "$request_id" -expected-generation "$generation" "$cancel_run" >"$evidence/cancel-control.json"
await_run cancel "$cancel_run"
[[ $(cat "$evidence/cancel-await-exit") == 1 ]] || { cat "$evidence/cancel-await.json"; echo 'FAIL: expected cancelled Jinushi Run' >&2; exit 1; }
"$jinushi_bin" inspect -state-dir "$jinushi_state" "$cancel_run" >"$evidence/cancel-terminal.json"
python3 - "$evidence/cancel-terminal.json" <<'PY'
import json, sys
run = json.load(open(sys.argv[1]))['run']
receipt = run.get('receipt', {})
assert run['state'] == 'terminal' and receipt.get('outcome') == 'cancelled'
assert receipt.get('cleanup') == 'complete' and receipt.get('evidenceIncomplete') is False
PY
"$podman_bin" "${podman_args[@]}" top "$container_id" hpid pid comm >"$evidence/cancel-top-after.txt"
for pid in "$inner_shell" "$inner_child"; do
  if awk -v target="$pid" 'NR > 1 && $2 == target { found = 1 } END { exit !found }' "$evidence/cancel-top-after.txt"; then
    echo "FAIL: cancelled container process remains pid=$pid" >&2; exit 1
  fi
done
printf 'PASS cancel_run=%s generation=%s request_id=%s container_pids=%s,%s absent_after_cancel=yes\n' "$cancel_run" "$generation" "$request_id" "$inner_shell" "$inner_child"
printf 'NOTE this probe observes one existing container exec; it does not establish a Tsukai/container recovery contract.\n'
