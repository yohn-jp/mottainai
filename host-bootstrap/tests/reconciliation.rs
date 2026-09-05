use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Barrier,
};
use std::thread;

use flate2::{write::GzEncoder, Compression};
use mottainai_host_bootstrap::appliance::ApplianceReference;
use mottainai_host_bootstrap::contract::ProviderContract;
use mottainai_host_bootstrap::deployment_descriptor::{
    provider_requirement_from_descriptor, Route4ProviderRequirement,
};
use mottainai_host_bootstrap::error::{BootstrapError, ErrorCode};
use mottainai_host_bootstrap::host::{HostObservation, KvmObservation};
use mottainai_host_bootstrap::lima::{RuntimeSpec, RUNTIME_SPEC_SCHEMA_VERSION};
use mottainai_host_bootstrap::lock::BootstrapLock;
use mottainai_host_bootstrap::model::{Classification, Outcome, QemuIdentity};
use mottainai_host_bootstrap::paths::{ensure_managed_directories, ManagedPaths};
use mottainai_host_bootstrap::provider::ArtifactSource;
use mottainai_host_bootstrap::qemu::{
    QemuArtifact, QemuArtifactSource, QemuContract, QemuDataArtifact, QemuOverride,
    QEMU_CONTRACT_SCHEMA_VERSION, QEMU_IMAGE_EXECUTABLE, QEMU_SUPPORTED_VERSION,
    QEMU_SYSTEM_EXECUTABLE,
};
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

#[derive(Clone)]
struct FixtureQemuSource {
    system_archive: Arc<Vec<u8>>,
    image_archive: Arc<Vec<u8>>,
    data_archive: Arc<Vec<u8>>,
    calls: Arc<AtomicUsize>,
}

impl QemuArtifactSource for FixtureQemuSource {
    fn download(&self, artifact: &QemuArtifact, destination: &Path) -> Result<(), BootstrapError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let bytes = match artifact.artifact_id.as_str() {
            "fixture-qemu-system" => self.system_archive.as_slice(),
            "fixture-qemu-image" => self.image_archive.as_slice(),
            _ => {
                return Err(BootstrapError::new(
                    ErrorCode::DownloadFailed,
                    format!("unknown QEMU fixture artifact {}", artifact.artifact_id),
                ));
            }
        };
        write_fixture_download(destination, bytes, "QEMU fixture download")
    }

    fn download_data(
        &self,
        artifact: &QemuDataArtifact,
        destination: &Path,
    ) -> Result<(), BootstrapError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if artifact.artifact_id != "fixture-qemu-data" {
            return Err(BootstrapError::new(
                ErrorCode::DownloadFailed,
                format!("unknown QEMU fixture artifact {}", artifact.artifact_id),
            ));
        }
        write_fixture_download(
            destination,
            self.data_archive.as_slice(),
            "QEMU data fixture download",
        )
    }
}

fn write_fixture_download(
    destination: &Path,
    bytes: &[u8],
    description: &str,
) -> Result<(), BootstrapError> {
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| BootstrapError::io(description, &error))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| BootstrapError::io(description, &error))
}

#[derive(Clone)]
struct BlockingFixtureSource {
    bytes: Arc<Vec<u8>>,
    calls: Arc<AtomicUsize>,
    entered: Arc<Barrier>,
    release: Arc<Barrier>,
}

impl ArtifactSource for BlockingFixtureSource {
    fn download(
        &self,
        _contract: &ProviderContract,
        destination: &Path,
    ) -> Result<(), BootstrapError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.wait();
        self.release.wait();
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .map_err(|error| BootstrapError::io("create blocking fixture download", &error))?;
        file.write_all(&self.bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| BootstrapError::io("write blocking fixture download", &error))
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

fn qemu_archive(path: &str, contents: &[u8], mode: u32) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    {
        let mut builder = Builder::new(&mut encoder);
        let mut header = Header::new_gnu();
        header.set_path(path).unwrap();
        header.set_size(contents.len() as u64);
        header.set_mode(mode);
        header.set_cksum();
        builder.append(&header, contents).unwrap();
        builder.finish().unwrap();
    }
    encoder.finish().unwrap()
}

