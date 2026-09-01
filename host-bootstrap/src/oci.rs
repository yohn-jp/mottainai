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
const MAX_BEARER_TOKEN_RESPONSE_BYTES: u64 = 16 * 1024;

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
        if token_response
            .content_length()
            .is_some_and(|length| length > MAX_BEARER_TOKEN_RESPONSE_BYTES)
        {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                "OCI registry bearer token response exceeds the bounded token response size",
            ));
        }
        let token_bytes = read_bounded_body(
            token_response,
            MAX_BEARER_TOKEN_RESPONSE_BYTES,
            ErrorCode::ApplianceDownloadFailed,
            "read OCI registry bearer token response",
            ErrorCode::ApplianceDownloadFailed,
            "OCI registry bearer token response exceeds the bounded token response size",
        )?;
        let token_body: serde_json::Value =
            serde_json::from_slice(&token_bytes).map_err(|error| {
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
        if response
            .content_length()
            .is_some_and(|length| length > MAX_MANIFEST_BYTES)
        {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceManifestInvalid,
                "OCI registry manifest exceeds the bounded manifest size",
            ));
        }
        let bytes = read_bounded_body(
            response,
            MAX_MANIFEST_BYTES,
            ErrorCode::ApplianceDownloadFailed,
            "read OCI registry manifest body",
            ErrorCode::ApplianceManifestInvalid,
            "OCI registry manifest exceeds the bounded manifest size",
        )?;
        verify_digest_bytes(&bytes, digest)?;
        Ok(bytes)
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

/// Reads at most one byte beyond the ceiling so overflow is detected without
/// buffering an unbounded response.
fn read_bounded_body<R: Read>(
    source: R,
    maximum: u64,
    read_error_code: ErrorCode,
    read_context: &str,
    oversized_error_code: ErrorCode,
    oversized_message: &str,
) -> Result<Vec<u8>, BootstrapError> {
    let read_limit = maximum.checked_add(1).ok_or_else(|| {
        BootstrapError::new(
            read_error_code,
            format!("{read_context}: response size bound overflow"),
        )
    })?;
    let mut bytes = Vec::new();
    source
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            BootstrapError::new(read_error_code, format!("{read_context}: {error}"))
        })?;
    if bytes.len() as u64 > maximum {
        return Err(BootstrapError::new(oversized_error_code, oversized_message));
    }
    Ok(bytes)
}

/// Reads a local, content-addressed OCI Artifact layout instead of a
/// network registry: the manifest is read verbatim from `manifest_path` and
/// verified against the requested digest exactly like `HttpOciSource` would
/// verify a registry response, and each blob is read from
/// `blobs_directory/<hex-digest>` — the same `blobs/sha256/<hex>` naming
/// convention OCI content stores and `oras pull` use. This exists so a
/// build pipeline can prove `ensure_appliance` against the exact bytes of an
/// already-built canonical Runtime Appliance without a registry in the
/// loop; see `scripts/build-runtime-appliance-oci-fixture.mjs`.
#[derive(Clone, Debug)]
pub struct FileOciSource {
    pub manifest_path: std::path::PathBuf,
    pub blobs_directory: std::path::PathBuf,
}

impl OciSource for FileOciSource {
    fn fetch_manifest(&self, _repository: &str, digest: &str) -> Result<Vec<u8>, BootstrapError> {
        validate_digest(digest)?;
        let bytes = fs::read(&self.manifest_path)
            .map_err(|error| BootstrapError::io("read local OCI manifest fixture", &error))?;
        verify_digest_bytes(&bytes, digest)?;
        Ok(bytes)
    }

    fn fetch_blob(
        &self,
        _repository: &str,
        digest: &str,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(), BootstrapError> {
        validate_digest(digest)?;
        let hex = digest.trim_start_matches("sha256:");
        let source = self.blobs_directory.join(hex);
        let metadata = fs::metadata(&source)
            .map_err(|error| BootstrapError::io("inspect local OCI blob fixture", &error))?;
        if metadata.len() > max_bytes {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                "local OCI blob fixture exceeds the configured download size bound",
            ));
        }
        let file = fs::File::open(&source)
            .map_err(|error| BootstrapError::io("open local OCI blob fixture", &error))?;
        write_bounded_verified(file, destination, max_bytes, digest)
    }
}

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
    use std::io::{self, Cursor, Read};

    use super::{
        bearer_token_url, read_bounded_body, validate_digest, MAX_BEARER_TOKEN_RESPONSE_BYTES,
        MAX_MANIFEST_BYTES,
    };
    use crate::error::ErrorCode;

    struct InfiniteBody(u8);

    impl Read for InfiniteBody {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            buffer.fill(self.0);
            Ok(buffer.len())
        }
    }

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

    #[test]
    fn oversized_manifest_body_is_rejected_before_parsing() {
        let error = read_bounded_body(
            InfiniteBody(b'm'),
            MAX_MANIFEST_BYTES,
            ErrorCode::ApplianceDownloadFailed,
            "read OCI registry manifest body",
            ErrorCode::ApplianceManifestInvalid,
            "OCI registry manifest exceeds the bounded manifest size",
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ApplianceManifestInvalid);
        assert_eq!(
            error.message,
            "OCI registry manifest exceeds the bounded manifest size"
        );
    }

    #[test]
    fn oversized_bearer_token_body_is_rejected_before_json_parsing() {
        let error = read_bounded_body(
            InfiniteBody(b't'),
            MAX_BEARER_TOKEN_RESPONSE_BYTES,
            ErrorCode::ApplianceDownloadFailed,
            "read OCI registry bearer token response",
            ErrorCode::ApplianceDownloadFailed,
            "OCI registry bearer token response exceeds the bounded token response size",
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ApplianceDownloadFailed);
        assert_eq!(
            error.message,
            "OCI registry bearer token response exceeds the bounded token response size"
        );
    }

    #[test]
    fn bounded_body_without_content_length_is_accepted() {
        let body = br#"{"schemaVersion":2}"#;
        let bytes = read_bounded_body(
            Cursor::new(body),
            MAX_MANIFEST_BYTES,
            ErrorCode::ApplianceDownloadFailed,
            "read OCI registry manifest body",
            ErrorCode::ApplianceManifestInvalid,
            "OCI registry manifest exceeds the bounded manifest size",
        )
        .expect("bounded manifest body");
        assert_eq!(bytes, body);
    }

    #[test]
    fn bounded_bearer_token_body_without_content_length_is_accepted() {
        let body = br#"{"token":"test-token"}"#;
        let bytes = read_bounded_body(
            Cursor::new(body),
            MAX_BEARER_TOKEN_RESPONSE_BYTES,
            ErrorCode::ApplianceDownloadFailed,
            "read OCI registry bearer token response",
            ErrorCode::ApplianceDownloadFailed,
            "OCI registry bearer token response exceeds the bounded token response size",
        )
        .expect("bounded bearer token body");
        let token_body: serde_json::Value =
            serde_json::from_slice(&bytes).expect("valid bearer token JSON");
        assert_eq!(token_body["token"], "test-token");
    }
}
