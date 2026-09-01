use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use mottainai_host_bootstrap::appliance::{
    ensure_appliance, inspect_appliance, ApplianceReference,
};
use mottainai_host_bootstrap::error::{BootstrapError, ErrorCode};
use mottainai_host_bootstrap::model::Classification;
use mottainai_host_bootstrap::oci::OciSource;
use mottainai_host_bootstrap::paths::{ensure_managed_directories, ManagedPaths};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

/// Hand-builds a minimal, spec-valid single-frame zstd stream containing
/// `content` as one uncompressed "Raw_Block". This is the smallest correct
/// zstd encoding (no compression library or external `zstd` binary
/// required) and is exactly what any conformant zstd decoder, including the
/// pure-Rust `ruzstd` this crate uses, must be able to read.
fn zstd_frame(content: &[u8]) -> Vec<u8> {
    assert!(
        content.len() < 256,
        "fixture helper only supports small payloads"
    );
    let mut frame = vec![0x28, 0xB5, 0x2F, 0xFD];
    // Frame_Header_Descriptor: Single_Segment_flag set, all other flags 0,
    // so exactly one Frame_Content_Size byte follows.
    frame.push(0b0010_0000);
    frame.push(content.len() as u8);
    // Block_Header: Last_Block=1, Block_Type=0 (Raw_Block), Block_Size=len.
    let header = ((content.len() as u32) << 3) | 1;
    frame.push((header & 0xFF) as u8);
    frame.push(((header >> 8) & 0xFF) as u8);
    frame.push(((header >> 16) & 0xFF) as u8);
    frame.extend_from_slice(content);
    frame
}

fn digest_of(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[derive(Default)]
struct FixtureOci {
    blobs: HashMap<String, Vec<u8>>,
    manifest: Option<(String, Vec<u8>)>,
    fetch_manifest_calls: AtomicUsize,
    fetch_blob_calls: AtomicUsize,
}

impl OciSource for FixtureOci {
    fn fetch_manifest(&self, _repository: &str, digest: &str) -> Result<Vec<u8>, BootstrapError> {
        self.fetch_manifest_calls.fetch_add(1, Ordering::SeqCst);
        let (expected_digest, bytes) = self.manifest.as_ref().expect("fixture manifest configured");
        if digest != expected_digest {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                "fixture manifest digest mismatch",
            ));
        }
        Ok(bytes.clone())
    }

    fn fetch_blob(
        &self,
        _repository: &str,
        digest: &str,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(), BootstrapError> {
        self.fetch_blob_calls.fetch_add(1, Ordering::SeqCst);
        let bytes = self.blobs.get(digest).ok_or_else(|| {
            BootstrapError::new(ErrorCode::ApplianceDownloadFailed, "fixture blob not found")
        })?;
        if bytes.len() as u64 > max_bytes {
            return Err(BootstrapError::new(
                ErrorCode::ApplianceDownloadFailed,
                "fixture blob exceeds bound",
            ));
        }
        fs::write(destination, bytes)
            .map_err(|error| BootstrapError::io("write fixture blob", &error))
    }
}

struct Fixture {
    oci: FixtureOci,
    reference: ApplianceReference,
    raw_bytes: Vec<u8>,
}

fn build_fixture() -> Fixture {
    let raw_bytes = b"fixture-mottainai-runtime-appliance-raw-disk".to_vec();
    let compressed = zstd_frame(&raw_bytes);
    let raw_sha256 = format!("{:x}", Sha256::digest(&raw_bytes));
    let compressed_digest = digest_of(&compressed);

    let appliance_manifest = serde_json::json!({
        "sourceRevision": "abc123",
        "image": { "sha256": raw_sha256, "sizeBytes": raw_bytes.len() as u64 },
    });
    let appliance_manifest_bytes = serde_json::to_vec(&appliance_manifest).unwrap();
    let appliance_manifest_digest = digest_of(&appliance_manifest_bytes);

    let release_metadata = build_release_metadata(
        format!("{:x}", Sha256::digest(&compressed)),
        compressed.len() as u64,
    );
    let release_metadata_bytes = serde_json::to_vec(&release_metadata).unwrap();
    let release_metadata_digest = digest_of(&release_metadata_bytes);

    let oci_manifest = serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "artifactType": "application/vnd.mottainai.runtime.appliance.v1",
        "layers": [
            {
                "mediaType": "application/vnd.mottainai.runtime.appliance.raw.v1+zstd",
                "digest": compressed_digest,
                "size": compressed.len() as u64,
            },
            {
                "mediaType": "application/vnd.mottainai.runtime.appliance.manifest.v1+json",
                "digest": appliance_manifest_digest,
                "size": appliance_manifest_bytes.len() as u64,
            },
            {
                "mediaType": "application/vnd.mottainai.runtime.appliance.release-metadata.v1+json",
                "digest": release_metadata_digest,
                "size": release_metadata_bytes.len() as u64,
            },
        ],
    });
    let oci_manifest_bytes = serde_json::to_vec(&oci_manifest).unwrap();
    let oci_manifest_digest = digest_of(&oci_manifest_bytes);

    let mut blobs = HashMap::new();
    blobs.insert(compressed_digest, compressed);
    blobs.insert(appliance_manifest_digest, appliance_manifest_bytes);
    blobs.insert(release_metadata_digest, release_metadata_bytes);

    let oci = FixtureOci {
        blobs,
        manifest: Some((oci_manifest_digest.clone(), oci_manifest_bytes)),
        fetch_manifest_calls: AtomicUsize::new(0),
        fetch_blob_calls: AtomicUsize::new(0),
    };
    let reference = ApplianceReference {
        registry: "ghcr.io".to_owned(),
        repository: "yohn-jp/mottainai/runtime-appliance".to_owned(),
        digest: oci_manifest_digest,
    };
    Fixture {
        oci,
        reference,
        raw_bytes,
    }
}

