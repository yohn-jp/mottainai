use std::env;
use std::path::PathBuf;

use mottainai_host_bootstrap::contract::ProviderContract;
use mottainai_host_bootstrap::error::{BootstrapError, ErrorCode};
use mottainai_host_bootstrap::provider::FileArtifactSource;
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
                host_override: None,
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
       [--artifact PATH] [--kvm-path PATH]\n\n\
Reconciles the supported Linux x86_64/KVM Lima provider into the managed\n\
state directory. No privileged mutation or ambient PATH adoption is performed."
    );
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
