use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{BootstrapError, ErrorCode};
use crate::model::Classification;
use crate::oci::{validate_digest, OciSource};
use crate::paths::ManagedPaths;

/// The published non-container OCI Artifact contract for the canonical
/// Runtime Appliance, documented in `docs/runtime-appliance-oci.md`. These
/// constants mirror that document's table exactly; they are the immutable
/// distribution contract, not a Lima- or provider-specific detail.
pub const APPLIANCE_ARTIFACT_TYPE: &str = "application/vnd.mottainai.runtime.appliance.v1";
pub const APPLIANCE_MANIFEST_MEDIA_TYPE: &str = "application/vnd.oci.image.manifest.v1+json";
pub const APPLIANCE_RAW_LAYER_MEDIA_TYPE: &str =
    "application/vnd.mottainai.runtime.appliance.raw.v1+zstd";
pub const APPLIANCE_MANIFEST_LAYER_MEDIA_TYPE: &str =
    "application/vnd.mottainai.runtime.appliance.manifest.v1+json";
pub const APPLIANCE_METADATA_LAYER_MEDIA_TYPE: &str =
    "application/vnd.mottainai.runtime.appliance.release-metadata.v1+json";

const MAX_LAYER_JSON_BYTES: u64 = 64 * 1024;
/// Bounds the compressed appliance disk transfer.
///
/// The canonical appliance is a bootstrap-only disk (see #627); 8 GiB is a
/// generous ceiling that still fails closed against a corrupt/oversized
/// response instead of accepting unbounded registry content.
const MAX_APPLIANCE_COMPRESSED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Bounds the decompressed appliance disk materialization. Artifact metadata
/// may tighten this bound, but it can never raise the product hard limit.
const MAX_APPLIANCE_RAW_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Pins the canonical Runtime Appliance by its immutable OCI digest. A tag
/// is never accepted here: resolving a mutable locator to a digest is an
/// operator-time decision that happens before a Runtime specification is
/// produced, per `docs/runtime-appliance-oci.md` ("record the descriptor
/// digest ... use for every pull").
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ApplianceReference {
    pub registry: String,
    pub repository: String,
    pub digest: String,
}

impl ApplianceReference {
    pub fn validate(&self) -> Result<(), BootstrapError> {
        let registry_ok = !self.registry.is_empty()
            && self.registry.len() <= 255
            && self
                .registry
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':'));
        let repository_ok = !self.repository.is_empty()
            && self.repository.len() <= 255
            && self
                .repository
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
        if !registry_ok || !repository_ok {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceReferenceInvalid,
                "appliance registry/repository is not a bounded well-formed reference",
            ));
        }
        validate_digest(&self.digest)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct ApplianceState {
    schema_version: String,
    registry: String,
    repository: String,
    digest: String,
    raw_sha256: String,
    raw_size_bytes: u64,
}

const APPLIANCE_STATE_SCHEMA_VERSION: &str = "mottainai.host-bootstrap.appliance.v1";

pub struct ApplianceObservation {
    pub classification: Classification,
    pub raw_path: Option<PathBuf>,
    pub diagnostic: Option<String>,
}

