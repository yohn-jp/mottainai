#!/usr/bin/env bash
set -Eeuo pipefail

# Reproduce the rootless OCI + latest Nawabari strict-run probe on the Wave 1
# NixOS target. The known proc-mount denial is a compatibility FAIL.
# The host policy is created only with the explicitly approved opt-in:
# MOTTAINAI_OCI_TEMP_POLICY_APPROVED=debian-only ./scripts/poc/oci-worker-a.sh
readonly nixpkgs_rev='39ad350a0602fa0a58a544344e3e9187526ea45c'
readonly image='docker.io/library/debian@sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5'
readonly node_version='24.17.0'
readonly nawabari_version='0.14.0'

script_path="$(realpath "$0")"
if [[ "${MOTTAINAI_OCI_WORKER_A_PINNED_SHELL:-0}" != 1 ]] && { ! command -v podman >/dev/null || ! command -v crun >/dev/null; }; then
  command -v nix >/dev/null 2>&1 || { echo 'BLOCKED: install/use Nix for the pinned Podman/crun shell' >&2; exit 2; }
  exec nix shell \
    "github:NixOS/nixpkgs/${nixpkgs_rev}#podman" \
    "github:NixOS/nixpkgs/${nixpkgs_rev}#crun" \
    --command env MOTTAINAI_OCI_WORKER_A_PINNED_SHELL=1 bash "$script_path"
fi

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
for tool in podman crun git tar getent sha256sum python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool missing: $tool"
done
[[ "$(id -u)" != 0 ]] || fail 'run as an unprivileged host user'
[[ "$(podman --version)" == 'podman version 5.8.8' ]] || fail "unexpected Podman: $(podman --version)"
[[ "$(crun --version | head -n1)" == 'crun version 1.30.1' ]] || fail "unexpected crun: $(crun --version | head -n1)"

repo_root="$(git -C "$(dirname "$script_path")/../.." rev-parse --show-toplevel)"
repo_head="$(git -C "$repo_root" rev-parse HEAD)"
repo_branch="$(git -C "$repo_root" branch --show-current)"
host_uid="$(id -u)"
user_home="$(getent passwd "$host_uid" | cut -d: -f6)"
[[ -n "$user_home" && -d "$user_home" ]] || fail 'could not resolve caller home from passwd database'
[[ "${MOTTAINAI_OCI_TEMP_POLICY_APPROVED:-}" == debian-only ]] \
  || { echo 'BLOCKED: require MOTTAINAI_OCI_TEMP_POLICY_APPROVED=debian-only for temporary per-user policy creation' >&2; exit 2; }

# Podman 5.8.8 has no pull/global signature-policy override. Temporarily create
# only the caller policy, default-deny with Debian Official Image allowed.
policy_dir="$user_home/.config/containers"
policy_path="$policy_dir/policy.json"
policy_dir_created=0
policy_dir_identity=''
if [[ -e "$policy_path" || -L "$policy_path" ]]; then
  fail "refusing to replace existing policy: $policy_path"
fi
if [[ -e "$policy_dir" || -L "$policy_dir" ]]; then
  [[ -d "$policy_dir" && ! -L "$policy_dir" ]] || fail "unsafe policy directory: $policy_dir"
else
  install -d -m 700 "$policy_dir"
  policy_dir_created=1
fi
umask 077
if ! (set -o noclobber; cat > "$policy_path") <<'POLICY'
{
  "default": [{"type": "reject"}],
  "transports": {
    "docker": {
      "docker.io/library/debian": [{"type": "insecureAcceptAnything"}]
    }
  }
}
POLICY
then
  fail "could not exclusively create temporary policy: $policy_path"
