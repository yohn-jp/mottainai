use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::appliance::{ensure_appliance, ApplianceReference};
use crate::error::{BootstrapError, ErrorCode};
use crate::model::Outcome;
use crate::oci::OciSource;
use crate::paths::ManagedPaths;

pub const RUNTIME_SPEC_SCHEMA_VERSION: &str = "mottainai.host-bootstrap.lima-runtime-spec.v1";
const RUNTIME_STATE_SCHEMA_VERSION: &str = "mottainai.host-bootstrap.lima-runtime-state.v1";
const MAX_MOUNTS: usize = 8;
const MAX_NAME_LENGTH: usize = 63;
const MAX_PATH_LENGTH: usize = 4096;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const CREATE_START_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_COMMAND_OUTPUT: usize = 64 * 1024;

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
        mount_type: "none",
        mounts: spec
            .mounts
            .iter()
            .map(|mount| LimaMount {
                location: &mount.host_path,
                mount_point: &mount.guest_path,
                writable: mount.writable,
            })
            .collect(),
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
    serde_yaml::to_string(&config).expect("supported Lima configuration is serializable")
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
#[serde(rename_all = "camelCase")]
struct LimaSsh {
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
}

pub struct SystemLimaCli {
    pub binary_path: PathBuf,
    pub lima_home: PathBuf,
}

impl SystemLimaCli {
    fn run(&self, arguments: &[&str], timeout: Duration) -> Result<String, BootstrapError> {
        let mut child = Command::new(&self.binary_path)
            .args(arguments)
            .env("LIMA_HOME", &self.lima_home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                BootstrapError::new(
                    ErrorCode::LimaCommandFailed,
                    format!("could not execute limactl: {error}"),
                )
            })?;
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(BootstrapError::new(
                        ErrorCode::LimaCommandFailed,
                        "limactl command timed out",
                    ));
                }
                Err(error) => {
                    return Err(BootstrapError::new(
                        ErrorCode::LimaCommandFailed,
                        format!("could not wait for limactl: {error}"),
                    ))
                }
            }
        }
        let output = child.wait_with_output().map_err(|error| {
            BootstrapError::new(
                ErrorCode::LimaCommandFailed,
                format!("could not collect limactl output: {error}"),
            )
        })?;
        let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
        if !output.status.success() {
            combined.push('\n');
            combined.push_str(&String::from_utf8_lossy(&output.stderr));
            let bounded: String = combined.chars().take(MAX_COMMAND_OUTPUT).collect();
            return Err(BootstrapError::new(
                ErrorCode::LimaCommandFailed,
                format!("limactl {} failed: {bounded}", arguments.join(" ")),
            ));
        }
        Ok(combined.chars().take(MAX_COMMAND_OUTPUT).collect())
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
        let mut arguments = vec!["--tty=false", "shell", instance, "--"];
        arguments.extend_from_slice(command);
        self.run(&arguments, COMMAND_TIMEOUT)
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

    let raw_path = match ensure_appliance(paths, &spec.appliance, oci) {
        Ok(path) => path,
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
        state.appliance_digest == spec.appliance.digest
            && state.config_identity_sha256 == desired_identity
    });

    let start_needed = match &existing {
        None => {
            // Missing: no ambient adoption. Record intent before mutating
            // Lima so an interruption before `start` completes is safely
            // recognized and resumed on the next ensure, without treating
            // this as recreation.
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
                Some("Running") => false,
                Some("Stopped") => true,
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

    evidence.result = if evidence.changed {
        Outcome::Changed
    } else {
        Outcome::NoOp
    };
    evidence
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
/// (`docs/linux-runtime-contract.md`) — `contractId`, `schemaVersion`,
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

    use tempfile::TempDir;

    use super::*;
    use crate::error::ErrorCode;
    use crate::oci::OciSource;
    use crate::paths::ManagedPaths;

    #[derive(Clone, Debug)]
    struct FakeInstance {
        status: String,
        vm_type: Option<String>,
    }

    struct FakeLimaCli {
        instances: RefCell<HashMap<String, FakeInstance>>,
        create_calls: RefCell<u32>,
        start_calls: RefCell<u32>,
        shell_calls: RefCell<u32>,
    }

    impl FakeLimaCli {
        fn new() -> Self {
            Self {
                instances: RefCell::new(HashMap::new()),
                create_calls: RefCell::new(0),
                start_calls: RefCell::new(0),
                shell_calls: RefCell::new(0),
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

        fn shell(&self, _instance: &str, _command: &[&str]) -> Result<String, BootstrapError> {
            *self.shell_calls.borrow_mut() += 1;
            // Shaped exactly like `mottainai-runtime-health`'s real
            // schema-2 output (`nix/modules/runtime.nix`'s `healthScript`)
            // for a fresh bootstrap-only appliance: bootstrapReady is true,
            // no managed generation exists yet.
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

    fn managed_paths() -> (TempDir, ManagedPaths) {
        let temp = TempDir::new().unwrap();
        let paths = ManagedPaths::new(temp.path().join("state"));
        crate::paths::ensure_managed_directories(&paths).unwrap();
        (temp, paths)
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
        let parsed: serde_yaml::Value = serde_yaml::from_str(&rendered).unwrap();

        assert!(rendered.contains("vmType: qemu"));
        assert!(rendered.contains("mounts: []"));
        assert!(!rendered.contains("cloud-init"));
        assert_eq!(
            parsed["images"][0]["location"].as_str(),
            Some("/tmp/appliance.raw")
        );
        assert_eq!(parsed["mounts"].as_sequence().unwrap().len(), 0);
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
        let parsed: serde_yaml::Value = serde_yaml::from_str(&rendered).unwrap();

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
}