/// Idempotently resolves, verifies, and materializes the canonical Runtime
/// Appliance's raw disk for the exact pinned digest, then returns its path.
/// A prior successful materialization for the same digest is detected and
/// reused without any network access.
pub fn ensure_appliance<S: OciSource>(
    paths: &ManagedPaths,
    reference: &ApplianceReference,
    source: &S,
) -> Result<PathBuf, BootstrapError> {
    reference.validate()?;
    let observation = inspect_appliance(paths, reference)?;
    if observation.classification == Classification::Satisfied {
        return Ok(observation
            .raw_path
            .expect("satisfied appliance observation carries a raw path"));
    }
    if observation.classification == Classification::Incompatible {
        return Err(BootstrapError::new(
            ErrorCode::ApplianceStateIncompatible,
            observation
                .diagnostic
                .unwrap_or_else(|| "managed appliance state is incompatible".to_owned()),
        ));
    }

    let directory = paths.appliance_directory(&reference.digest);
    let staging = paths.staging_appliance_directory();
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| BootstrapError::io("remove interrupted appliance staging", &error))?;
    }
    fs::create_dir_all(&staging)
        .map_err(|error| BootstrapError::io("create appliance staging directory", &error))?;

    let manifest_bytes = source.fetch_manifest(&reference.repository, &reference.digest)?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|error| {
        BootstrapError::new(
            ErrorCode::ApplianceManifestInvalid,
            format!("parse appliance OCI manifest: {error}"),
        )
    })?;
    let layers = require_manifest_shape(&manifest)?;

    let manifest_layer = find_layer(&layers, APPLIANCE_MANIFEST_LAYER_MEDIA_TYPE)?;
    let metadata_layer = find_layer(&layers, APPLIANCE_METADATA_LAYER_MEDIA_TYPE)?;
    let raw_layer = find_layer(&layers, APPLIANCE_RAW_LAYER_MEDIA_TYPE)?;

    source.fetch_blob(
        &reference.repository,
        &manifest_layer.digest,
        &staging.join("runtime-appliance-manifest.json"),
        MAX_LAYER_JSON_BYTES,
    )?;
    let appliance_manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(staging.join("runtime-appliance-manifest.json"))
            .map_err(|error| BootstrapError::io("read appliance manifest layer", &error))?,
    )
    .map_err(|error| {
        BootstrapError::new(
            ErrorCode::ApplianceManifestInvalid,
            format!("parse appliance manifest layer: {error}"),
        )
    })?;

    source.fetch_blob(
        &reference.repository,
        &metadata_layer.digest,
        &staging.join("runtime-appliance-release-metadata.json"),
        MAX_LAYER_JSON_BYTES,
    )?;
    let release_metadata: serde_json::Value = serde_json::from_slice(
        &fs::read(staging.join("runtime-appliance-release-metadata.json"))
            .map_err(|error| BootstrapError::io("read appliance release metadata layer", &error))?,
    )
    .map_err(|error| {
        BootstrapError::new(
            ErrorCode::ApplianceManifestInvalid,
            format!("parse appliance release metadata layer: {error}"),
        )
    })?;

    cross_verify_metadata(&appliance_manifest, &release_metadata)?;
    let image = require_string_field(&appliance_manifest, "image", "sha256")?;
    let image_size = require_u64_field(&appliance_manifest, "image", "sizeBytes")?;
    if image_size > MAX_APPLIANCE_RAW_BYTES {
        return Err(BootstrapError::new(
            ErrorCode::ApplianceManifestInvalid,
            "declared appliance raw disk exceeds the maximum supported size",
        ));
    }

    let compressed_path = staging.join("mottainai-runtime-appliance.raw.zst");
    source.fetch_blob(
        &reference.repository,
        &raw_layer.digest,
        &compressed_path,
        raw_layer.size.min(MAX_APPLIANCE_COMPRESSED_BYTES),
    )?;

    let raw_path = staging.join("mottainai-runtime-appliance.raw");
    let (raw_sha256, raw_size) = decompress_and_hash(&compressed_path, &raw_path, image_size)?;
    if raw_sha256 != image || raw_size != image_size {
        return Err(BootstrapError::new(
            ErrorCode::ApplianceDigestMismatch,
            "decompressed appliance raw disk does not match its declared manifest identity",
        ));
    }

    if directory.exists() {
        fs::remove_dir_all(&directory)
            .map_err(|error| BootstrapError::io("remove stale appliance directory", &error))?;
    }
    if let Some(parent) = directory.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| BootstrapError::io("create appliances directory", &error))?;
    }
    fs::rename(&staging, &directory)
        .map_err(|error| BootstrapError::io("atomically promote appliance directory", &error))?;

    let state = ApplianceState {
        schema_version: APPLIANCE_STATE_SCHEMA_VERSION.to_owned(),
        registry: reference.registry.clone(),
        repository: reference.repository.clone(),
        digest: reference.digest.clone(),
        raw_sha256,
        raw_size_bytes: raw_size,
    };
    write_state(&paths.appliance_state_path(&reference.digest), &state)?;

    let final_observation = inspect_appliance(paths, reference)?;
    if final_observation.classification != Classification::Satisfied {
        return Err(BootstrapError::new(
            ErrorCode::ApplianceStateIncompatible,
            final_observation
                .diagnostic
                .unwrap_or_else(|| "materialized appliance cannot be proven safe".to_owned()),
        ));
    }
    Ok(final_observation.raw_path.expect("just verified"))
}

