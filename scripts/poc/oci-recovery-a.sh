#!/usr/bin/env bash
set -Eeuo pipefail

# Reproduce the default rootless OCI path on the accepted nixos-dev host.
# The Debian-only signature policy is an externally approved, temporary input;
# this script only verifies it and never creates, edits, or removes it.

readonly BASE=152da3c3a61900fa65db8b0abce44fdcb170b73b
readonly IMAGE=docker.io/library/debian@sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5
readonly PODMAN_BIN=/nix/store/ml8x1jki0s2s18923xp603wiz731s871-podman-5.8.8/bin/podman
readonly CRUN_BIN=/nix/store/6116w8nq5ly8padymnqzvl3pw014r07h-crun-1.30.1/bin/crun
readonly NODE_VERSION=24.17.0
readonly NODE_SHA256=ab343a1b747c7cbf3630dfd7dbf818c5423fab2eb4f5ad1afc896f6bd121a917
readonly POLICY=${HOME:?}/.config/containers/policy.json
readonly REPO=$(git rev-parse --show-toplevel)
readonly EVIDENCE=$(mktemp -d /tmp/mottainai-oci-recovery-a-evidence.XXXXXXXX)
readonly STATE=$(mktemp -d /tmp/mottainai-oci-recovery-a-state.XXXXXXXX)
readonly NAME="mottainai-oci-recovery-a-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
readonly CONTAINER_PATH=/opt/node-v24.17.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

export PATH="$(dirname "$PODMAN_BIN"):$(dirname "$CRUN_BIN"):$PATH"
mkdir -m 700 "$STATE/storage" "$STATE/runroot" "$STATE/tmp"
chmod 700 "$EVIDENCE"
CID=
PRESERVE_STATE=0

podman() {
  "$PODMAN_BIN" --root "$STATE/storage" --runroot "$STATE/runroot" \
    --tmpdir "$STATE/tmp" --storage-driver=vfs --events-backend=file \
    --runtime=crun --cgroup-manager=systemd "$@"
}

container_exec() {
  podman exec --env "PATH=$CONTAINER_PATH" --workdir / "$CID" "$@"
}

repo_exec() {
  podman exec --env "PATH=$CONTAINER_PATH" --workdir /workspace/mottainai "$CID" "$@"
}

runtime_exec() {
  runtime_exec_at /workspace/mottainai "$@"
}

runtime_exec_at() {
  local workdir=$1
  shift
  podman exec --env "PATH=$CONTAINER_PATH" \
    --env NAWABARI_FHS_NODE_EXECUTABLE=/opt/node-v24.17.0/bin/node \
    --env NAWABARI_FHS_GIT_EXECUTABLE=/usr/bin/git \
    --env NAWABARI_FHS_LS_EXECUTABLE=/usr/bin/ls \
    --workdir "$workdir" "$CID" "$@"
}

cleanup() {
  local result=$? remaining owner real_state
  trap - EXIT
  if [[ -n "$CID" ]] && podman inspect "$CID" >/dev/null 2>&1; then
    if ! podman rm --force "$CID" >"$EVIDENCE/container-remove.log" 2>&1; then
      printf 'cleanup: container removal failed; preserving %s\n' "$STATE" >&2
      PRESERVE_STATE=1
    fi
  fi
  if ! remaining=$(podman ps --all --quiet 2>"$EVIDENCE/cleanup-list.log"); then
    printf 'cleanup: container inventory failed; preserving %s\n' "$STATE" >&2
    PRESERVE_STATE=1
  elif [[ -n "$remaining" ]]; then
    printf 'cleanup: containers remain in owned store; preserving %s\n' "$STATE" >&2
    PRESERVE_STATE=1
  fi
  if (( PRESERVE_STATE == 0 )); then
    owner=$(stat -c '%u' "$STATE" 2>/dev/null || printf 'unknown')
    real_state=$(realpath -e "$STATE" 2>/dev/null || true)
    if [[ "$owner" == "$(id -u)" && "$real_state" == "$STATE" && "$STATE" == /tmp/mottainai-oci-recovery-a-state.* ]]; then
      rm -rf -- "$STATE"
    else
      printf 'cleanup: state ownership/path check failed; preserving %s\n' "$STATE" >&2
      PRESERVE_STATE=1
    fi
  fi
  printf 'evidence=%s\n' "$EVIDENCE"
  if (( PRESERVE_STATE != 0 )); then printf 'state_preserved=%s\n' "$STATE" >&2; fi
  if (( PRESERVE_STATE != 0 && result == 0 )); then result=1; fi
  exit "$result"
}
trap cleanup EXIT