fn replace_appliance_manifest(fixture: &mut Fixture, image_sha256: &str, image_size: u64) {
    let appliance_manifest = serde_json::json!({
        "sourceRevision": "abc123",
        "image": { "sha256": image_sha256, "sizeBytes": image_size },
    });
    let appliance_manifest_bytes = serde_json::to_vec(&appliance_manifest).unwrap();
    let appliance_manifest_digest = digest_of(&appliance_manifest_bytes);
    fixture.oci.blobs.insert(
        appliance_manifest_digest.clone(),
        appliance_manifest_bytes.clone(),
    );

    let (_, oci_manifest_bytes) = fixture.oci.manifest.take().unwrap();
    let mut oci_manifest: serde_json::Value = serde_json::from_slice(&oci_manifest_bytes).unwrap();
    let layer = oci_manifest["layers"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|layer| {
            layer.get("mediaType").and_then(serde_json::Value::as_str)
                == Some("application/vnd.mottainai.runtime.appliance.manifest.v1+json")
        })
        .unwrap();
    layer["digest"] = serde_json::json!(appliance_manifest_digest);
    layer["size"] = serde_json::json!(appliance_manifest_bytes.len() as u64);

    let oci_manifest_bytes = serde_json::to_vec(&oci_manifest).unwrap();
    let oci_manifest_digest = digest_of(&oci_manifest_bytes);
    fixture.oci.manifest = Some((oci_manifest_digest.clone(), oci_manifest_bytes));
    fixture.reference.digest = oci_manifest_digest;
}

fn build_release_metadata(sha256: String, size_bytes: u64) -> serde_json::Value {
    serde_json::json!({
        "sourceRevision": "abc123",
        "canonicalManifest": "runtime-appliance-manifest.json",
        "compressedAsset": {
            "filename": "mottainai-runtime-appliance.raw.zst",
            "format": "zstd",
            "sha256": sha256,
            "sizeBytes": size_bytes,
        },
    })
}

fn valid_compressed_size(fixture: &Fixture) -> u64 {
    zstd_frame(&fixture.raw_bytes).len() as u64
}

fn update_oci_manifest(fixture: &mut Fixture, update: impl FnOnce(&mut serde_json::Value)) {
    let (_, bytes) = fixture
        .oci
        .manifest
        .take()
        .expect("fixture manifest configured");
    let mut manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    update(&mut manifest);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = digest_of(&bytes);
    fixture.oci.manifest = Some((digest.clone(), bytes));
    fixture.reference.digest = digest;
}

fn replace_release_metadata(fixture: &mut Fixture, metadata: serde_json::Value) {
    let bytes = serde_json::to_vec(&metadata).unwrap();
    let digest = digest_of(&bytes);
    let size = bytes.len() as u64;
    fixture.oci.blobs.insert(digest.clone(), bytes);
    update_oci_manifest(fixture, |manifest| {
        let layer = manifest
            .get_mut("layers")
            .and_then(serde_json::Value::as_array_mut)
            .and_then(|layers| {
                layers.iter_mut().find(|layer| {
                    layer.get("mediaType").and_then(serde_json::Value::as_str)
                        == Some(
                            "application/vnd.mottainai.runtime.appliance.release-metadata.v1+json",
                        )
                })
            })
            .expect("fixture release metadata layer");
        layer["digest"] = serde_json::json!(digest);
        layer["size"] = serde_json::json!(size);
    });
}

