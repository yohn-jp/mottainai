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
use crate::qemu::{ensure_qemu, inspect_override, inspect_qemu, requirement, QemuOverride};

#[derive(Clone, Debug)]
pub struct BootstrapConfig {
    pub state_directory: PathBuf,
    pub kvm_path: PathBuf,
    pub contract: ProviderContract,
    pub environment_path: Option<OsString>,
    pub qemu_path: Option<PathBuf>,
    /// Test-only/in-process host seam; the CLI always performs real inspection.
    pub host_override: Option<HostObservation>,
    /// Test-only QEMU observation seam; the CLI always performs real inspection.
    pub qemu_override: Option<QemuOverride>,
}

impl BootstrapConfig {
    pub fn from_defaults() -> Result<Self, BootstrapError> {
        Ok(Self {
            state_directory: default_state_directory()?,
            kvm_path: PathBuf::from("/dev/kvm"),
            contract: ProviderContract::default(),
            environment_path: std::env::var_os("PATH"),
            qemu_path: None,
            host_override: None,
            qemu_override: None,
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
        let mut evidence = Evidence::new(host.clone(), desired_provider, requirement());
        if let Err(error) = self.config.contract.validate() {
            evidence.steps.push(provider_step(
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
        evidence.steps.push(host_step(
            "host",
            host_classification,
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

        let qemu_observation = match &self.config.qemu_override {
            Some(override_value) => {
                inspect_override(&paths, override_value, &host.os, &host.architecture)
            }
            None => inspect_qemu(
                &paths,
                self.config.qemu_path.as_deref(),
                self.config.environment_path.as_deref(),
                &host.os,
                &host.architecture,
            ),
        };
        let qemu_observation = match qemu_observation {
            Ok(observation) => observation,
            Err(error) => {
                evidence.steps.push(qemu_step(
                    Classification::Ambiguous,
                    None,
                    Some(&error.message),
                ));
                evidence.fail(&error, false);
                return evidence;
            }
        };
        evidence.observed_qemu = qemu_observation.observed_identity.clone();
        evidence.steps.push(qemu_step(
            qemu_observation.classification,
            qemu_observation.observed_identity.clone(),
            qemu_observation.diagnostic.as_deref(),
        ));
        if matches!(
            qemu_observation.classification,
            Classification::Incompatible | Classification::Ambiguous | Classification::Missing
        ) {
            let error = crate::qemu::error_for_observation(&qemu_observation);
            evidence.fail(&error, false);
            return evidence;
        }
        if qemu_observation.classification == Classification::Repairable {
            if let Err(error) = ensure_qemu(&paths, &qemu_observation, &host.os, &host.architecture)
            {
                evidence.fail(&error, false);
                return evidence;
            }
            let final_qemu = match &self.config.qemu_override {
                Some(override_value) => {
                    inspect_override(&paths, override_value, &host.os, &host.architecture)
                }
                None => inspect_qemu(
                    &paths,
                    self.config.qemu_path.as_deref(),
                    self.config.environment_path.as_deref(),
                    &host.os,
                    &host.architecture,
                ),
            };
            let final_qemu = match final_qemu {
                Ok(observation) => observation,
                Err(error) => {
                    evidence.fail(&error, false);
                    return evidence;
                }
            };
            if final_qemu.classification != Classification::Satisfied {
                let error = crate::qemu::error_for_observation(&final_qemu);
                evidence.fail(&error, false);
                return evidence;
            }
            evidence.observed_qemu = final_qemu.observed_identity;
            evidence.steps[1].changed = true;
            evidence.steps[1].classification = Classification::Repairable;
            evidence.steps[1].observed_qemu = evidence.observed_qemu.clone();
            evidence.changed = true;
        }

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
        let provider_step_index = 2;
        evidence.steps[provider_step_index].changed = true;
        evidence.steps[provider_step_index].observed_identity = final_observation.observed_identity;
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
        desired_qemu: None,
        observed_qemu: None,
        diagnostic: diagnostic(message),
    }
}

fn provider_step(
    name: &str,
    classification: Classification,
    changed: bool,
    desired_identity: Option<crate::model::ProviderIdentity>,
    observed_identity: Option<crate::model::ProviderIdentity>,
    message: Option<&str>,
) -> StepEvidence {
    step(
        name,
        classification,
        changed,
        desired_identity,
        observed_identity,
        message,
    )
}

fn host_step(name: &str, classification: Classification, message: Option<&str>) -> StepEvidence {
    step(name, classification, false, None, None, message)
}

fn qemu_step(
    classification: Classification,
    observed_identity: Option<crate::model::QemuIdentity>,
    message: Option<&str>,
) -> StepEvidence {
    StepEvidence {
        name: "qemu".to_owned(),
        classification,
        changed: false,
        desired_identity: None,
        observed_identity: None,
        desired_qemu: Some(requirement()),
        observed_qemu: observed_identity,
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
    let mut evidence = Evidence::new(host, desired, requirement());
    evidence.fail(&error, false);
    evidence.executable.version = BOOTSTRAP_VERSION.to_owned();
    evidence
}
