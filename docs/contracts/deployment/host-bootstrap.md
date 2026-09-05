# Standalone host bootstrap

mottainai-init is the host-side bootstrap for the initial local provider
profile: Linux x86_64, KVM, and the Lima/QEMU provider boundary. Its default
invocation (no subcommand) prepares the machine that launches a Runtime
Appliance: the verified Lima provider binary and a pinned, verified QEMU/KVM
host toolchain. The selected Lima profile also requires the host OpenSSH
client tools `ssh` and `ssh-keygen`; Route 4 validates both independently
from `PATH` before any provider or Runtime state mutation.
Its `runtime ensure` subcommand (#661, see
[`lima-runtime-orchestration.md`](../../architecture/runtime/lima-orchestration.md)) converges a
local Lima-managed Runtime instance to ready state using that verified
provider. Neither owns the #626 guest bootstrap or managed Mottainai
generation installation, QEMU topology construction, or Proxmox deployment.

For the normative execution order connecting this host-bootstrap surface to
the selected release, Lima, the canonical Appliance, managed generation, and
Route 1 payload, see
[`route4-route1-operation-book.md`](../../operations/deployment/route4-to-route1.md). This file
remains the Route 4 component contract. Open implementation gaps such as the
provider-profile consumer, SSH key lifecycle, and QEMU data closure
revalidation are recorded against their exact handoff steps in the operation
book rather than being normalized here as completed behavior.

## Contract and execution

The executable is a Rust binary. Its runtime has no dependency on Node,
Python, DSC, Nix, Lima, a distro package manager, or an installed Mottainai
application. Build and test it from the repository root:

~~~bash
cargo test --locked --manifest-path host-bootstrap/Cargo.toml
cargo build --locked --release --manifest-path host-bootstrap/Cargo.toml
./host-bootstrap/target/release/mottainai-init --help
~~~

The ordinary target above is a local development build only. The
distributable `mottainai-init-linux-x86_64` is built and tested with the
`x86_64-unknown-linux-musl` target; a glibc-linked `target/release` binary is
not a portable release artifact.

The default provider contract is explicit and immutable: Lima 2.2.0,
Linux x86_64 archive identity, GitHub HTTPS release URL, and the official
release SHA-256 `a0ea1ccf6b7335a900adb5f8d2b8384457965fecb1ba72f09b4e3e46d12f424a`.
A reviewed contract JSON
may be supplied with --contract; it must still identify the supported Lima
provider and pass the schema, URL, path, size, timeout, and digest checks.

When QEMU is absent, Route 4 automatically materializes the reviewed
hermeticbuild static QEMU 11.0.0 Linux x86_64 system and image artifacts.
Their release URLs, archive digests, executable paths, and version are fixed
in the compiled QEMU contract; no package manager or operator research is
required. If acquisition is unavailable, convergence fails closed with a
bounded remediation diagnostic.

For a release artifact, verify the detached digest/provenance before executing
it:

~~~bash
sha256sum --check mottainai-init-linux-x86_64.sha256
./mottainai-init-linux-x86_64 --json
~~~

The release sidecar is the trust boundary for the bootstrap executable itself.
The --json result also reports the running executable version and digest.
The binary does not invoke sudo, a shell, apt, dnf, pacman, or any other
package manager.

## OpenSSH host prerequisite

The supported Lima 2.2.0 profile resolves the host `ssh` client and
`ssh-keygen` independently from the process `PATH`. Route 4 treats those
executables as an explicit validated host precondition: `mottainai-init`
checks that each is a regular executable before acquiring managed state,
materializing Lima/QEMU/Appliance artifacts, or invoking any Lima operation.
Missing tools fail closed with a bounded diagnostic naming the missing
executable and the required remediation. The standalone Rust bootstrap never
invokes a shell or package manager to install them.

This host-tooling check is separate from the provider credential authority.
Lima continues to use the isolated managed `$LIMA_HOME/_config/user(.pub)`
identity with `ssh.loadDotSSHPubKeys: false`; Route 4 never adopts ambient
`~/.ssh` credentials. The validated host `ssh` client transports that managed
identity, while `ssh-keygen` supports its creation when the isolated identity
does not yet exist.

