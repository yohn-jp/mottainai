use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::download::digest_file;
use crate::error::{bound_text, BootstrapError, ErrorCode};
use crate::model::{Classification, QemuIdentity, QemuRequirement};
use crate::paths::{display_path, ManagedPaths};

pub const QEMU_CONTRACT_SCHEMA_VERSION: &str = "mottainai.host-bootstrap.qemu.v1";
pub const QEMU_SYSTEM_EXECUTABLE: &str = "qemu-system-x86_64";
pub const QEMU_IMAGE_EXECUTABLE: &str = "qemu-img";
pub const QEMU_MINIMUM_VERSION: &str = "8.2.0";

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_COMMAND_OUTPUT: usize = 16 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct QemuState {
    pub schema_version: String,
    pub system_path: String,
    pub system_sha256: String,
    pub image_path: String,
    pub image_sha256: String,
    pub version: String,
    pub host_os: String,
    pub host_architecture: String,
}

impl QemuState {
    fn identity(&self) -> QemuIdentity {
        QemuIdentity {
            system_path: self.system_path.clone(),
            system_sha256: self.system_sha256.clone(),
            image_path: self.image_path.clone(),
            image_sha256: self.image_sha256.clone(),
            version: self.version.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QemuObservation {
    pub classification: Classification,
    pub observed_identity: Option<QemuIdentity>,
    pub state: Option<QemuState>,
    pub diagnostic: Option<String>,
}

/// Test seam for the bootstrap's host-tool observation. The CLI never sets it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QemuOverride {
    Missing,
    Identity(QemuIdentity),
    Incompatible(String),
    Ambiguous(String),
}

pub fn requirement() -> QemuRequirement {
    QemuRequirement {
        system_executable: QEMU_SYSTEM_EXECUTABLE.to_owned(),
        image_executable: QEMU_IMAGE_EXECUTABLE.to_owned(),
        minimum_version: QEMU_MINIMUM_VERSION.to_owned(),
        accelerator: "kvm".to_owned(),
    }
}

pub fn inspect_qemu(
    paths: &ManagedPaths,
    configured_path: Option<&Path>,
    environment_path: Option<&OsStr>,
    host_os: &str,
    host_architecture: &str,
) -> Result<QemuObservation, BootstrapError> {
    let state = read_state(&paths.qemu_state_file)?;
    let (system_path, image_path) = if let Some(configured_path) = configured_path {
        (
            Some(canonical_pathbuf(configured_path)),
            configured_path
                .parent()
                .map(|parent| parent.join(QEMU_IMAGE_EXECUTABLE)),
        )
    } else if let Some(state) = &state {
        (
            Some(PathBuf::from(&state.system_path)),
            Some(PathBuf::from(&state.image_path)),
        )
    } else {
        (
            resolve_unique_binary(environment_path, QEMU_SYSTEM_EXECUTABLE)?,
            resolve_unique_binary(environment_path, QEMU_IMAGE_EXECUTABLE)?,
        )
    };

    let Some(system_path) = system_path else {
        return Ok(observation(
            Classification::Missing,
            None,
            state,
            Some("qemu-system-x86_64 is not available on PATH"),
        ));
    };
    let Some(image_path) = image_path else {
        return Ok(observation(
            Classification::Missing,
            None,
            state,
            Some("qemu-img is not available on PATH"),
        ));
    };

    let system_parent = canonical_parent(&system_path);
    let image_parent = canonical_parent(&image_path);
    if system_parent.is_none() || image_parent.is_none() || system_parent != image_parent {
        return Ok(observation(
            Classification::Incompatible,
            None,
            state,
            Some("QEMU system and image tools are not from one proven installation"),
        ));
    }

    let system = match probe_binary(&system_path, true) {
        Ok(probe) => probe,
        Err(message) => {
            return Ok(observation(
                Classification::Incompatible,
                None,
                state,
                Some(&message),
            ))
        }
    };
    let image = match probe_binary(&image_path, false) {
        Ok(probe) => probe,
        Err(message) => {
            return Ok(observation(
                Classification::Incompatible,
                None,
                state,
                Some(&message),
            ))
        }
    };
    if system.version != image.version {
        return Ok(observation(
            Classification::Incompatible,
            None,
            state,
            Some("qemu-system-x86_64 and qemu-img report different versions"),
        ));
    }

    let identity = QemuIdentity {
        system_path: canonical_path(&system_path),
        system_sha256: system.sha256,
        image_path: canonical_path(&image_path),
        image_sha256: image.sha256,
        version: system.version,
    };
    let matches_state = state.as_ref().is_some_and(|value| {
        value.schema_version == QEMU_CONTRACT_SCHEMA_VERSION
            && value.host_os == host_os
            && value.host_architecture == host_architecture
            && value.identity() == identity
    });
    let classification = if state.is_none() {
        Classification::Repairable
    } else if matches_state {
        Classification::Satisfied
    } else {
        return Ok(observation(
            Classification::Ambiguous,
            Some(identity),
            state,
            Some("verified QEMU changed relative to the managed prerequisite state"),
        ));
    };
    Ok(observation(classification, Some(identity), state, None))
}

pub fn inspect_override(
    paths: &ManagedPaths,
    override_value: &QemuOverride,
    host_os: &str,
    host_architecture: &str,
) -> Result<QemuObservation, BootstrapError> {
    let state = read_state(&paths.qemu_state_file)?;
    match override_value {
        QemuOverride::Missing => Ok(observation(
            Classification::Missing,
            None,
            state,
            Some("QEMU prerequisite is missing in the test host observation"),
        )),
        QemuOverride::Incompatible(message) => Ok(observation(
            Classification::Incompatible,
            None,
            state,
            Some(message),
        )),
        QemuOverride::Ambiguous(message) => Ok(observation(
            Classification::Ambiguous,
            None,
            state,
            Some(message),
        )),
        QemuOverride::Identity(identity) => {
            let matches_state = state.as_ref().is_some_and(|value| {
                value.schema_version == QEMU_CONTRACT_SCHEMA_VERSION
                    && value.host_os == host_os
                    && value.host_architecture == host_architecture
                    && value.identity() == *identity
            });
            let classification = if state.is_none() {
                Classification::Repairable
            } else if matches_state {
                Classification::Satisfied
            } else {
                Classification::Ambiguous
            };
            Ok(observation(
                classification,
                Some(identity.clone()),
                state,
                (classification == Classification::Ambiguous)
                    .then_some("verified QEMU changed relative to the managed prerequisite state"),
            ))
        }
    }
}

pub fn ensure_qemu(
    paths: &ManagedPaths,
    observation: &QemuObservation,
    host_os: &str,
    host_architecture: &str,
) -> Result<(), BootstrapError> {
    if observation.classification == Classification::Satisfied {
        return Ok(());
    }
    if observation.classification != Classification::Repairable {
        return Err(classification_error(observation));
    }
    let identity = observation.observed_identity.as_ref().ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::QemuStateAmbiguous,
            "QEMU prerequisite is repairable but has no verified identity",
        )
    })?;
    let state = QemuState {
        schema_version: QEMU_CONTRACT_SCHEMA_VERSION.to_owned(),
        system_path: identity.system_path.clone(),
        system_sha256: identity.system_sha256.clone(),
        image_path: identity.image_path.clone(),
        image_sha256: identity.image_sha256.clone(),
        version: identity.version.clone(),
        host_os: host_os.to_owned(),
        host_architecture: host_architecture.to_owned(),
    };
    write_state(&paths.qemu_state_file, &state)
}