for executable in "$PODMAN_BIN" "$CRUN_BIN" python3 git curl; do
  command -v "$executable" >/dev/null 2>&1 || {
    printf 'missing executable: %s\n' "$executable" >&2
    exit 2
  }
done
[[ "$(git rev-parse refs/remotes/origin/main)" == "$BASE" ]] || {
  printf 'origin/main is not the accepted base %s\n' "$BASE" >&2
  exit 2
}
[[ -r "$POLICY" ]] || {
  printf 'approved temporary image policy is missing: %s\n' "$POLICY" >&2
  exit 2
}
python3 - "$POLICY" <<'PY'
import json, sys
expected = {
    "default": [{"type": "reject"}],
    "transports": {"docker": {"docker.io/library/debian": [{"type": "insecureAcceptAnything"}]}},
}
with open(sys.argv[1], encoding="utf-8") as stream:
    actual = json.load(stream)
if actual != expected:
    raise SystemExit("image policy differs from the approved Debian-only policy")
PY

{
  printf 'date='; date --iso-8601=seconds
  printf 'hostname='; hostname
  printf 'virtualization='; systemd-detect-virt
  uname -a
  printf '\n-- subuid/subgid --\n'
  grep '^sophia:' /etc/subuid /etc/subgid
  printf '\n-- user service delegation --\n'
  systemctl show user@1000.service -p Delegate -p ControlGroup
  printf '\n-- cgroup filesystem --\n'
  stat -fc '%T' /sys/fs/cgroup
  printf '\n-- pinned tools --\n'
  "$PODMAN_BIN" --version
  "$CRUN_BIN" --version
} >"$EVIDENCE/host-preflight.txt" 2>&1

podman info --format json >"$EVIDENCE/podman-info.json"
podman pull "$IMAGE" >"$EVIDENCE/image-pull.log" 2>&1
podman image inspect "$IMAGE" >"$EVIDENCE/image-inspect.json"
podman run --detach --name "$NAME" --pull=never --memory=512m --cpus=1 \
  --pids-limit=128 "$IMAGE" sleep infinity >"$EVIDENCE/container-id.txt"
