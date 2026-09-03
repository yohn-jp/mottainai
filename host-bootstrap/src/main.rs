use std::env;
use std::path::PathBuf;
use std::time::Duration;

use mottainai_host_bootstrap::contract::ProviderContract;
use mottainai_host_bootstrap::deployment_descriptor::runtime_spec_from_descriptor;
use mottainai_host_bootstrap::error::{BootstrapError, ErrorCode};
use mottainai_host_bootstrap::lima::{
    ensure_runtime_locked, RuntimeEnsureConfig, RuntimeSpec, SystemLimaCli,
};
use mottainai_host_bootstrap::lock::BootstrapLock;
use mottainai_host_bootstrap::model::Classification;
use mottainai_host_bootstrap::oci::HttpOciSource;
use mottainai_host_bootstrap::paths::ensure_managed_root;
use mottainai_host_bootstrap::provider::{inspect_provider, FileArtifactSource};
use mottainai_host_bootstrap::qemu::{inspect_qemu, managed_qemu_system_path};
use mottainai_host_bootstrap::reconcile::{failure_for_contract, Bootstrap, BootstrapConfig};
use mottainai_host_bootstrap::BOOTSTRAP_VERSION;

fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments
        .iter()
        .any(|argument| argument == "--help" || argument == "-h")
    {
        print_help();
        return;
    }
    if arguments
        .iter()
        .any(|argument| argument == "--version" || argument == "-V")
    {
        println!("mottainai-init {BOOTSTRAP_VERSION}");
        return;
    }
    if arguments.first().map(String::as_str) == Some("runtime") {
        std::process::exit(run_runtime_command(&arguments[1..]));
    }
    let json = arguments.iter().any(|argument| argument == "--json");
    match parse_config(&arguments) {
        Ok((config, artifact_path)) => {
            let evidence = if let Some(path) = artifact_path {
                Bootstrap::new(config).reconcile_with_source(FileArtifactSource { path })
            } else {
                Bootstrap::new(config).reconcile()
            };
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&evidence).expect("evidence is serializable")
                );
            } else {
                print_human(&evidence);
            }
            std::process::exit(
                if matches!(
                    evidence.result,
                    mottainai_host_bootstrap::Outcome::Changed
                        | mottainai_host_bootstrap::Outcome::NoOp
                ) {
                    0
                } else {
                    1
                },
            );
        }
        Err(error) => {
            let config = BootstrapConfig::from_defaults().unwrap_or_else(|_| BootstrapConfig {
                state_directory: PathBuf::from("."),
                kvm_path: PathBuf::from("/dev/kvm"),
                contract: ProviderContract::default(),
                environment_path: env::var_os("PATH"),
                qemu_path: None,
                host_override: None,
                qemu_override: None,
            });
            let evidence = failure_for_contract(error, &config);
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&evidence).expect("evidence is serializable")
                );
            } else {
                eprintln!(
                    "{}: {}",
                    evidence.error_code.as_deref().unwrap_or("bootstrap_error"),
                    evidence.diagnostic.as_deref().unwrap_or("bootstrap failed")
                );
            }
            std::process::exit(2);
        }
    }
}

fn parse_config(
    arguments: &[String],
) -> Result<(BootstrapConfig, Option<PathBuf>), BootstrapError> {
    let mut config = BootstrapConfig::from_defaults()?;
    let mut artifact_path = None;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--json" => {}
            "--state-directory" => {
                index += 1;
                config.state_directory = value(arguments, index, "--state-directory")?.into();
            }
            "--kvm-path" => {
                index += 1;
                config.kvm_path = value(arguments, index, "--kvm-path")?.into();
            }
            "--qemu-path" => {
                index += 1;
                config.qemu_path = Some(value(arguments, index, "--qemu-path")?.into());
            }
            "--artifact" => {
                index += 1;
                artifact_path = Some(value(arguments, index, "--artifact")?.into());
            }
            "--contract" => {
                index += 1;
                let path: PathBuf = value(arguments, index, "--contract")?.into();
                let contents = std::fs::read_to_string(&path)
                    .map_err(|error| BootstrapError::io("read provider contract", &error))?;
                config.contract = serde_json::from_str(&contents).map_err(|error| {
                    BootstrapError::new(
                        ErrorCode::ContractInvalid,
                        format!("parse provider contract: {error}"),
                    )
                })?;
            }
            argument if argument.starts_with('-') => {
                return Err(BootstrapError::new(
                    ErrorCode::ContractInvalid,
                    format!("unknown option {argument}"),
                ));
            }
            argument => {
                return Err(BootstrapError::new(
                    ErrorCode::ContractInvalid,
                    format!("unexpected argument {argument}"),
                ));
            }
        }
        index += 1;
    }
    config.environment_path = env::var_os("PATH");
    Ok((config, artifact_path))
}