## Fetching the published release artifact

Every tagged Mottainai release publishes `mottainai-init-linux-x86_64` and its
detached `mottainai-init-linux-x86_64.sha256` digest sidecar as durable,
immutable release assets. No repository checkout, Rust toolchain, Node, or
Nix is required to obtain or verify them. From a fresh Linux x86_64 host,
substitute the exact release tag (for example `v0.7.1`) and run:

~~~bash
RELEASE_TAG=v0.7.1
curl -fsSLO "https://github.com/yohn-jp/mottainai/releases/download/${RELEASE_TAG}/mottainai-init-linux-x86_64"
curl -fsSLO "https://github.com/yohn-jp/mottainai/releases/download/${RELEASE_TAG}/mottainai-init-linux-x86_64.sha256"
sha256sum --check mottainai-init-linux-x86_64.sha256
chmod +x mottainai-init-linux-x86_64
./mottainai-init-linux-x86_64 --version
~~~

`sha256sum --check` fails closed on any missing, mismatched, or mutated
bytes; do not execute the binary if it does not pass. The publishing release
workflow performs this same fetch-and-verify sequence against the just-
published assets, from a fresh location outside the build directory, before
the release is considered successful. Re-running publication for an already
published release tag is idempotent for identical bytes and fails the
workflow rather than silently replacing a published asset with different
bytes.

## Reconciliation

Every step follows:

~~~text
inspect -> classify -> ensure -> verify
~~~

The six classifications are deterministic:

| Classification | Meaning |
| --- | --- |
| satisfied | Exact supported state is proven; no mutation |
| missing | State is absent and bounded managed convergence is allowed |
| repairable | An interrupted managed transaction can be rebuilt safely |
| incompatible | Existing state conflicts with the contract; fail closed |
| unsupported | Host profile is outside Linux x86_64/KVM |
| ambiguous | Identity or capability cannot be proven safely |

The host probe checks OS, architecture, kernel release, /dev/kvm existence,
character-device type, and a real current-user read/write open. Missing KVM,
permission failure, non-character state, unknown capability state, and
unsupported profiles are diagnostics, not implicit privilege-remediation
requests.

## Managed state

The default location is:

~~~text
$XDG_STATE_HOME/mottainai/host-bootstrap/
~~~

when XDG_STATE_HOME is an absolute path; otherwise:

~~~text
$HOME/.local/state/mottainai/host-bootstrap/
├── bootstrap.lock
├── state.json                 # Lima artifact/materialization proof
├── qemu.json                  # QEMU prerequisite proof
├── qemu/                      # pinned relocatable QEMU host-toolchain closure
│   └── 11.0.0/                # bin/ tools and share/qemu firmware/data
├── active -> providers/<artifact-id>
├── cache/
│   └── <artifact-id>.tar.gz
├── providers/
│   └── <artifact-id>/
│       └── bin/limactl
├── staging/
├── appliances/                 # runtime ensure: verified canonical Appliance disks, by digest
│   └── <sha256-hex>/
│       ├── mottainai-runtime-appliance.raw
│       └── state.json
├── runtime/                    # runtime ensure: managed Lima instance configuration/state
│   └── <instance-name>/
│       ├── lima.yaml
│       └── state.json
└── lima-home/                  # runtime ensure: isolated LIMA_HOME for managed limactl invocations
~~~

`appliances/` and `runtime/` are populated only by `mottainai-init runtime
ensure`, are keyed the same idempotent, digest-verified way as the provider
directory above, and are documented in
[`lima-runtime-orchestration.md`](../../architecture/runtime/lima-orchestration.md).

The host bootstrap and `mottainai-init runtime ensure` share ownership of this
state root. Host bootstrap owns QEMU/provider state (`qemu.json`, `cache/`,
`providers/`, `active`, and the provider staging boundary); `runtime ensure`
owns verified Appliance materialization (`appliances/`), managed Runtime
configuration/state (`runtime/`), and its isolated Lima home (`lima-home/`).
Both mutating paths acquire the same non-blocking `bootstrap.lock` before any
state, configuration, staging, provider, Appliance, or Lima mutation and hold
it through the complete reconciliation. Lock contention returns the bounded
`bootstrap_locked` classification; it never waits or guesses at recovery.