pub fn error_for_observation(observation: &QemuObservation) -> BootstrapError {
    classification_error(observation)
}

fn observation(
    classification: Classification,
    observed_identity: Option<QemuIdentity>,
    state: Option<QemuState>,
    diagnostic: Option<&str>,
) -> QemuObservation {
    QemuObservation {
        classification,
        observed_identity,
        state,
        diagnostic: diagnostic.map(bound_text),
    }
}

fn classification_error(observation: &QemuObservation) -> BootstrapError {
    let code = match observation.classification {
        Classification::Ambiguous => ErrorCode::QemuStateAmbiguous,
        Classification::Incompatible => ErrorCode::QemuIncompatible,
        Classification::Missing => ErrorCode::QemuMissing,
        _ => ErrorCode::QemuIncompatible,
    };
    BootstrapError::new(
        code,
        observation
            .diagnostic
            .as_deref()
            .unwrap_or("QEMU/KVM prerequisite cannot be proven safe"),
    )
}

#[derive(Debug)]
struct BinaryProbe {
    sha256: String,
    version: String,
}

fn probe_binary(path: &Path, require_kvm: bool) -> Result<BinaryProbe, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect QEMU executable: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "QEMU executable is a symbolic link: {}",
            display_path(path)
        ));
    }
    if !metadata.file_type().is_file() || !is_executable(&metadata) {
        return Err(format!(
            "QEMU executable is not a regular executable file: {}",
            display_path(path)
        ));
    }
    verify_x86_64_elf(path)?;
    let sha256 =
        digest_file(path).map_err(|error| format!("could not digest QEMU executable: {error}"))?;
    let version_output = run_command(path, &["--version"])?;
    let version = parse_version(&version_output).ok_or_else(|| {
        format!(
            "QEMU executable did not report a supported version: {}",
            display_path(path)
        )
    })?;
    if compare_versions(&version, QEMU_MINIMUM_VERSION) == std::cmp::Ordering::Less {
        return Err(format!(
            "QEMU version {version} is below the supported minimum {QEMU_MINIMUM_VERSION}"
        ));
    }
    if require_kvm {
        let accelerators = run_command(path, &["-accel", "help"])?;
        if !has_kvm_accelerator(&accelerators) {
            return Err("qemu-system-x86_64 does not advertise the KVM accelerator".to_owned());
        }
    }
    Ok(BinaryProbe { sha256, version })
}

