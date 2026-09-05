use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::appliance::ApplianceReference;
use crate::contract::{ProviderContract, CONTRACT_SCHEMA_VERSION, SUPPORTED_LIMA_VERSION};
use crate::error::{BootstrapError, ErrorCode};
use crate::lima::{ManagedGenerationIntent, RuntimeSpec, RUNTIME_SPEC_SCHEMA_VERSION};
use crate::qemu::{
    QemuArtifact, QemuContract, QemuDataArtifact, QemuState, QEMU_CONTRACT_SCHEMA_VERSION,
    QEMU_IMAGE_EXECUTABLE, QEMU_SUPPORTED_VERSION, QEMU_SYSTEM_EXECUTABLE,
};

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
/// before projecting the Route 2/3/4 subsets below.
#[derive(Clone, Debug, Deserialize)]
struct DeploymentDescriptorCompatibility {
    #[serde(rename = "contractId")]
    contract_id: String,
    #[serde(rename = "schemaVersion")]
    schema_version: u64,
    profile: String,
    architecture: String,
}

/// One immutable artifact identity carried by the selected Route 4 provider
/// profile. This is intentionally the profile's identity vocabulary rather
/// than a second artifact schema invented by the Rust consumer.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
pub struct QemuArtifactIdentity {
    pub version: String,
    pub architecture: String,
    pub filename: String,
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<u64>,
    pub locator: String,
}

/// The complete QEMU identity selected by a Route 4 release descriptor.
/// `data_artifact` is required for every profile; executable identities are
/// additionally required to carry the system and image archive identities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QemuProviderRequirement {
    pub version: String,
    pub architecture: String,
    pub identity: String,
    pub identity_kind: String,
    pub system_binary: Option<QemuArtifactIdentity>,
    pub image_binary: Option<QemuArtifactIdentity>,
    pub data_artifact: QemuArtifactIdentity,
    pub minimum_version: String,
    pub qemu_major: u8,
    pub requires_kvm: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct DescriptorQemu {
    version: String,
    architecture: String,
    identity: String,
    #[serde(rename = "identityKind")]
    identity_kind: String,
    #[serde(rename = "systemBinary")]
    system_binary: Option<QemuArtifactIdentity>,
    #[serde(rename = "imageBinary")]
    image_binary: Option<QemuArtifactIdentity>,
    #[serde(rename = "dataArtifact")]
    data_artifact: QemuArtifactIdentity,
    #[serde(rename = "minimumVersion")]
    minimum_version: String,
}

#[derive(Clone, Debug, Deserialize)]
struct DescriptorProviderCompatibility {
    #[serde(rename = "limaMajor")]
    lima_major: u8,
    #[serde(rename = "qemuMajor")]
    qemu_major: u8,
    #[serde(rename = "requiresKvm")]
    requires_kvm: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct DescriptorProviderProvisioning {
    strategy: String,
    #[serde(rename = "contractVersion")]
    contract_version: u8,
    #[serde(rename = "stateDirectory")]
    state_directory: String,
}

#[derive(Clone, Debug, Deserialize)]
struct DescriptorRoute4Provider {
    #[serde(rename = "profileId")]
    profile_id: String,
    architecture: String,
    provisioning: DescriptorProviderProvisioning,
    lima: QemuArtifactIdentity,
    qemu: DescriptorQemu,
    compatibility: DescriptorProviderCompatibility,
}

#[derive(Clone, Debug, Deserialize)]
struct DescriptorRoute4 {
    provider: DescriptorRoute4Provider,
}

/// Only the fields the standalone consumer needs to derive Route 3 (#753) and
/// the complete Route 4 QEMU requirement from the exact published deployment
/// descriptor (#755/ADR-0003). Deliberately not a full mirror of
/// `DeploymentDescriptorSchema`
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
    route4: DescriptorRoute4,
}