fi
policy_identity="$(stat -c '%d:%i:%u:%g:%a:%s' "$policy_path")"
policy_hash="$(sha256sum "$policy_path" | cut -d' ' -f1)"
policy_dir_identity="$(stat -c '%d:%i:%u:%g:%a' "$policy_dir")"
state_dir=''
container_id=''
image_present=0
evidence_dir=''
podman_args=()
cleanup() {
  rc=$?
  trap - EXIT
  if [[ -n "$state_dir" ]]; then
    if [[ -n "$container_id" ]]; then
      podman "${podman_args[@]}" container rm --force "$container_id" >/dev/null 2>&1 || true
    fi
    if podman "${podman_args[@]}" ps --all --no-trunc --quiet >"$state_dir/remaining-containers" 2>"$state_dir/cleanup-error"; then
      if [[ -s "$state_dir/remaining-containers" ]]; then
        printf 'KEEP OCI storage; containers remain: %s\n' "$state_dir" >&2
        cat "$state_dir/remaining-containers" >&2
        rc=1
      else
        if [[ "$image_present" == 1 ]]; then
          podman "${podman_args[@]}" image rm "$image" >/dev/null 2>&1 || true
        fi
        rm -rf -- "$state_dir"
        printf 'REMOVED isolated OCI storage after confirming no containers remain.\n'
      fi
    else
      printf 'KEEP OCI storage; could not verify container absence: %s\n' "$state_dir" >&2
      rc=1
    fi
  fi

  if [[ ! -e "$policy_path" && ! -L "$policy_path" ]]; then
    printf 'POLICY already absent: %s\n' "$policy_path"
  elif [[ -f "$policy_path" && ! -L "$policy_path" \
      && "$(stat -c '%d:%i:%u:%g:%a:%s' "$policy_path" 2>/dev/null || true)" == "$policy_identity" \
      && "$(sha256sum "$policy_path" 2>/dev/null | cut -d' ' -f1)" == "$policy_hash" ]]; then
    rm -- "$policy_path"
    printf 'REMOVED verified temporary policy: %s\n' "$policy_path"
  else
    printf 'KEEP policy; ownership identity changed: %s\n' "$policy_path" >&2
    rc=1
  fi
  if [[ "$policy_dir_created" == 1 ]]; then
    if [[ ! -e "$policy_dir" && ! -L "$policy_dir" ]]; then
      printf 'POLICY directory already absent: %s\n' "$policy_dir"
    elif [[ -d "$policy_dir" && ! -L "$policy_dir" \
        && "$(stat -c '%d:%i:%u:%g:%a' "$policy_dir" 2>/dev/null || true)" == "$policy_dir_identity" ]]; then
      rmdir -- "$policy_dir" 2>/dev/null || { printf 'KEEP nonempty policy directory: %s\n' "$policy_dir" >&2; rc=1; }
    else
      printf 'KEEP policy directory; identity changed: %s\n' "$policy_dir" >&2
      rc=1
    fi
  fi
  if [[ -n "$evidence_dir" ]]; then printf 'CLEANUP rc=%s evidence=%s\n' "$rc" "$evidence_dir"; fi
  exit "$rc"
}
trap cleanup EXIT
[[ "$(stat -c '%a' "$policy_path")" == 600 ]] || fail 'temporary policy mode is not 0600'

evidence_dir="$(mktemp -d /tmp/mottainai-oci-worker-a-evidence.XXXXXXXX)"
chmod 700 "$evidence_dir"
exec > >(tee -a "$evidence_dir/run.log") 2>&1
printf 'EVIDENCE %s\n' "$evidence_dir"
printf 'REPOSITORY head=%s branch=%s\n' "$repo_head" "$repo_branch"
printf 'TOOLS %s; %s\n' "$(podman --version)" "$(crun --version | head -n1)"
printf 'POLICY identity=%s sha256=%s default=reject docker.io/library/debian=insecureAcceptAnything\n' "$policy_identity" "$policy_hash"

state_dir="$(mktemp -d /tmp/mottainai-oci-worker-a-state.XXXXXXXX)"
chmod 700 "$state_dir"
mkdir -m 700 "$state_dir/storage" "$state_dir/runroot" "$state_dir/tmp"
podman_args=(
  --root "$state_dir/storage"
  --runroot "$state_dir/runroot"
  --tmpdir "$state_dir/tmp"
  --storage-driver=vfs
  --events-backend=file
  --runtime=crun
  --cgroup-manager=systemd
)

