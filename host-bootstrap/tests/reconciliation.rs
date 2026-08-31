use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use flate2::{write::GzEncoder, Compression};
use mottainai_host_bootstrap::contract::ProviderContract;
use mottainai_host_bootstrap::error::{BootstrapError, ErrorCode};
use mottainai_host_bootstrap::host::{HostObservation, KvmObservation};
use mottainai_host_bootstrap::lock::BootstrapLock;
use mottainai_host_bootstrap::model::{Classification, Outcome};
use mottainai_host_bootstrap::paths::{ensure_managed_directories, ManagedPaths};
use mottainai_host_bootstrap::provider::ArtifactSource;
use mottainai_host_bootstrap::reconcile::{Bootstrap, BootstrapConfig};
use sha2::{Digest, Sha256};
use tar::{Builder, Header};
use tempfile::TempDir;

#[derive(Clone)]
struct FixtureSource {
    bytes: Arc<Vec<u8>>,
    calls: Arc<AtomicUsize>,
}

impl ArtifactSource for FixtureSource {
    fn download(
        &self,
        _contract: &ProviderContract,
        destination: &Path,
    ) -> Result<(), BootstrapError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .map_err(|error| BootstrapError::io("create fixture download", &error))?;
        file.write_all(&self.bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| BootstrapError::io("write fixture download", &error))
    }
}

fn archive() -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    {
        let mut builder = Builder::new(&mut encoder);
        let contents = b"#!/bin/sh\nexit 0\n";
        let mut header = Header::new_gnu();
        header.set_path("./bin/limactl").unwrap();
        header.set_size(contents.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append(&header, &contents[..]).unwrap();
        let mut link = Header::new_gnu();
        link.set_path("./share/doc/lima/templates").unwrap();
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_link_name("../../lima/templates").unwrap();
        link.set_size(0);
        link.set_cksum();
        builder.append(&link, io::empty()).unwrap();
        builder.finish().unwrap();
    }
    encoder.finish().unwrap()
}

fn contract(bytes: &[u8]) -> ProviderContract {
    let digest = format!("{:x}", Sha256::digest(bytes));
    ProviderContract {
        artifact_id: "fixture-lima-linux-x86_64".to_owned(),
        artifact_sha256: digest,
        ..ProviderContract::default()
    }
}

fn config(root: PathBuf, contract: ProviderContract) -> BootstrapConfig {
    BootstrapConfig {
        state_directory: root,
        kvm_path: PathBuf::from("/unused-in-test"),
        contract,
        environment_path: None,
        host_override: Some(HostObservation {
            os: "linux".to_owned(),
            architecture: "x86_64".to_owned(),
            kernel: Some("test-kernel".to_owned()),
            kvm: KvmObservation {
                path: "/dev/kvm".to_owned(),
                exists: true,
                character_device: Some(true),
                access_checked: true,
                current_user_access: Some(true),
                diagnostic: None,
            },
        }),
    }
}

fn fixture() -> (TempDir, ProviderContract, FixtureSource, BootstrapConfig) {
    let temporary = tempfile::tempdir().unwrap();
    let bytes = archive();
    let source = FixtureSource {
        bytes: Arc::new(bytes.clone()),
        calls: Arc::new(AtomicUsize::new(0)),
    };
    let contract = contract(&bytes);
    let bootstrap = config(temporary.path().to_path_buf(), contract.clone());
    (temporary, contract, source, bootstrap)
}

#[test]
fn verified_materialization_promotes_only_after_digest_verification() {
    let (_temporary, contract, source, bootstrap_config) = fixture();
    let evidence = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(evidence.result, Outcome::Changed);
    assert_eq!(evidence.steps[0].classification, Classification::Satisfied);
    assert_eq!(evidence.steps[1].classification, Classification::Missing);
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);

    let paths = bootstrap_config.paths();
    assert!(paths.active_link.is_symlink());
    assert!(paths.archive_path(&contract.artifact_id).is_file());
    assert!(paths
        .provider_directory(&contract.artifact_id)
        .join("bin/limactl")
        .is_file());
    assert!(paths.state_file.is_file());
}