/// The complete immutable Route 4 provider projection selected by one
/// verified deployment descriptor. `lima` uses the same bounded provider
/// artifact vocabulary as the QEMU projection; the alias keeps one artifact
/// identity schema for the whole provider profile.
pub type ProviderArtifactIdentity = QemuArtifactIdentity;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Route4ProviderRequirement {
    pub profile_id: String,
    pub architecture: String,
    pub provisioning_strategy: String,
    pub provisioning_contract_version: u8,
    pub state_directory: String,
    pub lima: ProviderArtifactIdentity,
    pub qemu: QemuProviderRequirement,
    pub lima_major: u8,
    pub qemu_major: u8,
    pub requires_kvm: bool,
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

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value.chars().all(|character| character.is_ascii_hexdigit())
        && value == value.to_ascii_lowercase()
}

fn version_major(value: &str) -> Option<u8> {
    value.split('.').next()?.parse().ok()
}

fn validate_qemu_artifact(
    artifact: &QemuArtifactIdentity,
    qemu_version: &str,
    role: &str,
) -> Result<(), BootstrapError> {
    let valid_filename = !artifact.filename.is_empty()
        && artifact.filename.len() <= 256
        && artifact.filename.ends_with(".tar.gz")
        && artifact
            .filename
            .chars()
            .all(|character| !character.is_control() && !matches!(character, '/' | '\\'));
    let valid_locator = artifact
        .locator
        .starts_with("https://github.com/hermeticbuild/qemu-prebuilt/")
        && !artifact.locator.contains(['\n', '\r', '"', '\'']);
    let valid_size = artifact
        .size_bytes
        .is_none_or(|size| (1..=2 * 1024 * 1024 * 1024).contains(&size));
    if artifact.version != qemu_version
        || artifact.architecture != "x86_64"
        || !valid_filename
        || !valid_sha256(&artifact.sha256)
        || !valid_locator
        || !valid_size
    {
        return Err(invalid(format!(
            "Route 4 QEMU {role} artifact is not a bounded immutable x86_64 archive identity"
        )));
    }
    Ok(())
}

impl QemuProviderRequirement {
    /// Validates the minimal supported QEMU profile policy after the
    /// publication schema has validated the complete descriptor. The profile
    /// remains the identity authority; this method does not derive a second
    /// digest or replace any artifact identity.
    pub fn validate(&self) -> Result<(), BootstrapError> {
        if self.version != QEMU_SUPPORTED_VERSION
            || self.architecture != "x86_64"
            || !valid_sha256(&self.identity)
            || !matches!(
                self.identity_kind.as_str(),
                "compatibility-profile" | "executable-digest"
            )
            || version_major(&self.minimum_version) != version_major(&self.version)
        {
            return Err(invalid(
                "Route 4 QEMU profile is not the supported immutable x86_64 contract",
            ));
        }
        if self.identity_kind == "executable-digest"
            && (self.system_binary.is_none() || self.image_binary.is_none())
        {
            return Err(invalid(
                "executable-digest QEMU profile must bind system and image artifacts",
            ));
        }
        if let Some(system) = &self.system_binary {
            validate_qemu_artifact(system, &self.version, "system")?;
        }
        if let Some(image) = &self.image_binary {
            validate_qemu_artifact(image, &self.version, "image")?;
        }
        validate_qemu_artifact(&self.data_artifact, &self.version, "data")?;

        let artifacts = [
            ("system", self.system_binary.as_ref()),
            ("image", self.image_binary.as_ref()),
            ("data", Some(&self.data_artifact)),
        ];
        for left in 0..artifacts.len() {
            for right in (left + 1)..artifacts.len() {
                if let (Some(left_artifact), Some(right_artifact)) =
                    (artifacts[left].1, artifacts[right].1)
                {
                    if left_artifact.sha256 == right_artifact.sha256
                        || left_artifact.filename == right_artifact.filename
                    {
                        return Err(invalid(format!(
                            "Route 4 QEMU {} and {} must identify distinct artifacts",
                            artifacts[left].0, artifacts[right].0
                        )));
                    }
                }
            }
        }
        if self.qemu_major != version_major(&self.version).unwrap_or_default() || !self.requires_kvm
        {
            return Err(invalid(
                "Route 4 QEMU compatibility does not match the supported version/KVM profile",
            ));
        }
        Ok(())
    }