[[ "$(stat -fc '%T' /sys/fs/cgroup)" == cgroup2fs ]] || fail 'host is not using unified cgroups v2'
rootless="$(podman "${podman_args[@]}" info --format '{{.Host.Security.Rootless}}')"
runtime="$(podman "${podman_args[@]}" info --format '{{.Host.OCIRuntime.Name}}')"
seccomp="$(podman "${podman_args[@]}" info --format json | python3 -c 'import json,sys; print(str(json.load(sys.stdin)["host"]["security"]["seccompEnabled"]).lower())')"
cgroup_manager="$(podman "${podman_args[@]}" info --format '{{.Host.CgroupManager}}')"
printf 'PODMAN rootless=%s runtime=%s seccomp=%s cgroup_manager=%s storage=%s\n' \
  "$rootless" "$runtime" "$seccomp" "$cgroup_manager" "$state_dir"
[[ "$rootless" == true && "$runtime" == crun && "$seccomp" == true && "$cgroup_manager" == systemd ]] \
  || fail 'isolated Podman did not report required rootless crun/seccomp/systemd facts'
printf 'PASS rootless Podman runtime readiness\n'

printf 'IMAGE_PULL %s\n' "$image"
podman "${podman_args[@]}" pull --quiet "$image" >"$evidence_dir/pull.log" 2>&1 || {
  cat "$evidence_dir/pull.log"; fail 'pinned Debian image pull failed'
}
image_present=1
printf 'IMAGE_REPODIGEST %s\n' "$(podman "${podman_args[@]}" image inspect "$image" --format '{{index .RepoDigests 0}}')"

container_name="mottainai-oci-a-$$"
container_id="$(podman "${podman_args[@]}" run --detach --name "$container_name" \
  --pull=never --memory=512m --cpus=1 --pids-limit=128 "$image" sleep infinity)" \
  || fail 'rootless Debian container launch failed'
printf 'CONTAINER_ID %s\n' "$container_id"
podman "${podman_args[@]}" inspect "$container_id" \
  --format 'CONTAINER privileged={{.HostConfig.Privileged}} pid_mode={{if .HostConfig.PidMode}}{{.HostConfig.PidMode}}{{else}}private(default){{end}} memory_bytes={{.HostConfig.Memory}} nano_cpus={{.HostConfig.NanoCpus}} pids_limit={{.HostConfig.PidsLimit}}'
podman "${podman_args[@]}" exec "$container_id" sh -ec \
  'printf "CGROUP memory.max="; cat /sys/fs/cgroup/memory.max; printf "CGROUP cpu.max="; cat /sys/fs/cgroup/cpu.max; printf "CGROUP pids.max="; cat /sys/fs/cgroup/pids.max; printf "UID_MAP "; tr "\n" ";" </proc/self/uid_map; printf "\n"' \
  | tee "$evidence_dir/container-limits.log"
printf 'NOTE configured cgroup values are not enforcement stress tests.\n'

clone_dir="$state_dir/mottainai"
git clone --no-hardlinks --single-branch --branch "$repo_branch" "$repo_root" "$clone_dir" >"$evidence_dir/clone.log" 2>&1 \
  || { cat "$evidence_dir/clone.log"; fail 'isolated repository clone failed'; }
git -C "$clone_dir" remote remove origin
[[ "$(git -C "$clone_dir" rev-parse HEAD)" == "$repo_head" ]] || fail 'isolated clone HEAD changed'
podman "${podman_args[@]}" exec "$container_id" mkdir -p /workspace/mottainai
podman "${podman_args[@]}" cp "$clone_dir/." "$container_id:/workspace/mottainai/"
podman "${podman_args[@]}" exec "$container_id" chown -R 0:0 /workspace/mottainai

podman "${podman_args[@]}" exec "$container_id" sh -ec \
  'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl git xz-utils bubblewrap && rm -rf /var/lib/apt/lists/*' \
  >"$evidence_dir/debian-setup.log" 2>&1 || { cat "$evidence_dir/debian-setup.log"; fail 'disposable Debian tool setup failed'; }
