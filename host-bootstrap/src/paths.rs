use std::env;
use std::path::{Path, PathBuf};

use crate::error::{BootstrapError, ErrorCode};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedPaths {
    pub root: PathBuf,
    pub state_file: PathBuf,
    pub qemu_state_file: PathBuf,
    pub lock_file: PathBuf,
    pub cache_directory: PathBuf,
    pub providers_directory: PathBuf,
    pub staging_directory: PathBuf,
    pub active_link: PathBuf,
}

impl ManagedPaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            state_file: root.join("state.json"),
            qemu_state_file: root.join("qemu.json"),
            lock_file: root.join("bootstrap.lock"),
            cache_directory: root.join("cache"),
            providers_directory: root.join("providers"),
            staging_directory: root.join("staging"),
            active_link: root.join("active"),
            root,
        }
    }

    pub fn provider_directory(&self, artifact_id: &str) -> PathBuf {
        self.providers_directory.join(artifact_id)
    }

    pub fn archive_path(&self, artifact_id: &str) -> PathBuf {
        self.cache_directory.join(format!("{artifact_id}.tar.gz"))
    }

    pub fn staging_provider_directory(&self) -> PathBuf {
        self.staging_directory.join("provider")
    }
}

pub fn default_state_directory() -> Result<PathBuf, BootstrapError> {
    if let Some(value) = env::var_os("XDG_STATE_HOME") {
        let path = PathBuf::from(value);
        if path.is_absolute() && path.to_string_lossy().len() <= 4096 {
            return Ok(path.join("mottainai").join("host-bootstrap"));
        }
    }
    let home = env::var_os("HOME").ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::IoError,
            "HOME is not set and XDG_STATE_HOME is unavailable; cannot select managed state location",
        )
    })?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("state")
        .join("mottainai")
        .join("host-bootstrap"))
}

pub fn ensure_managed_directories(paths: &ManagedPaths) -> Result<(), BootstrapError> {
    ensure_directory(&paths.root, "managed state root")?;
    ensure_directory(&paths.cache_directory, "managed cache directory")?;
    ensure_directory(&paths.providers_directory, "managed providers directory")?;
    ensure_directory(&paths.staging_directory, "managed staging directory")?;
    Ok(())
}

fn ensure_directory(path: &Path, description: &str) -> Result<(), BootstrapError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(BootstrapError::new(
            ErrorCode::IoError,
            format!("{description} is not a real directory"),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path)
                .map_err(|error| BootstrapError::io(description, &error))?;
            match std::fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
                Ok(_) => Err(BootstrapError::new(
                    ErrorCode::IoError,
                    format!("{description} is not a real directory"),
                )),
                Err(error) => Err(BootstrapError::io(description, &error)),
            }
        }
        Err(error) => Err(BootstrapError::io(
            &format!("inspect {description}"),
            &error,
        )),
    }
}

pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().chars().take(4096).collect()
}