    pub fn observation_requirement(&self) -> crate::model::QemuRequirement {
        crate::model::QemuRequirement {
            system_executable: QEMU_SYSTEM_EXECUTABLE.to_owned(),
            image_executable: QEMU_IMAGE_EXECUTABLE.to_owned(),
            minimum_version: self.minimum_version.clone(),
            accelerator: if self.requires_kvm {
                "kvm".to_owned()
            } else {
                "".to_owned()
            },
        }
    }
}

fn qemu_requirement_from_descriptor_value(
    descriptor: &DeploymentDescriptor,
) -> Result<QemuProviderRequirement, BootstrapError> {
    let qemu = &descriptor.route4.provider.qemu;
    let compatibility = &descriptor.route4.provider.compatibility;
    let requirement = QemuProviderRequirement {
        version: qemu.version.clone(),
        architecture: qemu.architecture.clone(),
        identity: qemu.identity.clone(),
        identity_kind: qemu.identity_kind.clone(),
        system_binary: qemu.system_binary.clone(),
        image_binary: qemu.image_binary.clone(),
        data_artifact: qemu.data_artifact.clone(),
        minimum_version: qemu.minimum_version.clone(),
        qemu_major: compatibility.qemu_major,
        requires_kvm: compatibility.requires_kvm,
    };
    requirement.validate()?;
    Ok(requirement)
}

fn validate_lima_artifact(artifact: &ProviderArtifactIdentity) -> Result<(), BootstrapError> {
    let valid_filename = !artifact.filename.is_empty()
        && artifact.filename.len() <= 256
        && artifact.filename.ends_with(".tar.gz")
        && artifact
            .filename
            .chars()
            .all(|character| !character.is_control() && !matches!(character, '/' | '\\'));
    let valid_locator = artifact
        .locator
        .starts_with("https://github.com/lima-vm/lima/")
        && !artifact.locator.contains(['\n', '\r', '"', '\'']);
    let valid_size = artifact
        .size_bytes
        .is_none_or(|size| (1..=256 * 1024 * 1024).contains(&size));
    if artifact.version != SUPPORTED_LIMA_VERSION
        || artifact.architecture != "x86_64"
        || !valid_filename
        || !valid_sha256(&artifact.sha256)
        || !valid_locator
        || !valid_size
    {
        return Err(invalid(
            "Route 4 Lima profile is not the supported immutable x86_64 archive identity",
        ));
    }
    Ok(())
}

fn artifact_id(filename: &str) -> String {
    filename
        .strip_suffix(".tar.gz")
        .unwrap_or(filename)
        .to_owned()
}

fn lima_contract_from_requirement(requirement: &Route4ProviderRequirement) -> ProviderContract {
    ProviderContract {
        schema_version: CONTRACT_SCHEMA_VERSION.to_owned(),
        provider: "lima".to_owned(),
        version: requirement.lima.version.clone(),
        artifact_id: artifact_id(&requirement.lima.filename),
        artifact_url: requirement.lima.locator.clone(),
        artifact_sha256: requirement.lima.sha256.clone(),
        max_artifact_bytes: requirement.lima.size_bytes.unwrap_or(256 * 1024 * 1024),
        download_timeout_seconds: 300,
        archive_binary_path: "bin/limactl".to_owned(),
    }
}

