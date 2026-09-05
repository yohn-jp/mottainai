use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::appliance::ApplianceReference;
use crate::error::{BootstrapError, ErrorCode};
use crate::lima::{ManagedGenerationIntent, RuntimeSpec, RUNTIME_SPEC_SCHEMA_VERSION};

/// Bounded ceiling for the published deployment descriptor document itself
/// (distinct from `lima::MAX_MANIFEST_BYTES`, which bounds the smaller
/// projected manifest this module derives from it).
const MAX_DESCRIPTOR_BYTES: usize = 1024 * 1024;

const SUPPORTED_DEPLOYMENT_CONTRACT_ID: &str = "mottainai.deployment.v1";
const SUPPORTED_DEPLOYMENT_SCHEMA_VERSION: u64 = 1;
const SUPPORTED_DEPLOYMENT_PROFILE: &str = "linux-x86_64";
const SUPPORTED_DEPLOYMENT_ARCHITECTURE: &str = "x86_64-linux";

/// A published `mottainai.managed-generation.v1` package entry, read
/// directly off `route2.managedGeneration.packages` — the exact shape
/// `src/runtime-contract/deployment-descriptor.ts`'s `managedPackageSchema`
/// already validated at publish time. This crate never re-validates that
/// shape; see the module doc below.
#[derive(Clone, Debug, Deserialize)]
struct DescriptorManagedPackage {
    #[serde(rename = "packageId")]
    package_id: String,
    version: String,
    #[serde(rename = "flakeRef")]
    flake_ref: String,
    #[serde(rename = "sourceSha256")]
    source_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
struct DescriptorRoute2ManagedGeneration {
    packages: Vec<DescriptorManagedPackage>,
}

#[derive(Clone, Debug, Deserialize)]
struct DescriptorRoute2 {
    #[serde(rename = "managedGeneration")]
    managed_generation: DescriptorRoute2ManagedGeneration,
}

#[derive(Clone, Debug, Deserialize)]
struct DescriptorApplianceRef {
    registry: String,
    repository: String,
    digest: String,
}

#[derive(Clone, Debug, Deserialize)]
struct DescriptorRoute3 {
    appliance: DescriptorApplianceRef,
    #[serde(rename = "managedGenerationIdentity")]
    managed_generation_identity: String,
}

/// The small compatibility envelope owned by this standalone consumer. The
/// publication schema remains authoritative for the complete descriptor; the
/// consumer only needs these fields to prove that it understands the document
/// before projecting the Route 2/3 subset below.
#[derive(Clone, Debug, Deserialize)]
struct DeploymentDescriptorCompatibility {
    #[serde(rename = "contractId")]
    contract_id: String,
    #[serde(rename = "schemaVersion")]
    schema_version: u64,
    profile: String,
    architecture: String,
}

/// Only the fields Route 3 (#753) needs to derive a `RuntimeSpec` from the
/// exact published deployment descriptor (#755/ADR-0003). Deliberately not a
/// full mirror of `DeploymentDescriptorSchema`
/// (`src/runtime-contract/deployment-descriptor.ts`): that schema's own
/// `.strict()` validation already ran once, at publish time
/// (`scripts/build-deployment-descriptor.mjs`), and produced the exact,
/// content-addressed bytes this module reads. Re-implementing that
/// validation here would be a second, driftable copy of the same authority;
/// instead this module trusts the descriptor's *contents* only after
/// `read_deployment_descriptor` has byte-verified the file against its
/// published sha256 sidecar, validated the minimal compatibility envelope,
/// and then read out a bounded projection subset with ordinary `serde` field
/// presence/type checks. Unknown unrelated fields remain outside this
/// consumer-owned compatibility contract.
#[derive(Clone, Debug, Deserialize)]
struct DeploymentDescriptor {
    route2: DescriptorRoute2,
    route3: DescriptorRoute3,
}

fn invalid(message: impl Into<String>) -> BootstrapError {
    BootstrapError::new(ErrorCode::DeploymentDescriptorInvalid, message)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_compatibility(bytes: &[u8]) -> Result<(), BootstrapError> {
    let compatibility: DeploymentDescriptorCompatibility = serde_json::from_slice(bytes)
        .map_err(|_| invalid("deployment descriptor compatibility envelope is malformed"))?;

    if compatibility.contract_id != SUPPORTED_DEPLOYMENT_CONTRACT_ID {
        return Err(invalid("unsupported deployment descriptor contractId"));
    }
    if compatibility.schema_version != SUPPORTED_DEPLOYMENT_SCHEMA_VERSION {
        return Err(invalid("unsupported deployment descriptor schemaVersion"));
    }
    if compatibility.profile != SUPPORTED_DEPLOYMENT_PROFILE {
        return Err(invalid("unsupported deployment descriptor profile"));
    }
    if compatibility.architecture != SUPPORTED_DEPLOYMENT_ARCHITECTURE {
        return Err(invalid("unsupported deployment descriptor architecture"));
    }

    Ok(())
}

/// Reads a published deployment descriptor's exact bytes and verifies them
/// against a detached sha256 sidecar (`<sha256>  <basename>\n`, the format
/// `scripts/build-deployment-descriptor.mjs` writes) before parsing anything.
/// This is a byte-identity check against a content-addressed, already-
/// validated artifact — not a re-derivation of the descriptor's own
/// canonicalization — so a single-line sidecar read and a raw sha256 over
/// the file bytes is the complete, correct check.
fn read_verified_descriptor_bytes(
    descriptor_path: &Path,
    sidecar_path: &Path,
) -> Result<Vec<u8>, BootstrapError> {
    let bytes = std::fs::read(descriptor_path)
        .map_err(|error| BootstrapError::io("read deployment descriptor", &error))?;
    if bytes.len() > MAX_DESCRIPTOR_BYTES {
        return Err(invalid(
            "deployment descriptor exceeds the bounded document size",
        ));
    }
    let sidecar_text = std::fs::read_to_string(sidecar_path)
        .map_err(|error| BootstrapError::io("read deployment descriptor sidecar", &error))?;
    let expected_sha256 = sidecar_text
        .split_whitespace()
        .next()
        .ok_or_else(|| invalid("deployment descriptor sidecar is empty or malformed"))?
        .to_ascii_lowercase();
    let valid_digest = expected_sha256.len() == 64
        && expected_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit());
    if !valid_digest {
        return Err(invalid(
            "deployment descriptor sidecar does not contain a sha256 hex digest",
        ));
    }
    let actual_sha256 = sha256_hex(&bytes);
    if actual_sha256 != expected_sha256 {
        return Err(invalid(format!(
            "deployment descriptor identity mismatch; expected {expected_sha256}, got {actual_sha256}"
        )));
    }
    Ok(bytes)
}

/// The canonical `mottainai.managed-package-manifest.v1` projection of one
/// descriptor package entry, matching
/// `src/runtime-contract/managed-package-manifest.ts`'s
/// `canonicalizePackageEntries` field order/shape exactly — this crate is
/// still not the parser/validator of that contract (`lima.rs`'s
/// `ManagedGenerationIntent` doc), it only emits the same deterministic
/// projection `scripts/build-lima-runtime-spec.mjs` used to, from the same
/// closed-form input.
fn canonical_manifest(packages: &[DescriptorManagedPackage]) -> Value {
    let mut sorted = packages.to_vec();
    sorted.sort_by(|left, right| left.package_id.cmp(&right.package_id));
    let entries: Vec<Value> = sorted
        .iter()
        .map(|entry| {
            serde_json::json!({
                "packageId": entry.package_id,
                "kind": "nix-flake-package",
                "version": entry.version,
                "source": {
                    "flakeRef": entry.flake_ref,
                    "sourceSha256": entry.source_sha256.to_ascii_lowercase(),
                },
            })
        })
        .collect();
    serde_json::json!({
        "contractId": "mottainai.managed-package-manifest.v1",
        "schemaVersion": 1,
        // A fresh materialization always starts at generation 1; the
        // guest's own reconcileManagedRuntime state machine owns generation
        // progression from here on (docs/managed-package-manifest.md:
        // activation.generation is reconciliation-ordering bookkeeping,
        // excluded from semantic identity).
        "activation": { "generation": 1 },
        "packages": entries,
    })
}

/// Derives one Route 3 `RuntimeSpec` — Appliance identity plus the desired
/// managed-generation intent — directly from an exact, byte-verified
/// deployment descriptor. The zero-manual composition boundary ADR-0003
/// requires, now inside the standalone Rust bootstrap itself: no Node, no
/// repository checkout, no ambient host dependency.
pub fn runtime_spec_from_descriptor(
    descriptor_path: &Path,
    sidecar_path: &Path,
    instance_name: &str,
    cpus: u32,
    memory_mib: u64,
) -> Result<RuntimeSpec, BootstrapError> {
    let bytes = read_verified_descriptor_bytes(descriptor_path, sidecar_path)?;
    validate_compatibility(&bytes)?;
    let descriptor: DeploymentDescriptor = serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("parse deployment descriptor: {error}")))?;

    let manifest = canonical_manifest(&descriptor.route2.managed_generation.packages);

    Ok(RuntimeSpec {
        schema_version: RUNTIME_SPEC_SCHEMA_VERSION.to_owned(),
        instance_name: instance_name.to_owned(),
        architecture: "x86_64".to_owned(),
        cpus,
        memory_mib,
        appliance: ApplianceReference {
            registry: descriptor.route3.appliance.registry,
            repository: descriptor.route3.appliance.repository,
            digest: descriptor.route3.appliance.digest.to_ascii_lowercase(),
        },
        mounts: Vec::new(),
        managed_generation: Some(ManagedGenerationIntent {
            identity: descriptor
                .route3
                .managed_generation_identity
                .to_ascii_lowercase(),
            manifest,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_descriptor(
        dir: &Path,
        descriptor_json: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let descriptor_path = dir.join("deployment-descriptor.json");
        let mut file = std::fs::File::create(&descriptor_path).unwrap();
        file.write_all(descriptor_json.as_bytes()).unwrap();
        let sha256 = sha256_hex(descriptor_json.as_bytes());
        let sidecar_path = dir.join("deployment-descriptor.json.sha256");
        std::fs::write(
            &sidecar_path,
            format!("{sha256}  deployment-descriptor.json\n"),
        )
        .unwrap();
        (descriptor_path, sidecar_path)
    }

    fn sample_descriptor_json() -> String {
        serde_json::json!({
            "contractId": SUPPORTED_DEPLOYMENT_CONTRACT_ID,
            "schemaVersion": SUPPORTED_DEPLOYMENT_SCHEMA_VERSION,
            "profile": SUPPORTED_DEPLOYMENT_PROFILE,
            "architecture": SUPPORTED_DEPLOYMENT_ARCHITECTURE,
            "route2": {
                "managedGeneration": {
                    "packages": [
                        {
                            "packageId": "zellij",
                            "version": "0.41.0",
                            "flakeRef": "nix#zellij",
                            "sourceSha256": "b".repeat(64),
                        },
                        {
                            "packageId": "mottainai",
                            "version": "1.2.3",
                            "flakeRef": "nix#mottainai",
                            "sourceSha256": "A".repeat(64),
                        }
                    ]
                }
            },
            "route3": {
                "appliance": {
                    "registry": "ghcr.io",
                    "repository": "yohn-jp/mottainai/runtime-appliance",
                    "digest": "SHA256:".to_ascii_lowercase() + &"c".repeat(64),
                },
                "managedGenerationIdentity": "D".repeat(64),
            }
        })
        .to_string()
    }

    fn descriptor_with_compatibility_value(field: &str, value: Value) -> String {
        let mut descriptor: Value = serde_json::from_str(&sample_descriptor_json()).unwrap();
        descriptor
            .as_object_mut()
            .unwrap()
            .insert(field.to_owned(), value);
        serde_json::to_string(&descriptor).unwrap()
    }

    #[test]
    fn derives_runtime_spec_with_sorted_manifest_and_lowercase_digests() {
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) =
            write_descriptor(dir.path(), &sample_descriptor_json());

        let spec = runtime_spec_from_descriptor(
            &descriptor_path,
            &sidecar_path,
            "mottainai-runtime",
            2,
            4096,
        )
        .unwrap();

        assert_eq!(spec.schema_version, RUNTIME_SPEC_SCHEMA_VERSION);
        assert_eq!(spec.appliance.registry, "ghcr.io");
        assert_eq!(spec.appliance.digest, format!("sha256:{}", "c".repeat(64)));
        assert!(spec.mounts.is_empty());
        spec.validate()
            .expect("derived spec passes RuntimeSpec::validate");

        let managed_generation = spec.managed_generation.expect("managed generation intent");
        assert_eq!(managed_generation.identity, "d".repeat(64));
        let packages = managed_generation.manifest["packages"].as_array().unwrap();
        assert_eq!(packages.len(), 2);
        // Sorted by packageId: "mottainai" before "zellij".
        assert_eq!(packages[0]["packageId"], "mottainai");
        assert_eq!(packages[0]["source"]["sourceSha256"], "a".repeat(64));
        assert_eq!(packages[1]["packageId"], "zellij");
        assert_eq!(managed_generation.manifest["activation"]["generation"], 1);
    }

    #[test]
    fn fails_closed_on_sidecar_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) =
            write_descriptor(dir.path(), &sample_descriptor_json());
        std::fs::write(
            &sidecar_path,
            format!("{}  deployment-descriptor.json\n", "0".repeat(64)),
        )
        .unwrap();

        let error = runtime_spec_from_descriptor(
            &descriptor_path,
            &sidecar_path,
            "mottainai-runtime",
            2,
            4096,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
        assert!(error.message.contains("identity mismatch"));
    }

    #[test]
    fn fails_closed_on_unsupported_contract_id_after_byte_verification() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_json = descriptor_with_compatibility_value(
            "contractId",
            Value::String("mottainai.deployment.v2".to_owned()),
        );
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &descriptor_json);

        let error = runtime_spec_from_descriptor(
            &descriptor_path,
            &sidecar_path,
            "mottainai-runtime",
            2,
            4096,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
        assert_eq!(
            error.message,
            "unsupported deployment descriptor contractId"
        );
    }

    #[test]
    fn fails_closed_on_unsupported_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_json = descriptor_with_compatibility_value("schemaVersion", Value::from(2));
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &descriptor_json);

        let error = runtime_spec_from_descriptor(
            &descriptor_path,
            &sidecar_path,
            "mottainai-runtime",
            2,
            4096,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
        assert_eq!(
            error.message,
            "unsupported deployment descriptor schemaVersion"
        );
    }

    #[test]
    fn fails_closed_on_unsupported_profile() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_json = descriptor_with_compatibility_value(
            "profile",
            Value::String("linux-aarch64".to_owned()),
        );
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &descriptor_json);

        let error = runtime_spec_from_descriptor(
            &descriptor_path,
            &sidecar_path,
            "mottainai-runtime",
            2,
            4096,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
        assert_eq!(error.message, "unsupported deployment descriptor profile");
    }

    #[test]
    fn fails_closed_on_unsupported_architecture() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_json = descriptor_with_compatibility_value(
            "architecture",
            Value::String("aarch64-linux".to_owned()),
        );
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &descriptor_json);

        let error = runtime_spec_from_descriptor(
            &descriptor_path,
            &sidecar_path,
            "mottainai-runtime",
            2,
            4096,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
        assert_eq!(
            error.message,
            "unsupported deployment descriptor architecture"
        );
    }

    #[test]
    fn byte_mismatch_is_rejected_before_compatibility_parsing() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_json = descriptor_with_compatibility_value(
            "contractId",
            Value::String("mottainai.deployment.v2".to_owned()),
        );
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &descriptor_json);
        std::fs::write(
            &sidecar_path,
            format!("{}  deployment-descriptor.json\n", "0".repeat(64)),
        )
        .unwrap();

        let error = runtime_spec_from_descriptor(
            &descriptor_path,
            &sidecar_path,
            "mottainai-runtime",
            2,
            4096,
        )
        .unwrap_err();
        assert!(error.message.contains("identity mismatch"));
    }

    #[test]
    fn unknown_unrelated_fields_do_not_change_compatibility() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_json = descriptor_with_compatibility_value(
            "futureField",
            serde_json::json!({ "schemaVersion": 99, "meaning": "future" }),
        );
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &descriptor_json);

        runtime_spec_from_descriptor(
            &descriptor_path,
            &sidecar_path,
            "mottainai-runtime",
            2,
            4096,
        )
        .expect("unrelated fields are outside the consumer compatibility envelope");
    }

    #[test]
    fn fails_closed_on_malformed_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) =
            write_descriptor(dir.path(), &sample_descriptor_json());
        std::fs::write(&sidecar_path, "not-a-digest\n").unwrap();

        let error = runtime_spec_from_descriptor(
            &descriptor_path,
            &sidecar_path,
            "mottainai-runtime",
            2,
            4096,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
    }

    #[test]
    fn fails_closed_on_missing_required_field() {
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), r#"{"route2":{}}"#);

        let error = runtime_spec_from_descriptor(
            &descriptor_path,
            &sidecar_path,
            "mottainai-runtime",
            2,
            4096,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
    }
}