pub fn inspect_appliance(
    paths: &ManagedPaths,
    reference: &ApplianceReference,
) -> Result<ApplianceObservation, BootstrapError> {
    let raw_path = paths.appliance_raw_path(&reference.digest);
    let state_path = paths.appliance_state_path(&reference.digest);
    let state = read_state(&state_path)?;
    let raw_metadata = fs::symlink_metadata(&raw_path).ok();
    let raw_is_file = raw_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_file());

    let Some(state) = state else {
        return Ok(ApplianceObservation {
            classification: if raw_is_file {
                Classification::Ambiguous
            } else {
                Classification::Missing
            },
            raw_path: None,
            diagnostic: raw_is_file
                .then(|| "an appliance raw disk exists with no managed state record".to_owned()),
        });
    };
    if state.schema_version != APPLIANCE_STATE_SCHEMA_VERSION
        || state.registry != reference.registry
        || state.digest != reference.digest
        || state.repository != reference.repository
    {
        return Ok(ApplianceObservation {
            classification: Classification::Incompatible,
            raw_path: None,
            diagnostic: Some(
                "managed appliance state does not match the supported contract or requested appliance identity"
                    .to_owned(),
            ),
        });
    }
    if !raw_is_file {
        return Ok(ApplianceObservation {
            classification: Classification::Repairable,
            raw_path: None,
            diagnostic: Some(
                "managed appliance state exists but the raw disk is missing".to_owned(),
            ),
        });
    }
    let actual_digest = digest_file(&raw_path)?;
    let actual_size = raw_metadata.map(|metadata| metadata.len()).unwrap_or(0);
    if actual_digest != state.raw_sha256 || actual_size != state.raw_size_bytes {
        return Ok(ApplianceObservation {
            classification: Classification::Incompatible,
            raw_path: None,
            diagnostic: Some(
                "materialized appliance raw disk no longer matches its recorded verified identity"
                    .to_owned(),
            ),
        });
    }
    Ok(ApplianceObservation {
        classification: Classification::Satisfied,
        raw_path: Some(raw_path),
        diagnostic: None,
    })
}

struct LayerDescriptor {
    digest: String,
    size: u64,
}

fn require_manifest_shape(
    manifest: &serde_json::Value,
) -> Result<std::collections::HashMap<String, LayerDescriptor>, BootstrapError> {
    let invalid = || {
        BootstrapError::new(
            ErrorCode::ApplianceManifestInvalid,
            "appliance OCI manifest is not the exact documented Runtime Appliance contract",
        )
    };
    if manifest
        .get("schemaVersion")
        .and_then(serde_json::Value::as_i64)
        != Some(2)
    {
        return Err(invalid());
    }
    if manifest
        .get("mediaType")
        .and_then(serde_json::Value::as_str)
        != Some(APPLIANCE_MANIFEST_MEDIA_TYPE)
    {
        return Err(invalid());
    }
    if manifest
        .get("artifactType")
        .and_then(serde_json::Value::as_str)
        != Some(APPLIANCE_ARTIFACT_TYPE)
    {
        return Err(invalid());
    }
    let layers = manifest
        .get("layers")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(invalid)?;
    if layers.len() != 3 {
        return Err(invalid());
    }
    let mut by_media_type = std::collections::HashMap::with_capacity(3);
    for layer in layers {
        let media_type = layer
            .get("mediaType")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(invalid)?;
        let digest = layer
            .get("digest")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(invalid)?;
        validate_digest(digest).map_err(|_| invalid())?;
        let size = layer
            .get("size")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(invalid)?;
        if by_media_type
            .insert(
                media_type.to_owned(),
                LayerDescriptor {
                    digest: digest.to_owned(),
                    size,
                },
            )
            .is_some()
        {
            return Err(invalid());
        }
    }
    for expected in [
        APPLIANCE_RAW_LAYER_MEDIA_TYPE,
        APPLIANCE_MANIFEST_LAYER_MEDIA_TYPE,
        APPLIANCE_METADATA_LAYER_MEDIA_TYPE,
    ] {
        if !by_media_type.contains_key(expected) {
            return Err(invalid());
        }
    }
    Ok(by_media_type)
}

