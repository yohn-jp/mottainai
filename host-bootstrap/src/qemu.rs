use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};

use crate::download::digest_file;
use crate::error::{bound_text, BootstrapError, ErrorCode};
use crate::model::{Classification, QemuIdentity, QemuRequirement};
use crate::paths::{display_path, ManagedPaths};

pub const QEMU_CONTRACT_SCHEMA_VERSION: &str = "mottainai.host-bootstrap.qemu.v1";
pub const QEMU_SYSTEM_EXECUTABLE: &str = "qemu-system-x86_64";
pub const QEMU_IMAGE_EXECUTABLE: &str = "qemu-img";
pub const QEMU_MINIMUM_VERSION: &str = "8.2.0";
pub const QEMU_SUPPORTED_VERSION: &str = "11.0.0";

const QEMU_RELEASE_TAG: &str = "11.0.0.1";
const QEMU_SYSTEM_ARCHIVE_SHA256: &str =
    "31399af8d874176f104679c6aae8c8741bcd86283dbc8de1fce8a140f67f1448";
const QEMU_IMAGE_ARCHIVE_SHA256: &str =
    "4cab6e3f186ec6c500dd340f84b794f8320e3d58a2b2b9d2f835416589279d3e";
const QEMU_RELEASE_BASE: &str =
    "https://github.com/hermeticbuild/qemu-prebuilt/releases/download/11.0.0.1";

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_COMMAND_OUTPUT: usize = 16 * 1024;

/// Immutable relocatable QEMU artifacts selected for the supported profile.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct QemuArtifact {
    pub artifact_id: String,
    pub artifact_url: String,
    pub artifact_sha256: String,
    pub archive_binary_path: String,
    pub max_artifact_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct QemuContract {
    pub schema_version: String,
    pub version: String,
    pub system: QemuArtifact,
    pub image: QemuArtifact,
    pub data: QemuDataArtifact,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct QemuDataArtifact {
    pub artifact_id: String,
    pub artifact_url: String,
    pub artifact_sha256: String,
    pub max_artifact_bytes: u64,
}

impl Default for QemuContract {
    fn default() -> Self {
        Self {
            schema_version: QEMU_CONTRACT_SCHEMA_VERSION.to_owned(),
            version: QEMU_SUPPORTED_VERSION.to_owned(),
            system: QemuArtifact {
                artifact_id: format!("qemu-system-bin-linux-amd64-x86_64-softmmu-{QEMU_RELEASE_TAG}"),
                artifact_url: format!("{QEMU_RELEASE_BASE}/qemu-system-bin-linux-amd64-x86_64-softmmu-{QEMU_RELEASE_TAG}.tar.gz"),
                artifact_sha256: QEMU_SYSTEM_ARCHIVE_SHA256.to_owned(),
                archive_binary_path: "bin/qemu-system-x86_64".to_owned(),
                max_artifact_bytes: 64 * 1024 * 1024,
            },
            image: QemuArtifact {
                artifact_id: format!("qemu-img-linux-amd64-{QEMU_RELEASE_TAG}"),
                artifact_url: format!("{QEMU_RELEASE_BASE}/qemu-img-linux-amd64-{QEMU_RELEASE_TAG}.tar.gz"),
                artifact_sha256: QEMU_IMAGE_ARCHIVE_SHA256.to_owned(),
                archive_binary_path: "bin/qemu-img".to_owned(),
                max_artifact_bytes: 64 * 1024 * 1024,
            },
            data: QemuDataArtifact {
                artifact_id: format!("qemu-system-data-linux-amd64-{QEMU_RELEASE_TAG}"),
                artifact_url: format!("{QEMU_RELEASE_BASE}/qemu-system-data-linux-amd64-{QEMU_RELEASE_TAG}.tar.gz"),
                artifact_sha256: "27e5a04a32d56783ebf8277140ec52304dd2376f97a1c01c36982bd228f37cfc".to_owned(),
                max_artifact_bytes: 64 * 1024 * 1024,
            },
        }
    }
}

impl QemuContract {
    pub fn validate(&self) -> Result<(), BootstrapError> {
        if self.schema_version != QEMU_CONTRACT_SCHEMA_VERSION
            || self.version != QEMU_SUPPORTED_VERSION
            || !valid_qemu_artifact(&self.system, QEMU_SYSTEM_EXECUTABLE)
            || !valid_qemu_artifact(&self.image, QEMU_IMAGE_EXECUTABLE)
            || !valid_qemu_data_artifact(&self.data)
        {
            return Err(BootstrapError::new(
                ErrorCode::ContractInvalid,
                "QEMU contract is not the explicit supported Linux x86_64 toolchain",
            ));
        }
        Ok(())
    }
}

fn valid_qemu_data_artifact(artifact: &QemuDataArtifact) -> bool {
    let digest_valid = artifact.artifact_sha256.len() == 64
        && artifact
            .artifact_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        && artifact.artifact_sha256 == artifact.artifact_sha256.to_ascii_lowercase();
    let id_valid = !artifact.artifact_id.is_empty()
        && artifact.artifact_id.len() <= 160
        && artifact.artifact_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        });
    digest_valid
        && id_valid
        && artifact.max_artifact_bytes > 0
        && artifact.max_artifact_bytes <= 256 * 1024 * 1024
        && artifact
            .artifact_url
            .starts_with("https://github.com/hermeticbuild/qemu-prebuilt/")
}