fn verify_x86_64_elf(path: &Path) -> Result<(), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("could not read QEMU executable header: {error}"))?;
    let mut header = [0_u8; 20];
    file.read_exact(&mut header)
        .map_err(|error| format!("QEMU executable is not a complete ELF binary: {error}"))?;
    if &header[..4] != b"\x7fELF" || header[4] != 2 || header[5] != 1 {
        return Err("QEMU executable is not a little-endian 64-bit ELF binary".to_owned());
    }
    if u16::from_le_bytes([header[18], header[19]]) != 62 {
        return Err("QEMU executable is not an x86_64 ELF binary".to_owned());
    }
    Ok(())
}

fn run_command(path: &Path, arguments: &[&str]) -> Result<String, String> {
    let mut child = Command::new(path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not execute {}: {error}", display_path(path)))?;
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "QEMU capability command timed out: {}",
                    display_path(path)
                ));
            }
            Err(error) => return Err(format!("could not wait for QEMU: {error}")),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("could not collect QEMU capability output: {error}"))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    let bounded = combined
        .chars()
        .take(MAX_COMMAND_OUTPUT)
        .collect::<String>();
    if !output.status.success() {
        return Err(format!(
            "QEMU capability command failed for {}",
            display_path(path)
        ));
    }
    Ok(bounded)
}

fn parse_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|token| {
        let token = token
            .trim_start_matches('v')
            .trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.');
        let parts = token.split('.').collect::<Vec<_>>();
        (parts.len() >= 3
            && parts
                .iter()
                .take(3)
                .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())))
        .then(|| parts[..3].join("."))
    })
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |value: &str| {
        value
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    parse(left).cmp(&parse(right))
}

fn has_kvm_accelerator(output: &str) -> bool {
    output.lines().any(|line| {
        line.split_whitespace()
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("kvm"))
    })
}

fn resolve_unique_binary(
    environment_path: Option<&OsStr>,
    executable: &str,
) -> Result<Option<PathBuf>, BootstrapError> {
    let Some(environment_path) = environment_path else {
        return Ok(None);
    };
    let mut matches = Vec::new();
    for entry in std::env::split_paths(environment_path) {
        let directory = if entry.as_os_str().is_empty() {
            std::env::current_dir()
                .map_err(|error| BootstrapError::io("resolve empty PATH entry", &error))?
        } else {
            entry
        };
        let candidate = directory.join(executable);
        if fs::symlink_metadata(&candidate).is_ok() {
            let candidate = canonical_pathbuf(&candidate);
            if !matches.contains(&candidate) {
                matches.push(candidate);
            }
        }
    }
    match matches.as_slice() {
        [] => Ok(None),
        [candidate] => Ok(Some(candidate.clone())),
        _ => Err(BootstrapError::new(
            ErrorCode::QemuStateAmbiguous,
            format!("multiple ambient {executable} binaries were found; none was adopted"),
        )),
    }
}

fn canonical_parent(path: &Path) -> Option<PathBuf> {
    path.parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
}

fn canonical_path(path: &Path) -> String {
    canonical_pathbuf(path).to_string_lossy().into_owned()
}

fn canonical_pathbuf(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn read_state(path: &Path) -> Result<Option<QemuState>, BootstrapError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.file_type().is_file() {
            return Err(BootstrapError::new(
                ErrorCode::QemuStateAmbiguous,
                "managed QEMU prerequisite state is not a regular file",
            ));
        }
    }
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(BootstrapError::io("read managed QEMU state", &error)),
    };
    let mut contents = String::new();
    Read::by_ref(&mut file)
        .take(64 * 1024 + 1)
        .read_to_string(&mut contents)
        .map_err(|error| {
            BootstrapError::new(
                ErrorCode::QemuStateAmbiguous,
                format!("read managed QEMU state: {error}"),
            )
        })?;
    if contents.len() > 64 * 1024 {
        return Err(BootstrapError::new(
            ErrorCode::QemuStateAmbiguous,
            "managed QEMU state exceeds the bounded state size",
        ));
    }
    serde_json::from_str(&contents).map(Some).map_err(|error| {
        BootstrapError::new(
            ErrorCode::QemuStateAmbiguous,
            format!("managed QEMU state is not valid JSON: {error}"),
        )
    })
}

fn write_state(path: &Path, state: &QemuState) -> Result<(), BootstrapError> {
    let temporary = path.with_extension("json.tmp");
    if let Ok(metadata) = fs::symlink_metadata(&temporary) {
        if !metadata.file_type().is_file() {
            return Err(BootstrapError::new(
                ErrorCode::QemuStateAmbiguous,
                "staged QEMU state is not a regular file",
            ));
        }
        fs::remove_file(&temporary)
            .map_err(|error| BootstrapError::io("remove staged QEMU state", &error))?;
    }
    let serialized = serde_json::to_vec_pretty(state).map_err(|error| {
        BootstrapError::new(
            ErrorCode::IoError,
            format!("serialize managed QEMU state: {error}"),
        )
    })?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| BootstrapError::io("create staged QEMU state", &error))?;
    file.write_all(&serialized)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| BootstrapError::io("write staged QEMU state", &error))?;
    fs::rename(&temporary, path)
        .map_err(|error| BootstrapError::io("atomically promote QEMU state", &error))
}

fn is_executable(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        false
    }
}
