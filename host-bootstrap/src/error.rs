use std::fmt::{Display, Formatter};

use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BootstrapLocked,
    BootstrapLockMismatch,
    ContractInvalid,
    DownloadFailed,
    ProviderArchiveInvalid,
    ProviderChecksumMismatch,
    ProviderStateAmbiguous,
    ProviderStateIncompatible,
    QemuMissing,
    QemuIncompatible,
    QemuStateAmbiguous,
    KvmMissing,
    KvmInaccessible,
    KvmNotCharacterDevice,
    AmbiguousHostCapability,
    UnsupportedArchitecture,
    UnsupportedHostProfile,
    IoError,
    RuntimeSpecInvalid,
    ApplianceReferenceInvalid,
    ApplianceManifestInvalid,
    ApplianceDigestMismatch,
    ApplianceDownloadFailed,
    ApplianceStateAmbiguous,
    ApplianceStateIncompatible,
    ProviderNotBootstrapped,
    LimaCommandFailed,
    LimaInstanceIncompatible,
    LimaInstanceAmbiguous,
    RuntimeNotReady,
    ManagedGenerationReconcileFailed,
    ManagedRuntimeSmokeFailed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BootstrapError {
    pub code: ErrorCode,
    pub message: String,
}

impl BootstrapError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: bound_text(&message.into()),
        }
    }

    pub fn io(context: &str, error: &std::io::Error) -> Self {
        Self::new(ErrorCode::IoError, format!("{context}: {error}"))
    }
}

impl Display for BootstrapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code_string(), self.message)
    }
}

impl std::error::Error for BootstrapError {}

impl BootstrapError {
    pub fn code_string(&self) -> &'static str {
        match self.code {
            ErrorCode::BootstrapLocked => "bootstrap_locked",
            ErrorCode::BootstrapLockMismatch => "bootstrap_lock_mismatch",
            ErrorCode::ContractInvalid => "contract_invalid",
            ErrorCode::DownloadFailed => "download_failed",
            ErrorCode::ProviderArchiveInvalid => "provider_archive_invalid",
            ErrorCode::ProviderChecksumMismatch => "provider_checksum_mismatch",
            ErrorCode::ProviderStateAmbiguous => "provider_state_ambiguous",
            ErrorCode::ProviderStateIncompatible => "provider_state_incompatible",
            ErrorCode::QemuMissing => "qemu_missing",
            ErrorCode::QemuIncompatible => "qemu_incompatible",
            ErrorCode::QemuStateAmbiguous => "qemu_state_ambiguous",
            ErrorCode::KvmMissing => "kvm_missing",
            ErrorCode::KvmInaccessible => "kvm_inaccessible",
            ErrorCode::KvmNotCharacterDevice => "kvm_not_character_device",
            ErrorCode::AmbiguousHostCapability => "ambiguous_host_capability",
            ErrorCode::UnsupportedArchitecture => "unsupported_architecture",
            ErrorCode::UnsupportedHostProfile => "unsupported_host_profile",
            ErrorCode::IoError => "io_error",
            ErrorCode::RuntimeSpecInvalid => "runtime_spec_invalid",
            ErrorCode::ApplianceReferenceInvalid => "appliance_reference_invalid",
            ErrorCode::ApplianceManifestInvalid => "appliance_manifest_invalid",
            ErrorCode::ApplianceDigestMismatch => "appliance_digest_mismatch",
            ErrorCode::ApplianceDownloadFailed => "appliance_download_failed",
            ErrorCode::ApplianceStateAmbiguous => "appliance_state_ambiguous",
            ErrorCode::ApplianceStateIncompatible => "appliance_state_incompatible",
            ErrorCode::ProviderNotBootstrapped => "provider_not_bootstrapped",
            ErrorCode::LimaCommandFailed => "lima_command_failed",
            ErrorCode::LimaInstanceIncompatible => "lima_instance_incompatible",
            ErrorCode::LimaInstanceAmbiguous => "lima_instance_ambiguous",
            ErrorCode::RuntimeNotReady => "runtime_not_ready",
            ErrorCode::ManagedGenerationReconcileFailed => "managed_generation_reconcile_failed",
            ErrorCode::ManagedRuntimeSmokeFailed => "managed_runtime_smoke_failed",
        }
    }
}

/// Evidence and diagnostics are deliberately bounded before they reach JSON or stderr.
pub fn bound_text(value: &str) -> String {
    const LIMIT: usize = 512;
    let mut result = value.chars().take(LIMIT).collect::<String>();
    if value.chars().count() > LIMIT {
        result.push('…');
    }
    result
}