fn valid_qemu_artifact(artifact: &QemuArtifact, executable: &str) -> bool {
    let digest_valid = artifact.artifact_sha256.len() == 64
        && artifact
            .artifact_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        && artifact.artifact_sha256 == artifact.artifact_sha256.to_ascii_lowercase();
    let path = Path::new(&artifact.archive_binary_path);
    let id_valid = !artifact.artifact_id.is_empty()
        && artifact.artifact_id.len() <= 160
        && artifact.artifact_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        });
    digest_valid
        && id_valid
        && artifact.max_artifact_bytes > 0
        && artifact.max_artifact_bytes <= 256 * 1024 * 1024
        && artifact
            .artifact_url
            .starts_with("https://github.com/hermeticbuild/qemu-prebuilt/")
        && path.is_relative()
        && !artifact.archive_binary_path.is_empty()
        && !artifact.archive_binary_path.contains('\\')
        && !artifact
            .archive_binary_path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && artifact.archive_binary_path == format!("bin/{executable}")
}

pub trait QemuArtifactSource {
    fn download(&self, artifact: &QemuArtifact, destination: &Path) -> Result<(), BootstrapError>;

    fn download_data(
        &self,
        artifact: &QemuDataArtifact,
        destination: &Path,
    ) -> Result<(), BootstrapError> {
        let _ = (artifact, destination);
        Err(BootstrapError::new(
            ErrorCode::DownloadFailed,
            "QEMU data artifact source is unavailable",
        ))
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct HttpQemuArtifactSource;

impl QemuArtifactSource for HttpQemuArtifactSource {
    fn download(&self, artifact: &QemuArtifact, destination: &Path) -> Result<(), BootstrapError> {
        download_http_qemu_artifact(
            &artifact.artifact_url,
            artifact.max_artifact_bytes,
            destination,
        )
    }

    fn download_data(
        &self,
        artifact: &QemuDataArtifact,
        destination: &Path,
    ) -> Result<(), BootstrapError> {
        download_http_qemu_artifact(
            &artifact.artifact_url,
            artifact.max_artifact_bytes,
            destination,
        )
    }
}

fn download_http_qemu_artifact(
    url: &str,
    max_artifact_bytes: u64,
    destination: &Path,
) -> Result<(), BootstrapError> {
    let timeout = Duration::from_secs(300);
    let client = Client::builder()
        .connect_timeout(timeout.min(Duration::from_secs(30)))
        .timeout(timeout)
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.stop();
            }
            match attempt.url().host_str() {
                Some(
                    "github.com"
                    | "objects.githubusercontent.com"
                    | "release-assets.githubusercontent.com",
                ) => attempt.follow(),
                _ => attempt.stop(),
            }
        }))
        .build()
        .map_err(|error| {
            BootstrapError::new(
                ErrorCode::DownloadFailed,
                format!("create QEMU HTTPS client: {error}"),
            )
        })?;
    let mut response = client.get(url).send().map_err(|error| {
        BootstrapError::new(
            ErrorCode::DownloadFailed,
            format!("download QEMU artifact: {error}"),
        )
    })?;
    if !response.status().is_success() {
        return Err(BootstrapError::new(
            ErrorCode::DownloadFailed,
            format!("QEMU artifact returned HTTP {}", response.status().as_u16()),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_artifact_bytes)
    {
        return Err(BootstrapError::new(
            ErrorCode::DownloadFailed,
            "QEMU artifact exceeds the configured download size bound",
        ));
    }
    write_bounded(&mut response, destination, max_artifact_bytes)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct UnavailableQemuArtifactSource;

impl QemuArtifactSource for UnavailableQemuArtifactSource {
    fn download(
        &self,
        _artifact: &QemuArtifact,
        _destination: &Path,
    ) -> Result<(), BootstrapError> {
        Err(BootstrapError::new(
            ErrorCode::QemuMissing,
            "supported QEMU is absent and automatic provisioning is unavailable; install the pinned QEMU host toolchain or rerun with an explicit --qemu-path",
        ))
    }

    fn download_data(
        &self,
        _artifact: &QemuDataArtifact,
        _destination: &Path,
    ) -> Result<(), BootstrapError> {
        Err(BootstrapError::new(
            ErrorCode::QemuMissing,
            "supported QEMU data is absent and automatic provisioning is unavailable; install the pinned QEMU host toolchain or rerun with an explicit --qemu-path",
        ))
    }
}

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
    /// The selected Route 4 descriptor QEMU profile identity, when this
    /// state was materialized from a release-bound provider requirement.
    /// Legacy/default-mode state remains representable and can be migrated
    /// only after its complete stored artifact provenance is re-verified.
    #[serde(default)]
    pub provider_identity: Option<String>,
    /// A profile identity kind change is not interchangeable with the
    /// selected release's attested provider profile.
    #[serde(default)]
    pub provider_identity_kind: Option<String>,
    #[serde(default)]
    pub provisioning: Option<QemuProvisioningState>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct QemuProvisioningState {
    pub contract_schema_version: String,
    pub system_artifact_id: String,
    pub system_artifact_sha256: String,
    pub image_artifact_id: String,
    pub image_artifact_sha256: String,
    pub data_artifact_id: String,
    pub data_artifact_sha256: String,
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
    let provisioning_is_valid = state.as_ref().is_none_or(|value| {
        value.provisioning.as_ref().is_none_or(|provenance| {
            provenance.contract_schema_version == QEMU_CONTRACT_SCHEMA_VERSION
                && !provenance.system_artifact_id.is_empty()
                && !provenance.image_artifact_id.is_empty()
                && !provenance.data_artifact_id.is_empty()
                && provenance.system_artifact_sha256.len() == 64
                && provenance.image_artifact_sha256.len() == 64
                && provenance.data_artifact_sha256.len() == 64
                && is_managed_qemu_path(paths, Path::new(&value.system_path))
                && is_managed_qemu_path(paths, Path::new(&value.image_path))
        })
    });
    let matches_state = state.as_ref().is_some_and(|value| {
        value.schema_version == QEMU_CONTRACT_SCHEMA_VERSION
            && value.host_os == host_os
            && value.host_architecture == host_architecture
            && value.identity() == identity
            && provisioning_is_valid
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
        provider_identity: None,
        provider_identity_kind: None,
        provisioning: None,
    };
    write_state(&paths.qemu_state_file, &state)
}

/// Downloads, verifies, and atomically activates the pinned QEMU system and
/// image tools. Both archives are staged before either executable is trusted;
/// an interrupted run therefore leaves no partially trusted active state.
pub fn ensure_provisioned_qemu<S: QemuArtifactSource>(
    paths: &ManagedPaths,
    contract: &QemuContract,
    source: &S,
    host_os: &str,
    host_architecture: &str,
) -> Result<QemuIdentity, BootstrapError> {
    contract.validate()?;
    if host_os != "linux" || host_architecture != "x86_64" {
        return Err(BootstrapError::new(
            ErrorCode::UnsupportedHostProfile,
            "automatic QEMU provisioning supports Linux x86_64 only",
        ));
    }
    crate::paths::ensure_managed_directories(paths)?;
    if paths.qemu_staging_directory.exists() {
        fs::remove_dir_all(&paths.qemu_staging_directory)
            .map_err(|error| BootstrapError::io("remove interrupted QEMU staging", &error))?;
    }

    ensure_qemu_archive(paths, &contract.system, source)?;
    ensure_qemu_archive(paths, &contract.image, source)?;
    ensure_qemu_data_archive(paths, &contract.data, source)?;

    let version_directory = paths.qemu_directory.join(&contract.version);
    let version_directory_exists = match fs::symlink_metadata(&version_directory) {
        Ok(metadata) if metadata.file_type().is_dir() => true,
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(BootstrapError::new(
                ErrorCode::QemuStateAmbiguous,
                "managed QEMU version directory is a symbolic link",
            ));
        }
        Ok(_) => {
            return Err(BootstrapError::new(
                ErrorCode::QemuStateAmbiguous,
                "managed QEMU version path is not a directory",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(BootstrapError::io("inspect managed QEMU version", &error)),
    };
    if version_directory_exists {
        let system = version_directory.join(&contract.system.archive_binary_path);
        let image = version_directory.join(&contract.image.archive_binary_path);
        verify_qemu_data_directory(&version_directory)?;
        let observed = verify_provisioned_binaries(&system, &image, contract)?;
        write_provisioned_state(paths, contract, &observed, host_os, host_architecture)?;
        return Ok(observed);
    }

    fs::create_dir_all(&paths.qemu_staging_directory)
        .map_err(|error| BootstrapError::io("create QEMU staging directory", &error))?;
    extract_qemu_archive(
        &paths.qemu_archive_path(&contract.system.artifact_id),
        &paths.qemu_staging_directory,
        &contract.system,
    )?;
    extract_qemu_archive(
        &paths.qemu_archive_path(&contract.image.artifact_id),
        &paths.qemu_staging_directory,
        &contract.image,
    )?;
    extract_qemu_data_archive(
        &paths.qemu_archive_path(&contract.data.artifact_id),
        &paths.qemu_staging_directory,
    )?;
    let staged_system = paths
        .qemu_staging_directory
        .join(&contract.system.archive_binary_path);
    let staged_image = paths
        .qemu_staging_directory
        .join(&contract.image.archive_binary_path);
    verify_provisioned_binaries(&staged_system, &staged_image, contract)?;

    if fs::symlink_metadata(&version_directory).is_ok() {
        return Err(BootstrapError::new(
            ErrorCode::QemuStateAmbiguous,
            "QEMU version directory appeared during provisioning; activation is refused",
        ));
    }
    fs::rename(&paths.qemu_staging_directory, &version_directory)
        .map_err(|error| BootstrapError::io("activate verified QEMU toolchain", &error))?;
    let system = version_directory.join(&contract.system.archive_binary_path);
    let image = version_directory.join(&contract.image.archive_binary_path);
    let activated = verify_provisioned_binaries(&system, &image, contract)?;
    write_provisioned_state(paths, contract, &activated, host_os, host_architecture)?;
    Ok(activated)
}

fn ensure_qemu_data_archive<S: QemuArtifactSource>(
    paths: &ManagedPaths,
    artifact: &QemuDataArtifact,
    source: &S,
) -> Result<(), BootstrapError> {
    let archive_path = paths.qemu_archive_path(&artifact.artifact_id);
    if verify_qemu_data_archive(&archive_path, artifact).is_ok() {
        return Ok(());
    }
    if archive_path.exists() {
        fs::remove_file(&archive_path)
            .map_err(|error| BootstrapError::io("remove unverifiable QEMU data archive", &error))?;
    }
    let partial = archive_path.with_extension("tar.gz.part");
    if partial.exists() {
        fs::remove_file(&partial)
            .map_err(|error| BootstrapError::io("remove interrupted QEMU data download", &error))?;
    }
    source
        .download_data(artifact, &partial)
        .map_err(provisioning_error)?;
    if let Err(error) = verify_qemu_data_archive(&partial, artifact) {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    fs::rename(&partial, &archive_path)
        .map_err(|error| BootstrapError::io("promote verified QEMU data archive", &error))?;
    Ok(())
}

fn verify_qemu_data_archive(
    path: &Path,
    artifact: &QemuDataArtifact,
) -> Result<(), BootstrapError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        BootstrapError::new(
            ErrorCode::QemuIncompatible,
            format!("inspect QEMU data archive: {error}"),
        )
    })?;
    if !metadata.file_type().is_file() || metadata.len() > artifact.max_artifact_bytes {
        return Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "QEMU data archive is not a regular file within the size bound",
        ));
    }
    let digest = digest_file(path)?;
    if digest != artifact.artifact_sha256 {
        return Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            format!(
                "QEMU data archive digest mismatch: expected {}",
                artifact.artifact_sha256
            ),
        ));
    }
    Ok(())
}