fn set_raw_layer_size(fixture: &mut Fixture, size: u64) {
    update_oci_manifest(fixture, |manifest| {
        let layer = manifest
            .get_mut("layers")
            .and_then(serde_json::Value::as_array_mut)
            .and_then(|layers| {
                layers.iter_mut().find(|layer| {
                    layer.get("mediaType").and_then(serde_json::Value::as_str)
                        == Some("application/vnd.mottainai.runtime.appliance.raw.v1+zstd")
                })
            })
            .expect("fixture raw layer");
        layer["size"] = serde_json::json!(size);
    });
}

fn managed_paths() -> (TempDir, ManagedPaths) {
    let temporary = TempDir::new().unwrap();
    let paths = ManagedPaths::new(temporary.path().join("state"));
    ensure_managed_directories(&paths).unwrap();
    (temporary, paths)
}

fn rewrite_appliance_state_field(
    paths: &ManagedPaths,
    reference: &ApplianceReference,
    field: &str,
    value: &str,
) {
    let state_path = paths.appliance_state_path(&reference.digest);
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    state[field] = serde_json::Value::String(value.to_owned());
    fs::write(state_path, serde_json::to_vec_pretty(&state).unwrap()).unwrap();
}

fn assert_appliance_schema_is_incompatible(schema_version: &str) {
    let fixture = build_fixture();
    let (_temp, paths) = managed_paths();
    ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap();
    let raw_path = paths.appliance_raw_path(&fixture.reference.digest);
    let raw_before = fs::read(&raw_path).unwrap();
    rewrite_appliance_state_field(&paths, &fixture.reference, "schema_version", schema_version);
    let state_path = paths.appliance_state_path(&fixture.reference.digest);
    let state_before = fs::read(&state_path).unwrap();

    let observation = inspect_appliance(&paths, &fixture.reference).unwrap();
    assert_eq!(observation.classification, Classification::Incompatible);
    assert!(observation.raw_path.is_none());

    fixture.oci.fetch_manifest_calls.store(0, Ordering::SeqCst);
    fixture.oci.fetch_blob_calls.store(0, Ordering::SeqCst);
    let error = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplianceStateIncompatible);
    assert_eq!(fixture.oci.fetch_manifest_calls.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.oci.fetch_blob_calls.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read(raw_path).unwrap(), raw_before);
    assert_eq!(fs::read(state_path).unwrap(), state_before);
}

fn assert_appliance_identity_is_incompatible(field: &str, value: &str) {
    let fixture = build_fixture();
    let (_temp, paths) = managed_paths();
    ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap();
    let raw_path = paths.appliance_raw_path(&fixture.reference.digest);
    let raw_before = fs::read(&raw_path).unwrap();
    rewrite_appliance_state_field(&paths, &fixture.reference, field, value);
    let state_path = paths.appliance_state_path(&fixture.reference.digest);
    let state_before = fs::read(&state_path).unwrap();

    let observation = inspect_appliance(&paths, &fixture.reference).unwrap();
    assert_eq!(observation.classification, Classification::Incompatible);
    assert!(observation.raw_path.is_none());

    fixture.oci.fetch_manifest_calls.store(0, Ordering::SeqCst);
    fixture.oci.fetch_blob_calls.store(0, Ordering::SeqCst);
    let error = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplianceStateIncompatible);
    assert_eq!(fixture.oci.fetch_manifest_calls.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.oci.fetch_blob_calls.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read(raw_path).unwrap(), raw_before);
    assert_eq!(fs::read(state_path).unwrap(), state_before);
}

#[test]
fn valid_appliance_is_resolved_verified_and_materialized() {
    let fixture = build_fixture();
    let (_temp, paths) = managed_paths();
    let raw_path = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap();
    assert_eq!(fs::read(&raw_path).unwrap(), fixture.raw_bytes);
    assert_eq!(fixture.oci.fetch_manifest_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn wrong_compressed_sha_fails_closed() {
    let mut fixture = build_fixture();
    let metadata = build_release_metadata("0".repeat(64), valid_compressed_size(&fixture));
    replace_release_metadata(&mut fixture, metadata);

    let (_temp, paths) = managed_paths();
    let error = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplianceManifestInvalid);
}

#[test]
fn wrong_compressed_size_fails_closed() {
    let mut fixture = build_fixture();
    let metadata = build_release_metadata(
        format!("{:x}", Sha256::digest(zstd_frame(&fixture.raw_bytes))),
        valid_compressed_size(&fixture) + 1,
    );
    replace_release_metadata(&mut fixture, metadata);

    let (_temp, paths) = managed_paths();
    let error = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplianceManifestInvalid);
}