fn value(arguments: &[String], index: usize, option: &str) -> Result<String, BootstrapError> {
    arguments
        .get(index)
        .cloned()
        .filter(|value| !value.starts_with('-'))
        .ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::ContractInvalid,
                format!("{option} requires a value"),
            )
        })
}

fn print_help() {
    println!(
        "mottainai-init {BOOTSTRAP_VERSION}\n\
Usage: mottainai-init [--json] [--state-directory PATH] [--contract PATH]\n\
       [--artifact PATH] [--kvm-path PATH] [--qemu-path PATH]\n\
       mottainai-init runtime ensure --spec PATH [--json] [--state-directory PATH]\n\
       mottainai-init runtime ensure --descriptor PATH [--sidecar PATH]\n\
           [--instance-name NAME] [--cpus N] [--memory-mib N] [--json]\n\
           [--state-directory PATH]\n\n\
Reconciles the supported Linux x86_64/KVM Lima provider and its QEMU\n\
prerequisite into the managed state directory. No privileged mutation,\n\
package-manager invocation, VM launch, or ambient PATH adoption is performed.\n\n\
`runtime ensure` converges the local Lima-managed Runtime instance described\n\
by the given Runtime specification to ready state: it requires the Lima\n\
provider above to already be bootstrapped. When the specification names a\n\
managed_generation, convergence continues past bootstrapReady to the exact\n\
intended managed generation and a bounded packaged CLI/MCP functional smoke.\n\n\
`--spec PATH` accepts an already-built Runtime specification document.\n\
`--descriptor PATH` instead derives that specification, including the\n\
managed generation intent, directly from an exact published deployment\n\
descriptor (#755/ADR-0003) after verifying it against its sha256 sidecar\n\
(`<descriptor>.sha256` unless `--sidecar` names another path) — no Node,\n\
repository checkout, or ambient host dependency is used. Exactly one of\n\
`--spec`/`--descriptor` is required."
    );
}

/// Converges a local Lima-managed Runtime instance to ready state. Requires
/// the managed Lima provider (`mottainai-init` above, with no subcommand) to
/// already be bootstrapped and verified; this command never adopts an
/// ambient `limactl`.
fn run_runtime_command(arguments: &[String]) -> i32 {
    if arguments.first().map(String::as_str) != Some("ensure") {
        eprintln!("contract_invalid: expected `mottainai-init runtime ensure --spec PATH`");
        return 2;
    }
    let arguments = &arguments[1..];
    let json = arguments.iter().any(|argument| argument == "--json");
    match run_runtime_ensure(arguments) {
        Ok(evidence) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&evidence).expect("evidence is serializable")
                );
            } else {
                println!(
                    "result: {}; changed: {}; guest_reachable: {}",
                    evidence.result.as_str(),
                    evidence.changed,
                    evidence.guest_reachable
                );
                if let Some(status) = &evidence.lima_status {
                    println!("lima_status: {status}");
                }
                if let Some(error) = &evidence.error_code {
                    println!(
                        "error: {error}: {}",
                        evidence
                            .diagnostic
                            .as_deref()
                            .unwrap_or("runtime not ready")
                    );
                }
            }
            match evidence.result {
                mottainai_host_bootstrap::Outcome::Changed
                | mottainai_host_bootstrap::Outcome::NoOp => 0,
                _ => 1,
            }
        }
        Err(error) => {
            if json {
                println!(
                    "{{\"error_code\":\"{}\",\"diagnostic\":\"{}\"}}",
                    error.code_string(),
                    error.message.replace('"', "'")
                );
            } else {
                eprintln!("{}: {}", error.code_string(), error.message);
            }
            2
        }
    }
}