fn ensure_qemu_archive<S: QemuArtifactSource>(
    paths: &ManagedPaths,
    artifact: &QemuArtifact,
    source: &S,
) -> Result<(), BootstrapError> {
    let archive_path = paths.qemu_archive_path(&artifact.artifact_id);
    if verify_qemu_archive(&archive_path, artifact).is_ok() {
        return Ok(());
    }
    if archive_path.exists() {
        fs::remove_file(&archive_path)
            .map_err(|error| BootstrapError::io("remove unverifiable QEMU archive", &error))?;
    }
    let partial = archive_path.with_extension("tar.gz.part");
    if partial.exists() {
        fs::remove_file(&partial)
            .map_err(|error| BootstrapError::io("remove interrupted QEMU download", &error))?;
    }
    source
        .download(artifact, &partial)
        .map_err(provisioning_error)?;
    if let Err(error) = verify_qemu_archive(&partial, artifact) {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    fs::rename(&partial, &archive_path)
        .map_err(|error| BootstrapError::io("promote verified QEMU archive", &error))?;
    Ok(())
}

fn verify_qemu_archive(path: &Path, artifact: &QemuArtifact) -> Result<(), BootstrapError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        BootstrapError::new(
            ErrorCode::QemuIncompatible,
            format!("inspect QEMU archive: {error}"),
        )
    })?;
    if !metadata.file_type().is_file() || metadata.len() > artifact.max_artifact_bytes {
        return Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "QEMU archive is not a regular file within the size bound",
        ));
    }
    let digest = digest_file(path)?;
    if digest != artifact.artifact_sha256 {
        return Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            format!(
                "QEMU archive digest mismatch: expected {}",
                artifact.artifact_sha256
            ),
        ));
    }
    Ok(())
}

