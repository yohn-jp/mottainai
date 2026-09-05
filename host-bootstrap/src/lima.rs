use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::appliance::{ensure_appliance, ApplianceReference};
use crate::bootstrap_disk::{
    bootstrap_disk_name, ensure_bootstrap_disk, ensure_lima_public_key, verify_bootstrap_disk,
};
use crate::error::{BootstrapError, ErrorCode};
use crate::lock::BootstrapLock;
use crate::model::Outcome;
use crate::oci::OciSource;
use crate::paths::{ensure_managed_root, ManagedPaths};

pub const RUNTIME_SPEC_SCHEMA_VERSION: &str = "mottainai.host-bootstrap.lima-runtime-spec.v1";
const RUNTIME_STATE_SCHEMA_VERSION: &str = "mottainai.host-bootstrap.lima-runtime-state.v1";
const MAX_MOUNTS: usize = 8;
const MAX_NAME_LENGTH: usize = 63;
const MAX_PATH_LENGTH: usize = 4096;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const CREATE_START_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_COMMAND_OUTPUT: usize = 64 * 1024;
/// Bounded ceiling for the desired managed-package manifest document
/// (#753) — generous for the closed `MANAGED_PACKAGE_IDS` set
/// (src/runtime-contract/managed-package-manifest.ts caps 64 entries), but
/// never unbounded.
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// Guest-side reconcile/smoke operations touch the network (Nix
/// substituters, GitHub source resolution) and can legitimately run far
/// longer than the bounded `COMMAND_TIMEOUT` used for inspection-only
/// `limactl shell` calls.
const MANAGED_GENERATION_COMMAND_TIMEOUT: Duration = Duration::from_secs(1800);

/// An explicit, bounded workspace mount. Never defaulted or inferred: the
/// canonical Runtime Appliance boundary (#600) requires bounded, intentional
/// filesystem exposure only.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MountSpec {
    pub host_path: String,
    pub guest_path: String,
    #[serde(default)]
    pub writable: bool,
}

/// The exact desired managed-generation intent for Route 3 (#753): the
/// canonical `mottainai.managed-package-manifest.v1` document, opaque to
/// this crate. `mottainai-bootstrap reconcile` on the guest is the sole
/// parser/validator/generation authority for its bytes (src/runtime-contract
/// /managed-package-manifest.ts); Rust never re-implements that schema, it
/// only transports and byte-verifies the manifest identity.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ManagedGenerationIntent {
    /// Exact `mottainai.managed-generation.v1` identity this manifest must
    /// converge the guest to — matched against the guest's own
    /// `activeGenerationIdentity` after reconciliation to prove the
    /// *intended* generation activated, not merely *a* healthy one.
    pub identity: String,
    /// The canonical manifest document, forwarded byte-for-byte to the
    /// guest's persisted `managed-packages/manifest.json`.
    pub manifest: serde_json::Value,
}

/// Product-level intent only: no QEMU flags or Lima internals. Mirrors the
/// bounded shape #600 describes for the Mottainai Runtime specification,
/// narrowed to exactly what the Lima provider adapter needs.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RuntimeSpec {
    pub schema_version: String,
    pub instance_name: String,
    pub architecture: String,
    pub cpus: u32,
    pub memory_mib: u64,
    pub appliance: ApplianceReference,
    #[serde(default)]
    pub mounts: Vec<MountSpec>,
    /// Desired Route 2 managed-generation intent (#753). `None` means the
    /// guest converges to `bootstrapReady` only — the pre-#753 Route 3
    /// boundary, still valid for callers that only need the base Appliance.
    #[serde(default)]
    pub managed_generation: Option<ManagedGenerationIntent>,
}

impl RuntimeSpec {
    pub fn validate(&self) -> Result<(), BootstrapError> {
        let invalid = |message: &str| {
            Err(BootstrapError::new(
                ErrorCode::RuntimeSpecInvalid,
                message.to_owned(),
            ))
        };
        if self.schema_version != RUNTIME_SPEC_SCHEMA_VERSION {
            return invalid("runtime specification schema version is not supported");
        }
        let name_ok = !self.instance_name.is_empty()
            && self.instance_name.len() <= MAX_NAME_LENGTH
            && self
                .instance_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            && self
                .instance_name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric());
        if !name_ok {
            return invalid("runtime instance name is not a bounded safe identifier");
        }
        if self.architecture != "x86_64" {
            return invalid("only the x86_64 Linux Runtime architecture is supported");
        }
        if !(1..=32).contains(&self.cpus) {
            return invalid("runtime cpus must be between 1 and 32");
        }
        if !(512..=131_072).contains(&self.memory_mib) {
            return invalid("runtime memory_mib must be between 512 and 131072");
        }
        if self.mounts.len() > MAX_MOUNTS {
            return invalid("runtime mount list exceeds the bounded mount count");
        }
        for mount in &self.mounts {
            let bounded = |value: &str| {
                !value.is_empty()
                    && value.len() <= MAX_PATH_LENGTH
                    && value.chars().all(|character| !character.is_control())
            };
            if !bounded(&mount.host_path)
                || !bounded(&mount.guest_path)
                || !Path::new(&mount.host_path).is_absolute()
                || !Path::new(&mount.guest_path).is_absolute()
            {
                return invalid(
                    "runtime mount paths must be bounded absolute paths without control characters",
                );
            }
        }
        if let Some(managed_generation) = &self.managed_generation {
            let identity_ok = !managed_generation.identity.is_empty()
                && managed_generation.identity.len() == 64
                && managed_generation
                    .identity
                    .chars()
                    .all(|character| character.is_ascii_hexdigit());
            if !identity_ok {
                return invalid(
                    "managed generation identity must be a 64-character hex sha256 digest",
                );
            }
            if !managed_generation.manifest.is_object() {
                return invalid("managed generation manifest must be a JSON object");
            }
            let serialized_len = serde_json::to_string(&managed_generation.manifest)
                .map(|text| text.len())
                .unwrap_or(usize::MAX);
            if serialized_len > MAX_MANIFEST_BYTES {
                return invalid("managed generation manifest exceeds the bounded document size");
            }
        }
        self.appliance.validate()
    }
}

/// Renders exactly one bounded, supported Lima instance configuration from
/// product-level intent. No QEMU flags, cloud-init, or Lima-specific
/// provisioning is added beyond documented `limactl` YAML configuration
/// keys, and no host path is mounted unless the spec explicitly lists it.
pub fn render_lima_config(spec: &RuntimeSpec, appliance_raw_path: &Path) -> String {
    let appliance_path = appliance_raw_path.to_string_lossy();
    let config = LimaConfig {
        vm_type: "qemu",
        arch: &spec.architecture,
        cpus: spec.cpus,
        memory: format!("{}MiB", spec.memory_mib),
        images: [LimaImage {
            location: appliance_path.as_ref(),
            arch: &spec.architecture,
        }],
        // Lima 2.2.0 only accepts reverse-sshfs/9p/virtiofs/wsl2 here; it
        // has no "none" mount type, unlike this crate's prior assumption.
        // "9p" is Lima's own QEMU default (see its bundled default.yaml),
        // and with `mounts: []` below no host path is ever actually
        // mounted regardless of which valid value is configured here.
        mount_type: "9p",
        mounts: spec
            .mounts
            .iter()
            .map(|mount| LimaMount {
                location: &mount.host_path,
                mount_point: &mount.guest_path,
                writable: mount.writable,
            })
            .collect(),
        additional_disks: [LimaDisk {
            name: bootstrap_disk_name(&spec.instance_name),
            format: false,
        }],
        ssh: LimaSsh {
            load_dot_ssh_pub_keys: false,
        },
        containerd: LimaContainerd {
            system: false,
            user: false,
        },
    };

    // RuntimeSpec::validate rejects unsupported control characters before this
    // function is called by ensure_runtime. All remaining values are scalar
    // data, so the structured serializer cannot expose them as YAML syntax.
    serde_saphyr::to_string(&config).expect("supported Lima configuration is serializable")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LimaConfig<'a> {
    vm_type: &'static str,
    arch: &'a str,
    cpus: u32,
    memory: String,
    images: [LimaImage<'a>; 1],
    mount_type: &'static str,
    mounts: Vec<LimaMount<'a>>,
    additional_disks: [LimaDisk; 1],
    ssh: LimaSsh,
    containerd: LimaContainerd,
}

#[derive(Serialize)]
struct LimaImage<'a> {
    location: &'a str,
    arch: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LimaMount<'a> {
    location: &'a str,
    mount_point: &'a str,
    writable: bool,
}

#[derive(Serialize)]
struct LimaDisk {
    name: String,
    format: bool,
}

#[derive(Serialize)]
struct LimaSsh {
    // Lima's actual field name capitalizes SSH in full
    // (loadDotSSHPubKeys), which #[serde(rename_all = "camelCase")]
    // cannot produce from load_dot_ssh_pub_keys -- it renders
    // loadDotSshPubKeys, an unknown field Lima 2.2.0 rejects outright.
    #[serde(rename = "loadDotSSHPubKeys")]
    load_dot_ssh_pub_keys: bool,
}

#[derive(Serialize)]
struct LimaContainerd {
    system: bool,
    user: bool,
}

fn config_identity(rendered: &str) -> String {
    format!("{:x}", Sha256::digest(rendered.as_bytes()))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimaInstanceInfo {
    pub name: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub vm_type: Option<String>,
}

/// Only the documented/public `limactl` operations #600's provider contract
/// allows: `list`, `create`, `start`, and `shell` (guest exec, used both for
/// recovery and to reach the canonical bootstrap health boundary). No
/// private state files, sockets, or driver internals are touched.
pub trait LimaCli {
    fn list_all(&self) -> Result<Vec<LimaInstanceInfo>, BootstrapError>;
    fn create(&self, instance: &str, config_path: &Path) -> Result<(), BootstrapError>;
    fn start(&self, instance: &str) -> Result<(), BootstrapError>;
    fn shell(&self, instance: &str, command: &[&str]) -> Result<String, BootstrapError>;
    /// Same guest-exec surface as `shell`, bounded by an explicit timeout
    /// instead of the short inspection-only default. Used for #753's
    /// managed-generation reconcile/smoke calls, which perform real network
    /// and build work on the guest. Defaults to `shell` so existing
    /// implementations are unaffected; `SystemLimaCli` overrides it.
    fn shell_with_timeout(
        &self,
        instance: &str,
        command: &[&str],
        _timeout: Duration,
    ) -> Result<String, BootstrapError> {
        self.shell(instance, command)
    }
}

fn drain_bounded_output<R: Read>(mut reader: R) -> io::Result<Vec<u8>> {
    const READ_BUFFER_SIZE: usize = 8 * 1024;
    let mut retained = Vec::with_capacity(MAX_COMMAND_OUTPUT);
    let mut buffer = [0_u8; READ_BUFFER_SIZE];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(retained);
        }
        let remaining = MAX_COMMAND_OUTPUT.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..read.min(remaining)]);
    }
}

fn spawn_output_reader<R: Read + Send + 'static>(
    reader: R,
    stream: &'static str,
) -> Result<thread::JoinHandle<io::Result<Vec<u8>>>, BootstrapError> {
    thread::Builder::new()
        .name(format!("limactl-{stream}-reader"))
        .spawn(move || drain_bounded_output(reader))
        .map_err(|error| {
            BootstrapError::new(
                ErrorCode::LimaCommandFailed,
                format!("could not start limactl {stream} reader: {error}"),
            )
        })
}

