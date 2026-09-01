use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, WWW_AUTHENTICATE};
use sha2::{Digest, Sha256};

use crate::error::{BootstrapError, ErrorCode};

/// Bounded generic OCI Distribution (Docker Registry v2) client surface used
/// to resolve the canonical Runtime Appliance by immutable digest. Only the
/// two read-only operations the appliance contract needs are exposed; this
/// is not a general registry client.
pub trait OciSource {
    fn fetch_manifest(&self, repository: &str, digest: &str) -> Result<Vec<u8>, BootstrapError>;

    fn fetch_blob(
        &self,
        repository: &str,
        digest: &str,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(), BootstrapError>;
}

pub const OCI_MANIFEST_ACCEPT: &str = "application/vnd.oci.image.manifest.v1+json";

#[derive(Clone, Debug)]
pub struct HttpOciSource {
    pub registry: String,
    pub timeout: Duration,
}

impl HttpOciSource {
    fn client(&self) -> Result<Client, BootstrapError> {
        Client::builder()
            .connect_timeout(self.timeout.min(Duration::from_secs(30)))
            .timeout(self.timeout)
            .build()
            .map_err(|error| {
                BootstrapError::new(
                    ErrorCode::ApplianceDownloadFailed,
                    format!("create OCI registry HTTPS client: {error}"),
                )
            })
    }

    /// Performs the standard OCI/Docker Registry v2 anonymous bearer
    /// challenge/response dance: an unauthenticated request that receives a
    /// `401` with a `WWW-Authenticate: Bearer realm=...,service=...,scope=...`
    /// header is retried once with a token fetched from that realm. This is
    /// the same public, documented registry protocol every OCI client
    /// (`oras`, `docker`, `crane`) uses; it is not a Lima- or GHCR-specific
    /// surface.
    fn get_authenticated(
        &self,
        client: &Client,
        url: &str,
        accept: &str,
    ) -> Result<reqwest::blocking::Response, BootstrapError> {
        let first = client
            .get(url)
            .header(ACCEPT, accept)
            .send()
            .map_err(|error| {
                BootstrapError::new(
                    ErrorCode::ApplianceDownloadFailed,
                    format!("request OCI registry resource: {error}"),
                )
            })?;
        if first.status().as_u16() != 401 {
            return Ok(first);
        }
        let challenge = first
            .headers()
            .get(WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                BootstrapError::new(
                    ErrorCode::ApplianceDownloadFailed,
                    "OCI registry returned 401 without a bearer challenge",
                )
            })?;
        let token_url = bearer_token_url(challenge).ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                "OCI registry bearer challenge could not be parsed",
            )
        })?;
        let token_response = client.get(&token_url).send().map_err(|error| {
            BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                format!("request OCI registry bearer token: {error}"),
            )
        })?;
        if !token_response.status().is_success() {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                format!(
                    "OCI registry bearer token request returned HTTP {}",
                    token_response.status().as_u16()
                ),
            ));
        }
        let token_body: serde_json::Value = token_response.json().map_err(|error| {
            BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                format!("parse OCI registry bearer token response: {error}"),
            )
        })?;
        let token = token_body
            .get("token")
            .or_else(|| token_body.get("access_token"))
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                BootstrapError::new(
                    ErrorCode::ApplianceDownloadFailed,
                    "OCI registry bearer token response has no token field",
                )
            })?;
        client
            .get(url)
            .header(ACCEPT, accept)
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .send()
            .map_err(|error| {
                BootstrapError::new(
                    ErrorCode::ApplianceDownloadFailed,
                    format!("request OCI registry resource with bearer token: {error}"),
                )
            })
    }
}

impl OciSource for HttpOciSource {
    fn fetch_manifest(&self, repository: &str, digest: &str) -> Result<Vec<u8>, BootstrapError> {
        validate_digest(digest)?;
        let client = self.client()?;
        let url = format!(
            "https://{}/v2/{repository}/manifests/{digest}",
            self.registry
        );
        let response = self.get_authenticated(&client, &url, OCI_MANIFEST_ACCEPT)?;
        if !response.status().is_success() {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                format!(
                    "OCI registry manifest fetch returned HTTP {}",
                    response.status().as_u16()
                ),
            ));
        }
        let bytes = response.bytes().map_err(|error| {
            BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                format!("read OCI registry manifest body: {error}"),
            )
        })?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceManifestInvalid,
                "OCI registry manifest exceeds the bounded manifest size",
            ));
        }
        verify_digest_bytes(&bytes, digest)?;
        Ok(bytes.to_vec())
    }

    fn fetch_blob(
        &self,
        repository: &str,
        digest: &str,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(), BootstrapError> {
        validate_digest(digest)?;
        let client = self.client()?;
        let url = format!("https://{}/v2/{repository}/blobs/{digest}", self.registry);
        let mut response = self.get_authenticated(&client, &url, "*/*")?;
        if !response.status().is_success() {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                format!(
                    "OCI registry blob fetch returned HTTP {}",
                    response.status().as_u16()
                ),
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes)
        {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                "OCI registry blob exceeds the configured download size bound",
            ));
        }
        write_bounded_verified(&mut response, destination, max_bytes, digest)
    }
}

pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

fn bearer_token_url(challenge: &str) -> Option<String> {
    let rest = challenge.trim().strip_prefix("Bearer ")?;
    let mut realm = None;
    let mut service = None;
    let mut scope = None;
    for part in split_challenge_params(rest) {
        let (key, value) = part.split_once('=')?;
        let value = value.trim_matches('"');
        match key.trim() {
            "realm" => realm = Some(value.to_owned()),
            "service" => service = Some(value.to_owned()),
            "scope" => scope = Some(value.to_owned()),
            _ => {}
        }
    }
    let realm = realm?;
    let mut url = realm;
    let mut separator = '?';
    if let Some(service) = service {
        url.push(separator);
        url.push_str("service=");
        url.push_str(&urlencode(&service));
        separator = '&';
    }
    if let Some(scope) = scope {
        url.push(separator);
        url.push_str("scope=");
        url.push_str(&urlencode(&scope));
    }
    Some(url)
}

/// Splits `key="value",key2="value2"` on commas that are not inside quotes.
fn split_challenge_params(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut in_quotes = false;
    let mut start = 0;
    for (index, character) in value.char_indices() {
        match character {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                parts.push(value[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(value[start..].trim());
    parts
}

fn urlencode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

pub fn validate_digest(digest: &str) -> Result<(), BootstrapError> {
    let hex = digest.strip_prefix("sha256:").ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::ApplianceReferenceInvalid,
            "OCI digest must be an explicit sha256: reference",
        )
    })?;
    let valid = hex.len() == 64
        && hex.chars().all(|character| character.is_ascii_hexdigit())
        && hex == hex.to_ascii_lowercase();
    if !valid {
        return Err(BootstrapError::new(
            ErrorCode::ApplianceReferenceInvalid,
            "OCI digest is not a well-formed lowercase sha256 hex digest",
        ));
    }
    Ok(())
}

fn verify_digest_bytes(bytes: &[u8], digest: &str) -> Result<(), BootstrapError> {
    let expected = digest.trim_start_matches("sha256:");
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        return Err(BootstrapError::new(
            ErrorCode::ApplianceDigestMismatch,
            "OCI registry response content does not match the requested digest",
        ));
    }
    Ok(())
}

fn write_bounded_verified<R: Read>(
    mut source: R,
    destination: &Path,
    maximum: u64,
    expected_digest: &str,
) -> Result<(), BootstrapError> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| BootstrapError::io("create OCI blob destination directory", &error))?;
    }
    let _ = fs::remove_file(destination);
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| BootstrapError::io("create staged OCI blob", &error))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = source.read(&mut buffer).map_err(|error| {
            BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                format!("read OCI blob: {error}"),
            )
        })?;
        if read == 0 {
            break;
        }
        total = total.checked_add(read as u64).ok_or_else(|| {
            BootstrapError::new(ErrorCode::ApplianceDownloadFailed, "OCI blob size overflow")
        })?;
        if total > maximum {
            let _ = fs::remove_file(destination);
            return Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                "OCI blob exceeded the configured download size bound",
            ));
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| BootstrapError::io("write staged OCI blob", &error))?;
    }
    output
        .sync_all()
        .map_err(|error| BootstrapError::io("sync staged OCI blob", &error))?;
    let expected = expected_digest.trim_start_matches("sha256:");
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        let _ = fs::remove_file(destination);
        return Err(BootstrapError::new(
            ErrorCode::ApplianceDigestMismatch,
            format!("OCI blob digest mismatch: expected {expected}, got {actual}"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{bearer_token_url, validate_digest};
    use crate::error::ErrorCode;

    #[test]
    fn bearer_challenge_is_parsed_into_a_token_url() {
        let challenge = r#"Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:yohn-jp/mottainai/runtime-appliance:pull""#;
        let url = bearer_token_url(challenge).expect("parses");
        assert!(url.starts_with("https://ghcr.io/token?"));
        assert!(url.contains("service=ghcr.io"));
        assert!(url.contains("scope=repository%3Ayohn-jp%2Fmottainai%2Fruntime-appliance%3Apull"));
    }

    #[test]
    fn only_lowercase_sha256_digests_validate() {
        let too_long = format!("sha256:{}", "0".repeat(66));
        let exact = format!("sha256:{}", "0".repeat(64));
        let wrong_case = format!("SHA256:{}", "0".repeat(64));
        assert!(validate_digest(&too_long).is_err());
        assert!(validate_digest(&exact).is_ok());
        let error = validate_digest(&wrong_case).unwrap_err();
        assert_eq!(error.code, ErrorCode::ApplianceReferenceInvalid);
    }
}
