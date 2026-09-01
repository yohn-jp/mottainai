# Standalone host bootstrap

mottainai-init is the host-side bootstrap for the initial local provider
profile: Linux x86_64, KVM, and the Lima/QEMU provider boundary. It prepares
the machine that launches a Runtime Appliance. It is not the #626 guest
bootstrap, does not install managed Mottainai generations, and does not own
Lima VM lifecycle, appliance boot, QEMU topology, or Proxmox deployment.

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
├── active -> providers/<artifact-id>
├── cache/
│   └── <artifact-id>.tar.gz
├── providers/
│   └── <artifact-id>/
│       └── bin/limactl
└── staging/
~~~

Only the bootstrap process owns this location. A non-blocking filesystem lock
serializes invocations. Downloaded bytes first land in a .part file, are
size- and digest-verified, and are atomically promoted. Archive extraction is
performed into staging, then atomically promoted to the immutable provider
identity. The active link and state.json are promoted only after the provider
executable and archive identity verify. Stale staging or partial downloads are
discarded and safely retried on the next locked run.

Ambient limactl binaries are never adopted. A non-managed or multiply
resolved ambient binary is classified as incompatible or ambiguous and blocks
convergence.

## QEMU/KVM prerequisite

The supported Lima provider requires the host-side `qemu-system-x86_64` and
`qemu-img` tools in one installation. Before Lima is downloaded or activated,
the bootstrap uniquely resolves both tools, requires regular executable files,
checks that both report the same version (at least QEMU 8.2.0), and runs
`qemu-system-x86_64 -accel help` to prove that the binary advertises `kvm`.
It records each resolved path and SHA-256 in `qemu.json` and rechecks those
values on every run. A changed, ambiguous, incompatible, or missing QEMU
prerequisite blocks Lima convergence.

Mottainai does not distribute a private QEMU archive or invoke `sudo`,
`apt`, `dnf`, `pacman`, Nix, or a shell. This preserves the #654 ownership
boundary: the host administrator or base image supplies QEMU, while
`mottainai-init` proves and records the exact host installation required by
Lima. Removing `qemu.json` only permits a fresh contract proof; it does not
permit an unverified binary to be used, and a same-version replacement is
identified by its newly observed digest.

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

On a fresh supported Linux x86_64 host, first provision the distribution's
QEMU system-emulation package through the host's normal image or administrator
workflow. That action is deliberately outside `mottainai-init`; it must leave
`qemu-system-x86_64` and `qemu-img` on PATH and `/dev/kvm` readable and
writable by the invoking user. Then run the following exact sequence from the
directory containing the detached release artifacts:

~~~bash
sha256sum --check mottainai-init-linux-x86_64.sha256
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test -c /dev/kvm
test -r /dev/kvm && test -w /dev/kvm
qemu-system-x86_64 --version
qemu-img --version
qemu-system-x86_64 -accel help | grep -E '^kvm([[:space:]]|$)'
./mottainai-init-linux-x86_64 --json --state-directory "$HOME/.local/state/mottainai/host-bootstrap"
./mottainai-init-linux-x86_64 --json --state-directory "$HOME/.local/state/mottainai/host-bootstrap"
~~~

The first successful run must report `changed`, with host and QEMU
`satisfied`/`repairable` evidence and Lima `missing`/`repairable` evidence.
The second run must report `no-op`, perform no download, and leave both
`state.json` and `qemu.json` unchanged. This command sequence does not claim
the real-host criterion passed until it has actually been run on a host where
`/dev/kvm` opens successfully.
