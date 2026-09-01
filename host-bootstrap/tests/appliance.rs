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

fn managed_paths() -> (TempDir, ManagedPaths) {
    let temporary = TempDir::new().unwrap();
    let paths = ManagedPaths::new(temporary.path().join("state"));
    ensure_managed_directories(&paths).unwrap();
    (temporary, paths)
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
fn tampered_materialized_raw_disk_is_detected_as_incompatible_and_self_healed() {
    let fixture = build_fixture();
    let (_temp, paths) = managed_paths();
    let raw_path = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap();
    fs::write(&raw_path, b"tampered-after-verification").unwrap();

    // A tampered materialization is never silently reused as-is: inspection
    // must classify it Incompatible rather than Satisfied.
    let observation = inspect_appliance(&paths, &fixture.reference).unwrap();
    assert_eq!(observation.classification, Classification::Incompatible);

    // `ensure_appliance` still converges to a verified state by re-deriving
    // it from the trusted OCI source, exactly like the managed Lima
    // provider's own repair path; it does not fail closed forever just
    // because a repair source remains available.
    let repaired_path = ensure_appliance(&paths, &fixture.reference, &fixture.oci).unwrap();
    assert_eq!(fs::read(repaired_path).unwrap(), fixture.raw_bytes);
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