fn provisioning_error(error: BootstrapError) -> BootstrapError {
    BootstrapError::new(
        error.code,
        format!(
            "automatic QEMU provisioning unavailable: {}; install the pinned QEMU host toolchain or rerun with an explicit --qemu-path",
            error.message
        ),
    )
}

fn extract_qemu_archive(
    archive_path: &Path,
    destination: &Path,
    artifact: &QemuArtifact,
) -> Result<(), BootstrapError> {
    let file = File::open(archive_path)
        .map_err(|error| BootstrapError::io("open verified QEMU archive", &error))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| {
        BootstrapError::new(
            ErrorCode::QemuIncompatible,
            format!("read QEMU archive: {error}"),
        )
    })?;
    let mut extracted = false;
    for entry in entries {
        let mut entry = entry.map_err(|error| {
            BootstrapError::new(
                ErrorCode::QemuIncompatible,
                format!("read QEMU archive entry: {error}"),
            )
        })?;
        let raw = entry.path().map_err(|error| {
            BootstrapError::new(
                ErrorCode::QemuIncompatible,
                format!("read QEMU archive path: {error}"),
            )
        })?;
        let relative = normalize_archive_path(&raw).ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::QemuIncompatible,
                "QEMU archive contains an absolute or parent-traversing path",
            )
        })?;
        if relative == Path::new(&artifact.archive_binary_path) {
            if extracted || !entry.header().entry_type().is_file() || entry.size() == 0 {
                return Err(BootstrapError::new(
                    ErrorCode::QemuIncompatible,
                    "QEMU archive executable is duplicated, empty, or not a regular file",
                ));
            }
            let target = destination.join(&relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    BootstrapError::io("create QEMU executable directory", &error)
                })?;
            }
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&target)
                .map_err(|error| BootstrapError::io("extract QEMU executable", &error))?;
            io::copy(&mut entry, &mut output)
                .map_err(|error| BootstrapError::io("write QEMU executable", &error))?;
            output
                .sync_all()
                .map_err(|error| BootstrapError::io("sync QEMU executable", &error))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(0o755))
                    .map_err(|error| BootstrapError::io("set QEMU executable mode", &error))?;
            }
            extracted = true;
        } else if entry.header().entry_type().is_symlink() {
            // The selected QEMU artifacts contain no required symlinks. Reject
            // them rather than allowing links to escape the staged closure.
            return Err(BootstrapError::new(
                ErrorCode::QemuIncompatible,
                "QEMU archive contains an unsupported symbolic link",
            ));
        }
    }
    if !extracted {
        return Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "QEMU archive does not contain the declared executable",
        ));
    }
    Ok(())
}

