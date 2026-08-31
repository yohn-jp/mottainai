use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use tar::Archive;

use crate::contract::ProviderContract;
use crate::download::{digest_file, verify_archive, ArtifactSource};
use crate::error::{BootstrapError, ErrorCode};
use crate::model::Classification;
use crate::paths::{ensure_managed_directories, ManagedPaths};
use crate::provider::{inspect_provider, ManagedState, ProviderObservation};

const MAX_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;

pub fn ensure_provider<S: ArtifactSource>(
    paths: &ManagedPaths,
    contract: &ProviderContract,
    source: &S,
    host_os: &str,
    host_architecture: &str,
    environment_path: Option<&std::ffi::OsStr>,
) -> Result<(), BootstrapError> {
    let observation = inspect_provider(
        paths,
        contract,
        environment_path,
        host_os,
        host_architecture,
    )?;
    if matches!(
        observation.classification,
        Classification::Incompatible | Classification::Ambiguous
    ) {
        return Err(provider_classification_error(&observation));
    }
    ensure_managed_directories(paths)?;
    if observation.staging_present {
        fs::remove_dir_all(paths.staging_provider_directory())
            .map_err(|error| BootstrapError::io("remove interrupted provider staging", &error))?;
    }

    let archive_path = paths.archive_path(&contract.artifact_id);
    if verify_archive(&archive_path, contract).is_err() {
        if archive_path.exists() {
            fs::remove_file(&archive_path).map_err(|error| {
                BootstrapError::io("remove unverifiable provider archive", &error)
            })?;
        }
        let partial_path = archive_path.with_extension("tar.gz.part");
        if partial_path.exists() {
            fs::remove_file(&partial_path).map_err(|error| {
                BootstrapError::io("remove interrupted provider download", &error)
            })?;
        }
        source.download(contract, &partial_path)?;
        if let Err(error) = verify_archive(&partial_path, contract) {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
        fs::rename(&partial_path, &archive_path)
            .map_err(|error| BootstrapError::io("promote verified provider archive", &error))?;
    }

    let provider_directory = paths.provider_directory(&contract.artifact_id);
    if provider_directory.exists()
        && verified_executable_digest(&provider_directory.join(&contract.archive_binary_path))?
            .is_none()
    {
        if observation.active_is_expected || observation.state.is_some() {
            return Err(BootstrapError::new(
                ErrorCode::ProviderStateIncompatible,
                "existing managed provider directory is incomplete and cannot be safely replaced",
            ));
        }
        fs::remove_dir_all(&provider_directory).map_err(|error| {
            BootstrapError::io("remove incomplete managed provider directory", &error)
        })?;
    }
    if !provider_directory.exists() {
        let staging = paths.staging_provider_directory();
        fs::create_dir_all(&staging)
            .map_err(|error| BootstrapError::io("create provider staging directory", &error))?;
        extract_archive(&archive_path, &staging, contract)?;
        let binary = staging.join(&contract.archive_binary_path);
        if verified_executable_digest(&binary)?.is_none() {
            let _ = fs::remove_dir_all(&staging);
            return Err(BootstrapError::new(
                ErrorCode::ProviderArchiveInvalid,
                "verified provider archive does not contain an executable bin/limactl",
            ));
        }
        fs::rename(&staging, &provider_directory)
            .map_err(|error| BootstrapError::io("atomically promote provider directory", &error))?;
    }

    let binary_path = provider_directory.join(&contract.archive_binary_path);
    let binary_digest = verified_executable_digest(&binary_path)?.ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::ProviderArchiveInvalid,
            "managed provider directory does not contain a regular executable limactl",
        )
    })?;
    ensure_active_link(paths, contract)?;
    let state = ManagedState {
        schema_version: crate::contract::CONTRACT_SCHEMA_VERSION.to_owned(),
        provider: contract.provider.clone(),
        version: contract.version.clone(),
        artifact_id: contract.artifact_id.clone(),
        artifact_sha256: contract.artifact_sha256.clone(),
        active_relative_path: "active".to_owned(),
        archive_relative_path: format!("cache/{}.tar.gz", contract.artifact_id),
        managed_binary_sha256: binary_digest,
        host_os: host_os.to_owned(),
        host_architecture: host_architecture.to_owned(),
    };
    write_state(&paths.state_file, &state)?;
    let final_observation = inspect_provider(
        paths,
        contract,
        environment_path,
        host_os,
        host_architecture,
    )?;
    if final_observation.classification != Classification::Satisfied {
        return Err(provider_classification_error(&final_observation));
    }
    Ok(())
}

