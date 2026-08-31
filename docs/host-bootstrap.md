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

The default provider contract is explicit and immutable: Lima 2.1.1,
Linux x86_64 archive identity, GitHub HTTPS release URL, and the archive
SHA-256 recorded in host-bootstrap/src/contract.rs. A reviewed contract JSON
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
├── state.json
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
./host-bootstrap/target/release/mottainai-init --json
~~~

On success, the managed active/bin/limactl is the provider binary for the
downstream #649 Lima validation probe. The probe still owns its own documented
Lima lifecycle experiment; this bootstrap does not start a VM.