fn extract_qemu_data_archive(
    archive_path: &Path,
    destination: &Path,
) -> Result<(), BootstrapError> {
    const MAX_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
    let file = File::open(archive_path)
        .map_err(|error| BootstrapError::io("open verified QEMU data archive", &error))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| {
        BootstrapError::new(
            ErrorCode::QemuIncompatible,
            format!("read QEMU data archive: {error}"),
        )
    })?;
    let mut extracted_bytes = 0_u64;
    for entry in entries {
        let mut entry = entry.map_err(|error| {
            BootstrapError::new(
                ErrorCode::QemuIncompatible,
                format!("read QEMU data archive entry: {error}"),
            )
        })?;
        let raw = entry.path().map_err(|error| {
            BootstrapError::new(
                ErrorCode::QemuIncompatible,
                format!("read QEMU data archive path: {error}"),
            )
        })?;
        let relative = normalize_archive_path(&raw).ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::QemuIncompatible,
                "QEMU data archive contains an absolute or parent-traversing path",
            )
        })?;
        let target = destination.join(&relative);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&target)
                .map_err(|error| BootstrapError::io("create QEMU data directory", &error))?;
            continue;
        }
        if !entry.header().entry_type().is_file() || entry.size() == 0 {
            return Err(BootstrapError::new(
                ErrorCode::QemuIncompatible,
                "QEMU data archive contains a non-regular or empty entry",
            ));
        }
        extracted_bytes = extracted_bytes.checked_add(entry.size()).ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::QemuIncompatible,
                "QEMU data archive extracted-size overflow",
            )
        })?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err(BootstrapError::new(
                ErrorCode::QemuIncompatible,
                "QEMU data archive exceeds the extracted-size bound",
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| BootstrapError::io("create QEMU data parent", &error))?;
        }
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)
            .map_err(|error| BootstrapError::io("extract QEMU data file", &error))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| BootstrapError::io("write QEMU data file", &error))?;
        output
            .sync_all()
            .map_err(|error| BootstrapError::io("sync QEMU data file", &error))?;
    }
    verify_qemu_data_directory(destination)
}