fn fake_qemu_binary() -> Vec<u8> {
    const OUTPUT: &[u8] = b"QEMU emulator version 11.0.0\nkvm\n";
    const CODE_OFFSET: usize = 64 + 56;
    const OUTPUT_OFFSET: usize = CODE_OFFSET + 33;

    let code = [
        0xb8,
        0x01,
        0x00,
        0x00,
        0x00, // write
        0xbf,
        0x01,
        0x00,
        0x00,
        0x00, // stdout
        0x48,
        0x8d,
        0x35,
        (OUTPUT_OFFSET - (CODE_OFFSET + 17)) as u8,
        0x00,
        0x00,
        0x00, // output address
        0xba,
        OUTPUT.len() as u8,
        0x00,
        0x00,
        0x00, // output length
        0x0f,
        0x05, // syscall
        0xb8,
        0x3c,
        0x00,
        0x00,
        0x00, // exit
        0x31,
        0xff, // status 0
        0x0f,
        0x05, // syscall
    ];
    assert_eq!(code.len(), 33);

    let mut binary = vec![0_u8; CODE_OFFSET];
    binary[..4].copy_from_slice(b"\x7fELF");
    binary[4] = 2;
    binary[5] = 1;
    binary[6] = 1;
    put_u16(&mut binary, 16, 2); // ET_EXEC
    put_u16(&mut binary, 18, 62); // x86_64
    put_u32(&mut binary, 20, 1);
    put_u64(&mut binary, 24, 0x400000 + CODE_OFFSET as u64);
    put_u64(&mut binary, 32, 64);
    put_u16(&mut binary, 52, 64);
    put_u16(&mut binary, 54, 56);
    put_u16(&mut binary, 56, 1);

    put_u32(&mut binary, 64, 1); // PT_LOAD
    put_u32(&mut binary, 68, 5); // read + execute
    put_u64(&mut binary, 80, 0x400000);
    put_u64(&mut binary, 112, 0x1000);

    binary.extend_from_slice(&code);
    binary.extend_from_slice(OUTPUT);
    let binary_len = binary.len() as u64;
    put_u64(&mut binary, 96, binary_len);
    put_u64(&mut binary, 104, binary_len);
    binary
}

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn qemu_fixture() -> (QemuContract, FixtureQemuSource) {
    let binary = fake_qemu_binary();
    let system_archive = qemu_archive("bin/qemu-system-x86_64", &binary, 0o755);
    let image_archive = qemu_archive("bin/qemu-img", &binary, 0o755);
    let data_archive = qemu_archive("share/qemu/edk2-x86_64-code.fd", b"firmware fixture", 0o644);
    let artifact_url =
        |id: &str| format!("https://github.com/hermeticbuild/qemu-prebuilt/{id}.tar.gz");
    let system_id = "fixture-qemu-system";
    let image_id = "fixture-qemu-image";
    let data_id = "fixture-qemu-data";
    let contract = QemuContract {
        schema_version: QEMU_CONTRACT_SCHEMA_VERSION.to_owned(),
        version: QEMU_SUPPORTED_VERSION.to_owned(),
        system: QemuArtifact {
            artifact_id: system_id.to_owned(),
            artifact_url: artifact_url(system_id),
            artifact_sha256: sha256_hex(&system_archive),
            archive_binary_path: format!("bin/{QEMU_SYSTEM_EXECUTABLE}"),
            max_artifact_bytes: 1024 * 1024,
        },
        image: QemuArtifact {
            artifact_id: image_id.to_owned(),
            artifact_url: artifact_url(image_id),
            artifact_sha256: sha256_hex(&image_archive),
            archive_binary_path: format!("bin/{QEMU_IMAGE_EXECUTABLE}"),
            max_artifact_bytes: 1024 * 1024,
        },
        data: QemuDataArtifact {
            artifact_id: data_id.to_owned(),
            artifact_url: artifact_url(data_id),
            artifact_sha256: sha256_hex(&data_archive),
            max_artifact_bytes: 1024 * 1024,
        },
    };
    let source = FixtureQemuSource {
        system_archive: Arc::new(system_archive),
        image_archive: Arc::new(image_archive),
        data_archive: Arc::new(data_archive),
        calls: Arc::new(AtomicUsize::new(0)),
    };
    (contract, source)
}

fn persisted_qemu_identity(state: &serde_json::Value) -> (String, String, String, String, String) {
    (
        state["system_path"].as_str().unwrap().to_owned(),
        state["system_sha256"].as_str().unwrap().to_owned(),
        state["image_path"].as_str().unwrap().to_owned(),
        state["image_sha256"].as_str().unwrap().to_owned(),
        state["version"].as_str().unwrap().to_owned(),
    )
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
        qemu_path: None,
        qemu_override: Some(QemuOverride::Identity(QemuIdentity {
            system_path: "/fixture/qemu-system-x86_64".to_owned(),
            system_sha256: "1".repeat(64),
            image_path: "/fixture/qemu-img".to_owned(),
            image_sha256: "2".repeat(64),
            version: "9.2.2".to_owned(),
        })),
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    let bytes = archive();
    let source = FixtureSource {
        bytes: Arc::new(bytes.clone()),
        calls: Arc::new(AtomicUsize::new(0)),
    };
    let contract = contract(&bytes);
    let bootstrap = config(temporary.path().to_path_buf(), contract.clone());
    (temporary, contract, source, bootstrap)
}