fn find_layer<'a>(
    layers: &'a std::collections::HashMap<String, LayerDescriptor>,
    media_type: &str,
) -> Result<&'a LayerDescriptor, BootstrapError> {
    layers.get(media_type).ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::ApplianceManifestInvalid,
            format!("appliance OCI manifest is missing the {media_type} layer"),
        )
    })
}

fn cross_verify_metadata(
    manifest: &serde_json::Value,
    metadata: &serde_json::Value,
) -> Result<(), BootstrapError> {
    let invalid = || {
        BootstrapError::new(
            ErrorCode::ApplianceManifestInvalid,
            "appliance manifest/release metadata cross-references do not match",
        )
    };
    let manifest_source = manifest
        .get("sourceRevision")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    let metadata_source = metadata
        .get("sourceRevision")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    if manifest_source != metadata_source {
        return Err(invalid());
    }
    if metadata
        .get("canonicalManifest")
        .and_then(serde_json::Value::as_str)
        != Some("runtime-appliance-manifest.json")
    {
        return Err(invalid());
    }
    let compressed = metadata.get("compressedAsset").ok_or_else(invalid)?;
    if compressed
        .get("filename")
        .and_then(serde_json::Value::as_str)
        != Some("mottainai-runtime-appliance.raw.zst")
    {
        return Err(invalid());
    }
    if compressed.get("format").and_then(serde_json::Value::as_str) != Some("zstd") {
        return Err(invalid());
    }
    Ok(())
}

fn require_string_field(
    value: &serde_json::Value,
    object: &str,
    field: &str,
) -> Result<String, BootstrapError> {
    value
        .get(object)
        .and_then(|nested| nested.get(field))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::ApplianceManifestInvalid,
                format!("appliance manifest is missing {object}.{field}"),
            )
        })
}

fn require_u64_field(
    value: &serde_json::Value,
    object: &str,
    field: &str,
) -> Result<u64, BootstrapError> {
    value
        .get(object)
        .and_then(|nested| nested.get(field))
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::ApplianceManifestInvalid,
                format!("appliance manifest is missing {object}.{field}"),
            )
        })
}

struct RemoveStagedOutputOnFailure<'a> {
    path: &'a std::path::Path,
    active: bool,
}

impl Drop for RemoveStagedOutputOnFailure<'_> {
    fn drop(&mut self) {
        if self.active {
            let _ = fs::remove_file(self.path);
        }
    }
}

/// Decompresses the zstd-compressed appliance disk while hashing the
/// decompressed output in a single pass, bounded by the lower of the
/// manifest's declared size and the product hard limit.
fn decompress_and_hash(
    compressed_path: &std::path::Path,
    destination: &std::path::Path,
    declared_bound_bytes: u64,
) -> Result<(String, u64), BootstrapError> {
    let bound_bytes = effective_raw_bound(declared_bound_bytes);
    let mut cleanup = RemoveStagedOutputOnFailure {
        path: destination,
        active: false,
    };
    let compressed = File::open(compressed_path)
        .map_err(|error| BootstrapError::io("open staged compressed appliance disk", &error))?;
    let mut decoder = ruzstd::StreamingDecoder::new(compressed).map_err(|error| {
        BootstrapError::new(
            ErrorCode::ApplianceManifestInvalid,
            format!("open zstd appliance stream: {error}"),
        )
    })?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| BootstrapError::io("create staged appliance raw disk", &error))?;
    cleanup.active = true;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut total = 0_u64;
    loop {
        // Read only the remaining permitted bytes, plus a one-byte probe
        // at the limit, so no over-limit data is materialized on disk.
        let read_capacity = if total >= bound_bytes {
            1
        } else {
            bound_bytes.saturating_sub(total).min(buffer.len() as u64) as usize
        };
        let read = decoder
            .read(&mut buffer[..read_capacity])
            .map_err(|error| {
                BootstrapError::new(
                    ErrorCode::ApplianceManifestInvalid,
                    format!("decompress appliance disk: {error}"),
                )
            })?;
        if read == 0 {
            break;
        }
        total = total.checked_add(read as u64).ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::ApplianceDigestMismatch,
                "decompressed appliance disk size overflow",
            )
        })?;
        if total > bound_bytes {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceDigestMismatch,
                "decompressed appliance disk exceeds its effective size bound",
            ));
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| BootstrapError::io("write staged appliance raw disk", &error))?;
    }
    output
        .sync_all()
        .map_err(|error| BootstrapError::io("sync staged appliance raw disk", &error))?;
    cleanup.active = false;
    Ok((format!("{:x}", hasher.finalize()), total))
}

