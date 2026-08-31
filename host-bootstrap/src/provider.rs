use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::contract::ProviderContract;
use crate::error::{BootstrapError, ErrorCode};
use crate::model::{Classification, ProviderIdentity};
use crate::paths::{display_path, ManagedPaths};

pub use crate::download::{ArtifactSource, FileArtifactSource, HttpArtifactSource};
pub use crate::materialize::ensure_provider;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ManagedState {
    pub schema_version: String,
    pub provider: String,
    pub version: String,
    pub artifact_id: String,
    pub artifact_sha256: String,
    pub active_relative_path: String,
    pub archive_relative_path: String,
    pub managed_binary_sha256: String,
    pub host_os: String,
    pub host_architecture: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderObservation {
    pub classification: Classification,
    pub observed_identity: Option<ProviderIdentity>,
    pub state: Option<ManagedState>,
    pub active_is_expected: bool,
    pub staging_present: bool,
    pub cache_valid: bool,
    pub ambient_paths: Vec<String>,
    pub diagnostic: Option<String>,
}

pub fn inspect_provider(
    paths: &ManagedPaths,
    contract: &ProviderContract,
    environment_path: Option<&std::ffi::OsStr>,
    host_os: &str,
    host_architecture: &str,
) -> Result<ProviderObservation, BootstrapError> {
    let desired_directory = paths.provider_directory(&contract.artifact_id);
    let expected_target = PathBuf::from("providers").join(&contract.artifact_id);
    let state = read_state(&paths.state_file)?;
    let ambient_paths = find_ambient_provider_paths(environment_path)?;
    let staging_present = paths.staging_provider_directory().exists();
    let cache_path = paths.archive_path(&contract.artifact_id);
    let cache_metadata = fs::symlink_metadata(&cache_path).ok();
    let cache_is_regular = cache_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_file());
    let cache_valid =
        cache_is_regular && crate::download::verify_archive(&cache_path, contract).is_ok();
    let cache_exists = cache_metadata.is_some();
    let provider_metadata = fs::symlink_metadata(&desired_directory).ok();
    let provider_is_directory = provider_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_dir());
    let active_metadata = fs::symlink_metadata(&paths.active_link).ok();
    let active_target = if active_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_symlink())
    {
        fs::read_link(&paths.active_link).ok()
    } else {
        None
    };
    let active_exists = active_metadata.is_some();
    let active_is_expected = active_target.as_deref() == Some(expected_target.as_path());
    let binary_path = desired_directory.join(&contract.archive_binary_path);
    let binary_digest = if active_is_expected && provider_is_directory {
        crate::materialize::verified_executable_digest(&binary_path)
            .ok()
            .flatten()
    } else {
        None
    };
    let state_matches = state.as_ref().is_some_and(|value| {
        value.schema_version == crate::contract::CONTRACT_SCHEMA_VERSION
            && value.provider == contract.provider
            && value.version == contract.version
            && value.artifact_id == contract.artifact_id
            && value.artifact_sha256 == contract.artifact_sha256
            && value.active_relative_path == "active"
            && value.archive_relative_path == format!("cache/{}.tar.gz", contract.artifact_id)
            && value.host_os == host_os
            && value.host_architecture == host_architecture
            && binary_digest.as_deref() == Some(value.managed_binary_sha256.as_str())
    });
    let ambient_classification = classify_ambient_paths(&ambient_paths, paths);

    let (classification, diagnostic) = if ambient_classification != Classification::Satisfied {
        (
            ambient_classification,
            Some(if ambient_classification == Classification::Ambiguous {
                "multiple ambient limactl binaries were found; none was adopted".to_owned()
            } else {
                "ambient limactl/provider binary is outside the managed contract; it was not adopted".to_owned()
            }),
        )
    } else if state.is_none()
        && !active_exists
        && !staging_present
        && !cache_exists
        && provider_metadata.is_none()
    {
        (Classification::Missing, None)
    } else if provider_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_symlink())
    {
        (
            Classification::Incompatible,
            Some("managed provider directory is a symlink and cannot be adopted".to_owned()),
        )
    } else if provider_metadata
        .as_ref()
        .is_some_and(|metadata| !metadata.file_type().is_dir())
    {
        (
            Classification::Incompatible,
            Some("managed provider path is not a directory".to_owned()),
        )
    } else if active_exists && !active_is_expected {
        (
            Classification::Incompatible,
            Some("managed active provider is not the exact contract identity".to_owned()),
        )
    } else if state.is_some()
        && !state_matches
        && active_is_expected
        && binary_digest.is_some()
        && cache_valid
    {
        (
            Classification::Ambiguous,
            Some("managed state cannot prove the active provider identity".to_owned()),
        )
    } else if state.is_none() && active_is_expected && binary_digest.is_some() && cache_valid {
        (
            Classification::Repairable,
            Some("active provider is verified but managed state needs recovery".to_owned()),
        )
    } else if active_is_expected && binary_digest.is_some() && cache_valid && state_matches {
        (Classification::Satisfied, None)
    } else if active_is_expected {
        (
            Classification::Incompatible,
            Some(
                "active provider exists but its archive or executable digest cannot be verified"
                    .to_owned(),
            ),
        )
    } else if state.is_some() || staging_present || cache_exists || provider_metadata.is_some() {
        (
            Classification::Repairable,
            Some(
                "incomplete managed provider state can be rebuilt from a clean staging boundary"
                    .to_owned(),
            ),
        )
    } else {
        (Classification::Missing, None)
    };

    let observed_identity = if active_is_expected && binary_digest.is_some() {
        Some(contract.identity(Some(display_path(&binary_path))))
    } else {
        None
    };
    Ok(ProviderObservation {
        classification,
        observed_identity,
        state,
        active_is_expected,
        staging_present,
        cache_valid,
        ambient_paths,
        diagnostic,
    })
}

