use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{BootstrapError, ErrorCode};

const SSH_CLIENT: &str = "ssh";
const SSH_KEYGEN: &str = "ssh-keygen";

/// Validates the explicit host-tooling precondition consumed by the
/// supported Lima profile. This check only resolves executables from PATH;
/// it never reads or adopts credentials from the invoking user's home.
pub fn validate_path(environment_path: Option<&OsStr>) -> Result<(), BootstrapError> {
    require_executable(
        environment_path,
        SSH_CLIENT,
        ErrorCode::OpenSshClientMissing,
    )?;
    require_executable(
        environment_path,
        SSH_KEYGEN,
        ErrorCode::OpenSshKeygenMissing,
    )?;
    Ok(())
}

fn require_executable(
    environment_path: Option<&OsStr>,
    executable: &str,
    missing_code: ErrorCode,
) -> Result<PathBuf, BootstrapError> {
    resolve_executable(environment_path, executable)?.ok_or_else(|| {
        BootstrapError::new(
            missing_code,
            format!(
                "required OpenSSH executable `{executable}` is missing from PATH; install OpenSSH client tooling and rerun"
            ),
        )
    })
}

fn resolve_executable(
    environment_path: Option<&OsStr>,
    executable: &str,
) -> Result<Option<PathBuf>, BootstrapError> {
    let Some(environment_path) = environment_path else {
        return Ok(None);
    };

    for entry in std::env::split_paths(environment_path) {
        let directory = if entry.as_os_str().is_empty() {
            std::env::current_dir()
                .map_err(|error| BootstrapError::io("resolve empty PATH entry", &error))?
        } else {
            entry
        };
        let candidate = directory.join(executable);
        let metadata = match fs::metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(BootstrapError::io(
                    &format!("inspect OpenSSH executable `{executable}`"),
                    &error,
                ));
            }
        };
        if metadata.file_type().is_file() && is_executable(&metadata) {
            return Ok(Some(canonical_path(&candidate)));
        }
    }
    Ok(None)
}

fn canonical_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
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

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::fs;

    use super::validate_path;
    use crate::error::ErrorCode;
    use tempfile::TempDir;

    fn executable_directory() -> TempDir {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        directory
    }

    fn write_executable(directory: &TempDir, name: &str) {
        let path = directory.path().join(name);
        fs::write(&path, b"#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    fn path_for(directory: &TempDir) -> OsString {
        directory.path().as_os_str().to_owned()
    }

    #[test]
    fn requires_both_open_ssh_tools_independently() {
        let directory = executable_directory();
        write_executable(&directory, "ssh");
        write_executable(&directory, "ssh-keygen");
        assert!(validate_path(Some(&path_for(&directory))).is_ok());

        fs::remove_file(directory.path().join("ssh")).unwrap();
        assert_eq!(
            validate_path(Some(&path_for(&directory))).unwrap_err().code,
            ErrorCode::OpenSshClientMissing
        );

        write_executable(&directory, "ssh");
        fs::remove_file(directory.path().join("ssh-keygen")).unwrap();
        assert_eq!(
            validate_path(Some(&path_for(&directory))).unwrap_err().code,
            ErrorCode::OpenSshKeygenMissing
        );
    }

    #[test]
    fn absent_path_is_a_bounded_actionable_client_error() {
        let error = validate_path(None).unwrap_err();
        assert_eq!(error.code, ErrorCode::OpenSshClientMissing);
        assert!(error.message.contains("`ssh`"));
        assert!(error.message.len() <= 512);
    }

    #[test]
    fn non_executable_files_do_not_satisfy_the_contract() {
        let directory = executable_directory();
        fs::write(directory.path().join("ssh"), b"not executable").unwrap();
        write_executable(&directory, "ssh-keygen");
        let error = validate_path(Some(&path_for(&directory))).unwrap_err();
        assert_eq!(error.code, ErrorCode::OpenSshClientMissing);
    }
}