fn write_route4_descriptor(
    directory: &Path,
    provider_contract: &ProviderContract,
    qemu_contract: &QemuContract,
) -> (PathBuf, PathBuf) {
    let provider_filename = format!("{}.tar.gz", provider_contract.artifact_id);
    let qemu_artifact = |artifact: &QemuArtifact| {
        serde_json::json!({
            "version": qemu_contract.version.clone(),
            "architecture": "x86_64",
            "filename": format!("{}.tar.gz", artifact.artifact_id),
            "sha256": artifact.artifact_sha256.clone(),
            "locator": artifact.artifact_url.clone(),
        })
    };
    let data_artifact = serde_json::json!({
        "version": qemu_contract.version.clone(),
        "architecture": "x86_64",
        "filename": format!("{}.tar.gz", qemu_contract.data.artifact_id),
        "sha256": qemu_contract.data.artifact_sha256.clone(),
        "locator": qemu_contract.data.artifact_url.clone(),
    });
    let descriptor = serde_json::json!({
        "contractId": "mottainai.deployment.v1",
        "schemaVersion": 1,
        "release": {
            "version": "1.2.3",
            "tag": "v1.2.3",
            "sourceRevision": "a".repeat(40),
        },
        "profile": "linux-x86_64",
        "architecture": "x86_64-linux",
        "route1": { "payload": {
            "packageName": "mottainai",
            "version": "1.2.3",
            "sourceRevision": "a".repeat(40),
            "filename": "mottainai-1.2.3.tgz",
            "sha256": "f".repeat(64),
            "integrity": format!("sha512-{}", "A".repeat(86)),
            "locator": "https://github.com/yohn-jp/mottainai/releases/download/v1.2.3/mottainai-1.2.3.tgz",
        } },
        "route2": { "managedGeneration": { "applicationPayloadSha256": "f".repeat(64), "packages": [{
            "packageId": "mottainai",
            "version": "1.2.3",
            "flakeRef": "nix#mottainai",
            "sourceSha256": "a".repeat(64),
        }] } },
        "route3": {
            "appliance": {
                "registry": "ghcr.io",
                "repository": "yohn-jp/mottainai/runtime-appliance",
                "digest": format!("sha256:{}", "c".repeat(64)),
            },
            "managedGenerationIdentity": "d".repeat(64),
        },
        "route4": {
            "provider": {
                "profileId": "linux-x86_64",
                "architecture": "x86_64-linux",
                "provisioning": {
                    "strategy": "pinned-verified-archives",
                    "contractVersion": 1,
                    "stateDirectory": "$XDG_STATE_HOME/mottainai/host-bootstrap",
                },
                "lima": {
                    "version": provider_contract.version.clone(),
                    "architecture": "x86_64",
                    "filename": provider_filename,
                    "sha256": provider_contract.artifact_sha256.clone(),
                    "locator": provider_contract.artifact_url.clone(),
                },
                "qemu": {
                    "version": qemu_contract.version.clone(),
                    "architecture": "x86_64",
                    "identity": "e".repeat(64),
                    "identityKind": "executable-digest",
                    "systemBinary": qemu_artifact(&qemu_contract.system),
                    "imageBinary": qemu_artifact(&qemu_contract.image),
                    "dataArtifact": data_artifact,
                    "minimumVersion": qemu_contract.version.clone(),
                },
                "compatibility": {
                    "limaMajor": 2,
                    "qemuMajor": 11,
                    "requiresKvm": true,
                },
            },
        },
    });
    let descriptor_path = directory.join("deployment-descriptor.json");
    let sidecar_path = directory.join("deployment-descriptor.json.sha256");
    let bytes = serde_json::to_vec(&descriptor).unwrap();
    fs::write(&descriptor_path, &bytes).unwrap();
    fs::write(
        &sidecar_path,
        format!("{}  deployment-descriptor.json\n", sha256_hex(&bytes)),
    )
    .unwrap();
    (descriptor_path, sidecar_path)
}

fn prepared_legacy_route4_fixture() -> (
    TempDir,
    BootstrapConfig,
    FixtureSource,
    FixtureQemuSource,
    QemuContract,
    Route4ProviderRequirement,
) {
    let (temporary, provider_contract, provider_source, mut bootstrap_config) = fixture();
    let (qemu_contract, qemu_source) = qemu_fixture();
    let (descriptor_path, sidecar_path) =
        write_route4_descriptor(temporary.path(), &provider_contract, &qemu_contract);
    let requirement =
        provider_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap();
    bootstrap_config.qemu_override = None;
    let evidence = Bootstrap::new(bootstrap_config.clone()).reconcile_with_route4_requirement(
        provider_source.clone(),
        qemu_source.clone(),
        requirement.clone(),
    );
    assert_eq!(evidence.result, Outcome::Changed);
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(qemu_source.calls.load(Ordering::SeqCst), 3);

    let state_path = bootstrap_config.paths().qemu_state_file;
    let mut state: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(state_path).unwrap()).unwrap();
    state["provider_identity"] = serde_json::Value::Null;
    state["provider_identity_kind"] = serde_json::Value::Null;
    fs::write(
        bootstrap_config.paths().qemu_state_file,
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();

    (
        temporary,
        bootstrap_config,
        provider_source,
        qemu_source,
        qemu_contract,
        requirement,
    )
}

