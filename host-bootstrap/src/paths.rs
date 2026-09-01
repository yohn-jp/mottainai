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
    pub appliances_directory: PathBuf,
    pub runtime_directory: PathBuf,
    pub lima_home_directory: PathBuf,
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
            appliances_directory: root.join("appliances"),
            runtime_directory: root.join("runtime"),
            lima_home_directory: root.join("lima-home"),
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

    /// Digest is the `sha256:<hex>` reference; only the hex half is used as
    /// the directory name so the immutable identity stays filesystem-safe.
    pub fn appliance_directory(&self, digest: &str) -> PathBuf {
        let hex = digest.strip_prefix("sha256:").unwrap_or(digest);
        self.appliances_directory.join(hex)
    }

    pub fn appliance_raw_path(&self, digest: &str) -> PathBuf {
        self.appliance_directory(digest)
            .join("mottainai-runtime-appliance.raw")
    }

    pub fn appliance_state_path(&self, digest: &str) -> PathBuf {
        self.appliance_directory(digest).join("state.json")
    }

    pub fn staging_appliance_directory(&self) -> PathBuf {
        self.staging_directory.join("appliance")
    }

    pub fn runtime_instance_directory(&self, instance_name: &str) -> PathBuf {
        self.runtime_directory.join(instance_name)
    }

    pub fn runtime_config_path(&self, instance_name: &str) -> PathBuf {
        self.runtime_instance_directory(instance_name)
            .join("lima.yaml")
    }

    pub fn runtime_state_path(&self, instance_name: &str) -> PathBuf {
        self.runtime_instance_directory(instance_name)
            .join("state.json")
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
    ensure_directory(&paths.appliances_directory, "managed appliances directory")?;
    ensure_directory(&paths.runtime_directory, "managed runtime directory")?;
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