fn verify_qemu_data_directory(directory: &Path) -> Result<(), BootstrapError> {
    let firmware = directory.join("share/qemu/edk2-x86_64-code.fd");
    let metadata = fs::symlink_metadata(&firmware).map_err(|error| {
        BootstrapError::new(
            ErrorCode::QemuIncompatible,
            format!("managed QEMU firmware is unavailable: {error}"),
        )
    })?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "managed QEMU firmware is not a regular non-empty file",
        ));
    }
    Ok(())
}

fn verify_provisioned_binaries(
    system: &Path,
    image: &Path,
    contract: &QemuContract,
) -> Result<QemuIdentity, BootstrapError> {
    let system_probe = probe_binary(system, true)
        .map_err(|message| BootstrapError::new(ErrorCode::QemuIncompatible, message))?;
    let image_probe = probe_binary(image, false)
        .map_err(|message| BootstrapError::new(ErrorCode::QemuIncompatible, message))?;
    if system_probe.version != contract.version || image_probe.version != contract.version {
        return Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "provisioned QEMU reports a version different from the pinned contract",
        ));
    }
    if system_probe.version != image_probe.version {
        return Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "provisioned QEMU executables report different versions",
        ));
    }
    Ok(QemuIdentity {
        system_path: canonical_path(system),
        system_sha256: system_probe.sha256,
        image_path: canonical_path(image),
        image_sha256: image_probe.sha256,
        version: system_probe.version,
    })
}