fn effective_raw_bound(declared_bound_bytes: u64) -> u64 {
    declared_bound_bytes.min(MAX_APPLIANCE_RAW_BYTES)
}

fn digest_file(path: &std::path::Path) -> Result<String, BootstrapError> {
    let mut file =
        File::open(path).map_err(|error| BootstrapError::io("open appliance raw disk", &error))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| BootstrapError::io("read appliance raw disk", &error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_state(path: &std::path::Path) -> Result<Option<ApplianceState>, BootstrapError> {
    match fs::read(path) {
        Ok(bytes) => {
            if bytes.len() as u64 > MAX_LAYER_JSON_BYTES {
                return Err(BootstrapError::new(
                    ErrorCode::ApplianceStateAmbiguous,
                    "managed appliance state exceeds the bounded state size",
                ));
            }
            serde_json::from_slice(&bytes).map(Some).map_err(|error| {
                BootstrapError::new(
                    ErrorCode::ApplianceStateAmbiguous,
                    format!("managed appliance state is not valid JSON: {error}"),
                )
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(BootstrapError::io("read managed appliance state", &error)),
    }
}

fn write_state(path: &std::path::Path, state: &ApplianceState) -> Result<(), BootstrapError> {
    let temporary = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temporary);
    let serialized = serde_json::to_vec_pretty(state).map_err(|error| {
        BootstrapError::new(
            ErrorCode::IoError,
            format!("serialize managed appliance state: {error}"),
        )
    })?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| BootstrapError::io("create staged managed appliance state", &error))?;
    file.write_all(&serialized)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| BootstrapError::io("write staged managed appliance state", &error))?;
    fs::rename(&temporary, path).map_err(|error| {
        BootstrapError::io("atomically promote managed appliance state", &error)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{decompress_and_hash, effective_raw_bound, MAX_APPLIANCE_RAW_BYTES};
    use crate::error::ErrorCode;
    use std::fs;
    use tempfile::tempdir;

    fn zstd_frame(content: &[u8]) -> Vec<u8> {
        assert!(content.len() < 256);
        let mut frame = vec![0x28, 0xB5, 0x2F, 0xFD, 0b0010_0000, content.len() as u8];
        let header = ((content.len() as u32) << 3) | 1;
        frame.push((header & 0xFF) as u8);
        frame.push(((header >> 8) & 0xFF) as u8);
        frame.push(((header >> 16) & 0xFF) as u8);
        frame.extend_from_slice(content);
        frame
    }

    #[test]
    fn oversized_declared_bound_is_clamped_to_the_product_limit() {
        assert_eq!(effective_raw_bound(u64::MAX), MAX_APPLIANCE_RAW_BYTES);
    }

    #[test]
    fn overexpanding_zstd_stream_removes_partial_output() {
        let temporary = tempdir().unwrap();
        let compressed_path = temporary.path().join("appliance.raw.zst");
        let destination = temporary.path().join("appliance.raw");
        fs::write(&compressed_path, zstd_frame(&[0xA5; 64])).unwrap();

        let error = decompress_and_hash(&compressed_path, &destination, 32).unwrap_err();

        assert_eq!(error.code, ErrorCode::ApplianceDigestMismatch);
        assert!(
            !destination.exists(),
            "partial oversized output must be removed"
        );
    }
}