CID=$(tr -d '\n' <"$EVIDENCE/container-id.txt")
[[ "$CID" =~ ^[0-9a-f]{64}$ ]] || { printf 'unexpected container id: %s\n' "$CID" >&2; exit 1; }
podman inspect "$CID" >"$EVIDENCE/container-inspect.json"
OCI_CONFIG=$(podman inspect --format '{{.OCIConfigPath}}' "$CID")
case "$OCI_CONFIG" in
  "$STATE"/storage/*) cp -- "$OCI_CONFIG" "$EVIDENCE/oci-config.json" ;;
  *) printf 'OCI config escaped owned storage: %s\n' "$OCI_CONFIG" >&2; exit 1 ;;
esac

python3 - "$EVIDENCE" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
info = json.loads((root / "podman-info.json").read_text())
inspect = json.loads((root / "container-inspect.json").read_text())[0]
oci = json.loads((root / "oci-config.json").read_text())
linux = oci.get("linux", {})
host = inspect.get("HostConfig", {})
summary = {
    "podman_rootless": info.get("host", {}).get("security", {}).get("rootless"),
    "podman_seccomp_enabled": info.get("host", {}).get("security", {}).get("seccompEnabled"),
    "oci_runtime": info.get("host", {}).get("ociRuntime", {}).get("name"),
    "cgroup_version": info.get("host", {}).get("cgroupVersion"),
    "image_id": inspect.get("Image"),
    "image_digest": inspect.get("ImageDigest"),
    "privileged": host.get("Privileged"),
    "pid_mode": host.get("PidMode"),
    "security_options": host.get("SecurityOpt"),
    "cap_add": host.get("CapAdd"),
    "cap_drop": host.get("CapDrop"),
    "memory_bytes": host.get("Memory"),
    "nano_cpus": host.get("NanoCpus"),
    "pids_limit": host.get("PidsLimit"),
    "oci_uid_mappings": linux.get("uidMappings"),
    "oci_gid_mappings": linux.get("gidMappings"),
    "namespaces": linux.get("namespaces"),
    "seccomp_default_action": linux.get("seccomp", {}).get("defaultAction"),
    "seccomp_default_errno": linux.get("seccomp", {}).get("defaultErrnoRet"),
    "process_capabilities": oci.get("process", {}).get("capabilities"),
    "masked_proc_paths": [p for p in linux.get("maskedPaths", []) if p.startswith("/proc/")],
    "readonly_proc_paths": [p for p in linux.get("readonlyPaths", []) if p.startswith("/proc/")],
    "proc_mounts": [m for m in oci.get("mounts", []) if m.get("destination") == "/proc" or m.get("destination", "").startswith("/proc/")],
}
(root / "runtime-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
if (
    summary["podman_rootless"] is not True
    or summary["podman_seccomp_enabled"] is not True
    or summary["privileged"] is not False
    or summary["pid_mode"] != "private"
    or summary["security_options"] != []
    or summary["cap_add"] != []
    or summary["cap_drop"] != []
    or summary["memory_bytes"] != 536870912
    or summary["nano_cpus"] != 1000000000
    or summary["pids_limit"] != 128
    or summary["seccomp_default_action"] != "SCMP_ACT_ERRNO"
):
    raise SystemExit("container does not match the rootless/private/default-seccomp demo setup")
PY

container_exec sh -ec 'cat /proc/self/status | grep -E "^(Uid|Gid|Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Seccomp):"; printf "\\n-- uid_map --\\n"; cat /proc/self/uid_map; printf "\\n-- gid_map --\\n"; cat /proc/self/gid_map; printf "\\n-- cgroup --\\n"; cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max; printf "\\n-- mounts --\\n"; grep -E " /proc(/| )| - cgroup2 " /proc/self/mountinfo' >"$EVIDENCE/container-runtime-state.log" 2>&1
container_exec sh -ec 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git jq util-linux bubblewrap xz-utils' >"$EVIDENCE/debian-setup.log" 2>&1
git init --bare "$EVIDENCE/source.git" >"$EVIDENCE/repository-bundle.log" 2>&1
git --git-dir="$EVIDENCE/source.git" fetch --no-tags "$REPO" \
  refs/remotes/origin/main:refs/heads/main >>"$EVIDENCE/repository-bundle.log" 2>&1
git --git-dir="$EVIDENCE/source.git" symbolic-ref HEAD refs/heads/main
git --git-dir="$EVIDENCE/source.git" bundle create "$EVIDENCE/repository.bundle" HEAD \
  >>"$EVIDENCE/repository-bundle.log" 2>&1
[[ "$(git bundle list-heads "$EVIDENCE/repository.bundle" | awk '{print $1}')" == "$BASE" ]] || {
  printf 'repository bundle does not match the accepted base\n' >&2
  exit 1
}
rm -rf -- "$EVIDENCE/source.git"
podman exec "$CID" mkdir -p /workspace
podman cp "$EVIDENCE/repository.bundle" "$CID:/tmp/mottainai.bundle" >"$EVIDENCE/repository-copy.log" 2>&1
container_exec git clone /tmp/mottainai.bundle /workspace/mottainai >"$EVIDENCE/repository-clone.log" 2>&1
container_exec git -C /workspace/mottainai checkout -b main "$BASE" >>"$EVIDENCE/repository-clone.log" 2>&1
container_exec git -C /workspace/mottainai remote remove origin
[[ "$(container_exec git -C /workspace/mottainai rev-parse HEAD)" == "$BASE" ]] || {
  printf 'container source checkout does not match the accepted base\n' >&2
  exit 1
}
container_exec sh -ec "curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz && echo '$NODE_SHA256  /tmp/node.tar.xz' | sha256sum -c && mkdir -p /opt && tar -xJf /tmp/node.tar.xz -C /opt && mv /opt/node-v$NODE_VERSION-linux-x64 /opt/node-v$NODE_VERSION && /opt/node-v$NODE_VERSION/bin/node --version" >"$EVIDENCE/node-setup.log" 2>&1
container_exec /opt/node-v24.17.0/bin/npm install --prefix /opt/nawabari nawabari@0.14.0 >"$EVIDENCE/nawabari-install.log" 2>&1
readonly NAWABARI=/opt/nawabari/node_modules/.bin/nawabari
runtime_exec "$NAWABARI" --version >"$EVIDENCE/nawabari-version.txt"

# Test the nested user+mount+PID namespace and procfs mount under the OCI's
# unmodified default seccomp/capability profile.
container_exec sh -ec 'mkdir -p /tmp/proc-mount-probe'
set +e
container_exec unshare --user --map-root-user --mount --pid --fork sh -ec \
  'grep -E "^(CapEff|Seccomp):" /proc/self/status; mount -t proc proc /tmp/proc-mount-probe' \
  >"$EVIDENCE/nested-proc-mount.log" 2>&1
proc_status=$?
set -e
printf '%s\n' "$proc_status" >"$EVIDENCE/nested-proc-mount.exit"
if (( proc_status == 0 )) || ! grep -Fq 'fsmount() failed: VFS: Mount too revealing.' "$EVIDENCE/nested-proc-mount.log"; then
  printf 'expected nested procfs rejection was not reproduced; see %s\n' "$EVIDENCE/nested-proc-mount.log" >&2
  exit 1
fi

repo_exec "$NAWABARI" doctor --json >"$EVIDENCE/doctor-unconfigured.json" 2>"$EVIDENCE/doctor-unconfigured.stderr"
runtime_exec "$NAWABARI" doctor --json >"$EVIDENCE/doctor.json" 2>"$EVIDENCE/doctor.stderr"
python3 - "$EVIDENCE/doctor.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    report = json.load(stream)
sandbox = report["sandbox"]
if sandbox.get("strict_ready") is not True or sandbox.get("runtime", {}).get("selected") != "fhs":
    raise SystemExit("explicit FHS runtime candidate did not become strict-ready")
if report.get("managed_execution", {}).get("ready") is not False:
    raise SystemExit("managed process-tracking readiness changed unexpectedly")
PY
runtime_exec "$NAWABARI" session create --json >"$EVIDENCE/session-create.json" 2>"$EVIDENCE/session-create.stderr"
SESSION_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["session_id"])' "$EVIDENCE/session-create.json")
[[ "$SESSION_ID" =~ ^[0-9a-f-]{36}$ ]] || { printf 'unexpected session id: %s\n' "$SESSION_ID" >&2; exit 1; }
SESSION_WORKTREE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["worktree"])' "$EVIDENCE/session-create.json")
EXPECTED_WORKTREE="/workspace/.nawabari/worktrees/mottainai-$SESSION_ID"
[[ "$SESSION_WORKTREE" == "$EXPECTED_WORKTREE" ]] || {
  printf 'session worktree did not match the isolated session path: %s\n' "$SESSION_WORKTREE" >&2
  exit 1
}
printf 'session_worktree=%s\n' "$SESSION_WORKTREE" >"$EVIDENCE/session-worktree.txt"
set +e
runtime_exec_at "$SESSION_WORKTREE" "$NAWABARI" --json session run --session "$SESSION_ID" -- /bin/true \
  >"$EVIDENCE/session-run.json" 2>"$EVIDENCE/session-run.stderr"
run_status=$?
set -e
printf '%s\n' "$run_status" >"$EVIDENCE/session-run.exit"
python3 - "$EVIDENCE/session-run.json" "$run_status" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    result = json.load(stream)
if int(sys.argv[2]) != 3 or result.get("ok") is not False or result.get("code") != "SANDBOX_EXECUTION_FAILED":
    raise SystemExit("expected Nawabari strict execution failure was not reproduced")
if "bwrap: Can't mount proc on /proc: Operation not permitted" not in result.get("details", {}).get("stderr", ""):
    raise SystemExit("strict run failed for a different reason; inspect session-run.json")
PY

printf 'result=FAIL: default OCI masks hidden proc entries; nested procfs mount denied by kernel\n'
printf 'conditional_followups=BLOCKED: strict launch failed; do not infer isolation or enforcement\n'
printf 'session_id=%s\n' "$SESSION_ID"
printf 'image=%s\n' "$IMAGE"
printf 'signature_verified=false (temporary policy accepts this registry/repository only)\n'