fn write_provisioned_state(
    paths: &ManagedPaths,
    contract: &QemuContract,
    identity: &QemuIdentity,
    host_os: &str,
    host_architecture: &str,
) -> Result<(), BootstrapError> {
    let state = QemuState {
        schema_version: QEMU_CONTRACT_SCHEMA_VERSION.to_owned(),
        system_path: identity.system_path.clone(),
        system_sha256: identity.system_sha256.clone(),
        image_path: identity.image_path.clone(),
        image_sha256: identity.image_sha256.clone(),
        version: identity.version.clone(),
        host_os: host_os.to_owned(),
        host_architecture: host_architecture.to_owned(),
        provider_identity: None,
        provider_identity_kind: None,
        provisioning: Some(QemuProvisioningState {
            contract_schema_version: QEMU_CONTRACT_SCHEMA_VERSION.to_owned(),
            system_artifact_id: contract.system.artifact_id.clone(),
            system_artifact_sha256: contract.system.artifact_sha256.clone(),
            image_artifact_id: contract.image.artifact_id.clone(),
            image_artifact_sha256: contract.image.artifact_sha256.clone(),
            data_artifact_id: contract.data.artifact_id.clone(),
            data_artifact_sha256: contract.data.artifact_sha256.clone(),
        }),
    };
    write_state(&paths.qemu_state_file, &state)
}

/// Attests the exact descriptor QEMU profile identity after the verified
/// artifact closure has been materialized. The identity is carried through,
/// never recomputed from artifact fields.
pub fn attest_provider_profile(
    paths: &ManagedPaths,
    provider_identity: &str,
    provider_identity_kind: &str,
) -> Result<(), BootstrapError> {
    let mut state = read_state(&paths.qemu_state_file)?.ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::QemuStateAmbiguous,
            "cannot attest a QEMU provider profile without managed QEMU state",
        )
    })?;
    match (
        state.provider_identity.as_deref(),
        state.provider_identity_kind.as_deref(),
    ) {
        (None, None) => {}
        (Some(identity), Some(identity_kind))
            if identity == provider_identity && identity_kind == provider_identity_kind =>
        {
            return Ok(())
        }
        (None, Some(_)) | (Some(_), None) => {
            return Err(BootstrapError::new(
                ErrorCode::QemuIncompatible,
                "managed QEMU provider profile attestation is incomplete",
            ))
        }
        _ => {
            return Err(BootstrapError::new(
                ErrorCode::QemuIncompatible,
                "managed QEMU provider profile attestation cannot be overwritten",
            ))
        }
    }
    state.provider_identity = Some(provider_identity.to_owned());
    state.provider_identity_kind = Some(provider_identity_kind.to_owned());
    write_state(&paths.qemu_state_file, &state)
}

pub fn error_for_observation(observation: &QemuObservation) -> BootstrapError {
    classification_error(observation)
}

pub fn managed_qemu_system_path(paths: &ManagedPaths) -> Result<PathBuf, BootstrapError> {
    let state = read_state(&paths.qemu_state_file)?.ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::QemuMissing,
            "managed QEMU prerequisite state is missing",
        )
    })?;
    Ok(PathBuf::from(state.system_path))
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

fn is_managed_qemu_path(paths: &ManagedPaths, path: &Path) -> bool {
    let Ok(path) = fs::canonicalize(path) else {
        return false;
    };
    let Ok(root) = fs::canonicalize(&paths.qemu_directory) else {
        return false;
    };
    path.starts_with(root)
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

fn normalize_archive_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => return None,
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => return None,
            std::path::Component::Normal(value) => normalized.push(value),
        }
    }
    Some(normalized)
}

fn write_bounded<R: Read>(
    mut source: R,
    destination: &Path,
    maximum: u64,
) -> Result<(), BootstrapError> {
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| BootstrapError::io("create staged QEMU archive", &error))?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = source.read(&mut buffer).map_err(|error| {
            BootstrapError::new(
                ErrorCode::DownloadFailed,
                format!("read QEMU archive: {error}"),
            )
        })?;
        if read == 0 {
            break;
        }
        total = total.checked_add(read as u64).ok_or_else(|| {
            BootstrapError::new(ErrorCode::DownloadFailed, "QEMU archive size overflow")
        })?;
        if total > maximum {
            let _ = fs::remove_file(destination);
            return Err(BootstrapError::new(
                ErrorCode::DownloadFailed,
                "QEMU archive exceeded the configured download size bound",
            ));
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| BootstrapError::io("write staged QEMU archive", &error))?;
    }
    output
        .sync_all()
        .map_err(|error| BootstrapError::io("sync staged QEMU archive", &error))?;
    Ok(())
}
