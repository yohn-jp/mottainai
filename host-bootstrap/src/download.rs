use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use sha2::{Digest, Sha256};

use crate::contract::ProviderContract;
use crate::error::{BootstrapError, ErrorCode};

pub trait ArtifactSource {
    fn download(
        &self,
        contract: &ProviderContract,
        destination: &Path,
    ) -> Result<(), BootstrapError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct HttpArtifactSource;

impl ArtifactSource for HttpArtifactSource {
    fn download(
        &self,
        contract: &ProviderContract,
        destination: &Path,
    ) -> Result<(), BootstrapError> {
        let timeout = Duration::from_secs(contract.download_timeout_seconds);
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
                    format!("create HTTPS client: {error}"),
                )
            })?;
        let mut response = client.get(&contract.artifact_url).send().map_err(|error| {
            BootstrapError::new(
                ErrorCode::DownloadFailed,
                format!("download provider archive: {error}"),
            )
        })?;
        if !response.status().is_success() {
            return Err(BootstrapError::new(
                ErrorCode::DownloadFailed,
                format!(
                    "provider archive returned HTTP {}",
                    response.status().as_u16()
                ),
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > contract.max_artifact_bytes)
        {
            return Err(BootstrapError::new(
                ErrorCode::DownloadFailed,
                "provider archive exceeds the configured download size bound",
            ));
        }
        write_bounded(&mut response, destination, contract.max_artifact_bytes)
    }
}

#[derive(Clone, Debug)]
pub struct FileArtifactSource {
    pub path: std::path::PathBuf,
}

impl ArtifactSource for FileArtifactSource {
    fn download(
        &self,
        contract: &ProviderContract,
        destination: &Path,
    ) -> Result<(), BootstrapError> {
        let source = File::open(&self.path)
            .map_err(|error| BootstrapError::io("open artifact override", &error))?;
        let size = source
            .metadata()
            .map_err(|error| BootstrapError::io("inspect artifact override", &error))?
            .len();
        if size > contract.max_artifact_bytes {
            return Err(BootstrapError::new(
                ErrorCode::DownloadFailed,
                "artifact override exceeds the configured download size bound",
            ));
        }
        write_bounded(source, destination, contract.max_artifact_bytes)
    }
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
        .map_err(|error| BootstrapError::io("create staged provider archive", &error))?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = source.read(&mut buffer).map_err(|error| {
            BootstrapError::new(
                ErrorCode::DownloadFailed,
                format!("read provider archive: {error}"),
            )
        })?;
        if read == 0 {
            break;
        }
        total = total.checked_add(read as u64).ok_or_else(|| {
            BootstrapError::new(ErrorCode::DownloadFailed, "provider archive size overflow")
        })?;
        if total > maximum {
            let _ = fs::remove_file(destination);
            return Err(BootstrapError::new(
                ErrorCode::DownloadFailed,
                "provider archive exceeded the configured download size bound",
            ));
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| BootstrapError::io("write staged provider archive", &error))?;
    }
    output
        .sync_all()
        .map_err(|error| BootstrapError::io("sync staged provider archive", &error))?;
    Ok(())
}

pub(crate) fn verify_archive(
    path: &Path,
    contract: &ProviderContract,
) -> Result<(), BootstrapError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| BootstrapError::io("inspect provider archive", &error))?;
    if !metadata.file_type().is_file() {
        return Err(BootstrapError::new(
            ErrorCode::ProviderChecksumMismatch,
            "provider archive is not a regular managed file",
        ));
    }
    if metadata.len() > contract.max_artifact_bytes {
        return Err(BootstrapError::new(
            ErrorCode::ProviderChecksumMismatch,
            "provider archive exceeds size bound",
        ));
    }
    let digest = digest_file(path)?;
    if digest != contract.artifact_sha256 {
        return Err(BootstrapError::new(
            ErrorCode::ProviderChecksumMismatch,
            format!(
                "provider archive digest mismatch: expected {}, got {digest}",
                contract.artifact_sha256
            ),
        ));
    }
    Ok(())
}

pub(crate) fn digest_file(path: &Path) -> Result<String, BootstrapError> {
    let mut file =
        File::open(path).map_err(|error| BootstrapError::io("open file for digest", &error))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| BootstrapError::io("read file for digest", &error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
