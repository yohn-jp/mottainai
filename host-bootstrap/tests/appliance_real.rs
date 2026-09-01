//! Issue #661 review: a bounded composition proof that
//! `mottainai-init`'s appliance resolution/verification
//! (`host-bootstrap/src/appliance.rs`) works against the *real* canonical
//! Runtime Appliance output, not only synthetic fixture bytes.
//!
//! This does not require KVM. It requires the real Nix-built Appliance disk
//! and manifest plus a local OCI-shaped layout built by
//! `scripts/build-runtime-appliance-oci-fixture.mjs`, so it is `#[ignore]`d
//! by default and driven explicitly in CI (the "Nix Runtime evaluation /
//! image / VM test" job) once those real artifacts exist. Running
//! `cargo test` normally never needs Nix and is unaffected.

use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::time::Instant;

use mottainai_host_bootstrap::appliance::{ensure_appliance, ApplianceReference};
use mottainai_host_bootstrap::oci::FileOciSource;
use mottainai_host_bootstrap::paths::{ensure_managed_directories, ManagedPaths};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn digest_file(path: &std::path::Path) -> String {
    let mut file =
        File::open(path).unwrap_or_else(|error| panic!("open {}: {error}", path.display()));
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).expect("read fixture file");
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    format!("{:x}", hasher.finalize())
}

fn report_phase(started: Instant, phase: &str) {
    eprintln!(
        "appliance_real timing phase={phase} elapsed_ms={}",
        started.elapsed().as_millis()
    );
}

fn assert_files_equal(left_path: &std::path::Path, right_path: &std::path::Path) {
    let left_metadata = std::fs::metadata(left_path).unwrap();
    let right_metadata = std::fs::metadata(right_path).unwrap();
    assert_eq!(
        left_metadata.len(),
        right_metadata.len(),
        "materialized appliance disk size must match the real Nix-built disk"
    );

    let mut left = File::open(left_path).unwrap();
    let mut right = File::open(right_path).unwrap();
    let mut left_buffer = vec![0_u8; 1024 * 1024];
    let mut right_buffer = vec![0_u8; 1024 * 1024];
    loop {
        let left_read = left.read(&mut left_buffer).unwrap();
        let right_read = right.read(&mut right_buffer).unwrap();
        assert_eq!(
            left_read, right_read,
            "appliance disk streams must have equal length"
        );
        if left_read == 0 {
            break;
        }
        assert_eq!(
            &left_buffer[..left_read],
            &right_buffer[..right_read],
            "materialized appliance disk must be byte-identical to the real Nix-built disk"
        );
    }
}

fn required_env(name: &str) -> PathBuf {
    std::env::var(name)
        .unwrap_or_else(|_| {
            panic!(
                "{name} must be set (see scripts/build-runtime-appliance-oci-fixture.mjs and the \
                 CI step that runs this ignored test against the real Nix-built Appliance)"
            )
        })
        .into()
}

#[test]
#[ignore = "requires the real Nix-built canonical Runtime Appliance; wired explicitly in CI"]
fn real_canonical_appliance_resolves_verifies_and_matches_the_built_disk() {
    let started = Instant::now();
    let oci_manifest_path = required_env("MOTTAINAI_REAL_APPLIANCE_OCI_MANIFEST");
    let blobs_directory = required_env("MOTTAINAI_REAL_APPLIANCE_BLOBS_DIR");
    let real_raw_disk = required_env("MOTTAINAI_REAL_APPLIANCE_RAW_DISK");

    let digest = format!("sha256:{}", digest_file(&oci_manifest_path));
    report_phase(started, "manifest-digest");
    let reference = ApplianceReference {
        registry: "local-fixture".to_owned(),
        repository: "mottainai/runtime-appliance".to_owned(),
        digest,
    };
    let source = FileOciSource {
        manifest_path: oci_manifest_path,
        blobs_directory,
    };

    let temporary = TempDir::new().unwrap();
    let paths = ManagedPaths::new(temporary.path().join("state"));
    ensure_managed_directories(&paths).unwrap();

    let materialized_path = ensure_appliance(&paths, &reference, &source)
        .expect("the real canonical Runtime Appliance must resolve and verify");
    report_phase(
        started,
        "oci-resolution-blob-decompression-materialization-hash",
    );

    assert_files_equal(&materialized_path, &real_raw_disk);
    report_phase(started, "canonical-disk-byte-equality");

    // FileOciSource has no network wait, retry, or VM readiness phase. The
    // regular appliance unit suite retains the repeated-ensure/idempotency
    // proof; this real-artifact test avoids rereading a multi-gigabyte disk.
    eprintln!("appliance_real timing phase=locking-readiness-retry-vm-not-applicable elapsed_ms=0");
    drop(temporary);
    report_phase(started, "cleanup");
}