fn runtime_spec() -> RuntimeSpec {
    RuntimeSpec {
        schema_version: RUNTIME_SPEC_SCHEMA_VERSION.to_owned(),
        instance_name: "mottainai-runtime".to_owned(),
        architecture: "x86_64".to_owned(),
        cpus: 2,
        memory_mib: 4096,
        appliance: ApplianceReference {
            registry: "ghcr.io".to_owned(),
            repository: "yohn-jp/mottainai/runtime-appliance".to_owned(),
            digest: format!("sha256:{}", "a".repeat(64)),
        },
        mounts: Vec::new(),
        managed_generation: None,
    }
}

#[test]
fn descriptor_route4_identity_reaches_production_reconciliation_state() {
    let (temporary, provider_contract, provider_source, mut bootstrap_config) = fixture();
    let (qemu_contract, qemu_source) = qemu_fixture();
    let (descriptor_path, sidecar_path) =
        write_route4_descriptor(temporary.path(), &provider_contract, &qemu_contract);
    let requirement =
        provider_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap();

    assert_eq!(requirement.lima_contract().unwrap(), provider_contract);
    bootstrap_config.qemu_override = None;
    let evidence = Bootstrap::new(bootstrap_config.clone()).reconcile_with_route4_requirement(
        provider_source.clone(),
        qemu_source.clone(),
        requirement.clone(),
    );
    assert_eq!(evidence.result, Outcome::Changed);
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(qemu_source.calls.load(Ordering::SeqCst), 3);

    let provider_state: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(bootstrap_config.paths().state_file).unwrap())
            .unwrap();
    assert_eq!(provider_state["artifact_id"], provider_contract.artifact_id);
    assert_eq!(
        provider_state["artifact_sha256"],
        provider_contract.artifact_sha256
    );

    let qemu_state: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(bootstrap_config.paths().qemu_state_file).unwrap(),
    )
    .unwrap();
    assert_eq!(qemu_state["provider_identity"], "e".repeat(64));
    assert_eq!(qemu_state["provider_identity_kind"], "executable-digest");
    assert_eq!(
        qemu_state["provisioning"]["system_artifact_sha256"],
        qemu_contract.system.artifact_sha256
    );
    assert_eq!(
        qemu_state["provisioning"]["image_artifact_sha256"],
        qemu_contract.image.artifact_sha256
    );
    assert_eq!(
        qemu_state["provisioning"]["data_artifact_sha256"],
        qemu_contract.data.artifact_sha256
    );

    let reused = Bootstrap::new(bootstrap_config.clone()).reconcile_with_route4_requirement(
        provider_source.clone(),
        qemu_source.clone(),
        requirement.clone(),
    );
    assert_eq!(reused.result, Outcome::NoOp);
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(qemu_source.calls.load(Ordering::SeqCst), 3);

    let mut tampered_state = qemu_state;
    tampered_state["provisioning"]["data_artifact_sha256"] =
        serde_json::Value::String("f".repeat(64));
    fs::write(
        bootstrap_config.paths().qemu_state_file,
        serde_json::to_vec(&tampered_state).unwrap(),
    )
    .unwrap();
    let mismatch = Bootstrap::new(bootstrap_config).reconcile_with_route4_requirement(
        provider_source.clone(),
        qemu_source,
        requirement,
    );
    assert_eq!(mismatch.result, Outcome::Blocked);
    assert_eq!(mismatch.error_code.as_deref(), Some("qemu_incompatible"));
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn exact_legacy_qemu_state_migrates_by_metadata_only_and_then_is_a_noop() {
    let (_temporary, bootstrap_config, provider_source, qemu_source, qemu_contract, requirement) =
        prepared_legacy_route4_fixture();
    let paths = bootstrap_config.paths();
    let state_before = fs::read(&paths.qemu_state_file).unwrap();
    let version_directory = paths.qemu_directory.join(&qemu_contract.version);
    let version_directory_mtime = fs::metadata(&version_directory)
        .unwrap()
        .modified()
        .unwrap();

    let migrated = Bootstrap::new(bootstrap_config.clone()).reconcile_with_route4_requirement(
        provider_source.clone(),
        qemu_source.clone(),
        requirement.clone(),
    );
    assert_eq!(migrated.result, Outcome::Changed);
    assert!(migrated.changed);
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(qemu_source.calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        fs::metadata(&version_directory)
            .unwrap()
            .modified()
            .unwrap(),
        version_directory_mtime
    );

    let migrated_state: serde_json::Value =
        serde_json::from_slice(&fs::read(&paths.qemu_state_file).unwrap()).unwrap();
    assert_ne!(fs::read(&paths.qemu_state_file).unwrap(), state_before);
    assert_eq!(migrated_state["provider_identity"], "e".repeat(64));
    assert_eq!(
        migrated_state["provider_identity_kind"],
        "executable-digest"
    );

    let second = Bootstrap::new(bootstrap_config).reconcile_with_route4_requirement(
        provider_source.clone(),
        qemu_source.clone(),
        requirement,
    );
    assert_eq!(second.result, Outcome::NoOp);
    assert!(!second.changed);
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(qemu_source.calls.load(Ordering::SeqCst), 3);
}