fn join_output_reader(
    reader: thread::JoinHandle<io::Result<Vec<u8>>>,
    stream: &str,
) -> Result<Vec<u8>, BootstrapError> {
    match reader.join() {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(BootstrapError::new(
            ErrorCode::LimaCommandFailed,
            format!("could not read limactl {stream} output: {error}"),
        )),
        Err(_) => Err(BootstrapError::new(
            ErrorCode::LimaCommandFailed,
            format!("limactl {stream} output reader panicked"),
        )),
    }
}

fn join_output_readers(
    stdout_reader: thread::JoinHandle<io::Result<Vec<u8>>>,
    stderr_reader: thread::JoinHandle<io::Result<Vec<u8>>>,
) -> Result<(Vec<u8>, Vec<u8>), BootstrapError> {
    let stdout = join_output_reader(stdout_reader, "stdout");
    let stderr = join_output_reader(stderr_reader, "stderr");
    match (stdout, stderr) {
        (Ok(stdout), Ok(stderr)) => Ok((stdout, stderr)),
        (Err(error), _) | (_, Err(error)) => Err(error),
    }
}

fn terminate_and_wait(child: &mut Child) -> Result<(), BootstrapError> {
    let kill_result = child.kill();
    let wait_result = child.wait();
    if let Err(error) = wait_result {
        return Err(BootstrapError::new(
            ErrorCode::LimaCommandFailed,
            format!("could not wait for terminated limactl: {error}"),
        ));
    }
    if let Err(error) = kill_result {
        // The child may have exited between try_wait and kill. The wait above
        // still establishes deterministic reaping in that race.
        if error.kind() != io::ErrorKind::NotFound {
            return Err(BootstrapError::new(
                ErrorCode::LimaCommandFailed,
                format!("could not terminate limactl: {error}"),
            ));
        }
    }
    Ok(())
}

pub struct SystemLimaCli {
    pub binary_path: PathBuf,
    pub lima_home: PathBuf,
    /// Exact verified QEMU system executable selected by Route 4. When set,
    /// both this path and its sibling qemu-img are placed first in the child
    /// PATH so Lima cannot resolve a different ambient runtime.
    pub qemu_system_path: Option<PathBuf>,
}

impl SystemLimaCli {
    fn run(&self, arguments: &[&str], timeout: Duration) -> Result<String, BootstrapError> {
        let mut command = Command::new(&self.binary_path);
        command
            .args(arguments)
            .env("LIMA_HOME", &self.lima_home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(qemu_system_path) = &self.qemu_system_path {
            let qemu_directory = qemu_system_path.parent().ok_or_else(|| {
                BootstrapError::new(
                    ErrorCode::LimaCommandFailed,
                    "verified QEMU system path has no parent directory",
                )
            })?;
            let lima_directory = self.binary_path.parent().ok_or_else(|| {
                BootstrapError::new(
                    ErrorCode::LimaCommandFailed,
                    "managed Lima path has no parent directory",
                )
            })?;
            let mut path_entries = vec![qemu_directory.to_path_buf(), lima_directory.to_path_buf()];
            if let Some(ambient_path) = std::env::var_os("PATH") {
                path_entries.extend(std::env::split_paths(&ambient_path));
            }
            let controlled_path = std::env::join_paths(path_entries).map_err(|error| {
                BootstrapError::new(
                    ErrorCode::LimaCommandFailed,
                    format!("could not construct the Lima child PATH: {error}"),
                )
            })?;
            command
                .env("QEMU_SYSTEM_X86_64", qemu_system_path)
                .env(
                    "QEMU_DATA_DIR",
                    qemu_directory.join("..").join("share/qemu"),
                )
                .env("PATH", controlled_path);
        }
        let mut child = command.spawn().map_err(|error| {
            BootstrapError::new(
                ErrorCode::LimaCommandFailed,
                format!("could not execute limactl: {error}"),
            )
        })?;

        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let cleanup = terminate_and_wait(&mut child);
                return match cleanup {
                    Ok(()) => Err(BootstrapError::new(
                        ErrorCode::LimaCommandFailed,
                        "limactl stdout pipe was not available",
                    )),
                    Err(error) => Err(error),
                };
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                let cleanup = terminate_and_wait(&mut child);
                return match cleanup {
                    Ok(()) => Err(BootstrapError::new(
                        ErrorCode::LimaCommandFailed,
                        "limactl stderr pipe was not available",
                    )),
                    Err(error) => Err(error),
                };
            }
        };
        let stdout_reader = match spawn_output_reader(stdout, "stdout") {
            Ok(reader) => reader,
            Err(error) => {
                let cleanup = terminate_and_wait(&mut child);
                return match cleanup {
                    Ok(()) => Err(error),
                    Err(cleanup_error) => Err(cleanup_error),
                };
            }
        };
        let stderr_reader = match spawn_output_reader(stderr, "stderr") {
            Ok(reader) => reader,
            Err(error) => {
                let cleanup = terminate_and_wait(&mut child);
                let stdout_result = join_output_reader(stdout_reader, "stdout");
                return match cleanup {
                    Err(cleanup_error) => Err(cleanup_error),
                    Ok(()) => match stdout_result {
                        Err(reader_error) => Err(reader_error),
                        Ok(_) => Err(error),
                    },
                };
            }
        };

        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let (stdout, stderr) = join_output_readers(stdout_reader, stderr_reader)?;
                    if !status.success() {
                        let mut combined = String::from_utf8_lossy(&stdout).into_owned();
                        combined.push('\n');
                        combined.push_str(&String::from_utf8_lossy(&stderr));
                        let bounded: String = combined.chars().take(MAX_COMMAND_OUTPUT).collect();
                        return Err(BootstrapError::new(
                            ErrorCode::LimaCommandFailed,
                            format!("limactl {} failed: {bounded}", arguments.join(" ")),
                        ));
                    }
                    return Ok(String::from_utf8_lossy(&stdout)
                        .chars()
                        .take(MAX_COMMAND_OUTPUT)
                        .collect());
                }
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                Ok(None) => {
                    let cleanup = terminate_and_wait(&mut child);
                    let output = join_output_readers(stdout_reader, stderr_reader);
                    cleanup?;
                    output?;
                    return Err(BootstrapError::new(
                        ErrorCode::LimaCommandFailed,
                        "limactl command timed out",
                    ));
                }
                Err(error) => {
                    let wait_error = BootstrapError::new(
                        ErrorCode::LimaCommandFailed,
                        format!("could not wait for limactl: {error}"),
                    );
                    let cleanup = terminate_and_wait(&mut child);
                    let output = join_output_readers(stdout_reader, stderr_reader);
                    cleanup?;
                    output?;
                    return Err(wait_error);
                }
            }
        }
    }
}