#[test]
fn checksum_rejection_never_activates_an_artifact() {
    let (_temporary, mut contract, source, bootstrap_config) = fixture();
    contract.artifact_sha256 = "0".repeat(64);
    let evidence = Bootstrap::new(config(
        bootstrap_config.state_directory.clone(),
        contract.clone(),
    ))
    .reconcile_with_source(source);
    assert_eq!(evidence.result, Outcome::Blocked);
    assert_eq!(
        evidence.error_code.as_deref(),
        Some("provider_checksum_mismatch")
    );
    let paths = ManagedPaths::new(bootstrap_config.state_directory);
    assert!(!paths.active_link.exists());
    assert!(!paths.state_file.exists());
    assert!(!paths.provider_directory(&contract.artifact_id).exists());
}

#[test]
fn interrupted_staging_and_partial_download_are_recoverable() {
    let (_temporary, contract, source, bootstrap_config) = fixture();
    let paths = bootstrap_config.paths();
    ensure_managed_directories(&paths).unwrap();
    fs::create_dir_all(paths.staging_provider_directory().join("bin")).unwrap();
    fs::write(
        paths.staging_provider_directory().join("bin/partial"),
        b"partial",
    )
    .unwrap();
    fs::write(
        paths
            .archive_path(&contract.artifact_id)
            .with_extension("tar.gz.part"),
        b"partial",
    )
    .unwrap();

    let evidence = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source);
    assert_eq!(evidence.result, Outcome::Changed);
    assert!(!paths.staging_provider_directory().exists());
    assert!(paths.active_link.is_symlink());
}

#[test]
fn lock_behavior_is_non_blocking_and_released_on_drop() {
    let (_temporary, _contract, _source, bootstrap_config) = fixture();
    let paths = bootstrap_config.paths();
    fs::create_dir_all(&paths.root).unwrap();
    let first = BootstrapLock::acquire(&paths).unwrap();
    let second = BootstrapLock::acquire(&paths).unwrap_err();
    assert_eq!(second.code, ErrorCode::BootstrapLocked);
    drop(first);
    assert!(BootstrapLock::acquire(&paths).is_ok());
}

#[test]
fn second_successful_run_is_a_no_op_and_does_not_download_again() {
    let (_temporary, _contract, source, bootstrap_config) = fixture();
    let first = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(first.result, Outcome::Changed);
    let state_before = fs::read_to_string(&bootstrap_config.paths().state_file).unwrap();
    let second = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(second.result, Outcome::NoOp);
    assert!(!second.changed);
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        fs::read_to_string(&bootstrap_config.paths().state_file).unwrap(),
        state_before
    );
}

#[test]
fn verified_active_provider_without_state_is_repaired_without_redownload() {
    let (_temporary, _contract, source, bootstrap_config) = fixture();
    let first = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(first.result, Outcome::Changed);
    fs::remove_file(&bootstrap_config.paths().state_file).unwrap();

    let second = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(second.result, Outcome::Changed);
    assert_eq!(second.steps[1].classification, Classification::Repairable);
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    assert!(bootstrap_config.paths().state_file.is_file());
}

#[cfg(unix)]
#[test]
fn ambient_provider_is_not_adopted() {
    use std::os::unix::fs::PermissionsExt;

    let (_temporary, _contract, source, mut bootstrap_config) = fixture();
    let ambient_directory = tempfile::tempdir().unwrap();
    let ambient_binary = ambient_directory.path().join("limactl");
    fs::write(&ambient_binary, b"ambient").unwrap();
    fs::set_permissions(&ambient_binary, fs::Permissions::from_mode(0o755)).unwrap();
    bootstrap_config.environment_path = Some(OsString::from(ambient_directory.path()));

    let evidence = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(evidence.result, Outcome::Blocked);
    assert_eq!(
        evidence.steps[1].classification,
        Classification::Incompatible
    );
    assert_eq!(
        evidence.error_code.as_deref(),
        Some("provider_state_incompatible")
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    assert!(!bootstrap_config.paths().active_link.exists());
}
