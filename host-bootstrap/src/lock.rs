use std::fs::{File, OpenOptions};
use std::path::PathBuf;

use fs2::FileExt;

use crate::error::{BootstrapError, ErrorCode};
use crate::paths::ManagedPaths;

#[derive(Debug)]
pub struct BootstrapLock {
    file: File,
    root: PathBuf,
}

impl BootstrapLock {
    pub fn acquire(paths: &ManagedPaths) -> Result<Self, BootstrapError> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&paths.lock_file)
            .map_err(|error| BootstrapError::io("open bootstrap lock", &error))?;
        file.try_lock_exclusive().map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                BootstrapError::new(
                    ErrorCode::BootstrapLocked,
                    "another mottainai-init process owns the managed bootstrap lock",
                )
            } else {
                BootstrapError::io("acquire bootstrap lock", &error)
            }
        })?;
        Ok(Self {
            file,
            root: paths.root.clone(),
        })
    }

    pub(crate) fn validate_for(&self, paths: &ManagedPaths) -> Result<(), BootstrapError> {
        if self.root != paths.root {
            return Err(BootstrapError::new(
                ErrorCode::BootstrapLockMismatch,
                "bootstrap lock is bound to a different managed state root",
            ));
        }
        Ok(())
    }
}

impl Drop for BootstrapLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}