fn qemu_contract_from_requirement(
    requirement: &Route4ProviderRequirement,
) -> Result<QemuContract, BootstrapError> {
    let system =
        requirement.qemu.system_binary.as_ref().ok_or_else(|| {
            invalid("pinned Route 4 QEMU profile has no system artifact identity")
        })?;
    let image = requirement
        .qemu
        .image_binary
        .as_ref()
        .ok_or_else(|| invalid("pinned Route 4 QEMU profile has no image artifact identity"))?;
    let max_qemu_artifact_bytes =
        |artifact: &ProviderArtifactIdentity| artifact.size_bytes.unwrap_or(64 * 1024 * 1024);
    let contract = QemuContract {
        schema_version: QEMU_CONTRACT_SCHEMA_VERSION.to_owned(),
        version: requirement.qemu.version.clone(),
        system: QemuArtifact {
            artifact_id: artifact_id(&system.filename),
            artifact_url: system.locator.clone(),
            artifact_sha256: system.sha256.clone(),
            archive_binary_path: format!("bin/{QEMU_SYSTEM_EXECUTABLE}"),
            max_artifact_bytes: max_qemu_artifact_bytes(system),
        },
        image: QemuArtifact {
            artifact_id: artifact_id(&image.filename),
            artifact_url: image.locator.clone(),
            artifact_sha256: image.sha256.clone(),
            archive_binary_path: format!("bin/{QEMU_IMAGE_EXECUTABLE}"),
            max_artifact_bytes: max_qemu_artifact_bytes(image),
        },
        data: QemuDataArtifact {
            artifact_id: artifact_id(&requirement.qemu.data_artifact.filename),
            artifact_url: requirement.qemu.data_artifact.locator.clone(),
            artifact_sha256: requirement.qemu.data_artifact.sha256.clone(),
            max_artifact_bytes: max_qemu_artifact_bytes(&requirement.qemu.data_artifact),
        },
    };
    contract.validate()?;
    Ok(contract)
}

impl Route4ProviderRequirement {
    /// Validates the supported Route 4 provider mode after the descriptor's
    /// publication schema and shared compatibility boundary have run.
    pub fn validate(&self) -> Result<(), BootstrapError> {
        let state_directory_valid = !self.state_directory.is_empty()
            && self.state_directory.len() <= 4096
            && self
                .state_directory
                .chars()
                .all(|character| !character.is_control());
        if self.profile_id != SUPPORTED_DEPLOYMENT_PROFILE
            || self.architecture != SUPPORTED_DEPLOYMENT_ARCHITECTURE
            || self.provisioning_contract_version != 1
            || self.provisioning_strategy != "pinned-verified-archives"
            || self.qemu.identity_kind != "executable-digest"
            || !state_directory_valid
            || self.lima_major != version_major(&self.lima.version).unwrap_or_default()
            || self.lima_major != version_major(SUPPORTED_LIMA_VERSION).unwrap_or_default()
            || self.qemu_major != self.qemu.qemu_major
            || !self.requires_kvm
        {
            return Err(invalid(
                "Route 4 provider profile is not the supported pinned Linux x86_64/KVM mode",
            ));
        }
        validate_lima_artifact(&self.lima)?;
        self.qemu.validate()?;
        lima_contract_from_requirement(self).validate()?;
        qemu_contract_from_requirement(self)?;
        Ok(())
    }

    pub fn lima_contract(&self) -> Result<ProviderContract, BootstrapError> {
        self.validate()?;
        Ok(lima_contract_from_requirement(self))
    }

    pub fn qemu_contract(&self) -> Result<QemuContract, BootstrapError> {
        self.validate()?;
        qemu_contract_from_requirement(self)
    }
}

fn route4_provider_requirement_from_descriptor_value(
    descriptor: &DeploymentDescriptor,
) -> Result<Route4ProviderRequirement, BootstrapError> {
    let provider = &descriptor.route4.provider;
    let requirement = Route4ProviderRequirement {
        profile_id: provider.profile_id.clone(),
        architecture: provider.architecture.clone(),
        provisioning_strategy: provider.provisioning.strategy.clone(),
        provisioning_contract_version: provider.provisioning.contract_version,
        state_directory: provider.provisioning.state_directory.clone(),
        lima: provider.lima.clone(),
        qemu: qemu_requirement_from_descriptor_value(descriptor)?,
        lima_major: provider.compatibility.lima_major,
        qemu_major: provider.compatibility.qemu_major,
        requires_kvm: provider.compatibility.requires_kvm,
    };
    requirement.validate()?;
    Ok(requirement)
}

