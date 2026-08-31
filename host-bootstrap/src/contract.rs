use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{BootstrapError, ErrorCode};

pub const CONTRACT_SCHEMA_VERSION: &str = "mottainai.host-bootstrap.v1";
pub const BOOTSTRAP_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_LIMA_VERSION: &str = "2.1.1";
const DEFAULT_LIMA_ARCHIVE_SHA256: &str =
    "0f89235de8c3676d988d863cfef37ac7cf4b8a14ba05d5d678a99dfea1db2d3c";
const DEFAULT_LIMA_ARCHIVE_URL: &str =
    "https://github.com/lima-vm/lima/releases/download/v2.1.1/lima-2.1.1-Linux-x86_64.tar.gz";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProviderContract {
    pub schema_version: String,
    pub provider: String,
    pub version: String,
    pub artifact_id: String,
    pub artifact_url: String,
    pub artifact_sha256: String,
    pub max_artifact_bytes: u64,
    pub download_timeout_seconds: u64,
    pub archive_binary_path: String,
}

impl Default for ProviderContract {
    fn default() -> Self {
        Self {
            schema_version: CONTRACT_SCHEMA_VERSION.to_owned(),
            provider: "lima".to_owned(),
            version: DEFAULT_LIMA_VERSION.to_owned(),
            artifact_id: "lima-2.1.1-linux-x86_64".to_owned(),
            artifact_url: DEFAULT_LIMA_ARCHIVE_URL.to_owned(),
            artifact_sha256: DEFAULT_LIMA_ARCHIVE_SHA256.to_owned(),
            max_artifact_bytes: 256 * 1024 * 1024,
            download_timeout_seconds: 300,
            archive_binary_path: "bin/limactl".to_owned(),
        }
    }
}

impl ProviderContract {
    pub fn identity(&self, managed_path: Option<String>) -> crate::model::ProviderIdentity {
        crate::model::ProviderIdentity {
            provider: self.provider.clone(),
            version: self.version.clone(),
            artifact_id: self.artifact_id.clone(),
            artifact_sha256: self.artifact_sha256.clone(),
            managed_path,
        }
    }

    pub fn validate(&self) -> Result<(), BootstrapError> {
        let valid_digest = self.artifact_sha256.len() == 64
            && self
                .artifact_sha256
                .chars()
                .all(|character| character.is_ascii_hexdigit())
            && self.artifact_sha256 == self.artifact_sha256.to_ascii_lowercase();
        let safe_binary_path = Path::new(&self.archive_binary_path).is_relative()
            && !self.archive_binary_path.is_empty()
            && !self
                .archive_binary_path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            && self.archive_binary_path == self.archive_binary_path.replace('\\', "/");
        let safe_artifact_id = !self.artifact_id.is_empty()
            && self.artifact_id.len() <= 128
            && self.artifact_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            });
        let url_allowed = self.artifact_url.starts_with("https://github.com/")
            && !self.artifact_url.contains(['\n', '\r', '"', '\'']);
        if self.schema_version != CONTRACT_SCHEMA_VERSION
            || self.provider != "lima"
            || self.version.is_empty()
            || !safe_artifact_id
            || !url_allowed
            || !valid_digest
            || !safe_binary_path
            || self.max_artifact_bytes == 0
            || self.max_artifact_bytes > 256 * 1024 * 1024
            || !(1..=900).contains(&self.download_timeout_seconds)
        {
            return Err(BootstrapError::new(
                ErrorCode::ContractInvalid,
                "provider contract is not an explicit supported Lima/Linux x86_64 contract",
            ));
        }
        Ok(())
    }
}
