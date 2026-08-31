use std::env;

use serde::Serialize;

use crate::contract::{BOOTSTRAP_VERSION, CONTRACT_SCHEMA_VERSION};
use crate::download::digest_file;
use crate::error::{bound_text, BootstrapError};
use crate::host::HostObservation;
use crate::model::{Outcome, ProviderIdentity, StepEvidence};

#[derive(Clone, Debug, Serialize)]
pub struct ExecutableIdentity {
    pub version: String,
    pub path: Option<String>,
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Evidence {
    pub schema_version: String,
    pub executable: ExecutableIdentity,
    pub host: HostObservation,
    pub desired_provider: ProviderIdentity,
    pub observed_provider: Option<ProviderIdentity>,
    pub steps: Vec<StepEvidence>,
    pub changed: bool,
    pub result: Outcome,
    pub error_code: Option<String>,
    pub diagnostic: Option<String>,
}

impl Evidence {
    pub fn new(host: HostObservation, desired_provider: ProviderIdentity) -> Self {
        Self {
            schema_version: CONTRACT_SCHEMA_VERSION.to_owned(),
            executable: executable_identity(),
            host,
            desired_provider,
            observed_provider: None,
            steps: Vec::with_capacity(2),
            changed: false,
            result: Outcome::Blocked,
            error_code: None,
            diagnostic: None,
        }
    }

    pub fn fail(&mut self, error: &BootstrapError, unsupported: bool) {
        self.result = if unsupported {
            Outcome::Unsupported
        } else {
            Outcome::Blocked
        };
        self.error_code = Some(error.code_string().to_owned());
        self.diagnostic = Some(bound_text(&error.message));
    }
}

fn executable_identity() -> ExecutableIdentity {
    let path = env::current_exe().ok();
    let sha256 = path.as_deref().and_then(|path| digest_file(path).ok());
    ExecutableIdentity {
        version: BOOTSTRAP_VERSION.to_owned(),
        path: path.map(|path| path.to_string_lossy().chars().take(4096).collect()),
        sha256,
    }
}

pub fn diagnostic(value: Option<&str>) -> Option<String> {
    value.map(bound_text)
}