fn provider_classification_error(observation: &ProviderObservation) -> BootstrapError {
    let code = match observation.classification {
        Classification::Ambiguous => ErrorCode::ProviderStateAmbiguous,
        Classification::Incompatible => ErrorCode::ProviderStateIncompatible,
        _ => ErrorCode::ProviderStateIncompatible,
    };
    BootstrapError::new(
        code,
        observation
            .diagnostic
            .as_deref()
            .unwrap_or("provider state cannot be proven safe"),
    )
}

fn write_state(path: &Path, state: &ManagedState) -> Result<(), BootstrapError> {
    let temporary = path.with_extension("json.tmp");
    if temporary.exists() || fs::symlink_metadata(&temporary).is_ok() {
        fs::remove_file(&temporary)
            .map_err(|error| BootstrapError::io("remove stale staged managed state", &error))?;
    }
    let serialized = serde_json::to_vec_pretty(state).map_err(|error| {
        BootstrapError::new(
            ErrorCode::IoError,
            format!("serialize managed state: {error}"),
        )
    })?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| BootstrapError::io("create staged managed state", &error))?;
    file.write_all(&serialized)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| BootstrapError::io("write staged managed state", &error))?;
    fs::rename(&temporary, path)
        .map_err(|error| BootstrapError::io("atomically promote managed state", &error))?;
    Ok(())
}

pub(crate) fn verified_executable_digest(path: &Path) -> Result<Option<String>, BootstrapError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(BootstrapError::io(
                "inspect managed provider executable",
                &error,
            ))
        }
    };
    if !metadata.file_type().is_file() || !is_executable(&metadata) {
        return Ok(None);
    }
    digest_file(path).map(Some)
}