pub(crate) fn read_state(path: &Path) -> Result<Option<ManagedState>, BootstrapError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.file_type().is_file() {
            return Err(BootstrapError::new(
                ErrorCode::ProviderStateAmbiguous,
                "managed bootstrap state is not a regular file",
            ));
        }
    }
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(BootstrapError::io("read managed bootstrap state", &error)),
    };
    let mut contents = String::new();
    file.take(64 * 1024 + 1)
        .read_to_string(&mut contents)
        .map_err(|error| {
            BootstrapError::new(
                ErrorCode::ProviderStateAmbiguous,
                format!("read managed bootstrap state: {error}"),
            )
        })?;
    if contents.len() > 64 * 1024 {
        return Err(BootstrapError::new(
            ErrorCode::ProviderStateAmbiguous,
            "managed bootstrap state exceeds the bounded state size",
        ));
    }
    serde_json::from_str(&contents).map(Some).map_err(|error| {
        BootstrapError::new(
            ErrorCode::ProviderStateAmbiguous,
            format!("managed bootstrap state is not valid JSON: {error}"),
        )
    })
}

fn find_ambient_provider_paths(
    environment_path: Option<&std::ffi::OsStr>,
) -> Result<Vec<String>, BootstrapError> {
    let Some(environment_path) = environment_path else {
        return Ok(Vec::new());
    };
    let mut matches = Vec::new();
    for entry in std::env::split_paths(environment_path) {
        let directory = if entry.as_os_str().is_empty() {
            std::env::current_dir()
                .map_err(|error| BootstrapError::io("resolve empty PATH entry", &error))?
        } else {
            entry
        };
        let candidate = directory.join("limactl");
        let metadata = match fs::metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(BootstrapError::io("inspect ambient limactl path", &error)),
        };
        if metadata.file_type().is_file() && crate::materialize::is_executable(&metadata) {
            matches.push(display_path(&candidate));
        }
    }
    Ok(matches)
}

fn classify_ambient_paths(paths: &[String], managed: &ManagedPaths) -> Classification {
    if paths.is_empty() {
        return Classification::Satisfied;
    }
    if paths.len() > 1 {
        return Classification::Ambiguous;
    }
    let candidate = Path::new(&paths[0]);
    let expected = managed.active_link.join("bin/limactl");
    match (fs::canonicalize(candidate), fs::canonicalize(expected)) {
        (Ok(candidate), Ok(expected)) if candidate == expected => Classification::Satisfied,
        (Ok(_), _) => Classification::Incompatible,
        _ => Classification::Ambiguous,
    }
}