/// The single trust boundary every descriptor consumer routes through:
/// bounded read, detached sha256 exact-byte verification, minimal
/// compatibility validation, then parse into the typed projection subset.
/// Route 2/3 (`runtime_spec_from_descriptor`) and Route 4
/// (`qemu_requirement_from_descriptor`) both branch off this shared value
/// rather than each re-implementing authenticity/compatibility semantics.
fn read_verified_compatible_descriptor(
    descriptor_path: &Path,
    sidecar_path: &Path,
) -> Result<DeploymentDescriptor, BootstrapError> {
    let bytes = read_verified_descriptor_bytes(descriptor_path, sidecar_path)?;
    validate_compatibility(&bytes)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("parse deployment descriptor: {error}")))
}

/// Reads the selected release descriptor and returns its complete Route 4
/// QEMU system/image/data requirement. The detached sidecar plus the minimal
/// compatibility envelope remain the trust boundary; this function only
/// projects the already-verified, already-supported profile.
pub fn qemu_requirement_from_descriptor(
    descriptor_path: &Path,
    sidecar_path: &Path,
) -> Result<QemuProviderRequirement, BootstrapError> {
    let descriptor = read_verified_compatible_descriptor(descriptor_path, sidecar_path)?;
    qemu_requirement_from_descriptor_value(&descriptor)
}

/// Reads the selected release descriptor through the same verified and
/// compatible boundary and returns the complete Route 4 provider profile.
pub fn provider_requirement_from_descriptor(
    descriptor_path: &Path,
    sidecar_path: &Path,
) -> Result<Route4ProviderRequirement, BootstrapError> {
    let descriptor = read_verified_compatible_descriptor(descriptor_path, sidecar_path)?;
    route4_provider_requirement_from_descriptor_value(&descriptor)
}

/// The result of matching managed QEMU state to a descriptor-selected release.
/// `LegacyUnattested` is returned only after the complete existing artifact
/// provenance has been verified; it is not an authorization to trust unknown
/// state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QemuStateMatch {
    Exact,
    LegacyUnattested,
}