impl LimaCli for SystemLimaCli {
    fn list_all(&self) -> Result<Vec<LimaInstanceInfo>, BootstrapError> {
        let output = self.run(
            &["--tty=false", "list", "--all-fields", "--format", "json"],
            COMMAND_TIMEOUT,
        )?;
        let mut instances = Vec::new();
        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let info: LimaInstanceInfo = serde_json::from_str(line).map_err(|error| {
                BootstrapError::new(
                    ErrorCode::LimaCommandFailed,
                    format!("could not parse limactl list output: {error}"),
                )
            })?;
            instances.push(info);
        }
        Ok(instances)
    }

    fn create(&self, instance: &str, config_path: &Path) -> Result<(), BootstrapError> {
        self.run(
            &[
                "--tty=false",
                "create",
                "--name",
                instance,
                // The canonical Runtime Appliance has no Lima cloud-init
                // readiness sentinel; plain mode leaves readiness to the
                // guest health contract after Lima provides VM/SSH transport.
                "--plain",
                &config_path.to_string_lossy(),
            ],
            CREATE_START_TIMEOUT,
        )
        .map(|_| ())
    }

    fn start(&self, instance: &str) -> Result<(), BootstrapError> {
        self.run(&["--tty=false", "start", instance], CREATE_START_TIMEOUT)
            .map(|_| ())
    }

    fn shell(&self, instance: &str, command: &[&str]) -> Result<String, BootstrapError> {
        self.shell_with_timeout(instance, command, COMMAND_TIMEOUT)
    }

    fn shell_with_timeout(
        &self,
        instance: &str,
        command: &[&str],
        timeout: Duration,
    ) -> Result<String, BootstrapError> {
        let mut arguments = vec!["--tty=false", "shell", instance, "--"];
        arguments.extend_from_slice(command);
        self.run(&arguments, timeout)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct RuntimeState {
    schema_version: String,
    instance_name: String,
    appliance_digest: String,
    config_identity_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RuntimeEvidence {
    pub schema_version: String,
    pub instance_name: String,
    pub appliance_digest: Option<String>,
    pub lima_status: Option<String>,
    pub changed: bool,
    pub result: Outcome,
    pub guest_reachable: bool,
    pub guest_status: Option<serde_json::Value>,
    /// True only when the guest health boundary reported
    /// `managedRuntimeReady: true` for the exact requested generation
    /// identity (#753). `None` when `RuntimeSpec.managed_generation` was not
    /// requested — a bootstrap-only convergence never claims this field.
    pub managed_runtime_ready: Option<bool>,
    /// True only after the bounded packaged CLI/MCP functional smoke
    /// (#753's acceptance criterion) has run and succeeded against the
    /// active managed generation.
    pub functional_smoke_verified: Option<bool>,
    pub error_code: Option<String>,
    pub diagnostic: Option<String>,
}

impl RuntimeEvidence {
    fn new(instance_name: &str) -> Self {
        Self {
            schema_version: RUNTIME_SPEC_SCHEMA_VERSION.to_owned(),
            instance_name: instance_name.to_owned(),
            appliance_digest: None,
            lima_status: None,
            changed: false,
            result: Outcome::Blocked,
            guest_reachable: false,
            guest_status: None,
            managed_runtime_ready: None,
            functional_smoke_verified: None,
            error_code: None,
            diagnostic: None,
        }
    }

    fn fail(&mut self, error: &BootstrapError) {
        self.result = Outcome::Blocked;
        self.error_code = Some(error.code_string().to_owned());
        self.diagnostic = Some(crate::error::bound_text(&error.message));
    }
}

#[derive(Clone, Debug)]
pub struct RuntimeEnsureConfig {
    pub health_check_attempts: u32,
    pub health_check_interval: Duration,
}

impl Default for RuntimeEnsureConfig {
    fn default() -> Self {
        Self {
            health_check_attempts: 5,
            health_check_interval: Duration::from_secs(3),
        }
    }
}

/// Converges a local Lima-managed Runtime instance to ready state: resolves
/// and verifies the canonical Appliance, renders/writes one bounded Lima
/// configuration, creates/starts a missing instance or reconciles an
/// existing compatible one through documented `limactl` interfaces, and
/// waits for the canonical guest/bootstrap health boundary rather than
/// stopping at Lima's own `Running` state.
pub fn ensure_runtime<C: LimaCli, S: OciSource>(
    paths: &ManagedPaths,
    spec: &RuntimeSpec,
    cli: &C,
    oci: &S,
    config: &RuntimeEnsureConfig,
) -> RuntimeEvidence {
    let mut evidence = RuntimeEvidence::new(&spec.instance_name);
    if let Err(error) = spec.validate() {
        evidence.fail(&error);
        return evidence;
    }
    evidence.appliance_digest = Some(spec.appliance.digest.clone());

    if let Err(error) = ensure_managed_root(paths) {
        evidence.fail(&error);
        return evidence;
    }
    let lock = match BootstrapLock::acquire(paths) {
        Ok(lock) => lock,
        Err(error) => {
            evidence.fail(&error);
            return evidence;
        }
    };

    ensure_runtime_locked(paths, spec, cli, oci, config, &lock)
}

/// Performs the mutating Runtime reconciliation while the caller-owned
/// `BootstrapLock` remains held. The lock must cover the same managed state
/// root as `paths`; this entry point exists so the production CLI can acquire
/// the writer authority before its provider inspection as well.
pub fn ensure_runtime_locked<C: LimaCli, S: OciSource>(
    paths: &ManagedPaths,
    spec: &RuntimeSpec,
    cli: &C,
    oci: &S,
    config: &RuntimeEnsureConfig,
    lock: &BootstrapLock,
) -> RuntimeEvidence {
    let mut evidence = RuntimeEvidence::new(&spec.instance_name);
    if let Err(error) = lock.validate_for(paths) {
        evidence.fail(&error);
        return evidence;
    }
    if let Err(error) = spec.validate() {
        evidence.fail(&error);
        return evidence;
    }
    evidence.appliance_digest = Some(spec.appliance.digest.clone());

    let raw_path = match ensure_appliance(paths, &spec.appliance, oci) {
        Ok(path) => path,
        Err(error) => {
            evidence.fail(&error);
            return evidence;
        }
    };

    let public_key = match ensure_lima_public_key(paths) {
        Ok(public_key) => public_key,
        Err(error) => {
            evidence.fail(&error);
            return evidence;
        }
    };
    let rendered = render_lima_config(spec, &raw_path);
    let desired_identity = config_identity(&rendered);
    let instance_directory = paths.runtime_instance_directory(&spec.instance_name);
    if let Err(error) = fs::create_dir_all(&instance_directory)
        .map_err(|error| BootstrapError::io("create managed runtime instance directory", &error))
    {
        evidence.fail(&error);
        return evidence;
    }

    let state_path = paths.runtime_state_path(&spec.instance_name);
    let recorded_state = match read_state(&state_path) {
        Ok(state) => state,
        Err(error) => {
            evidence.fail(&error);
            return evidence;
        }
    };
    if let Some(state) = recorded_state.as_ref() {
        if state.schema_version != RUNTIME_STATE_SCHEMA_VERSION {
            let error = BootstrapError::new(
                ErrorCode::LimaInstanceAmbiguous,
                "managed runtime instance state schema version is not supported; reconciliation is refused",
            );
            evidence.fail(&error);
            return evidence;
        }
        if state.instance_name != spec.instance_name {
            let error = BootstrapError::new(
                ErrorCode::LimaInstanceAmbiguous,
                "managed runtime instance state does not match the exact requested instance name",
            );
            evidence.fail(&error);
            return evidence;
        }
    }

    let instances = match cli.list_all() {
        Ok(instances) => instances,
        Err(error) => {
            evidence.fail(&error);
            return evidence;
        }
    };
    let existing = instances
        .into_iter()
        .find(|instance| instance.name == spec.instance_name);

    let matches_recorded = recorded_state.as_ref().is_some_and(|state| {
        state.schema_version == RUNTIME_STATE_SCHEMA_VERSION
            && state.instance_name == spec.instance_name
            && state.appliance_digest == spec.appliance.digest
            && state.config_identity_sha256 == desired_identity
    });

    let start_needed = match &existing {
        None => {
            // Missing: no ambient adoption. Record intent before mutating
            // Lima so an interruption before `start` completes is safely
            // recognized and resumed on the next ensure, without treating
            // this as recreation.
            if let Err(error) = ensure_bootstrap_disk(paths, &spec.instance_name, &public_key) {
                evidence.fail(&error);
                return evidence;
            }
            let config_path = paths.runtime_config_path(&spec.instance_name);
            if let Err(error) = write_config(&config_path, &rendered) {
                evidence.fail(&error);
                return evidence;
            }
            let state = RuntimeState {
                schema_version: RUNTIME_STATE_SCHEMA_VERSION.to_owned(),
                instance_name: spec.instance_name.clone(),
                appliance_digest: spec.appliance.digest.clone(),
                config_identity_sha256: desired_identity.clone(),
            };
            if let Err(error) = write_state(&state_path, &state) {
                evidence.fail(&error);
                return evidence;
            }
            if let Err(error) = cli.create(&spec.instance_name, &config_path) {
                evidence.fail(&error);
                return evidence;
            }
            evidence.changed = true;
            true
        }
        Some(instance) => {
            // Fail closed on absent vmType too: only an explicit, observed
            // `qemu` value is accepted as the supported driver. A missing
            // field must never be treated as an implicit pass.
            if instance.vm_type.as_deref() != Some("qemu") {
                let error = BootstrapError::new(
                    ErrorCode::LimaInstanceIncompatible,
                    "existing Lima instance does not report the supported qemu vmType",
                );
                evidence.fail(&error);
                return evidence;
            }
            if recorded_state.is_none() {
                let error = BootstrapError::new(
                    ErrorCode::LimaInstanceAmbiguous,
                    "an existing Lima instance was found with no managed provenance record; it was not adopted",
                );
                evidence.fail(&error);
                return evidence;
            }
            if !matches_recorded {
                let error = BootstrapError::new(
                    ErrorCode::LimaInstanceIncompatible,
                    "existing Lima instance does not match the pinned Runtime specification; recreate is not performed automatically",
                );
                evidence.fail(&error);
                return evidence;
            }
            evidence.lima_status = instance.status.clone();
            match instance.status.as_deref() {
                Some("Running") => {
                    if let Err(error) =
                        verify_bootstrap_disk(paths, &spec.instance_name, &public_key)
                    {
                        evidence.fail(&error);
                        return evidence;
                    }
                    false
                }
                Some("Stopped") => {
                    if let Err(error) =
                        ensure_bootstrap_disk(paths, &spec.instance_name, &public_key)
                    {
                        evidence.fail(&error);
                        return evidence;
                    }
                    true
                }
                other => {
                    let error = BootstrapError::new(
                        ErrorCode::LimaInstanceAmbiguous,
                        format!(
                            "existing Lima instance is in an unrecognized state: {}",
                            other.unwrap_or("<none>")
                        ),
                    );
                    evidence.fail(&error);
                    return evidence;
                }
            }
        }
    };

    if start_needed {
        if let Err(error) = cli.start(&spec.instance_name) {
            evidence.fail(&error);
            return evidence;
        }
        evidence.changed = true;
    }

    if let Ok(instances) = cli.list_all() {
        evidence.lima_status = instances
            .into_iter()
            .find(|instance| instance.name == spec.instance_name)
            .and_then(|instance| instance.status);
    }

    let mut last_health_error: Option<BootstrapError> = None;
    for attempt in 0..config.health_check_attempts.max(1) {
        if attempt > 0 {
            thread::sleep(config.health_check_interval);
        }
        match check_guest_health(cli, &spec.instance_name) {
            Ok(status) => {
                evidence.guest_reachable = true;
                evidence.guest_status = Some(status);
                last_health_error = None;
                break;
            }
            Err(error) => last_health_error = Some(error),
        }
    }
    if let Some(error) = last_health_error {
        let error = BootstrapError::new(
            ErrorCode::RuntimeNotReady,
            format!(
                "canonical guest/bootstrap Runtime health boundary was not reachable: {}",
                error.message
            ),
        );
        evidence.fail(&error);
        return evidence;
    }

    if let Some(managed_generation) = &spec.managed_generation {
        let already_active = match intended_generation_active(
            cli,
            &spec.instance_name,
            &managed_generation.identity,
        ) {
            Ok(active) => active,
            Err(error) => {
                evidence.fail(&error);
                return evidence;
            }
        };
        if !already_active {
            match converge_managed_generation(cli, &spec.instance_name, managed_generation) {
                Ok(()) => evidence.changed = true,
                Err(error) => {
                    evidence.fail(&error);
                    return evidence;
                }
            }

            let mut last_convergence_error: Option<BootstrapError> = None;
            for attempt in 0..config.health_check_attempts.max(1) {
                if attempt > 0 {
                    thread::sleep(config.health_check_interval);
                }
                match check_guest_health(cli, &spec.instance_name) {
                    Ok(status) => {
                        evidence.guest_status = Some(status);
                        last_convergence_error = None;
                        break;
                    }
                    Err(error) => last_convergence_error = Some(error),
                }
            }
            if let Some(error) = last_convergence_error {
                evidence.fail(&error);
                return evidence;
            }
        }

        let intended_active = match intended_generation_active(
            cli,
            &spec.instance_name,
            &managed_generation.identity,
        ) {
            Ok(active) => active,
            Err(error) => {
                evidence.fail(&error);
                return evidence;
            }
        };
        if !intended_active {
            let error = BootstrapError::new(
                ErrorCode::RuntimeNotReady,
                "guest did not report managedRuntimeReady for the intended generation identity after reconciliation",
            );
            evidence.fail(&error);
            return evidence;
        }
        evidence.managed_runtime_ready = Some(true);

        if let Err(error) = run_functional_smoke(cli, &spec.instance_name) {
            evidence.managed_runtime_ready = Some(true);
            evidence.functional_smoke_verified = Some(false);
            evidence.fail(&error);
            return evidence;
        }
        evidence.functional_smoke_verified = Some(true);
    }

    evidence.result = if evidence.changed {
        Outcome::Changed
    } else {
        Outcome::NoOp
    };
    evidence
}

/// True only when the canonical guest/bootstrap health boundary reports
/// `managedRuntimeReady: true` AND the exact intended generation identity is
/// the one active — never merely "some generation is healthy" (#753
/// acceptance: `bootstrapReady` alone, or a healthy-but-different
/// generation, must not be accepted as success). `mottainai-runtime-health`
/// itself has no generation-identity field (`contract.ts`'s
/// `RuntimeCapabilityResultSchema` is deliberately `.strict()` with only a
/// boolean), so identity is confirmed through the same canonical, read-only
/// `mottainai-bootstrap managed-status --json` the health projection itself
/// consumes (Issue #644) — never a second, hand-rolled status re-check.
fn intended_generation_active<C: LimaCli>(
    cli: &C,
    instance: &str,
    intended_identity: &str,
) -> Result<bool, BootstrapError> {
    let health = check_guest_health(cli, instance)?;
    if health
        .get("managedRuntimeReady")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Ok(false);
    }
    let status_output = cli.shell(
        instance,
        &["mottainai-bootstrap", "managed-status", "--json"],
    )?;
    let status: serde_json::Value =
        serde_json::from_str(status_output.trim()).map_err(|error| {
            BootstrapError::new(
                ErrorCode::RuntimeNotReady,
                format!("guest managed-status did not return valid JSON: {error}"),
            )
        })?;
    if status.get("valid").and_then(serde_json::Value::as_bool) != Some(true)
        || status.get("present").and_then(serde_json::Value::as_bool) != Some(true)
    {
        return Ok(false);
    }
    Ok(status
        .get("activeGenerationIdentity")
        .and_then(serde_json::Value::as_str)
        == Some(intended_identity))
}

/// Materializes the desired manifest on the guest's canonical control state
/// root and invokes the packaged `mottainai-bootstrap reconcile`, the same
/// production seam Issue #628/#642 already implement — this function adds
/// no new build/activation/rollback logic, only guest-exec transport for
/// bytes and one command invocation, exactly as ADR-0003 requires ("Route 3
/// orchestration may transport desired intent and invoke guest bootstrap,
/// but it must not become a second package/generation authority").
fn converge_managed_generation<C: LimaCli>(
    cli: &C,
    instance: &str,
    managed_generation: &ManagedGenerationIntent,
) -> Result<(), BootstrapError> {
    let manifest_text = serde_json::to_string(&managed_generation.manifest).map_err(|error| {
        BootstrapError::new(
            ErrorCode::RuntimeSpecInvalid,
            format!("serialize managed generation manifest: {error}"),
        )
    })?;
    // `mottainai-bootstrap reconcile` (src/bootstrap/cli.ts) always resolves
    // its own canonical manifest path
    // (/var/lib/mottainai-control/managed-packages/manifest.json) — there is
    // no override flag, by design (review finding on PR #646, quoted in
    // reconcileAdapters' own doc comment). The manifest must therefore exist
    // at that exact path before `reconcile` runs; this is the only
    // "manual guest file injection" Route 3 performs, and it happens through
    // the same bounded `limactl shell` transport already used for health,
    // never a second SSH/credential channel.
    let write_script = "set -eu; manifest_path=\"$1\"; shift; \
install -m 0600 /dev/null \"$manifest_path\" && printf '%s' \"$1\" > \"$manifest_path\"";
    cli.shell_with_timeout(
        instance,
        &[
            "sh",
            "-c",
            write_script,
            "write-managed-package-manifest",
            MANAGED_PACKAGE_MANIFEST_GUEST_PATH,
            &manifest_text,
        ],
        COMMAND_TIMEOUT,
    )?;

    // `mottainai-bootstrap reconcile --json` (src/bootstrap/cli.ts's
    // runReconcileCommand) exits non-zero and prints `{code, message}` on
    // ANY failure — invalid/incompatible manifest, build failure, and
    // activation-health failure with rollback are all `ManagedRuntimeError`s
    // it catches and reports the same way, never a success-shaped `ok:
    // false`/"rolled-back-without-activating" result. A non-zero exit from
    // `mottainai-bootstrap` makes `limactl shell` itself exit non-zero,
    // which `cli.shell_with_timeout` above already turns into `Err` with the
    // guest's own bounded `{code, message}` text folded into the message —
    // so reaching this line at all already means the exact desired
    // generation activated (`reconcileManagedRuntime`'s only non-throwing
    // outcomes: "initialized" | "noop" | "updated" | "removed" | "recovered").
    let reconcile_output = cli
        .shell_with_timeout(
            instance,
            &[
                "mottainai-bootstrap",
                "reconcile",
                "--system",
                "x86_64-linux",
                "--json",
            ],
            MANAGED_GENERATION_COMMAND_TIMEOUT,
        )
        .map_err(|error| {
            BootstrapError::new(
                ErrorCode::ManagedGenerationReconcileFailed,
                format!(
                    "guest managed-generation reconcile failed: {}",
                    error.message
                ),
            )
        })?;
    let _: serde_json::Value = serde_json::from_str(reconcile_output.trim()).map_err(|error| {
        BootstrapError::new(
            ErrorCode::ManagedGenerationReconcileFailed,
            format!("guest reconcile did not return valid JSON despite a successful exit: {error}"),
        )
    })?;
    Ok(())
}

/// The exact canonical persisted-manifest path
/// (`MANAGED_PACKAGE_MANIFEST_RELATIVE_PATH` under `mottainai-control`'s
/// `stateDir`) `docs/contracts/runtime/managed-package-manifest.md` defines. Duplicated as a
/// literal rather than imported because this crate has no TypeScript
/// dependency; `host-bootstrap/tests/reconciliation.rs` and the golden-path
/// Nix test both exercise the real guest path independently.
const MANAGED_PACKAGE_MANIFEST_GUEST_PATH: &str =
    "/var/lib/mottainai-control/managed-packages/manifest.json";

/// Bounded, representative packaged Mottainai CLI and MCP smoke (#753's
/// final acceptance criterion), run against the active managed generation's
/// own `PATH` on the guest — never a Mottainai-owned re-implementation of
/// `reconcileHealthCheck`'s per-binary `--version` proof (that gate already
/// ran, inside reconcile, before activation). This proves the two supported
/// entrypoints application operators actually invoke: the `mottainai` CLI
/// and one MCP stdio JSON-RPC `initialize` exchange with `mottainai-mcp`.
fn run_functional_smoke<C: LimaCli>(cli: &C, instance: &str) -> Result<(), BootstrapError> {
    let script = r#"set -eu
mottainai --version >/dev/null
request='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mottainai-init-route3-smoke","version":"1"}}}'
response="$(printf '%s\n' "$request" | timeout 30 mottainai-mcp 2>/dev/null | head -n 1)"
case "$response" in
  *'"result"'*) ;;
  *) echo "mcp initialize did not return a result: $response" >&2; exit 1 ;;
