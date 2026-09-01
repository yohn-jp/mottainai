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
    let oci_manifest_path = required_env("MOTTAINAI_REAL_APPLIANCE_OCI_MANIFEST");
    let blobs_directory = required_env("MOTTAINAI_REAL_APPLIANCE_BLOBS_DIR");
    let real_raw_disk = required_env("MOTTAINAI_REAL_APPLIANCE_RAW_DISK");

    let digest = format!("sha256:{}", digest_file(&oci_manifest_path));
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

    assert_eq!(
        digest_file(&materialized_path),
        digest_file(&real_raw_disk),
        "materialized appliance disk must be byte-identical to the real Nix-built disk"
    );

    // Idempotent re-run against the real artifact must not touch the fixture
    // source again; FileOciSource has no call counters, so this simply
    // proves the second call still succeeds purely from managed state.
    let second = ensure_appliance(&paths, &reference, &source).unwrap();
    assert_eq!(second, materialized_path);
}