fn run_runtime_ensure(
    arguments: &[String],
) -> Result<mottainai_host_bootstrap::RuntimeEvidence, BootstrapError> {
    let mut spec_path: Option<PathBuf> = None;
    let mut descriptor_path: Option<PathBuf> = None;
    let mut sidecar_path: Option<PathBuf> = None;
    let mut instance_name = "mottainai-runtime".to_owned();
    let mut cpus: u32 = 2;
    let mut memory_mib: u64 = 4096;
    let mut state_directory: Option<PathBuf> = None;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--json" => {}
            "--spec" => {
                index += 1;
                spec_path = Some(value(arguments, index, "--spec")?.into());
            }
            "--descriptor" => {
                index += 1;
                descriptor_path = Some(value(arguments, index, "--descriptor")?.into());
            }
            "--sidecar" => {
                index += 1;
                sidecar_path = Some(value(arguments, index, "--sidecar")?.into());
            }
            "--instance-name" => {
                index += 1;
                instance_name = value(arguments, index, "--instance-name")?;
            }
            "--cpus" => {
                index += 1;
                cpus = value(arguments, index, "--cpus")?.parse().map_err(|_| {
                    BootstrapError::new(
                        ErrorCode::RuntimeSpecInvalid,
                        "--cpus must be a positive integer",
                    )
                })?;
            }
            "--memory-mib" => {
                index += 1;
                memory_mib = value(arguments, index, "--memory-mib")?
                    .parse()
                    .map_err(|_| {
                        BootstrapError::new(
                            ErrorCode::RuntimeSpecInvalid,
                            "--memory-mib must be a positive integer",
                        )
                    })?;
            }
            "--state-directory" => {
                index += 1;
                state_directory = Some(value(arguments, index, "--state-directory")?.into());
            }
            argument => {
                return Err(BootstrapError::new(
                    ErrorCode::ContractInvalid,
                    format!("unknown or unexpected argument {argument}"),
                ));
            }
        }
        index += 1;
    }
    let spec = match (spec_path, descriptor_path) {
        (Some(_), Some(_)) => {
            return Err(BootstrapError::new(
                ErrorCode::RuntimeSpecInvalid,
                "runtime ensure accepts exactly one of --spec or --descriptor, not both",
            ));
        }
        (Some(spec_path), None) => {
            let spec_contents = std::fs::read_to_string(&spec_path)
                .map_err(|error| BootstrapError::io("read runtime specification", &error))?;
            serde_json::from_str::<RuntimeSpec>(&spec_contents).map_err(|error| {
                BootstrapError::new(
                    ErrorCode::RuntimeSpecInvalid,
                    format!("parse runtime specification: {error}"),
                )
            })?
        }
        (None, Some(descriptor_path)) => {
            let sidecar_path = sidecar_path.unwrap_or_else(|| {
                let mut path = descriptor_path.clone().into_os_string();
                path.push(".sha256");
                path.into()
            });
            runtime_spec_from_descriptor(
                &descriptor_path,
                &sidecar_path,
                &instance_name,
                cpus,
                memory_mib,
            )?
        }
        (None, None) => {
            return Err(BootstrapError::new(
                ErrorCode::RuntimeSpecInvalid,
                "runtime ensure requires --spec PATH or --descriptor PATH",
            ));
        }
    };

    let mut bootstrap_config = BootstrapConfig::from_defaults()?;
    if let Some(state_directory) = state_directory {
        bootstrap_config.state_directory = state_directory;
    }
    let paths = bootstrap_config.paths();
    ensure_managed_root(&paths)?;
    let lock = BootstrapLock::acquire(&paths)?;
    let contract = ProviderContract::default();
    let observation = inspect_provider(
        &paths,
        &contract,
        env::var_os("PATH").as_deref(),
        env::consts::OS,
        env::consts::ARCH,
    )?;
    if observation.classification != Classification::Satisfied {
        return Err(BootstrapError::new(
            ErrorCode::ProviderNotBootstrapped,
            "the managed Lima provider is not bootstrapped; run mottainai-init before runtime ensure",
        ));
    }
    let limactl_path = paths.active_link.join(&contract.archive_binary_path);
    let qemu_observation = inspect_qemu(
        &paths,
        None,
        env::var_os("PATH").as_deref(),
        env::consts::OS,
        env::consts::ARCH,
    )?;
    if qemu_observation.classification != Classification::Satisfied {
        return Err(BootstrapError::new(
            ErrorCode::ProviderNotBootstrapped,
            "the managed QEMU prerequisite is not bootstrapped or no longer verifies",
        ));
    }
    let cli = SystemLimaCli {
        binary_path: limactl_path,
        lima_home: paths.lima_home_directory.clone(),
        qemu_system_path: Some(managed_qemu_system_path(&paths)?),
    };
    let oci = HttpOciSource {
        registry: spec.appliance.registry.clone(),
        timeout: Duration::from_secs(300),
    };
    Ok(ensure_runtime_locked(
        &paths,
        &spec,
        &cli,
        &oci,
        &RuntimeEnsureConfig::default(),
        &lock,
    ))
}

fn print_human(evidence: &mottainai_host_bootstrap::Evidence) {
    println!(
        "result: {}; changed: {}",
        evidence.result.as_str(),
        evidence.changed
    );
    println!(
        "host: {}/{}; kvm: {:?}",
        evidence.host.os, evidence.host.architecture, evidence.host.kvm.current_user_access
    );
    for step in &evidence.steps {
        println!(
            "step {}: {}; changed: {}",
            step.name,
            step.classification.as_str(),
            step.changed
        );
        if let Some(diagnostic) = &step.diagnostic {
            println!("  {diagnostic}");
        }
    }
    if let Some(error) = &evidence.error_code {
        println!(
            "error: {}: {}",
            error,
            evidence
                .diagnostic
                .as_deref()
                .unwrap_or("bootstrap blocked")
        );
    }
}