esac
"#;
    cli.shell_with_timeout(
        instance,
        &["sh", "-c", script],
        MANAGED_GENERATION_COMMAND_TIMEOUT,
    )
    .map(|_| ())
    .map_err(|error| {
        BootstrapError::new(
            ErrorCode::ManagedRuntimeSmokeFailed,
            format!(
                "packaged Mottainai CLI/MCP functional smoke failed: {}",
                error.message
            ),
        )
    })
}

const LINUX_RUNTIME_CONTRACT_ID: &str = "mottainai.linux-runtime.v1";
const LINUX_RUNTIME_MINIMUM_SCHEMA_VERSION: i64 = 2;

/// Reaches the canonical guest/bootstrap Runtime health boundary through
/// `limactl shell` (the same documented public guest-exec surface used for
/// guest health/recovery elsewhere in this repository): the packaged
/// `mottainai-runtime-health` executable
/// (`nix/modules/runtime.nix`'s `healthScript`, on `PATH` via
/// `environment.systemPackages`), the same command the guest's own
/// `mottainai-runtime-health.service` runs. This is the full
/// `mottainai.linux-runtime.v1` schema-2 health/capability result
/// (`docs/contracts/runtime/linux-runtime.md`) — `contractId`, `schemaVersion`,
/// `bootstrapReady`, `managedRuntimeReady`, `readiness`, `reconciliation` —
/// not a reinterpretation of the lower-level `mottainai-bootstrap
/// managed-status --json` read this script itself projects from. This
/// deliberately does not stop at Lima's own `Running` state, and it does
/// not invent a Lima-specific readiness substitute.
fn check_guest_health<C: LimaCli>(
    cli: &C,
    instance: &str,
) -> Result<serde_json::Value, BootstrapError> {
    let output = cli.shell(instance, &["mottainai-runtime-health"])?;
    let trimmed = output.trim();
    let value: serde_json::Value = serde_json::from_str(trimmed).map_err(|error| {
        BootstrapError::new(
            ErrorCode::RuntimeNotReady,
            format!("guest health boundary did not return valid JSON: {error}"),
        )
    })?;
    if value.get("contractId").and_then(serde_json::Value::as_str)
        != Some(LINUX_RUNTIME_CONTRACT_ID)
    {
        return Err(BootstrapError::new(
            ErrorCode::RuntimeNotReady,
            "guest health boundary reported an unrecognized Runtime contract id",
        ));
    }
    let schema_version = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_i64);
    if schema_version.is_none_or(|version| version < LINUX_RUNTIME_MINIMUM_SCHEMA_VERSION) {
        return Err(BootstrapError::new(
            ErrorCode::RuntimeNotReady,
            "guest health boundary reported a Runtime contract schema version below the supported minimum",
        ));
    }
    if value
        .get("bootstrapReady")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err(BootstrapError::new(
            ErrorCode::RuntimeNotReady,
            "guest health boundary reported bootstrapReady: false",
        ));
    }
    Ok(value)
}