The state-root directory may be created as the prerequisite for opening the
lock, but no state/configuration/staging write occurs before writer authority
is acquired. Downloaded bytes first land in a .part file, are size- and
digest-verified, and are atomically promoted. Archive extraction is performed
into staging, then atomically promoted to the immutable provider identity. The
active link and state.json are promoted only after the provider executable and
archive identity verify. Stale staging or partial downloads are discarded and
safely retried on the next locked run.

Ambient limactl binaries are never adopted. A non-managed or multiply
resolved ambient binary is classified as incompatible or ambiguous and blocks
convergence.

## QEMU/KVM prerequisite

The supported Lima provider requires `qemu-system-x86_64`, `qemu-img`, and the
matching QEMU firmware/data closure from one exact installation. Route 4 first
checks the managed QEMU state. If no explicitly adopted installation is
recorded, it downloads the three pinned archives into bounded `.part` files,
verifies their SHA-256 digests, extracts
only the declared regular executables into a private staging directory, and
atomically activates the complete closure. It then requires both binaries to
be x86_64 ELF executables, report the pinned version (11.0.0), and come from
the same materialized closure. `qemu-system-x86_64 -accel help` must advertise
`kvm`; missing or inaccessible `/dev/kvm` remains a host capability failure.

The exact artifact IDs and provenance are recorded in `qemu.json` alongside
the executable paths and SHA-256 values. Every run re-verifies those values;
corrupt, truncated, wrong-version, wrong-architecture, or changed managed
artifacts fail closed. Interrupted downloads and staging are discarded and
retried, while a verified unchanged closure is reused without downloading.

Lima remains the sole VM lifecycle, QEMU command-line, and device-topology
authority. Mottainai owns only bounded artifact acquisition, verification,
materialization, and binding. Before each managed `limactl` operation,
`mottainai-init` sets `QEMU_SYSTEM_X86_64` to the verified executable and puts
its directory first in a controlled child `PATH`; an unrelated ambient QEMU
cannot silently replace it. Arbitrary ambient QEMU is never silently adopted.
An external installation may be adopted only with an explicit `--qemu-path`
and is still identity-verified.

## Evidence

Human output is bounded and summarizes the final outcome as no-op, changed,
blocked, or unsupported. --json emits bounded evidence containing the bootstrap
schema/version/digest, host/KVM observations, desired and observed provider
identity, per-step classification and mutation flag, final result, and
deterministic error code/diagnostic. Secrets and command logs are not persisted.

The repository tests use temporary directories and synthetic provider archives.
They do not require KVM. A native Linux/KVM run is a separate manual evidence
step:

~~~bash
./host-bootstrap/target/x86_64-unknown-linux-musl/release/mottainai-init --json
~~~

On success, the managed active/bin/limactl is the provider binary for the
downstream #649 Lima validation probe, and qemu.json proves the host-side
QEMU prerequisite. The probe still owns its own documented Lima lifecycle
experiment; this bootstrap does not start a VM.

## Manual Linux x86_64/KVM validation

On a fresh supported Linux x86_64 host, begin with usable `/dev/kvm`, network
access, and the explicit host prerequisites declared by the current Route 4
profile: executable `ssh` and `ssh-keygen` commands on `PATH`. `mottainai-init`
provisions the pinned Lima/QEMU host toolchain itself and validates OpenSSH
before it mutates managed state. Run the following sequence from the
directory containing the detached release artifacts:

~~~bash
sha256sum --check mottainai-init-linux-x86_64.sha256
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test -c /dev/kvm
test -r /dev/kvm && test -w /dev/kvm
command -v ssh
command -v ssh-keygen
./mottainai-init-linux-x86_64 --json --state-directory "$HOME/.local/state/mottainai/host-bootstrap"
./mottainai-init-linux-x86_64 --json --state-directory "$HOME/.local/state/mottainai/host-bootstrap"
~~~

The first successful run must report `changed`, with QEMU and Lima materialized
under managed state. The second run must report `no-op`, perform no download,
and preserve both `state.json` and `qemu.json`. This command sequence does not
claim the real-host criterion passed until it has actually been run on a host
where `/dev/kvm` opens successfully.