podman "${podman_args[@]}" exec "$container_id" sh -ec "
  cd /tmp
  curl -fsSLO https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz
  curl -fsSLO https://nodejs.org/dist/v${node_version}/SHASUMS256.txt
  grep ' node-v${node_version}-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -
  mkdir -p /opt/node-v${node_version}
  tar -xJf node-v${node_version}-linux-x64.tar.xz --strip-components=1 -C /opt/node-v${node_version}
  export PATH=/opt/node-v${node_version}/bin:\$PATH
  npm --prefix /opt/node-v${node_version} install --global --omit=dev nawabari@${nawabari_version}
  /opt/node-v${node_version}/bin/node --version
  /opt/node-v${node_version}/bin/nawabari --version
" >"$evidence_dir/nawabari-install.log" 2>&1 || { cat "$evidence_dir/nawabari-install.log"; fail 'released Node/Nawabari setup failed'; }

fhs_env=(
  NAWABARI_FHS_NODE_EXECUTABLE="/opt/node-v${node_version}/bin/node"
  NAWABARI_FHS_GIT_EXECUTABLE=/usr/bin/git
  NAWABARI_FHS_LS_EXECUTABLE=/usr/bin/ls
  PATH="/opt/node-v${node_version}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)
doctor_output="$(podman "${podman_args[@]}" exec --workdir /workspace/mottainai \
  --env "${fhs_env[0]}" --env "${fhs_env[1]}" --env "${fhs_env[2]}" --env "${fhs_env[3]}" \
  "$container_id" nawabari --json doctor 2>"$evidence_dir/doctor.stderr")" \
  || { cat "$evidence_dir/doctor.stderr"; fail 'Nawabari doctor failed'; }
printf '%s\n' "$doctor_output" >"$evidence_dir/doctor.json"
printf '%s\n' "$doctor_output"

create_session() {
  local label="$1" output_file="$2" output session_id
  output="$(podman "${podman_args[@]}" exec --workdir /workspace/mottainai \
    --env "${fhs_env[0]}" --env "${fhs_env[1]}" --env "${fhs_env[2]}" --env "${fhs_env[3]}" \
    "$container_id" nawabari --json session create 2>"$evidence_dir/session-create-${label}.stderr")" \
    || { cat "$evidence_dir/session-create-${label}.stderr"; printf '%s\n' "$output" >&2; fail "Nawabari session create ${label} failed"; }
  printf '%s\n' "$output" >"$output_file"
  session_id="$(printf '%s\n' "$output" | grep -Eo '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}' | head -n1 || true)"
  [[ -n "$session_id" ]] || fail "could not extract session UUID from ${label} response"
  printf '%s' "$session_id"
}

session_one="$(create_session one "$evidence_dir/session-one.json")"
session_two="$(create_session two "$evidence_dir/session-two.json")"
[[ "$session_one" != "$session_two" ]] || fail 'session create returned duplicate IDs'
printf 'SESSION_CREATE one=%s two=%s\n' "$session_one" "$session_two"

set +e
podman "${podman_args[@]}" exec --workdir "/workspace/.nawabari/worktrees/mottainai-${session_one}" \
  --env "${fhs_env[0]}" --env "${fhs_env[1]}" --env "${fhs_env[2]}" --env "${fhs_env[3]}" \
  "$container_id" nawabari --json session run --session "$session_one" -- /bin/true \
  >"$evidence_dir/session-run.json" 2>&1
run_rc=$?
set -e
cat "$evidence_dir/session-run.json"
if [[ "$run_rc" == 3 ]] && grep -Fq "bwrap: Can't mount proc on /proc: Operation not permitted" "$evidence_dir/session-run.json"; then
  printf 'FAIL strict Nawabari compatibility: protected proc mount denied (exit=%s); no sandbox weakening attempted.\n' "$run_rc"
else
  fail "strict Nawabari run did not reproduce the measured proc-mount blocker (exit=$run_rc)"
fi
worker_b_script="$(dirname "$script_path")/oci-worker-b.sh"
[[ -x "$worker_b_script" ]] || fail "required live Jinushi probe missing: $worker_b_script"
"$worker_b_script" "$state_dir" "$container_id" | tee "$evidence_dir/jinushi-live.log"
printf 'REPRODUCED expected compatibility FAIL; script exit 0 denotes reproduction only, not acceptance. Managed execution and A6 enforcement remain BLOCKED.\n'