#[test]
fn runtime_ensure_migrates_exact_legacy_qemu_state_before_route3() {
    let (temporary, bootstrap_config, _provider_source, _qemu_source, _qemu_contract, _requirement) =
        prepared_legacy_route4_fixture();
    let paths = bootstrap_config.paths();

    let appliance_digest = format!("sha256:{}", "c".repeat(64));
    let raw = b"runtime appliance fixture";
    let appliance_directory = paths.appliance_directory(&appliance_digest);
    fs::create_dir_all(&appliance_directory).unwrap();
    fs::write(paths.appliance_raw_path(&appliance_digest), raw).unwrap();
    fs::write(
        paths.appliance_state_path(&appliance_digest),
        serde_json::json!({
            "schema_version": "mottainai.host-bootstrap.appliance.v1",
            "registry": "ghcr.io",
            "repository": "yohn-jp/mottainai/runtime-appliance",
            "digest": appliance_digest,
            "raw_sha256": sha256_hex(raw),
            "raw_size_bytes": raw.len(),
        })
        .to_string(),
    )
    .unwrap();

    let lima_config_directory = paths.lima_home_directory.join("_config");
    fs::create_dir_all(&lima_config_directory).unwrap();
    fs::write(lima_config_directory.join("user"), b"fixture-private-key").unwrap();
    fs::write(
        lima_config_directory.join("user.pub"),
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestBootstrapKeyForMottainai840 operator\n",
    )
    .unwrap();

    let empty_path = temporary.path().join("empty-path");
    fs::create_dir(&empty_path).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_mottainai-init"))
        .args([
            "runtime",
            "ensure",
            "--descriptor",
            temporary
                .path()
                .join("deployment-descriptor.json")
                .to_str()
                .unwrap(),
            "--state-directory",
            paths.root.to_str().unwrap(),
            "--json",
        ])
        .env("PATH", &empty_path)
        .output()
        .expect("production runtime ensure should launch");
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stdout).contains("runtime_not_ready"));

    let state: serde_json::Value =
        serde_json::from_slice(&fs::read(&paths.qemu_state_file).unwrap()).unwrap();
    assert_eq!(state["provider_identity"], "e".repeat(64));
    assert_eq!(state["provider_identity_kind"], "executable-digest");
}

fn assert_legacy_qemu_provenance_mismatch_fails_closed(
    mutate: impl FnOnce(&mut serde_json::Value),
) {
    let (_temporary, bootstrap_config, provider_source, qemu_source, qemu_contract, requirement) =
        prepared_legacy_route4_fixture();
    let paths = bootstrap_config.paths();
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(&paths.qemu_state_file).unwrap()).unwrap();
    mutate(&mut state);
    fs::write(&paths.qemu_state_file, serde_json::to_vec(&state).unwrap()).unwrap();
    let state_before = fs::read(&paths.qemu_state_file).unwrap();
    let version_directory = paths.qemu_directory.join(&qemu_contract.version);
    let version_directory_mtime = fs::metadata(&version_directory)
        .unwrap()
        .modified()
        .unwrap();

    let evidence = Bootstrap::new(bootstrap_config).reconcile_with_route4_requirement(
        provider_source.clone(),
        qemu_source.clone(),
        requirement,
    );
    assert_eq!(evidence.result, Outcome::Blocked);
    assert_eq!(evidence.error_code.as_deref(), Some("qemu_incompatible"));
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(qemu_source.calls.load(Ordering::SeqCst), 3);
    assert_eq!(fs::read(&paths.qemu_state_file).unwrap(), state_before);
    assert!(state["provider_identity"].is_null());
    assert!(state["provider_identity_kind"].is_null());
    assert_eq!(
        fs::metadata(&version_directory)
            .unwrap()
            .modified()
            .unwrap(),
        version_directory_mtime
    );
}

#[test]
fn legacy_qemu_state_artifact_and_version_mismatches_fail_closed_independently() {
    assert_legacy_qemu_provenance_mismatch_fails_closed(|state| {
        state["provisioning"]["system_artifact_sha256"] = serde_json::Value::String("f".repeat(64));
    });
    assert_legacy_qemu_provenance_mismatch_fails_closed(|state| {
        state["provisioning"]["image_artifact_sha256"] = serde_json::Value::String("f".repeat(64));
    });
    assert_legacy_qemu_provenance_mismatch_fails_closed(|state| {
        state["provisioning"]["data_artifact_sha256"] = serde_json::Value::String("f".repeat(64));
    });
    assert_legacy_qemu_provenance_mismatch_fails_closed(|state| {
        state["version"] = serde_json::Value::String("10.0.0".to_owned());
    });
}

