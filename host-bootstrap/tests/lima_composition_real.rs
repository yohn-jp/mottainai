//! Issue #844: trusted-main production Lima composition proof.
//!
//! This ignored test is intentionally small at the orchestration layer. It
//! supplies the exact canonical OCI-shaped fixture and an already bootstrapped
//! managed provider state, then calls the production `ensure_runtime` seam
//! with the real `SystemLimaCli`. YAML rendering, `limactl` lifecycle, SSH
//! transport, bootstrap-disk attachment, and guest health remain owned by
//! production Rust/Lima code.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use mottainai_host_bootstrap::appliance::ApplianceReference;
use mottainai_host_bootstrap::bootstrap_disk::{bootstrap_disk_name, bootstrap_disk_path};
use mottainai_host_bootstrap::lima::{
    ensure_runtime, LimaCli, RuntimeEnsureConfig, RuntimeSpec, SystemLimaCli,
    RUNTIME_SPEC_SCHEMA_VERSION,
};
use mottainai_host_bootstrap::oci::FileOciSource;
use mottainai_host_bootstrap::paths::ManagedPaths;
use mottainai_host_bootstrap::qemu::managed_qemu_system_path;
use sha2::{Digest, Sha256};

fn required_path(name: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{name} must be set for the trusted-main composition proof"))
}

fn digest_file(path: &Path) -> String {
    let mut file = File::open(path).unwrap_or_else(|error| {
        panic!("open {} for identity verification: {error}", path.display())
    });
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).unwrap_or_else(|error| {
            panic!("read {} for identity verification: {error}", path.display())
        });
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    format!("{:x}", hasher.finalize())
}

fn require_kvm_access() {
    let kvm_path = Path::new("/dev/kvm");
    assert!(
        kvm_path.exists(),
        "trusted-main runner must provide /dev/kvm; this proof never falls back to TCG and #261 remains the real-host certification"
    );
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(kvm_path)
        .unwrap_or_else(|error| {
            panic!(
                "trusted-main runner user cannot read/write /dev/kvm ({error}); refusing to claim a KVM Lima proof (real-host/provider certification remains #261)"
            )
        });
}

struct Cleanup<'a> {
    cli: &'a SystemLimaCli,
    instance: &'a str,
}

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.cli.delete_for_cleanup(self.instance) {
            eprintln!(
                "lima composition cleanup failed for {}: {}",
                self.instance, error.message
            );
        }
    }
}