fn write_config(path: &Path, rendered: &str) -> Result<(), BootstrapError> {
    let temporary = path.with_extension("yaml.tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| BootstrapError::io("create staged Lima instance configuration", &error))?;
    file.write_all(rendered.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| BootstrapError::io("write staged Lima instance configuration", &error))?;
    fs::rename(&temporary, path).map_err(|error| {
        BootstrapError::io("atomically promote Lima instance configuration", &error)
    })
}

fn read_state(path: &Path) -> Result<Option<RuntimeState>, BootstrapError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| {
            BootstrapError::new(
                ErrorCode::LimaInstanceAmbiguous,
                format!("managed runtime instance state is not valid JSON: {error}"),
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(BootstrapError::io(
            "read managed runtime instance state",
            &error,
        )),
    }
}

fn write_state(path: &Path, state: &RuntimeState) -> Result<(), BootstrapError> {
    let temporary = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temporary);
    let serialized = serde_json::to_vec_pretty(state).map_err(|error| {
        BootstrapError::new(
            ErrorCode::IoError,
            format!("serialize managed runtime instance state: {error}"),
        )
    })?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| {
            BootstrapError::io("create staged managed runtime instance state", &error)
        })?;
    file.write_all(&serialized)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            BootstrapError::io("write staged managed runtime instance state", &error)
        })?;
    fs::rename(&temporary, path).map_err(|error| {
        BootstrapError::io("atomically promote managed runtime instance state", &error)
    })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Barrier, Mutex,
    };
    use std::thread;

    use tempfile::TempDir;

    use super::*;
    use crate::bootstrap_disk::{bootstrap_disk_name, bootstrap_disk_path};
    use crate::error::ErrorCode;
    use crate::oci::OciSource;
    use crate::paths::ManagedPaths;

    const OUTPUT_FIXTURE_BYTES: usize = MAX_COMMAND_OUTPUT * 4;

    fn output_fixture_cli() -> SystemLimaCli {
        SystemLimaCli {
            binary_path: std::env::current_exe().unwrap(),
            lima_home: std::env::temp_dir(),
            qemu_system_path: None,
        }
    }

    fn running_as_fixture(filter: &str) -> bool {
        std::env::args().any(|argument| argument == filter)
    }

    #[test]
    fn limactl_output_fixture() {
        if !running_as_fixture("limactl_output_fixture") {
            return;
        }
        let payload = vec![b'o'; OUTPUT_FIXTURE_BYTES];
        let mut stdout = io::stdout().lock();
        stdout.write_all(&payload).unwrap();
        stdout.flush().unwrap();
        drop(stdout);

        let mut stderr = io::stderr().lock();
        stderr.write_all(&payload).unwrap();
        stderr.flush().unwrap();
    }

    #[test]
    fn limactl_failure_output_fixture() {
        if !running_as_fixture("limactl_failure_output_fixture") {
            return;
        }
        let mut stdout = io::stdout().lock();
        stdout.write_all(b"stdout-diagnostic").unwrap();
        stdout.flush().unwrap();
        drop(stdout);

        let mut stderr = io::stderr().lock();
        stderr.write_all(b"stderr-diagnostic").unwrap();
        stderr.flush().unwrap();
        std::process::exit(17);
    }

    #[test]
    fn limactl_timeout_fixture() {
        if !running_as_fixture("limactl_timeout_fixture") {
            return;
        }
        thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn large_stdout_and_stderr_are_drained_before_successful_exit() {
        let output = output_fixture_cli()
            .run(
                &["limactl_output_fixture", "--nocapture"],
                Duration::from_secs(10),
            )
            .unwrap();
        assert!(output.len() <= MAX_COMMAND_OUTPUT);
    }

    #[test]
    fn failure_preserves_bounded_stdout_and_stderr_diagnostics() {
        let error = output_fixture_cli()
            .run(
                &["limactl_failure_output_fixture", "--nocapture"],
                Duration::from_secs(10),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::LimaCommandFailed);
        assert!(error.message.contains("stdout-diagnostic"));
        assert!(error.message.contains("stderr-diagnostic"));
        assert!(error.message.chars().count() <= 512);
    }

    #[test]
    fn timeout_reaps_child_and_returns_stable_bounded_error() {
        let error = output_fixture_cli()
            .run(
                &["limactl_timeout_fixture", "--nocapture"],
                Duration::from_millis(100),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::LimaCommandFailed);
        assert_eq!(error.message, "limactl command timed out");
        assert!(error.message.chars().count() <= 512);
    }

    #[derive(Clone, Debug)]
    struct FakeInstance {
        status: String,
        vm_type: Option<String>,
    }

    /// Drives `FakeLimaCli::shell`'s managed-generation-aware responses.
    /// `active_identity` is the generation the fake reports as already
    /// active/healthy (via `managed-status`) *before* any reconcile call in
    /// the current test; `reconcile_activates` is the identity a call to
    /// `mottainai-bootstrap reconcile` promotes to active (simulating a real
    /// convergence). `reconcile_error`/`smoke_error`, when set, make the
    /// corresponding guest command fail instead.
    #[derive(Clone, Debug, Default)]
    struct ManagedGenerationFixture {
        active_identity: RefCell<Option<String>>,
        reconcile_activates: Option<String>,
        reconcile_error: Option<String>,
        smoke_error: Option<String>,
        manifest_writes: RefCell<u32>,
        reconcile_calls: RefCell<u32>,
        smoke_calls: RefCell<u32>,
    }

    struct FakeLimaCli {
        instances: RefCell<HashMap<String, FakeInstance>>,
        create_calls: RefCell<u32>,
        start_calls: RefCell<u32>,
        shell_calls: RefCell<u32>,
        managed_generation: ManagedGenerationFixture,
    }

    impl FakeLimaCli {
        fn new() -> Self {
            Self {
                instances: RefCell::new(HashMap::new()),
                create_calls: RefCell::new(0),
                start_calls: RefCell::new(0),
                shell_calls: RefCell::new(0),
                managed_generation: ManagedGenerationFixture::default(),
            }
        }

        fn with_instance(self, name: &str, status: &str, vm_type: Option<&str>) -> Self {
            self.instances.borrow_mut().insert(
                name.to_owned(),
                FakeInstance {
                    status: status.to_owned(),
                    vm_type: vm_type.map(str::to_owned),
                },
            );
            self
        }

        fn set_status(&self, name: &str, status: &str) {
            self.instances
                .borrow_mut()
                .get_mut(name)
                .expect("fixture instance must exist")
                .status = status.to_owned();
        }

        fn with_active_generation(self, identity: &str) -> Self {
            *self.managed_generation.active_identity.borrow_mut() = Some(identity.to_owned());
            self
        }

        fn with_reconcile_activating(mut self, identity: &str) -> Self {
            self.managed_generation.reconcile_activates = Some(identity.to_owned());
            self
        }

        fn with_reconcile_failure(mut self, message: &str) -> Self {
            self.managed_generation.reconcile_error = Some(message.to_owned());
            self
        }

        fn with_smoke_failure(mut self, message: &str) -> Self {
            self.managed_generation.smoke_error = Some(message.to_owned());
            self
        }
    }

    impl LimaCli for FakeLimaCli {
        fn list_all(&self) -> Result<Vec<LimaInstanceInfo>, BootstrapError> {
            Ok(self
                .instances
                .borrow()
                .iter()
                .map(|(name, instance)| LimaInstanceInfo {
                    name: name.clone(),
                    status: Some(instance.status.clone()),
                    vm_type: instance.vm_type.clone(),
                })
                .collect())
        }

        fn create(&self, instance: &str, _config_path: &Path) -> Result<(), BootstrapError> {
            *self.create_calls.borrow_mut() += 1;
            self.instances.borrow_mut().insert(
                instance.to_owned(),
                FakeInstance {
                    status: "Stopped".to_owned(),
                    vm_type: Some("qemu".to_owned()),
                },
            );
            Ok(())
        }

        fn start(&self, instance: &str) -> Result<(), BootstrapError> {
            *self.start_calls.borrow_mut() += 1;
            let mut instances = self.instances.borrow_mut();
            let entry = instances.get_mut(instance).ok_or_else(|| {
                BootstrapError::new(ErrorCode::LimaCommandFailed, "start: no such instance")
            })?;
            entry.status = "Running".to_owned();
            Ok(())
        }

        fn shell(&self, instance: &str, command: &[&str]) -> Result<String, BootstrapError> {
            self.shell_with_timeout(instance, command, COMMAND_TIMEOUT)
        }

        fn shell_with_timeout(
            &self,
            _instance: &str,
            command: &[&str],
            _timeout: Duration,
        ) -> Result<String, BootstrapError> {
            *self.shell_calls.borrow_mut() += 1;
            match command.first().copied() {
                Some("sh") if command.get(3) == Some(&"write-managed-package-manifest") => {
                    *self.managed_generation.manifest_writes.borrow_mut() += 1;
                    Ok(String::new())
                }
                Some("sh") => {
                    *self.managed_generation.smoke_calls.borrow_mut() += 1;
                    match &self.managed_generation.smoke_error {
                        Some(message) => Err(BootstrapError::new(
                            ErrorCode::LimaCommandFailed,
                            message.clone(),
                        )),
                        None => Ok(String::new()),
                    }
                }
                Some("mottainai-bootstrap") if command.get(1) == Some(&"reconcile") => {
                    *self.managed_generation.reconcile_calls.borrow_mut() += 1;
                    if let Some(message) = &self.managed_generation.reconcile_error {
                        return Err(BootstrapError::new(
                            ErrorCode::LimaCommandFailed,
                            message.clone(),
                        ));
                    }
                    if let Some(activated) = &self.managed_generation.reconcile_activates {
                        *self.managed_generation.active_identity.borrow_mut() =
                            Some(activated.clone());
                    }
                    Ok(serde_json::json!({ "ok": true, "outcome": "updated" }).to_string())
                }
                Some("mottainai-bootstrap") if command.get(1) == Some(&"managed-status") => {
                    let active = self.managed_generation.active_identity.borrow().clone();
                    Ok(match active {
                        Some(identity) => serde_json::json!({
                            "valid": true,
                            "present": true,
                            "activationPhase": "idle",
                            "activeGenerationIdentity": identity,
                            "observedGenerationIdentity": identity,
                        })
                        .to_string(),
                        None => serde_json::json!({ "valid": true, "present": false }).to_string(),
                    })
                }
                _ => {
                    // Shaped exactly like `mottainai-runtime-health`'s real
                    // schema-2 output (`nix/modules/runtime.nix`'s
                    // `healthScript`): bootstrapReady is always true once
                    // the guest is reachable, and managedRuntimeReady
                    // mirrors whether this fixture currently has an active
                    // managed generation recorded.
                    let managed_runtime_ready =
                        self.managed_generation.active_identity.borrow().is_some();
                    Ok(serde_json::json!({
                        "contractId": "mottainai.linux-runtime.v1",
                        "schemaVersion": 2,
                        "runtimeIdentity": "fixture-runtime",
                        "architecture": "x86_64-linux",
                        "buildIdentity": "/nix/store/fixture-system",
                        "generation": 1,
                        "stateOwners": { "system": [], "repositoryUser": [] },
                        "requiredCompanions": [],
                        "readiness": if managed_runtime_ready { "managed-runtime-ready" } else { "bootstrap-ready" },
                        "bootstrapReady": true,
                        "managedRuntimeReady": managed_runtime_ready,
                        "reconciliation": "current",
                        "upgradeRequired": false,
                    })
                    .to_string())
                }
            }
        }
    }

    /// A thread-safe provider fixture whose `create` publishes the external
    /// instance before returning an error. The first list call is held open
    /// so a concurrent ensure must contend on the bootstrap lock before it
    /// can observe or repeat that post-effect create.
    struct PostEffectLimaCli {
        instances: Mutex<HashMap<String, FakeInstance>>,
        create_calls: AtomicUsize,
        start_calls: AtomicUsize,
        list_calls: AtomicUsize,
        list_entered: Arc<Barrier>,
        release_list: Arc<Barrier>,
        fail_first_create: AtomicBool,
    }

    impl PostEffectLimaCli {
        fn new(list_entered: Arc<Barrier>, release_list: Arc<Barrier>) -> Self {
            Self {
                instances: Mutex::new(HashMap::new()),
                create_calls: AtomicUsize::new(0),
                start_calls: AtomicUsize::new(0),
                list_calls: AtomicUsize::new(0),
                list_entered,
                release_list,
                fail_first_create: AtomicBool::new(true),
            }
        }
    }

    impl LimaCli for PostEffectLimaCli {
        fn list_all(&self) -> Result<Vec<LimaInstanceInfo>, BootstrapError> {
            if self.list_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                self.list_entered.wait();
                self.release_list.wait();
            }
            Ok(self
                .instances
                .lock()
                .expect("post-effect fixture instance lock")
                .iter()
                .map(|(name, instance)| LimaInstanceInfo {
                    name: name.clone(),
                    status: Some(instance.status.clone()),
                    vm_type: instance.vm_type.clone(),
                })
                .collect())
        }

        fn create(&self, instance: &str, _config_path: &Path) -> Result<(), BootstrapError> {
            self.create_calls.fetch_add(1, Ordering::SeqCst);
            self.instances
                .lock()
                .expect("post-effect fixture instance lock")
                .insert(
                    instance.to_owned(),
                    FakeInstance {
                        status: "Stopped".to_owned(),
                        vm_type: Some("qemu".to_owned()),
                    },
                );
            if self.fail_first_create.swap(false, Ordering::SeqCst) {
                return Err(BootstrapError::new(
                    ErrorCode::LimaCommandFailed,
                    "simulated limactl create failure after external instance creation",
                ));
            }
            Ok(())
        }

        fn start(&self, instance: &str) -> Result<(), BootstrapError> {
            self.start_calls.fetch_add(1, Ordering::SeqCst);
            let mut instances = self
                .instances
                .lock()
                .expect("post-effect fixture instance lock");
            let entry = instances.get_mut(instance).ok_or_else(|| {
                BootstrapError::new(ErrorCode::LimaCommandFailed, "start: no such instance")
            })?;
            entry.status = "Running".to_owned();
            Ok(())
        }

        fn shell(&self, _instance: &str, _command: &[&str]) -> Result<String, BootstrapError> {
            Ok(serde_json::json!({
                "contractId": "mottainai.linux-runtime.v1",
                "schemaVersion": 2,
                "runtimeIdentity": "fixture-runtime",
                "architecture": "x86_64-linux",
                "buildIdentity": "/nix/store/fixture-system",
                "generation": 1,
                "stateOwners": { "system": [], "repositoryUser": [] },
                "requiredCompanions": [],
                "readiness": "bootstrap-ready",
                "bootstrapReady": true,
                "managedRuntimeReady": false,
                "reconciliation": "current",
                "upgradeRequired": false,
            })
            .to_string())
        }
    }

    struct FakeOciSource;

    impl OciSource for FakeOciSource {
        fn fetch_manifest(
            &self,
            _repository: &str,
            _digest: &str,
        ) -> Result<Vec<u8>, BootstrapError> {
            Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                "fixture appliance is preloaded; network should never be used",
            ))
        }

        fn fetch_blob(
            &self,
            _repository: &str,
            _digest: &str,
            _destination: &std::path::Path,
            _max_bytes: u64,
        ) -> Result<(), BootstrapError> {
            Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                "fixture appliance is preloaded; network should never be used",
            ))
        }
    }

    fn reference() -> ApplianceReference {
        ApplianceReference {
            registry: "ghcr.io".to_owned(),
            repository: "yohn-jp/mottainai/runtime-appliance".to_owned(),
            digest: format!("sha256:{}", "a".repeat(64)),
        }
    }

    fn spec() -> RuntimeSpec {
        RuntimeSpec {
            schema_version: RUNTIME_SPEC_SCHEMA_VERSION.to_owned(),
            instance_name: "mottainai-runtime".to_owned(),
            architecture: "x86_64".to_owned(),
            cpus: 2,
            memory_mib: 4096,
            appliance: reference(),
            mounts: Vec::new(),
            managed_generation: None,
        }
    }

    fn managed_generation_identity() -> String {
        "b".repeat(64)
    }

    fn spec_with_managed_generation() -> RuntimeSpec {
        RuntimeSpec {
            managed_generation: Some(ManagedGenerationIntent {
                identity: managed_generation_identity(),
                manifest: serde_json::json!({
                    "contractId": "mottainai.managed-package-manifest.v1",
                    "schemaVersion": 1,
                    "activation": { "generation": 1 },
                    "packages": [
                        {
                            "packageId": "mottainai",
                            "kind": "nix-flake-package",
                            "version": "0.9.0",
                            "source": {
                                "flakeRef": "nix#mottainai",
                                "sourceSha256": "c".repeat(64),
                            },
                        },
                    ],
                }),
            }),
            ..spec()
        }
    }

    /// Pre-seeds a satisfied managed appliance so tests exercise Lima
    /// instance reconciliation hermetically, without any OCI network path.
    fn seed_appliance(paths: &ManagedPaths, reference: &ApplianceReference) -> PathBuf {
        let raw_path = paths.appliance_raw_path(&reference.digest);
        fs::create_dir_all(raw_path.parent().unwrap()).unwrap();
        fs::write(&raw_path, b"fixture-raw-disk-bytes").unwrap();
        let raw_sha256 = format!("{:x}", Sha256::digest(b"fixture-raw-disk-bytes"));
        let state = serde_json::json!({
            "schema_version": "mottainai.host-bootstrap.appliance.v1",
            "registry": reference.registry,
            "repository": reference.repository,
            "digest": reference.digest,
            "raw_sha256": raw_sha256,
            "raw_size_bytes": std::fs::metadata(&raw_path).unwrap().len(),
        });
        fs::write(
            paths.appliance_state_path(&reference.digest),
            serde_json::to_vec_pretty(&state).unwrap(),
        )
        .unwrap();
        raw_path
    }

    fn seed_runtime_state(
        paths: &ManagedPaths,
        spec: &RuntimeSpec,
        schema_version: &str,
        instance_name: &str,
    ) {
        let raw_path = paths.appliance_raw_path(&spec.appliance.digest);
        let rendered = render_lima_config(spec, &raw_path);
        let state = RuntimeState {
            schema_version: schema_version.to_owned(),
            instance_name: instance_name.to_owned(),
            appliance_digest: spec.appliance.digest.clone(),
            config_identity_sha256: config_identity(&rendered),
        };
        let state_path = paths.runtime_state_path(&spec.instance_name);
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        write_state(&state_path, &state).unwrap();
    }

    fn managed_paths() -> (TempDir, ManagedPaths) {
        let temp = TempDir::new().unwrap();
        let paths = ManagedPaths::new(temp.path().join("state"));
        crate::paths::ensure_managed_directories(&paths).unwrap();
        let config_directory = paths.lima_home_directory.join("_config");
        fs::create_dir_all(&config_directory).unwrap();
        fs::write(config_directory.join("user"), b"test-private-key").unwrap();
        fs::write(
            config_directory.join("user.pub"),
            b"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestBootstrapKeyForMottainai840 operator\n",
        )
        .unwrap();
        (temp, paths)
    }

    #[test]
    fn concurrent_ensures_contend_before_post_effect_create_and_do_not_duplicate_it() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let list_entered = Arc::new(Barrier::new(2));
        let release_list = Arc::new(Barrier::new(2));
        let cli = Arc::new(PostEffectLimaCli::new(
            Arc::clone(&list_entered),
            Arc::clone(&release_list),
        ));
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };

        let first_paths = paths.clone();
        let first_cli = Arc::clone(&cli);
        let first_config = quick_config.clone();
        let first = thread::spawn(move || {
            ensure_runtime(
                &first_paths,
                &spec(),
                first_cli.as_ref(),
                &FakeOciSource,
                &first_config,
            )
        });
        list_entered.wait();

        let second_paths = paths.clone();
        let second_cli = Arc::clone(&cli);
        let second_config = quick_config.clone();
        let (second_done, second_result) = mpsc::channel();
        let second_thread = thread::spawn(move || {
            let evidence = ensure_runtime(
                &second_paths,
                &spec(),
                second_cli.as_ref(),
                &FakeOciSource,
                &second_config,
            );
            second_done
                .send(evidence)
                .expect("concurrent ensure result receiver should remain available");
        });
        let second = second_result
            .recv_timeout(Duration::from_secs(1))
            .expect("concurrent ensure should fail fast on lock contention");
        assert_eq!(second.result, Outcome::Blocked);
        assert_eq!(second.error_code.as_deref(), Some("bootstrap_locked"));
        assert_eq!(cli.create_calls.load(Ordering::SeqCst), 0);
        assert!(!paths
            .runtime_instance_directory(&spec().instance_name)
            .join("lima.yaml")
            .exists());
        assert!(!paths
            .runtime_instance_directory(&spec().instance_name)
            .join("state.json")
            .exists());

        release_list.wait();
        let first = first
            .join()
            .expect("first ensure thread should finish after release");
        assert_eq!(first.result, Outcome::Blocked);
        assert_eq!(first.error_code.as_deref(), Some("lima_command_failed"));
        assert_eq!(cli.create_calls.load(Ordering::SeqCst), 1);

        second_thread
            .join()
            .expect("concurrent ensure thread should finish cleanly");
        let resumed = ensure_runtime(&paths, &spec(), cli.as_ref(), &FakeOciSource, &quick_config);
        assert_eq!(resumed.result, Outcome::Changed);
        assert_eq!(cli.create_calls.load(Ordering::SeqCst), 1);
        assert_eq!(cli.start_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn mismatched_lock_fails_before_any_runtime_mutation() {
        let temporary = TempDir::new().unwrap();
        let locked_paths = ManagedPaths::new(temporary.path().join("locked-state"));
        let target_paths = ManagedPaths::new(temporary.path().join("target-state"));
        ensure_managed_root(&locked_paths).unwrap();
        let lock = BootstrapLock::acquire(&locked_paths).unwrap();
        let cli = FakeLimaCli::new();

        let evidence = ensure_runtime_locked(
            &target_paths,
            &spec(),
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig {
                health_check_attempts: 1,
                health_check_interval: Duration::from_millis(0),
            },
            &lock,
        );

        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(
            evidence.error_code.as_deref(),
            Some("bootstrap_lock_mismatch")
        );
        assert!(!target_paths.root.exists());
        assert_eq!(*cli.create_calls.borrow(), 0);
        assert_eq!(*cli.start_calls.borrow(), 0);
        assert_eq!(*cli.shell_calls.borrow(), 0);
    }

    #[test]
    fn missing_instance_is_created_started_and_reaches_health() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new();
        let evidence = ensure_runtime(
            &paths,
            &spec(),
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig {
                health_check_attempts: 1,
                health_check_interval: Duration::from_millis(0),
            },
        );
        assert_eq!(evidence.result, Outcome::Changed);
        assert!(evidence.guest_reachable);
        assert_eq!(*cli.create_calls.borrow(), 1);
        assert_eq!(*cli.start_calls.borrow(), 1);
    }

    #[test]
    fn repeated_ensure_on_a_running_matching_instance_is_a_no_op() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new();
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };
        let first = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(first.result, Outcome::Changed);

        let second = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(second.result, Outcome::NoOp);
        assert!(!second.changed);
        assert_eq!(*cli.create_calls.borrow(), 1, "create must not repeat");
        assert_eq!(*cli.start_calls.borrow(), 1, "start must not repeat");
        assert_eq!(
            *cli.shell_calls.borrow(),
            2,
            "health is re-verified each ensure"
        );
    }

    #[test]
    fn fresh_bootstrap_only_guest_converges_to_managed_runtime_ready() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let identity = managed_generation_identity();
        let cli = FakeLimaCli::new().with_reconcile_activating(&identity);
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };

        let evidence = ensure_runtime(
            &paths,
            &spec_with_managed_generation(),
            &cli,
            &FakeOciSource,
            &quick_config,
        );

        assert_eq!(evidence.result, Outcome::Changed);
        assert_eq!(evidence.managed_runtime_ready, Some(true));
        assert_eq!(evidence.functional_smoke_verified, Some(true));
        assert_eq!(*cli.managed_generation.manifest_writes.borrow(), 1);
        assert_eq!(*cli.managed_generation.reconcile_calls.borrow(), 1);
        assert_eq!(*cli.managed_generation.smoke_calls.borrow(), 1);
    }

    #[test]
    fn already_managed_current_guest_is_a_true_no_op() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let identity = managed_generation_identity();
        let cli = FakeLimaCli::new().with_active_generation(&identity);
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };

        let first = ensure_runtime(
            &paths,
            &spec_with_managed_generation(),
            &cli,
            &FakeOciSource,
            &quick_config,
        );
        assert_eq!(
            first.result,
            Outcome::Changed,
            "lima instance creation itself still counts as change"
        );
        assert_eq!(first.managed_runtime_ready, Some(true));
        assert_eq!(
            *cli.managed_generation.reconcile_calls.borrow(),
            0,
            "an already-active intended generation must never invoke reconcile"
        );
        assert_eq!(*cli.managed_generation.manifest_writes.borrow(), 0);

        let second = ensure_runtime(
            &paths,
            &spec_with_managed_generation(),
            &cli,
            &FakeOciSource,
            &quick_config,
        );
        assert_eq!(second.result, Outcome::NoOp);
        assert_eq!(second.managed_runtime_ready, Some(true));
        assert_eq!(second.functional_smoke_verified, Some(true));
        assert_eq!(
            *cli.managed_generation.reconcile_calls.borrow(),
            0,
            "repeated ensure against an unchanged healthy generation must not reconcile"
        );
    }

    #[test]
    fn wrong_generation_active_converges_to_the_intended_one() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let stale_identity = "d".repeat(64);
        let intended_identity = managed_generation_identity();
        let cli = FakeLimaCli::new()
            .with_active_generation(&stale_identity)
            .with_reconcile_activating(&intended_identity);
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };

        let evidence = ensure_runtime(
            &paths,
            &spec_with_managed_generation(),
            &cli,
            &FakeOciSource,
            &quick_config,
        );

        assert_eq!(evidence.result, Outcome::Changed);
        assert_eq!(evidence.managed_runtime_ready, Some(true));
        assert_eq!(*cli.managed_generation.reconcile_calls.borrow(), 1);
        assert_eq!(
            cli.managed_generation.active_identity.borrow().as_deref(),
            Some(intended_identity.as_str())
        );
    }

    #[test]
    fn reconcile_failure_fails_closed_and_never_claims_managed_readiness() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new()
            .with_reconcile_failure("simulated activation health failure; rolled back");
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };

        let evidence = ensure_runtime(
            &paths,
            &spec_with_managed_generation(),
            &cli,
            &FakeOciSource,
            &quick_config,
        );

        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(
            evidence.error_code.as_deref(),
            Some("managed_generation_reconcile_failed")
        );
        assert_ne!(evidence.managed_runtime_ready, Some(true));
        assert_ne!(evidence.functional_smoke_verified, Some(true));
        assert_eq!(
            *cli.managed_generation.smoke_calls.borrow(),
            0,
            "smoke must never run after a reconcile failure"
        );
    }

    #[test]
    fn bootstrap_ready_alone_never_satisfies_a_requested_managed_generation() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        // No reconcile_activates configured: reconcile "succeeds" (guest
        // accepts the call) but the fixture never actually records an
        // active generation, modelling a guest that only ever reaches
        // bootstrapReady. Route 3 must not accept this as success.
        let cli = FakeLimaCli::new();
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };

        let evidence = ensure_runtime(
            &paths,
            &spec_with_managed_generation(),
            &cli,
            &FakeOciSource,
            &quick_config,
        );

        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(evidence.error_code.as_deref(), Some("runtime_not_ready"));
        assert_ne!(evidence.managed_runtime_ready, Some(true));
    }

    #[test]
    fn functional_smoke_failure_fails_closed_after_managed_runtime_ready() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let identity = managed_generation_identity();
        let cli = FakeLimaCli::new()
            .with_active_generation(&identity)
            .with_smoke_failure("mcp initialize did not return a result");
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };

        let evidence = ensure_runtime(
            &paths,
            &spec_with_managed_generation(),
            &cli,
            &FakeOciSource,
            &quick_config,
        );

        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(
            evidence.error_code.as_deref(),
            Some("managed_runtime_smoke_failed")
        );
        assert_eq!(
            evidence.managed_runtime_ready,
            Some(true),
            "activation itself succeeded; only the smoke proof failed"
        );
        assert_eq!(evidence.functional_smoke_verified, Some(false));
    }

    #[test]
    fn no_managed_generation_requested_preserves_pre_753_bootstrap_only_behavior() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new();
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };

        let evidence = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);

        assert_eq!(evidence.result, Outcome::Changed);
        assert_eq!(evidence.managed_runtime_ready, None);
        assert_eq!(evidence.functional_smoke_verified, None);
        assert_eq!(*cli.managed_generation.reconcile_calls.borrow(), 0);
        assert_eq!(*cli.managed_generation.smoke_calls.borrow(), 0);
    }

    fn assert_runtime_schema_is_rejected_before_lima_reconciliation(schema_version: &str) {
        let (_temp, paths) = managed_paths();
        let runtime_spec = spec();
        seed_appliance(&paths, &runtime_spec.appliance);
        seed_runtime_state(
            &paths,
            &runtime_spec,
            schema_version,
            &runtime_spec.instance_name,
        );
        let cli = FakeLimaCli::new();

        let evidence = ensure_runtime(
            &paths,
            &runtime_spec,
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig {
                health_check_attempts: 1,
                health_check_interval: Duration::from_millis(0),
            },
        );
        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(
            evidence.error_code.as_deref(),
            Some("lima_instance_ambiguous")
        );
        assert_eq!(*cli.create_calls.borrow(), 0);
        assert_eq!(*cli.start_calls.borrow(), 0);
    }

    #[test]
    fn runtime_state_with_wrong_schema_is_rejected_before_lima_reconciliation() {
        assert_runtime_schema_is_rejected_before_lima_reconciliation(
            "mottainai.host-bootstrap.lima-runtime-state.legacy",
        );
    }

    #[test]
    fn runtime_state_with_future_schema_is_rejected_before_lima_reconciliation() {
        assert_runtime_schema_is_rejected_before_lima_reconciliation(
            "mottainai.host-bootstrap.lima-runtime-state.v2",
        );
    }

    #[test]
    fn runtime_state_with_mismatched_instance_identity_is_rejected_before_lima_reconciliation() {
        let (_temp, paths) = managed_paths();
        let runtime_spec = spec();
        seed_appliance(&paths, &runtime_spec.appliance);
        seed_runtime_state(
            &paths,
            &runtime_spec,
            RUNTIME_STATE_SCHEMA_VERSION,
            "other-runtime",
        );
        let cli = FakeLimaCli::new();

        let evidence = ensure_runtime(
            &paths,
            &runtime_spec,
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig {
                health_check_attempts: 1,
                health_check_interval: Duration::from_millis(0),
            },
        );
        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(
            evidence.error_code.as_deref(),
            Some("lima_instance_ambiguous")
        );
        assert_eq!(*cli.create_calls.borrow(), 0);
        assert_eq!(*cli.start_calls.borrow(), 0);
    }

    #[test]
    fn malformed_runtime_state_fails_closed_before_lima_reconciliation() {
        let (_temp, paths) = managed_paths();
        let runtime_spec = spec();
        seed_appliance(&paths, &runtime_spec.appliance);
        let state_path = paths.runtime_state_path(&runtime_spec.instance_name);
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        fs::write(state_path, b"{not valid json").unwrap();
        let cli = FakeLimaCli::new();

        let evidence = ensure_runtime(
            &paths,
            &runtime_spec,
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig {
                health_check_attempts: 1,
                health_check_interval: Duration::from_millis(0),
            },
        );
        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(
            evidence.error_code.as_deref(),
            Some("lima_instance_ambiguous")
        );
        assert_eq!(*cli.create_calls.borrow(), 0);
        assert_eq!(*cli.start_calls.borrow(), 0);
    }

    #[test]
    fn stopped_matching_instance_is_started_without_recreation() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new();
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };
        let first = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(first.result, Outcome::Changed);
        cli.instances
            .borrow_mut()
            .get_mut(&spec().instance_name)
            .unwrap()
            .status = "Stopped".to_owned();

        let second = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(second.result, Outcome::Changed);
        assert!(second.changed);
        assert_eq!(
            *cli.create_calls.borrow(),
            1,
            "stopped is reconciled, not recreated"
        );
        assert_eq!(*cli.start_calls.borrow(), 2);
    }

    #[test]
    fn ambient_unrecorded_instance_fails_closed_without_adoption() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new().with_instance("mottainai-runtime", "Running", Some("qemu"));
        let evidence = ensure_runtime(
            &paths,
            &spec(),
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig::default(),
        );
        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(
            evidence.error_code.as_deref(),
            Some("lima_instance_ambiguous")
        );
        assert_eq!(*cli.create_calls.borrow(), 0);
        assert_eq!(*cli.start_calls.borrow(), 0);
    }

    #[test]
    fn incompatible_vm_type_fails_closed() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new().with_instance("mottainai-runtime", "Running", Some("vz"));
        let evidence = ensure_runtime(
            &paths,
            &spec(),
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig::default(),
        );
        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(
            evidence.error_code.as_deref(),
            Some("lima_instance_incompatible")
        );
    }

    #[test]
    fn absent_vm_type_fails_closed_rather_than_passing_implicitly() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new().with_instance("mottainai-runtime", "Running", None);
        let evidence = ensure_runtime(
            &paths,
            &spec(),
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig::default(),
        );
        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(
            evidence.error_code.as_deref(),
            Some("lima_instance_incompatible")
        );
    }

    #[test]
    fn spec_drift_against_an_already_managed_instance_fails_closed() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new();
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };
        let first = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(first.result, Outcome::Changed);

        let mut changed_spec = spec();
        changed_spec.memory_mib = 8192;
        let second = ensure_runtime(&paths, &changed_spec, &cli, &FakeOciSource, &quick_config);
        assert_eq!(second.result, Outcome::Blocked);
        assert_eq!(
            second.error_code.as_deref(),
            Some("lima_instance_incompatible")
        );
        assert_eq!(*cli.create_calls.borrow(), 1, "no destructive recreate");
    }

    #[test]
    fn malformed_instance_status_is_ambiguous_and_fails_closed() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new();
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };
        let first = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(first.result, Outcome::Changed);
        cli.instances
            .borrow_mut()
            .get_mut(&spec().instance_name)
            .unwrap()
            .status = "Broken".to_owned();

        let second = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(second.result, Outcome::Blocked);
        assert_eq!(
            second.error_code.as_deref(),
            Some("lima_instance_ambiguous")
        );
        assert_eq!(
            *cli.start_calls.borrow(),
            1,
            "a broken instance is never started blindly"
        );
    }

    #[test]
    fn interrupted_reconciliation_resumes_from_a_created_but_unstarted_instance() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new();
        // Simulate a process crash between `create` succeeding and `start`
        // ever being attempted: the fake never receives a start() call, so
        // the instance is left Stopped by `create` alone, but our own
        // managed intent record was already durably written first.
        fs::create_dir_all(paths.runtime_instance_directory(&spec().instance_name)).unwrap();
        let config_path = paths.runtime_config_path(&spec().instance_name);
        let rendered = render_lima_config(&spec(), &seed_appliance(&paths, &reference()));
        write_config(&config_path, &rendered).unwrap();
        let state = RuntimeState {
            schema_version: RUNTIME_STATE_SCHEMA_VERSION.to_owned(),
            instance_name: spec().instance_name,
            appliance_digest: spec().appliance.digest,
            config_identity_sha256: config_identity(&rendered),
        };
        write_state(&paths.runtime_state_path(&spec().instance_name), &state).unwrap();
        cli.create(&spec().instance_name, &config_path).unwrap();
        assert_eq!(*cli.create_calls.borrow(), 1);
        assert_eq!(*cli.start_calls.borrow(), 0);

        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::from_millis(0),
        };
        let resumed = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(resumed.result, Outcome::Changed);
        assert_eq!(*cli.create_calls.borrow(), 1, "create is never repeated");
        assert_eq!(
            *cli.start_calls.borrow(),
            1,
            "the interrupted transaction is resumed with start"
        );
    }

    #[test]
    fn unreachable_guest_health_fails_closed_as_blocked() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());

        struct UnhealthyCli(FakeLimaCli);
        impl LimaCli for UnhealthyCli {
            fn list_all(&self) -> Result<Vec<LimaInstanceInfo>, BootstrapError> {
                self.0.list_all()
            }
            fn create(&self, instance: &str, config_path: &Path) -> Result<(), BootstrapError> {
                self.0.create(instance, config_path)
            }
            fn start(&self, instance: &str) -> Result<(), BootstrapError> {
                self.0.start(instance)
            }
            fn shell(&self, _instance: &str, _command: &[&str]) -> Result<String, BootstrapError> {
                Err(BootstrapError::new(
                    ErrorCode::LimaCommandFailed,
                    "simulated unreachable guest",
                ))
            }
        }
        let cli = UnhealthyCli(FakeLimaCli::new());
        let evidence = ensure_runtime(
            &paths,
            &spec(),
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig {
                health_check_attempts: 2,
                health_check_interval: Duration::from_millis(0),
            },
        );
        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(evidence.error_code.as_deref(), Some("runtime_not_ready"));
        assert!(!evidence.guest_reachable);
    }

    #[test]
    fn config_render_is_bounded_and_has_no_default_mounts() {
        let rendered = render_lima_config(&spec(), Path::new("/tmp/appliance.raw"));
        let parsed: serde_json::Value = serde_saphyr::from_str(&rendered).unwrap();

        assert!(rendered.contains("vmType: qemu"));
        assert!(rendered.contains("mounts: []"));
        assert!(!rendered.contains("cloud-init"));
        assert_eq!(
            parsed["images"][0]["location"].as_str(),
            Some("/tmp/appliance.raw")
        );
        assert_eq!(parsed["mounts"].as_array().unwrap().len(), 0);
        assert_eq!(
            parsed["additionalDisks"][0]["name"].as_str(),
            Some(bootstrap_disk_name(&spec().instance_name).as_str())
        );
        assert_eq!(
            parsed["additionalDisks"][0]["format"].as_bool(),
            Some(false)
        );
        assert!(parsed["additionalDisks"][0].get("path").is_none());
        // Lima 2.2.0 only accepts reverse-sshfs/9p/virtiofs/wsl2 for
        // mountType and rejects "none" outright (`limactl create` fails
        // closed on the whole config, not just this field) -- with
        // mounts: [] above, no host path is ever mounted regardless of
        // which valid value is configured here.
        assert_eq!(parsed["mountType"].as_str(), Some("9p"));
        // Lima 2.2.0 names this field loadDotSSHPubKeys (SSH fully
        // capitalized), not the camelCase-derived loadDotSshPubKeys; a
        // regression here makes `limactl create` reject the whole config
        // as an unknown field, which no other test in this suite exercises
        // against a real limactl binary.
        assert_eq!(parsed["ssh"]["loadDotSSHPubKeys"].as_bool(), Some(false));
        assert!(parsed["ssh"].get("loadDotSshPubKeys").is_none());
    }

    #[test]
    fn runtime_composition_generates_and_attaches_the_managed_key_disk() {
        let (_temp, paths) = managed_paths();
        let appliance_path = seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new();
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::ZERO,
        };

        let first = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(first.result, Outcome::Changed);
        let rendered =
            fs::read_to_string(paths.runtime_config_path(&spec().instance_name)).unwrap();
        let parsed: serde_json::Value = serde_saphyr::from_str(&rendered).unwrap();
        assert_eq!(
            parsed["images"][0]["location"].as_str(),
            Some(appliance_path.to_str().unwrap())
        );
        assert_eq!(
            parsed["additionalDisks"][0]["name"].as_str(),
            Some(bootstrap_disk_name(&spec().instance_name).as_str())
        );
        assert_eq!(
            parsed["additionalDisks"][0]["format"].as_bool(),
            Some(false)
        );
        let bootstrap_path = bootstrap_disk_path(&paths, &spec().instance_name);
        assert!(bootstrap_path.starts_with(&paths.root));
        assert_ne!(bootstrap_path, appliance_path);
        assert!(bootstrap_path.is_file());
        let modified = fs::metadata(&bootstrap_path).unwrap().modified().unwrap();

        let second = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(second.result, Outcome::NoOp);
        assert_eq!(
            modified,
            fs::metadata(&bootstrap_path).unwrap().modified().unwrap()
        );
    }

    #[test]
    fn changed_key_fails_closed_before_replacing_a_running_disk() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new();
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::ZERO,
        };
        let first = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(first.result, Outcome::Changed);
        let bootstrap_path = bootstrap_disk_path(&paths, &spec().instance_name);
        let before = fs::read(&bootstrap_path).unwrap();
        fs::write(
            paths.lima_home_directory.join("_config/user.pub"),
            b"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIchangedBootstrapKeyFor840 changed\n",
        )
        .unwrap();

        let second = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(second.result, Outcome::Blocked);
        assert_eq!(second.error_code.as_deref(), Some("bootstrap_disk_failed"));
        assert_eq!(before, fs::read(&bootstrap_path).unwrap());
    }

    #[test]
    fn changed_key_regenerates_before_a_stopped_instance_restarts() {
        let (_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = FakeLimaCli::new();
        let quick_config = RuntimeEnsureConfig {
            health_check_attempts: 1,
            health_check_interval: Duration::ZERO,
        };
        let first = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(first.result, Outcome::Changed);
        cli.set_status(&spec().instance_name, "Stopped");
        let changed_key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIchangedBootstrapKeyFor840 changed\n";
        fs::write(
            paths.lima_home_directory.join("_config/user.pub"),
            changed_key,
        )
        .unwrap();

        let second = ensure_runtime(&paths, &spec(), &cli, &FakeOciSource, &quick_config);
        assert_eq!(second.result, Outcome::Changed);
        verify_bootstrap_disk(&paths, &spec().instance_name, changed_key).unwrap();
    }

    #[test]
    fn config_render_preserves_quoted_and_backslashed_paths_as_scalars() {
        let mut configured = spec();
        configured.mounts.push(MountSpec {
            host_path: r#"/host/with\backslash"quote"#.to_owned(),
            guest_path: r#"/guest/with\backslash"quote"#.to_owned(),
            writable: true,
        });
        let appliance_path = Path::new(r#"/managed/appliance\disk"image.raw"#);

        let rendered = render_lima_config(&configured, appliance_path);
        let parsed: serde_json::Value = serde_saphyr::from_str(&rendered).unwrap();

        assert_eq!(
            parsed["images"][0]["location"].as_str(),
            Some(appliance_path.to_str().unwrap())
        );
        assert_eq!(
            parsed["mounts"][0]["location"].as_str(),
            Some(configured.mounts[0].host_path.as_str())
        );
        assert_eq!(
            parsed["mounts"][0]["mountPoint"].as_str(),
            Some(configured.mounts[0].guest_path.as_str())
        );
        assert_eq!(parsed["mounts"][0]["writable"].as_bool(), Some(true));
    }

    #[test]
    fn mount_paths_with_newline_or_control_characters_fail_closed() {
        for invalid_path in [
            "/workspace/line\nbreak",
            "/workspace/tab\tbreak",
            "/workspace/zero\u{0000}break",
        ] {
            let mut configured = spec();
            configured.mounts.push(MountSpec {
                host_path: invalid_path.to_owned(),
                guest_path: "/guest/workspace".to_owned(),
                writable: false,
            });

            let error = configured.validate().unwrap_err();
            assert_eq!(
                error.code,
                ErrorCode::RuntimeSpecInvalid,
                "{invalid_path:?}"
            );
        }

        let mut configured = spec();
        configured.mounts.push(MountSpec {
            host_path: "/workspace/ordinary".to_owned(),
            guest_path: "/guest/line\nbreak".to_owned(),
            writable: false,
        });
        assert_eq!(
            configured.validate().unwrap_err().code,
            ErrorCode::RuntimeSpecInvalid
        );
    }

    #[test]
    fn invalid_mount_path_is_rejected_before_lima_configuration_creation() {
        let (_temp, paths) = managed_paths();
        let cli = FakeLimaCli::new();
        let mut configured = spec();
        configured.mounts.push(MountSpec {
            host_path: "/workspace/injected\nmountPoint: /unexpected".to_owned(),
            guest_path: "/guest/workspace".to_owned(),
            writable: false,
        });

        let evidence = ensure_runtime(
            &paths,
            &configured,
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig {
                health_check_attempts: 1,
                health_check_interval: Duration::from_millis(0),
            },
        );

        assert_eq!(evidence.result, Outcome::Blocked);
        assert_eq!(evidence.error_code.as_deref(), Some("runtime_spec_invalid"));
        assert_eq!(*cli.create_calls.borrow(), 0);
        assert_eq!(*cli.start_calls.borrow(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn lima_child_is_bound_to_verified_qemu_when_ambient_path_has_another_binary() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = TempDir::new().unwrap();
        let verified_directory = temporary.path().join("verified");
        let ambient_directory = temporary.path().join("ambient");
        fs::create_dir_all(&verified_directory).unwrap();
        fs::create_dir_all(&ambient_directory).unwrap();
        let verified = verified_directory.join("qemu-system-x86_64");
        let ambient = ambient_directory.join("qemu-system-x86_64");
        for (path, marker) in [(&verified, "QEMU-A"), (&ambient, "QEMU-B")] {
            fs::write(path, format!("#!/bin/sh\nprintf '%s\\n' {marker}\n")).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let marker_path = temporary.path().join("selected");
        let limactl = ambient_directory.join("limactl");
        fs::write(
            &limactl,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$QEMU_SYSTEM_X86_64\" > '{}'\nprintf '%s\\n' \"$(qemu-system-x86_64 --version)\" >> '{}'\nprintf '%s\\n' '{{\"name\":\"probe\",\"status\":\"Running\",\"vmType\":\"qemu\"}}'\n",
                marker_path.display(),
                marker_path.display(),
            ),
        )
        .unwrap();
        fs::set_permissions(&limactl, fs::Permissions::from_mode(0o755)).unwrap();

        let cli = SystemLimaCli {
            binary_path: limactl,
            lima_home: temporary.path().join("lima-home"),
            qemu_system_path: Some(verified.clone()),
        };
        let instances = cli.list_all().unwrap();
        assert_eq!(instances.len(), 1);
        let selected = fs::read_to_string(marker_path).unwrap();
        assert!(selected.contains(verified.to_str().unwrap()));
        assert!(selected.contains("QEMU-A"));
        assert!(!selected.contains("QEMU-B"));
    }

    #[cfg(unix)]
    #[test]
    fn production_lima_handoff_uses_plain_create_and_runtime_health_after_boot_disk_attachment() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = TempDir::new().unwrap();
        let create_args_path = temporary.path().join("create-args");
        let shell_args_path = temporary.path().join("shell-args");
        let created_path = temporary.path().join("created");
        let started_path = temporary.path().join("started");
        let limactl = temporary.path().join("limactl");
        fs::write(
            &limactl,
            format!(
                r#"#!/bin/sh
case "$2" in
  list)
    if test -f "{}"; then
      if test -f "{}"; then status=Running; else status=Stopped; fi
      printf '{{"name":"mottainai-runtime","status":"%s","vmType":"qemu"}}\n' "$status"
    fi
    ;;
  create)
    test -f "$6"
    grep -q 'additionalDisks:' "$6"
    grep -q 'mtnai-boot-' "$6"
    printf '%s\n' "$@" > "{}"
    touch "{}"
    ;;
  start)
    test -f "{}"
    touch "{}"
    ;;
  shell)
    test -f "{}"
    printf '%s\n' "$@" > "{}"
    test "$5" = mottainai-runtime-health
    printf '%s\n' '{{"contractId":"mottainai.linux-runtime.v1","schemaVersion":2,"bootstrapReady":true}}'
    ;;
  *) exit 64 ;;
esac
"#,
                created_path.display(),
                started_path.display(),
                create_args_path.display(),
                created_path.display(),
                created_path.display(),
                started_path.display(),
                started_path.display(),
                shell_args_path.display(),
            ),
        )
        .unwrap();
        fs::set_permissions(&limactl, fs::Permissions::from_mode(0o755)).unwrap();

        let (_state_temp, paths) = managed_paths();
        seed_appliance(&paths, &reference());
        let cli = SystemLimaCli {
            binary_path: limactl,
            lima_home: paths.lima_home_directory.clone(),
            qemu_system_path: None,
        };
        let evidence = ensure_runtime(
            &paths,
            &spec(),
            &cli,
            &FakeOciSource,
            &RuntimeEnsureConfig {
                health_check_attempts: 1,
                health_check_interval: Duration::ZERO,
            },
        );

        assert_eq!(evidence.result, Outcome::Changed);
        assert!(evidence.guest_reachable);
        assert_eq!(
            evidence.guest_status.as_ref().unwrap()["bootstrapReady"],
            true
        );

        let config_path = paths.runtime_config_path(&spec().instance_name);
        let create_args = fs::read_to_string(create_args_path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert_eq!(
            create_args,
            vec![
                "--tty=false",
                "create",
                "--name",
                "mottainai-runtime",
                "--plain",
                config_path.to_str().unwrap(),
            ]
        );

        let rendered = fs::read_to_string(config_path).unwrap();
        let parsed: serde_json::Value = serde_saphyr::from_str(&rendered).unwrap();
        assert_eq!(
            parsed["additionalDisks"][0]["name"].as_str(),
            Some(bootstrap_disk_name("mottainai-runtime").as_str())
        );
        assert_eq!(
            parsed["additionalDisks"][0]["format"].as_bool(),
            Some(false)
        );
        verify_bootstrap_disk(
            &paths,
            "mottainai-runtime",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestBootstrapKeyForMottainai840 operator\n",
        )
        .unwrap();

        let shell_args = fs::read_to_string(shell_args_path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert_eq!(
            shell_args,
            vec![
                "--tty=false",
                "shell",
                "mottainai-runtime",
                "--",
                "mottainai-runtime-health",
            ]
        );
        assert!(!shell_args
            .iter()
            .any(|argument| argument.contains("lima-ssh-ready")));
    }
}