fn assert_conflicting_qemu_attestation_fails_closed(mutate: impl FnOnce(&mut serde_json::Value)) {
    let (_temporary, bootstrap_config, provider_source, qemu_source, qemu_contract, requirement) =
        prepared_legacy_route4_fixture();
    let paths = bootstrap_config.paths();
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(&paths.qemu_state_file).unwrap()).unwrap();
    mutate(&mut state);
    fs::write(&paths.qemu_state_file, serde_json::to_vec(&state).unwrap()).unwrap();
    let state_before = fs::read(&paths.qemu_state_file).unwrap();
    let version_directory = paths.qemu_directory.join(&qemu_contract.version);
    let version_directory_mtime = fs::metadata(&version_directory)
        .unwrap()
        .modified()
        .unwrap();

    let evidence = Bootstrap::new(bootstrap_config).reconcile_with_route4_requirement(
        provider_source.clone(),
        qemu_source.clone(),
        requirement,
    );
    assert_eq!(evidence.result, Outcome::Blocked);
    assert_eq!(evidence.error_code.as_deref(), Some("qemu_incompatible"));
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(qemu_source.calls.load(Ordering::SeqCst), 3);
    assert_eq!(fs::read(&paths.qemu_state_file).unwrap(), state_before);
    assert_eq!(
        fs::metadata(&version_directory)
            .unwrap()
            .modified()
            .unwrap(),
        version_directory_mtime
    );
}

#[test]
fn conflicting_qemu_attestation_is_not_overwritten() {
    assert_conflicting_qemu_attestation_fails_closed(|state| {
        state["provider_identity"] = serde_json::Value::String("1".repeat(64));
        state["provider_identity_kind"] = serde_json::Value::String("executable-digest".to_owned());
    });
    assert_conflicting_qemu_attestation_fails_closed(|state| {
        state["provider_identity"] = serde_json::Value::String("e".repeat(64));
        state["provider_identity_kind"] =
            serde_json::Value::String("compatibility-profile".to_owned());
    });
}