#[test]
#[ignore = "requires the canonical Nix Appliance, managed Lima/QEMU, KVM, and real limactl"]
fn canonical_appliance_crosses_production_lima_to_guest_health() {
    require_kvm_access();
    let oci_manifest_path = required_path("MOTTAINAI_REAL_APPLIANCE_OCI_MANIFEST");
    let blobs_directory = required_path("MOTTAINAI_REAL_APPLIANCE_BLOBS_DIR");
    let canonical_manifest_path = required_path("MOTTAINAI_REAL_APPLIANCE_MANIFEST");
    let canonical_raw_path = required_path("MOTTAINAI_REAL_APPLIANCE_RAW_DISK");
    let state_directory = required_path("MOTTAINAI_PRODUCTION_LIMA_STATE_DIRECTORY");
    let instance_name = std::env::var("MOTTAINAI_REAL_LIMA_INSTANCE")
        .unwrap_or_else(|_| "mottainai-runtime-844".to_owned());

    assert!(
        oci_manifest_path.is_file(),
        "OCI manifest must be a regular file"
    );
    assert!(
        canonical_manifest_path.is_file(),
        "canonical manifest must be a regular file"
    );
    assert!(
        canonical_raw_path.is_file(),
        "canonical raw disk must be a regular file"
    );

    // The OCI manifest digest is the immutable Appliance identity consumed by
    // `ensure_appliance`; the canonical image manifest separately identifies
    // the exact Nix-produced raw bytes that the OCI fixture was built from.
    let appliance_digest = format!("sha256:{}", digest_file(&oci_manifest_path));
    let canonical_manifest: serde_json::Value = serde_json::from_reader(
        File::open(&canonical_manifest_path).expect("open canonical Appliance manifest"),
    )
    .expect("parse canonical Appliance manifest");
    let canonical_raw_sha256 = canonical_manifest["image"]["sha256"]
        .as_str()
        .expect("canonical Appliance manifest must identify image.sha256");
    let canonical_raw_size = canonical_manifest["image"]["sizeBytes"]
        .as_u64()
        .expect("canonical Appliance manifest must identify image.sizeBytes");
    assert_eq!(canonical_raw_sha256.len(), 64);
    assert!(canonical_raw_sha256
        .chars()
        .all(|character| character.is_ascii_hexdigit()));
    assert_eq!(
        digest_file(&canonical_raw_path),
        canonical_raw_sha256,
        "trusted-main must hand the exact Nix-produced raw bytes to the OCI fixture"
    );
    assert_eq!(
        std::fs::metadata(&canonical_raw_path)
            .expect("inspect canonical Appliance raw disk")
            .len(),
        canonical_raw_size,
        "trusted-main must hand the Nix-produced raw artifact to the OCI fixture"
    );
    eprintln!(
        "lima_composition identity=oci:{} canonical_raw_sha256={} canonical_raw_size_bytes={}",
        &appliance_digest[7..],
        canonical_raw_sha256,
        canonical_raw_size
    );

    let paths = ManagedPaths::new(state_directory);
    let cli = SystemLimaCli {
        binary_path: paths.active_link.join("bin/limactl"),
        lima_home: paths.lima_home_directory.clone(),
        qemu_system_path: Some(
            managed_qemu_system_path(&paths)
                .expect("trusted-main state must contain the verified managed QEMU"),
        ),
    };
    assert!(cli.binary_path.is_file(), "managed limactl must be present");

    // The state root and LIMA_HOME are CI-owned and isolated. Remove only a
    // stale instance in that isolated home so a failed prior run cannot be
    // mistaken for successful production reconciliation.
    if cli
        .list_all()
        .expect("list isolated Lima instances")
        .iter()
        .any(|instance| instance.name == instance_name)
    {
        cli.delete_for_cleanup(&instance_name)
            .expect("remove stale isolated Lima instance");
    }
    let _cleanup = Cleanup {
        cli: &cli,
        instance: &instance_name,
    };

    let spec = RuntimeSpec {
        schema_version: RUNTIME_SPEC_SCHEMA_VERSION.to_owned(),
        instance_name: instance_name.clone(),
        architecture: "x86_64".to_owned(),
        cpus: 2,
        memory_mib: 2048,
        appliance: ApplianceReference {
            registry: "local-fixture".to_owned(),
            repository: "mottainai/runtime-appliance".to_owned(),
            digest: appliance_digest.clone(),
        },
        mounts: Vec::new(),
        managed_generation: None,
    };
    let source = FileOciSource {
        manifest_path: oci_manifest_path,
        blobs_directory,
    };

    // This is the production host-bootstrap orchestration boundary. The only
    // test injection is FileOciSource, which supplies already-built canonical
    // bytes without changing production YAML, lifecycle, SSH, or health code.
    let evidence = ensure_runtime(
        &paths,
        &spec,
        &cli,
        &source,
        &RuntimeEnsureConfig::default(),
    );
    assert_eq!(evidence.result, mottainai_host_bootstrap::Outcome::Changed);
    assert_eq!(
        evidence.appliance_digest.as_deref(),
        Some(appliance_digest.as_str())
    );
    assert_eq!(evidence.instance_name, instance_name);
    assert!(
        evidence.guest_reachable,
        "production Lima SSH must reach guest health"
    );
    let guest_status = evidence
        .guest_status
        .as_ref()
        .expect("production guest health status must be recorded");
    assert_eq!(
        guest_status["contractId"].as_str(),
        Some("mottainai.linux-runtime.v1")
    );
    assert!(guest_status["schemaVersion"]
        .as_i64()
        .is_some_and(|version| version >= 2));
    assert_eq!(guest_status["bootstrapReady"].as_bool(), Some(true));

    // ensure_appliance verified and materialized the same raw identity before
    // render_lima_config received it. The config and carrier assertions below
    // additionally make the #840 physical attachment visible in evidence.
    let materialized_raw = paths.appliance_raw_path(&appliance_digest);
    assert_eq!(digest_file(&materialized_raw), canonical_raw_sha256);
    let config_path = paths.runtime_config_path(&spec.instance_name);
    let config =
        std::fs::read_to_string(&config_path).expect("production Lima YAML must be recorded");
    let parsed: serde_json::Value =
        serde_saphyr::from_str(&config).expect("parse production Lima YAML");
    assert_eq!(
        parsed["images"][0]["location"].as_str(),
        materialized_raw.to_str(),
        "production render_lima_config must consume the materialized canonical Appliance"
    );
    assert_eq!(
        parsed["additionalDisks"][0]["name"].as_str(),
        Some(bootstrap_disk_name(&spec.instance_name).as_str())
    );
    assert_eq!(
        parsed["additionalDisks"][0]["format"].as_bool(),
        Some(false)
    );
    assert!(bootstrap_disk_path(&paths, &spec.instance_name).is_file());

    // Drop performs bounded provider cleanup even when a later assertion
    // fails. The managed provider/QEMU state remains available for diagnostics
    // until the workflow's isolated-state cleanup step runs.
}