pub(crate) fn is_executable(metadata: &fs::Metadata) -> bool {
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

fn ensure_active_link(
    paths: &ManagedPaths,
    contract: &ProviderContract,
) -> Result<(), BootstrapError> {
    let expected_target = PathBuf::from("providers").join(&contract.artifact_id);
    if let Ok(metadata) = fs::symlink_metadata(&paths.active_link) {
        if !metadata.file_type().is_symlink()
            || fs::read_link(&paths.active_link).ok().as_deref() != Some(expected_target.as_path())
        {
            return Err(BootstrapError::new(
                ErrorCode::ProviderStateIncompatible,
                "active provider path exists but is not the exact managed contract link",
            ));
        }
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let temporary = paths.root.join("active.tmp");
        let _ = fs::remove_file(&temporary);
        symlink(&expected_target, &temporary)
            .map_err(|error| BootstrapError::io("stage active provider link", &error))?;
        fs::rename(&temporary, &paths.active_link).map_err(|error| {
            BootstrapError::io("atomically promote active provider link", &error)
        })?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(BootstrapError::new(
            ErrorCode::UnsupportedHostProfile,
            "the initial host bootstrap requires Unix symlink semantics",
        ))
    }
}

fn extract_archive(
    archive_path: &Path,
    destination: &Path,
    contract: &ProviderContract,
) -> Result<(), BootstrapError> {
    let file = File::open(archive_path)
        .map_err(|error| BootstrapError::io("open verified provider archive", &error))?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    let mut seen = HashSet::new();
    let mut extracted = 0_u64;
    let entries = archive.entries().map_err(|error| {
        BootstrapError::new(
            ErrorCode::ProviderArchiveInvalid,
            format!("read provider archive entries: {error}"),
        )
    })?;
    for entry_result in entries {
        let mut entry = entry_result.map_err(|error| {
            BootstrapError::new(
                ErrorCode::ProviderArchiveInvalid,
                format!("read provider archive entry: {error}"),
            )
        })?;
        let raw_entry_path = entry
            .path()
            .map_err(|error| {
                BootstrapError::new(
                    ErrorCode::ProviderArchiveInvalid,
                    format!("read archive path: {error}"),
                )
            })?
            .into_owned();
        let entry_path = normalize_archive_path(&raw_entry_path).ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::ProviderArchiveInvalid,
                "provider archive contains an absolute or parent-traversing path",
            )
        })?;
        let entry_name = entry_path.to_string_lossy().into_owned();
        if entry_name.is_empty() {
            if entry.header().entry_type().is_dir() {
                continue;
            }
            return Err(BootstrapError::new(
                ErrorCode::ProviderArchiveInvalid,
                "provider archive contains an unnamed non-directory entry",
            ));
        }
        if !seen.insert(entry_name.clone()) {
            return Err(BootstrapError::new(
                ErrorCode::ProviderArchiveInvalid,
                "provider archive contains duplicate paths",
            ));
        }
        let target = destination.join(&entry_path);
        if entry.header().entry_type().is_dir() {
            ensure_directory(destination, &entry_path)?;
            continue;
        }
        if entry.header().entry_type().is_symlink() {
            let link_target = entry
                .link_name()
                .map_err(|error| {
                    BootstrapError::new(
                        ErrorCode::ProviderArchiveInvalid,
                        format!("read archive link: {error}"),
                    )
                })?
                .ok_or_else(|| {
                    BootstrapError::new(
                        ErrorCode::ProviderArchiveInvalid,
                        "provider archive has an empty link target",
                    )
                })?;
            if !safe_link_target(&entry_path, &link_target) {
                return Err(BootstrapError::new(
                    ErrorCode::ProviderArchiveInvalid,
                    "provider archive link escapes the managed provider directory",
                ));
            }
            if let Some(parent) = entry_path.parent() {
                ensure_directory(destination, parent)?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::symlink;
                symlink(&link_target, &target)
                    .map_err(|error| BootstrapError::io("create provider archive link", &error))?;
            }
            #[cfg(not(unix))]
            {
                let _ = target;
                return Err(BootstrapError::new(
                    ErrorCode::ProviderArchiveInvalid,
                    "provider archive links are unsupported on this host",
                ));
            }
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err(BootstrapError::new(
                ErrorCode::ProviderArchiveInvalid,
                "provider archive contains a link or special file; only regular files are accepted",
            ));
        }
        let size = entry.size();
        extracted = extracted.checked_add(size).ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::ProviderArchiveInvalid,
                "provider archive extraction size overflow",
            )
        })?;
        if extracted > MAX_EXTRACTED_BYTES {
            return Err(BootstrapError::new(
                ErrorCode::ProviderArchiveInvalid,
                "provider archive exceeds the extracted-size bound",
            ));
        }
        if entry_name == contract.archive_binary_path && size == 0 {
            return Err(BootstrapError::new(
                ErrorCode::ProviderArchiveInvalid,
                "provider executable is empty",
            ));
        }
        if let Some(parent) = entry_path.parent() {
            ensure_directory(destination, parent)?;
        }
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)
            .map_err(|error| BootstrapError::io("create extracted provider file", &error))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| BootstrapError::io("extract provider file", &error))?;
        output
            .sync_all()
            .map_err(|error| BootstrapError::io("sync extracted provider file", &error))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = entry.header().mode().unwrap_or(0o644) & 0o7777;
            fs::set_permissions(&target, fs::Permissions::from_mode(mode)).map_err(|error| {
                BootstrapError::io("set extracted provider permissions", &error)
            })?;
        }
    }
    Ok(())
}

fn normalize_archive_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(normalized)
}

fn ensure_directory(root: &Path, relative: &Path) -> Result<(), BootstrapError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err(BootstrapError::new(
                ErrorCode::ProviderArchiveInvalid,
                "provider archive directory path is not relative",
            ));
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => {
                return Err(BootstrapError::new(
                    ErrorCode::ProviderArchiveInvalid,
                    "provider archive path traverses a non-directory entry",
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|error| BootstrapError::io("create provider directory", &error))?;
            }
            Err(error) => return Err(BootstrapError::io("inspect provider directory", &error)),
        }
    }
    Ok(())
}

fn safe_link_target(entry_path: &Path, link_target: &Path) -> bool {
    let mut resolved = PathBuf::new();
    if let Some(parent) = entry_path.parent() {
        for component in parent.components() {
            if let Component::Normal(part) = component {
                resolved.push(part);
            }
        }
    }
    for component in link_target.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !resolved.pop() {
                    return false;
                }
            }
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    !resolved.as_os_str().is_empty()
}