/// Verifies that managed QEMU provenance proves every artifact identity in a
/// selected release requirement. A missing or role-swapped data identity is
/// an incompatibility and must be rejected before provider-profile attestation
/// is considered.
pub fn validate_qemu_state_against_requirement(
    requirement: &QemuProviderRequirement,
    state: &QemuState,
) -> Result<QemuStateMatch, BootstrapError> {
    requirement.validate()?;
    let provisioning = state.provisioning.as_ref().ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "managed QEMU state has no complete release artifact provenance",
        )
    })?;
    let system = requirement.system_binary.as_ref().ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "selected QEMU requirement has no system artifact identity",
        )
    })?;
    let image = requirement.image_binary.as_ref().ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "selected QEMU requirement has no image artifact identity",
        )
    })?;
    if state.schema_version != QEMU_CONTRACT_SCHEMA_VERSION
        || state.version != requirement.version
        || state.host_os != "linux"
        || state.host_architecture != "x86_64"
        || provisioning.contract_schema_version != QEMU_CONTRACT_SCHEMA_VERSION
    {
        return Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "managed QEMU state does not match the selected release requirement",
        ));
    }

    let expected = [
        (
            "system",
            system,
            &provisioning.system_artifact_id,
            &provisioning.system_artifact_sha256,
        ),
        (
            "image",
            image,
            &provisioning.image_artifact_id,
            &provisioning.image_artifact_sha256,
        ),
        (
            "data",
            &requirement.data_artifact,
            &provisioning.data_artifact_id,
            &provisioning.data_artifact_sha256,
        ),
    ];
    for (role, artifact, actual_id, actual_sha256) in expected {
        let expected_id = artifact
            .filename
            .strip_suffix(".tar.gz")
            .unwrap_or(artifact.filename.as_str());
        if actual_id != expected_id || actual_sha256 != &artifact.sha256 {
            return Err(BootstrapError::new(
                ErrorCode::QemuIncompatible,
                format!("managed QEMU {role} artifact identity differs from the selected release"),
            ));
        }
    }
    match (
        state.provider_identity.as_deref(),
        state.provider_identity_kind.as_deref(),
    ) {
        (None, None) => Ok(QemuStateMatch::LegacyUnattested),
        (Some(identity), Some(identity_kind))
            if identity == requirement.identity && identity_kind == requirement.identity_kind =>
        {
            Ok(QemuStateMatch::Exact)
        }
        (None, Some(_)) | (Some(_), None) => Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "managed QEMU state has incomplete provider profile attestation",
        )),
        _ => Err(BootstrapError::new(
            ErrorCode::QemuIncompatible,
            "managed QEMU state does not match the selected release requirement",
        )),
    }
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
    let descriptor = read_verified_compatible_descriptor(descriptor_path, sidecar_path)?;

    // Route 4 is validated at the descriptor boundary even though runtime
    // provider selection remains owned by #842. This prevents a descriptor
    // with an incomplete QEMU closure from being projected into Route 3.
    qemu_requirement_from_descriptor_value(&descriptor)?;

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
    use crate::qemu::QemuProvisioningState;
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
        let lima_artifact = serde_json::json!({
            "version": "2.2.0",
            "architecture": "x86_64",
            "filename": "lima-2.2.0-Linux-x86_64.tar.gz",
            "sha256": "5".repeat(64),
            "locator": "https://github.com/lima-vm/lima/releases/download/v2.2.0/lima-2.2.0-Linux-x86_64.tar.gz",
        });
        let qemu_artifact = |filename: &str, sha256: &str| {
            serde_json::json!({
                "version": "11.0.0",
                "architecture": "x86_64",
                "filename": filename,
                "sha256": sha256,
                "locator": format!("https://github.com/hermeticbuild/qemu-prebuilt/{filename}"),
            })
        };
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
                    "lima": lima_artifact,
                    "qemu": {
                        "version": "11.0.0",
                        "architecture": "x86_64",
                        "identity": "1".repeat(64),
                        "identityKind": "executable-digest",
                        "systemBinary": qemu_artifact("qemu-system-bin-linux-amd64-x86_64-softmmu-11.0.0.1.tar.gz", &"2".repeat(64)),
                        "imageBinary": qemu_artifact("qemu-img-linux-amd64-11.0.0.1.tar.gz", &"3".repeat(64)),
                        "dataArtifact": qemu_artifact("qemu-system-data-linux-amd64-11.0.0.1.tar.gz", &"4".repeat(64)),
                        "minimumVersion": "11.0.0",
                    },
                    "compatibility": {
                        "limaMajor": 2,
                        "qemuMajor": 11,
                        "requiresKvm": true,
                    },
                },
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

        let requirement =
            qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap();
        assert_eq!(
            requirement.system_binary.as_ref().unwrap().sha256,
            "2".repeat(64)
        );
        assert_eq!(
            requirement.image_binary.as_ref().unwrap().sha256,
            "3".repeat(64)
        );
        assert_eq!(requirement.data_artifact.sha256, "4".repeat(64));
    }

    #[test]
    fn projects_the_complete_route4_provider_profile_without_compiled_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) =
            write_descriptor(dir.path(), &sample_descriptor_json());
        let requirement = provider_requirement_from_descriptor(&descriptor_path, &sidecar_path)
            .expect("supported descriptor projects to Route 4 provider requirement");

        assert_eq!(requirement.profile_id, "linux-x86_64");
        assert_eq!(
            requirement.provisioning_strategy,
            "pinned-verified-archives"
        );
        assert_eq!(requirement.lima.version, "2.2.0");
        assert_eq!(requirement.lima.sha256, "5".repeat(64));
        assert_eq!(
            requirement.lima_contract().unwrap().artifact_sha256,
            "5".repeat(64)
        );

        let qemu_contract = requirement.qemu_contract().unwrap();
        assert_eq!(qemu_contract.system.artifact_sha256, "2".repeat(64));
        assert_eq!(qemu_contract.image.artifact_sha256, "3".repeat(64));
        assert_eq!(qemu_contract.data.artifact_sha256, "4".repeat(64));
        assert_ne!(qemu_contract, crate::qemu::QemuContract::default());
    }

    #[test]
    fn changing_only_managed_qemu_data_identity_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_value: serde_json::Value =
            serde_json::from_str(&sample_descriptor_json()).unwrap();
        let (descriptor_path, sidecar_path) =
            write_descriptor(dir.path(), &descriptor_value.to_string());
        let requirement =
            qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap();
        let mut state = QemuState {
            schema_version: QEMU_CONTRACT_SCHEMA_VERSION.to_owned(),
            system_path: "/managed/qemu-system-x86_64".to_owned(),
            system_sha256: "a".repeat(64),
            image_path: "/managed/qemu-img".to_owned(),
            image_sha256: "b".repeat(64),
            version: "11.0.0".to_owned(),
            host_os: "linux".to_owned(),
            host_architecture: "x86_64".to_owned(),
            provider_identity: Some("1".repeat(64)),
            provider_identity_kind: Some("executable-digest".to_owned()),
            provisioning: Some(QemuProvisioningState {
                contract_schema_version: QEMU_CONTRACT_SCHEMA_VERSION.to_owned(),
                system_artifact_id: "qemu-system-bin-linux-amd64-x86_64-softmmu-11.0.0.1"
                    .to_owned(),
                system_artifact_sha256: "2".repeat(64),
                image_artifact_id: "qemu-img-linux-amd64-11.0.0.1".to_owned(),
                image_artifact_sha256: "3".repeat(64),
                data_artifact_id: "qemu-system-data-linux-amd64-11.0.0.1".to_owned(),
                data_artifact_sha256: "4".repeat(64),
            }),
        };
        validate_qemu_state_against_requirement(&requirement, &state).unwrap();

        state.provisioning.as_mut().unwrap().data_artifact_sha256 = "5".repeat(64);
        let error = validate_qemu_state_against_requirement(&requirement, &state).unwrap_err();
        assert_eq!(error.code, ErrorCode::QemuIncompatible);
        assert!(error.message.contains("data artifact identity"));
    }

    #[test]
    fn changing_only_qemu_profile_identity_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) =
            write_descriptor(dir.path(), &sample_descriptor_json());
        let requirement =
            qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap();
        let state = QemuState {
            schema_version: QEMU_CONTRACT_SCHEMA_VERSION.to_owned(),
            system_path: "/managed/qemu-system-x86_64".to_owned(),
            system_sha256: "a".repeat(64),
            image_path: "/managed/qemu-img".to_owned(),
            image_sha256: "b".repeat(64),
            version: "11.0.0".to_owned(),
            host_os: "linux".to_owned(),
            host_architecture: "x86_64".to_owned(),
            provider_identity: Some("9".repeat(64)),
            provider_identity_kind: Some("executable-digest".to_owned()),
            provisioning: Some(QemuProvisioningState {
                contract_schema_version: QEMU_CONTRACT_SCHEMA_VERSION.to_owned(),
                system_artifact_id: "qemu-system-bin-linux-amd64-x86_64-softmmu-11.0.0.1"
                    .to_owned(),
                system_artifact_sha256: "2".repeat(64),
                image_artifact_id: "qemu-img-linux-amd64-11.0.0.1".to_owned(),
                image_artifact_sha256: "3".repeat(64),
                data_artifact_id: "qemu-system-data-linux-amd64-11.0.0.1".to_owned(),
                data_artifact_sha256: "4".repeat(64),
            }),
        };
        let error = validate_qemu_state_against_requirement(&requirement, &state).unwrap_err();
        assert_eq!(error.code, ErrorCode::QemuIncompatible);
        assert!(error.message.contains("selected release requirement"));
    }

    #[test]
    fn missing_or_role_swapped_qemu_data_identity_fails_closed() {
        let mut value: serde_json::Value = serde_json::from_str(&sample_descriptor_json()).unwrap();
        value["route4"]["provider"]["qemu"]
            .as_object_mut()
            .unwrap()
            .remove("dataArtifact");
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &value.to_string());
        let error = qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);

        let mut value: serde_json::Value = serde_json::from_str(&sample_descriptor_json()).unwrap();
        let system = value["route4"]["provider"]["qemu"]["systemBinary"].clone();
        value["route4"]["provider"]["qemu"]["dataArtifact"] = system;
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &value.to_string());
        let error = qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
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
    fn route4_projection_succeeds_on_supported_current_descriptor() {
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) =
            write_descriptor(dir.path(), &sample_descriptor_json());

        let requirement =
            qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap();
        assert_eq!(requirement.data_artifact.sha256, "4".repeat(64));
    }

    #[test]
    fn route4_projection_fails_closed_on_unsupported_contract_id() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_json = descriptor_with_compatibility_value(
            "contractId",
            Value::String("mottainai.deployment.v2".to_owned()),
        );
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &descriptor_json);

        let error = qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
        assert_eq!(
            error.message,
            "unsupported deployment descriptor contractId"
        );
    }

    #[test]
    fn route4_projection_fails_closed_on_unsupported_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_json = descriptor_with_compatibility_value("schemaVersion", Value::from(2));
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &descriptor_json);

        let error = qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
        assert_eq!(
            error.message,
            "unsupported deployment descriptor schemaVersion"
        );
    }

    #[test]
    fn route4_projection_fails_closed_on_unsupported_profile() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_json = descriptor_with_compatibility_value(
            "profile",
            Value::String("linux-aarch64".to_owned()),
        );
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &descriptor_json);

        let error = qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
        assert_eq!(error.message, "unsupported deployment descriptor profile");
    }

    #[test]
    fn route4_projection_fails_closed_on_unsupported_architecture() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor_json = descriptor_with_compatibility_value(
            "architecture",
            Value::String("aarch64-linux".to_owned()),
        );
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &descriptor_json);

        let error = qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
        assert_eq!(
            error.message,
            "unsupported deployment descriptor architecture"
        );
    }

    #[test]
    fn route4_projection_fails_closed_on_descriptor_byte_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) =
            write_descriptor(dir.path(), &sample_descriptor_json());
        std::fs::write(
            &sidecar_path,
            format!("{}  deployment-descriptor.json\n", "0".repeat(64)),
        )
        .unwrap();

        let error = qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
        assert!(error.message.contains("identity mismatch"));
    }

    #[test]
    fn route4_projection_fails_closed_on_missing_data_artifact() {
        let mut value: serde_json::Value = serde_json::from_str(&sample_descriptor_json()).unwrap();
        value["route4"]["provider"]["qemu"]
            .as_object_mut()
            .unwrap()
            .remove("dataArtifact");
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &value.to_string());

        let error = qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap_err();
        assert_eq!(error.code, ErrorCode::DeploymentDescriptorInvalid);
    }

    #[test]
    fn route4_projection_fails_closed_on_system_image_data_role_swap() {
        let mut value: serde_json::Value = serde_json::from_str(&sample_descriptor_json()).unwrap();
        let system = value["route4"]["provider"]["qemu"]["systemBinary"].clone();
        value["route4"]["provider"]["qemu"]["dataArtifact"] = system;
        let dir = tempfile::tempdir().unwrap();
        let (descriptor_path, sidecar_path) = write_descriptor(dir.path(), &value.to_string());

        let error = qemu_requirement_from_descriptor(&descriptor_path, &sidecar_path).unwrap_err();
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
