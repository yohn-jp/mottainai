use serde::{Deserialize, Serialize};

/// The only classifications used by the host reconciler.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Classification {
    Satisfied,
    Missing,
    Repairable,
    Incompatible,
    Unsupported,
    Ambiguous,
}

impl Classification {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Satisfied => "satisfied",
            Self::Missing => "missing",
            Self::Repairable => "repairable",
            Self::Incompatible => "incompatible",
            Self::Unsupported => "unsupported",
            Self::Ambiguous => "ambiguous",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    NoOp,
    Changed,
    Blocked,
    Unsupported,
}

impl Outcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NoOp => "no-op",
            Self::Changed => "changed",
            Self::Blocked => "blocked",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ProviderIdentity {
    pub provider: String,
    pub version: String,
    pub artifact_id: String,
    pub artifact_sha256: String,
    pub managed_path: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct QemuRequirement {
    pub system_executable: String,
    pub image_executable: String,
    pub minimum_version: String,
    pub accelerator: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct QemuIdentity {
    pub system_path: String,
    pub system_sha256: String,
    pub image_path: String,
    pub image_sha256: String,
    pub version: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct StepEvidence {
    pub name: String,
    pub classification: Classification,
    pub changed: bool,
    pub desired_identity: Option<ProviderIdentity>,
    pub observed_identity: Option<ProviderIdentity>,
    pub desired_qemu: Option<QemuRequirement>,
    pub observed_qemu: Option<QemuIdentity>,
    pub diagnostic: Option<String>,
}