#[test]
fn wrong_oci_descriptor_size_fails_closed() {
    let mut fixture = build_fixture();
    let wrong_size = valid_compressed_size(&fixture) + 1;
    set_raw_layer_size(&mut fixture, wrong_size);

    let (_temp, paths) = managed_paths();
    let error = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplianceManifestInvalid);
}

#[test]
fn compressed_bytes_digest_mismatch_fails_closed() {
    let mut fixture = build_fixture();
    let compressed_digest = digest_of(&zstd_frame(&fixture.raw_bytes));
    let compressed = fixture
        .oci
        .blobs
        .get_mut(&compressed_digest)
        .expect("fixture compressed blob");
    let last = compressed.len() - 1;
    compressed[last] ^= 1;

    let (_temp, paths) = managed_paths();
    let error = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplianceManifestInvalid);
}

#[test]
fn repeated_ensure_is_idempotent_and_touches_no_network() {
    let fixture = build_fixture();
    let (_temp, paths) = managed_paths();
    ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap();
    let calls_after_first = fixture.oci.fetch_manifest_calls.load(Ordering::SeqCst);
    assert_eq!(calls_after_first, 1);

    let raw_path = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap();
    assert_eq!(fs::read(&raw_path).unwrap(), fixture.raw_bytes);
    assert_eq!(
        fixture.oci.fetch_manifest_calls.load(Ordering::SeqCst),
        calls_after_first,
        "an already-verified digest must not be re-fetched"
    );
    assert_eq!(fixture.oci.fetch_blob_calls.load(Ordering::SeqCst), 3);
}

#[test]
fn oversized_declared_raw_image_is_rejected_before_decompression() {
    let mut fixture = build_fixture();
    let raw_sha256 = format!("{:x}", Sha256::digest(&fixture.raw_bytes));
    replace_appliance_manifest(&mut fixture, &raw_sha256, u64::MAX);

    let (_temp, paths) = managed_paths();
    let error = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplianceManifestInvalid);
    assert_eq!(fixture.oci.fetch_blob_calls.load(Ordering::SeqCst), 2);
    assert!(
        !paths
            .staging_appliance_directory()
            .join("mottainai-runtime-appliance.raw")
            .exists(),
        "an oversized declared image must not be materialized"
    );
}

#[test]
fn ambiguous_orphaned_raw_disk_keeps_the_existing_verified_repair_policy() {
    let fixture = build_fixture();
    let (_temp, paths) = managed_paths();
    let raw_path = paths.appliance_raw_path(&fixture.reference.digest);
    fs::create_dir_all(raw_path.parent().unwrap()).unwrap();
    fs::write(&raw_path, b"orphaned-raw-disk").unwrap();

    let observation = inspect_appliance(&paths, &fixture.reference).unwrap();
    assert_eq!(observation.classification, Classification::Ambiguous);

    let repaired_path = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap();
    assert_eq!(fs::read(repaired_path).unwrap(), fixture.raw_bytes);
    assert_eq!(fixture.oci.fetch_manifest_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn appliance_state_with_wrong_schema_is_not_satisfied() {
    assert_appliance_schema_is_incompatible("mottainai.host-bootstrap.appliance.legacy");
}

#[test]
fn appliance_state_with_future_schema_is_not_satisfied() {
    assert_appliance_schema_is_incompatible("mottainai.host-bootstrap.appliance.v2");
}

#[test]
fn appliance_state_with_mismatched_registry_is_not_satisfied() {
    assert_appliance_identity_is_incompatible("registry", "registry.example.invalid");
}

#[test]
fn appliance_state_with_mismatched_repository_is_not_satisfied() {
    assert_appliance_identity_is_incompatible("repository", "other/runtime-appliance");
}

#[test]
fn appliance_state_with_mismatched_digest_is_not_satisfied() {
    assert_appliance_identity_is_incompatible("digest", &format!("sha256:{}", "0".repeat(64)));
}

#[test]
fn malformed_appliance_state_fails_closed() {
    let fixture = build_fixture();
    let (_temp, paths) = managed_paths();
    let state_path = paths.appliance_state_path(&fixture.reference.digest);
    fs::create_dir_all(state_path.parent().unwrap()).unwrap();
    fs::write(state_path, b"{not valid json").unwrap();

    let error = match inspect_appliance(&paths, &fixture.reference) {
        Ok(_) => panic!("malformed appliance state must fail closed"),
        Err(error) => error,
    };
    assert_eq!(error.code, ErrorCode::ApplianceStateAmbiguous);
}

#[test]
fn manifest_shape_mismatch_fails_closed() {
    let mut fixture = build_fixture();
    let tampered = serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "artifactType": "application/vnd.mottainai.runtime.appliance.v1",
        "layers": [],
    });
    let bytes = serde_json::to_vec(&tampered).unwrap();
    let digest = digest_of(&bytes);
    fixture.oci.manifest = Some((digest.clone(), bytes));
    fixture.reference.digest = digest;

    let (_temp, paths) = managed_paths();
    let error = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplianceManifestInvalid);
}

