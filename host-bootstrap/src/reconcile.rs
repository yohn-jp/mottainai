use std::ffi::OsString;
use std::path::PathBuf;

use crate::contract::{ProviderContract, BOOTSTRAP_VERSION};
use crate::error::{BootstrapError, ErrorCode};
use crate::evidence::{diagnostic, Evidence};
use crate::host::{classify_host, host_error, inspect_host_at, HostObservation};
use crate::lock::BootstrapLock;
use crate::model::{Classification, Outcome, StepEvidence};
use crate::paths::{default_state_directory, ManagedPaths};
use crate::provider::{ensure_provider, inspect_provider, ArtifactSource, HttpArtifactSource};

#[derive(Clone, Debug)]
pub struct BootstrapConfig {
    pub state_directory: PathBuf,
    pub kvm_path: PathBuf,
    pub contract: ProviderContract,
    pub environment_path: Option<OsString>,
    /// Test-only/in-process host seam; the CLI always performs real inspection.
    pub host_override: Option<HostObservation>,
}

impl BootstrapConfig {
    pub fn from_defaults() -> Result<Self, BootstrapError> {
        Ok(Self {
            state_directory: default_state_directory()?,
            kvm_path: PathBuf::from("/dev/kvm"),
            contract: ProviderContract::default(),
            environment_path: std::env::var_os("PATH"),
            host_override: None,
        })
    }

    pub fn paths(&self) -> ManagedPaths {
        ManagedPaths::new(self.state_directory.clone())
    }
}

pub struct Bootstrap {
    pub config: BootstrapConfig,
}

impl Bootstrap {
    pub fn new(config: BootstrapConfig) -> Self {
        Self { config }
    }

    pub fn reconcile(&self) -> Evidence {
        self.reconcile_with_source(HttpArtifactSource)
    }

    pub fn reconcile_with_source<S: ArtifactSource>(&self, source: S) -> Evidence {
        let host = self.config.host_override.clone().unwrap_or_else(|| {
            inspect_host_at(
                &self.config.kvm_path,
                std::env::consts::OS,
                std::env::consts::ARCH,
                read_kernel_release(),
            )
        });
        let paths = self.config.paths();
        let desired_provider = self.config.contract.identity(Some(
            paths
                .active_link
                .join("bin/limactl")
                .to_string_lossy()
                .into_owned(),
        ));
        let mut evidence = Evidence::new(host.clone(), desired_provider);
        if let Err(error) = self.config.contract.validate() {
            evidence.steps.push(step(
                "provider",
                Classification::Ambiguous,
                false,
                None,
                None,
                Some(&error.message),
            ));
            evidence.fail(&error, false);
            return evidence;
        }

        let host_classification = classify_host(&host);
        evidence.steps.push(step(
            "host",
            host_classification,
            false,
            None,
            None,
            host.kvm.diagnostic.as_deref(),
        ));
        if host_classification != Classification::Satisfied {
            let error = host_error(&host, host_classification);
            evidence.fail(&error, host_classification == Classification::Unsupported);
            return evidence;
        }

        if let Err(error) = std::fs::create_dir_all(&paths.root) {
            let error = BootstrapError::io("create managed state root", &error);
            evidence.fail(&error, false);
            return evidence;
        }
        let _lock = match BootstrapLock::acquire(&paths) {
            Ok(lock) => lock,
            Err(error) => {
                evidence.fail(&error, false);
                return evidence;
            }
        };
        let observation = match inspect_provider(
            &paths,
            &self.config.contract,
            self.config.environment_path.as_deref(),
            &host.os,
            &host.architecture,
        ) {
            Ok(observation) => observation,
            Err(error) => {
                evidence.steps.push(step(
                    "provider",
                    Classification::Ambiguous,
                    false,
                    Some(evidence.desired_provider.clone()),
                    None,
                    Some(&error.message),
                ));
                evidence.fail(&error, false);
                return evidence;
            }
        };
        evidence.observed_provider = observation.observed_identity.clone();
        evidence.steps.push(step(
            "provider",
            observation.classification,
            false,
            Some(evidence.desired_provider.clone()),
            observation.observed_identity.clone(),
            observation.diagnostic.as_deref(),
        ));

        if matches!(
            observation.classification,
            Classification::Incompatible | Classification::Ambiguous
        ) {
            let error = provider_error(
                &observation.classification,
                observation.diagnostic.as_deref(),
            );
            evidence.fail(&error, false);
            return evidence;
        }
        if observation.classification == Classification::Satisfied {
            evidence.result = Outcome::NoOp;
            return evidence;
        }

        if let Err(error) = ensure_provider(
            &paths,
            &self.config.contract,
            &source,
            &host.os,
            &host.architecture,
            self.config.environment_path.as_deref(),
        ) {
            evidence.fail(&error, false);
            return evidence;
        }
        let final_observation = match inspect_provider(
            &paths,
            &self.config.contract,
            self.config.environment_path.as_deref(),
            &host.os,
            &host.architecture,
        ) {
            Ok(observation) => observation,
            Err(error) => {
                evidence.fail(&error, false);
                return evidence;
            }
        };
        evidence.observed_provider = final_observation.observed_identity.clone();
        if final_observation.classification != Classification::Satisfied {
            let error = provider_error(
                &final_observation.classification,
                final_observation.diagnostic.as_deref(),
            );
            evidence.fail(&error, false);
            return evidence;
        }
        evidence.steps[1].changed = true;
        evidence.steps[1].observed_identity = final_observation.observed_identity;
        evidence.changed = true;
        evidence.result = Outcome::Changed;
        evidence.diagnostic = diagnostic(Some(
            "verified managed Lima provider materialized and activated",
        ));
        evidence
    }
}

fn step(
    name: &str,
    classification: Classification,
    changed: bool,
    desired_identity: Option<crate::model::ProviderIdentity>,
    observed_identity: Option<crate::model::ProviderIdentity>,
    message: Option<&str>,
) -> StepEvidence {
    StepEvidence {
        name: name.to_owned(),
        classification,
        changed,
        desired_identity,
        observed_identity,
        diagnostic: diagnostic(message),
    }
}

fn provider_error(classification: &Classification, message: Option<&str>) -> BootstrapError {
    let code = match classification {
        Classification::Ambiguous => ErrorCode::ProviderStateAmbiguous,
        Classification::Incompatible => ErrorCode::ProviderStateIncompatible,
        _ => ErrorCode::ProviderStateIncompatible,
    };
    BootstrapError::new(
        code,
        message.unwrap_or("provider state cannot be proven safe"),
    )
}

fn read_kernel_release() -> Option<String> {
    let contents = std::fs::read_to_string("/proc/sys/kernel/osrelease").ok()?;
    let value = contents.trim();
    (!value.is_empty()).then(|| value.chars().take(256).collect())
}

pub fn failure_for_contract(error: BootstrapError, config: &BootstrapConfig) -> Evidence {
    let host = config.host_override.clone().unwrap_or_else(|| {
        inspect_host_at(
            &config.kvm_path,
            std::env::consts::OS,
            std::env::consts::ARCH,
            None,
        )
    });
    let desired = config.contract.identity(Some(
        config
            .paths()
            .active_link
            .join("bin/limactl")
            .to_string_lossy()
            .into_owned(),
    ));
    let mut evidence = Evidence::new(host, desired);
    evidence.fail(&error, false);
    evidence.executable.version = BOOTSTRAP_VERSION.to_owned();
    evidence
}