#[test]
fn descriptor_rejects_incompatible_provider_and_qemu_overrides_closed() {
    let (temporary, provider_contract, provider_source, bootstrap_config) = fixture();
    let (qemu_contract, qemu_source) = qemu_fixture();
    let (descriptor_path, sidecar_path) =
        write_route4_descriptor(temporary.path(), &provider_contract, &qemu_contract);
    let requirement =
        provider_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap();

    let mut mismatched_contract_config = bootstrap_config.clone();
    mismatched_contract_config.qemu_override = None;
    mismatched_contract_config.contract = ProviderContract::default();
    let contract_evidence = Bootstrap::new(mismatched_contract_config)
        .reconcile_with_route4_requirement(
            provider_source.clone(),
            qemu_source.clone(),
            requirement.clone(),
        );
    assert_eq!(
        contract_evidence.error_code.as_deref(),
        Some("contract_invalid")
    );
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 0);
    assert_eq!(qemu_source.calls.load(Ordering::SeqCst), 0);

    let qemu_override_evidence = Bootstrap::new(bootstrap_config)
        .reconcile_with_route4_requirement(provider_source.clone(), qemu_source, requirement);
    assert_eq!(
        qemu_override_evidence.error_code.as_deref(),
        Some("qemu_incompatible")
    );
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn verified_materialization_promotes_only_after_digest_verification() {
    let (_temporary, contract, source, bootstrap_config) = fixture();
    let evidence = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(evidence.result, Outcome::Changed);
    assert_eq!(evidence.steps[0].classification, Classification::Satisfied);
    assert_eq!(evidence.steps[1].classification, Classification::Repairable);
    assert_eq!(evidence.steps[2].classification, Classification::Missing);
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
fn runtime_ensure_contends_with_bootstrap_before_mutating_shared_runtime_state() {
    let (temporary, _contract, source, bootstrap_config) = fixture();
    let paths = bootstrap_config.paths();
    ensure_managed_directories(&paths).unwrap();
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let blocking_source = BlockingFixtureSource {
        bytes: Arc::clone(&source.bytes),
        calls: Arc::clone(&source.calls),
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
    };

    let bootstrap_handle = thread::spawn(move || {
        Bootstrap::new(bootstrap_config).reconcile_with_source(blocking_source)
    });
    entered.wait();

    let spec_path = temporary.path().join("runtime-spec.json");
    fs::write(&spec_path, serde_json::to_vec(&runtime_spec()).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_mottainai-init"))
        .args([
            "runtime",
            "ensure",
            "--spec",
            spec_path.to_str().unwrap(),
            "--state-directory",
            paths.root.to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("production runtime ensure should launch");
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"error_code\":\"bootstrap_locked\""));
    assert!(!paths
        .runtime_instance_directory("mottainai-runtime")
        .exists());
    assert!(!paths.staging_appliance_directory().exists());
    assert!(!paths
        .appliance_directory(&runtime_spec().appliance.digest)
        .exists());

    release.wait();
    let bootstrap_evidence = bootstrap_handle
        .join()
        .expect("bootstrap thread should finish after release");
    assert_eq!(bootstrap_evidence.result, Outcome::Changed);
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
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

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
fn route4_qemu_promotion_persists_final_identity_and_is_idempotent() {
    let (_temporary, _provider_contract, provider_source, mut bootstrap_config) = fixture();
    let (qemu_contract, qemu_source) = qemu_fixture();
    bootstrap_config.environment_path = None;
    bootstrap_config.qemu_override = None;

    let first = Bootstrap::new(bootstrap_config.clone()).reconcile_with_contract_and_sources(
        provider_source.clone(),
        qemu_source.clone(),
        qemu_contract.clone(),
    );
    assert_eq!(first.result, Outcome::Changed);

    let paths = bootstrap_config.paths();
    let qemu_state_before = fs::read_to_string(&paths.qemu_state_file).unwrap();
    let qemu_state_json: serde_json::Value = serde_json::from_str(&qemu_state_before).unwrap();
    let system_path = paths.qemu_binary_path(QEMU_SUPPORTED_VERSION, QEMU_SYSTEM_EXECUTABLE);
    let image_path = paths.qemu_binary_path(QEMU_SUPPORTED_VERSION, QEMU_IMAGE_EXECUTABLE);
    assert_eq!(
        qemu_state_json["system_path"].as_str().unwrap(),
        system_path.to_str().unwrap()
    );
    assert_eq!(
        qemu_state_json["image_path"].as_str().unwrap(),
        image_path.to_str().unwrap()
    );
    assert!(system_path.is_file());
    assert!(image_path.is_file());
    assert!(!qemu_state_before.contains("staging"));
    assert_eq!(
        qemu_state_json["system_sha256"].as_str().unwrap(),
        sha256_hex(&fs::read(&system_path).unwrap())
    );
    assert_eq!(
        qemu_state_json["image_sha256"].as_str().unwrap(),
        sha256_hex(&fs::read(&image_path).unwrap())
    );
    assert!(qemu_state_json["provisioning"]["data_closure_sha256"]
        .as_str()
        .is_some_and(|digest| digest.len() == 64));
    assert!(!paths.qemu_staging_directory.exists());
    assert_eq!(qemu_source.calls.load(Ordering::SeqCst), 3);
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);

    let activation_marker = paths
        .qemu_directory
        .join(QEMU_SUPPORTED_VERSION)
        .join("activation-marker");
    fs::write(&activation_marker, b"activated").unwrap();

    let identity_before = persisted_qemu_identity(&qemu_state_json);
    let second = Bootstrap::new(bootstrap_config.clone()).reconcile_with_contract_and_sources(
        provider_source.clone(),
        qemu_source.clone(),
        qemu_contract.clone(),
    );
    assert_eq!(second.result, Outcome::NoOp);
    assert!(!second.changed);
    assert_eq!(qemu_source.calls.load(Ordering::SeqCst), 3);
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);
    assert!(activation_marker.is_file());
    assert!(!paths.qemu_staging_directory.exists());

    let qemu_state_after = fs::read_to_string(&paths.qemu_state_file).unwrap();
    let qemu_state_after_json: serde_json::Value = serde_json::from_str(&qemu_state_after).unwrap();
    assert_eq!(
        identity_before,
        persisted_qemu_identity(&qemu_state_after_json)
    );
    assert_eq!(qemu_state_before, qemu_state_after);

    let firmware = paths
        .qemu_directory
        .join(QEMU_SUPPORTED_VERSION)
        .join("share/qemu/edk2-x86_64-code.fd");
    fs::write(&firmware, b"different non-empty firmware").unwrap();

    let drift = Bootstrap::new(bootstrap_config.clone()).reconcile_with_contract_and_sources(
        provider_source.clone(),
        qemu_source.clone(),
        qemu_contract.clone(),
    );
    assert_eq!(drift.result, Outcome::Blocked);
    assert_eq!(drift.error_code.as_deref(), Some("qemu_state_ambiguous"));

    fs::remove_file(&firmware).unwrap();
    let missing = Bootstrap::new(bootstrap_config.clone()).reconcile_with_contract_and_sources(
        provider_source.clone(),
        qemu_source.clone(),
        qemu_contract.clone(),
    );
    assert_eq!(missing.result, Outcome::Blocked);
    assert_eq!(missing.error_code.as_deref(), Some("qemu_state_ambiguous"));

    fs::create_dir(&firmware).unwrap();
    let nonregular = Bootstrap::new(bootstrap_config).reconcile_with_contract_and_sources(
        provider_source.clone(),
        qemu_source,
        qemu_contract,
    );
    assert_eq!(nonregular.result, Outcome::Blocked);
    assert_eq!(
        nonregular.error_code.as_deref(),
        Some("qemu_state_ambiguous")
    );
    assert_eq!(provider_source.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn verified_active_provider_without_state_is_repaired_without_redownload() {
    let (_temporary, _contract, source, bootstrap_config) = fixture();
    let first = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(first.result, Outcome::Changed);
    fs::remove_file(&bootstrap_config.paths().state_file).unwrap();

    let second = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(second.result, Outcome::Changed);
    assert_eq!(second.steps[2].classification, Classification::Repairable);
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    assert!(bootstrap_config.paths().state_file.is_file());
}

#[test]
fn modified_active_provider_without_state_is_never_adopted() {
    let (_temporary, contract, source, bootstrap_config) = fixture();
    let first = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(first.result, Outcome::Changed);
    let binary = bootstrap_config
        .paths()
        .provider_directory(&contract.artifact_id)
        .join("bin/limactl");
    fs::write(&binary, b"#!/bin/sh\n# modified\nexit 0\n").unwrap();
    fs::remove_file(&bootstrap_config.paths().state_file).unwrap();

    let second = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(second.result, Outcome::Blocked);
    assert_eq!(second.steps[2].classification, Classification::Incompatible);
    assert_eq!(
        second.error_code.as_deref(),
        Some("provider_state_incompatible")
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    assert!(!bootstrap_config.paths().state_file.exists());
}

#[test]
fn missing_qemu_blocks_lima_materialization() {
    let (_temporary, _contract, source, mut bootstrap_config) = fixture();
    bootstrap_config.qemu_override = Some(QemuOverride::Missing);

    let evidence = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(evidence.result, Outcome::Blocked);
    assert_eq!(evidence.steps[1].classification, Classification::Missing);
    assert_eq!(evidence.error_code.as_deref(), Some("qemu_missing"));
    assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    assert!(!bootstrap_config.paths().state_file.exists());
}

#[test]
fn incompatible_qemu_is_not_adopted() {
    let (_temporary, _contract, source, mut bootstrap_config) = fixture();
    bootstrap_config.qemu_override = Some(QemuOverride::Incompatible(
        "QEMU version is below the supported minimum".to_owned(),
    ));

    let evidence = Bootstrap::new(bootstrap_config).reconcile_with_source(source.clone());
    assert_eq!(evidence.result, Outcome::Blocked);
    assert_eq!(
        evidence.steps[1].classification,
        Classification::Incompatible
    );
    assert_eq!(evidence.error_code.as_deref(), Some("qemu_incompatible"));
    assert_eq!(source.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn changed_qemu_identity_after_state_is_ambiguous() {
    let (_temporary, _contract, source, mut bootstrap_config) = fixture();
    let first = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(first.result, Outcome::Changed);
    bootstrap_config.qemu_override = Some(QemuOverride::Identity(QemuIdentity {
        system_path: "/fixture/qemu-system-x86_64".to_owned(),
        system_sha256: "3".repeat(64),
        image_path: "/fixture/qemu-img".to_owned(),
        image_sha256: "2".repeat(64),
        version: "9.2.2".to_owned(),
    }));

    let second = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source.clone());
    assert_eq!(second.result, Outcome::Blocked);
    assert_eq!(second.steps[1].classification, Classification::Ambiguous);
    assert_eq!(second.error_code.as_deref(), Some("qemu_state_ambiguous"));
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn corrupted_qemu_state_fails_closed() {
    let (_temporary, _contract, source, bootstrap_config) = fixture();
    let paths = bootstrap_config.paths();
    ensure_managed_directories(&paths).unwrap();
    fs::write(&paths.qemu_state_file, b"{not-json").unwrap();

    let evidence = Bootstrap::new(bootstrap_config).reconcile_with_source(source.clone());
    assert_eq!(evidence.result, Outcome::Blocked);
    assert_eq!(evidence.steps[1].classification, Classification::Ambiguous);
    assert_eq!(evidence.error_code.as_deref(), Some("qemu_state_ambiguous"));
    assert_eq!(source.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn interrupted_qemu_state_is_reconciled_atomically() {
    let (_temporary, _contract, source, bootstrap_config) = fixture();
    let paths = bootstrap_config.paths();
    ensure_managed_directories(&paths).unwrap();
    fs::write(paths.qemu_state_file.with_extension("json.tmp"), b"partial").unwrap();

    let evidence = Bootstrap::new(bootstrap_config.clone()).reconcile_with_source(source);
    assert_eq!(evidence.result, Outcome::Changed);
    assert!(!paths.qemu_state_file.with_extension("json.tmp").exists());
    assert!(paths.qemu_state_file.is_file());
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
        evidence.steps[2].classification,
        Classification::Incompatible
    );
    assert_eq!(
        evidence.error_code.as_deref(),
        Some("provider_state_incompatible")
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    assert!(!bootstrap_config.paths().active_link.exists());
}