#[test]
fn decompressed_disk_digest_mismatch_fails_closed() {
    let mut fixture = build_fixture();
    // Corrupt the declared image digest inside the appliance manifest layer
    // so the decompressed disk no longer matches its claimed identity.
    let appliance_manifest = serde_json::json!({
        "sourceRevision": "abc123",
        "image": { "sha256": "0".repeat(64), "sizeBytes": fixture.raw_bytes.len() as u64 },
    });
    let bytes = serde_json::to_vec(&appliance_manifest).unwrap();
    let digest = digest_of(&bytes);

    // Rebuild the OCI manifest to reference the tampered appliance-manifest
    // layer by its new digest, then re-point every fixture structure at it.
    let compressed = zstd_frame(&fixture.raw_bytes);
    let compressed_digest = digest_of(&compressed);
    let release_metadata = serde_json::json!({
        "sourceRevision": "abc123",
        "canonicalManifest": "runtime-appliance-manifest.json",
        "compressedAsset": {
            "filename": "mottainai-runtime-appliance.raw.zst",
            "format": "zstd",
            "sha256": format!("{:x}", Sha256::digest(&compressed)),
            "sizeBytes": compressed.len() as u64,
        },
    });
    let release_metadata_bytes = serde_json::to_vec(&release_metadata).unwrap();
    let release_metadata_digest = digest_of(&release_metadata_bytes);

    let oci_manifest = serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "artifactType": "application/vnd.mottainai.runtime.appliance.v1",
        "layers": [
            { "mediaType": "application/vnd.mottainai.runtime.appliance.raw.v1+zstd", "digest": compressed_digest, "size": compressed.len() as u64 },
            { "mediaType": "application/vnd.mottainai.runtime.appliance.manifest.v1+json", "digest": digest, "size": bytes.len() as u64 },
            { "mediaType": "application/vnd.mottainai.runtime.appliance.release-metadata.v1+json", "digest": release_metadata_digest, "size": release_metadata_bytes.len() as u64 },
        ],
    });
    let oci_manifest_bytes = serde_json::to_vec(&oci_manifest).unwrap();
    let oci_manifest_digest = digest_of(&oci_manifest_bytes);

    fixture.oci.blobs.insert(compressed_digest, compressed);
    fixture.oci.blobs.insert(digest, bytes);
    fixture
        .oci
        .blobs
        .insert(release_metadata_digest, release_metadata_bytes);
    fixture.oci.manifest = Some((oci_manifest_digest.clone(), oci_manifest_bytes));
    fixture.reference.digest = oci_manifest_digest;

    let (_temp, paths) = managed_paths();
    let error = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplianceDigestMismatch);
}

#[test]
fn tampered_materialized_raw_disk_is_detected_as_incompatible_and_not_replaced() {
    let fixture = build_fixture();
    let (_temp, paths) = managed_paths();
    let raw_path = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap();
    fs::write(&raw_path, b"tampered-after-verification").unwrap();

    // A tampered materialization is never silently reused as-is: inspection
    // must classify it Incompatible rather than Satisfied.
    let observation = inspect_appliance(&paths, &fixture.reference).unwrap();
    assert_eq!(observation.classification, Classification::Incompatible);

    // An incompatible managed state is not replaced implicitly, even when
    // the trusted OCI source remains available.
    let fetches_before = fixture.oci.fetch_manifest_calls.load(Ordering::SeqCst);
    let error = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplianceStateIncompatible);
    assert_eq!(
        fixture.oci.fetch_manifest_calls.load(Ordering::SeqCst),
        fetches_before
    );
    assert_eq!(fs::read(raw_path).unwrap(), b"tampered-after-verification");
}

#[test]
fn non_digest_reference_is_rejected() {
    let fixture = build_fixture();
    let (_temp, paths) = managed_paths();
    let mut mutable_reference = fixture.reference.clone();
    mutable_reference.digest = "contract-v1".to_owned();
    let error = ensure_appliance(&paths, &mutable_reference, &fixture.oci).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplianceReferenceInvalid);
}
