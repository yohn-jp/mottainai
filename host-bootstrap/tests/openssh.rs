use std::fs;
use std::path::Path;
use std::process::Command;

use mottainai_host_bootstrap::appliance::ApplianceReference;
use mottainai_host_bootstrap::lima::{RuntimeSpec, RUNTIME_SPEC_SCHEMA_VERSION};

#[cfg(unix)]
fn write_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    fs::write(path, b"#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn runtime_spec() -> RuntimeSpec {
    RuntimeSpec {
        schema_version: RUNTIME_SPEC_SCHEMA_VERSION.to_owned(),
        instance_name: "mottainai-runtime".to_owned(),
        architecture: "x86_64".to_owned(),
        cpus: 2,
        memory_mib: 4096,
        appliance: ApplianceReference {
            registry: "ghcr.io".to_owned(),
            repository: "yohn-jp/mottainai/runtime-appliance".to_owned(),
            digest: format!("sha256:{}", "a".repeat(64)),
        },
        mounts: Vec::new(),
        managed_generation: None,
    }
}

#[test]
fn missing_openssh_client_fails_before_route4_state_mutation() {
    let temporary = tempfile::tempdir().unwrap();
    let empty_path = temporary.path().join("empty-path");
    fs::create_dir(&empty_path).unwrap();
    let state_directory = temporary.path().join("managed-state");
    let output = Command::new(env!("CARGO_BIN_EXE_mottainai-init"))
        .args([
            "--json",
            "--state-directory",
            state_directory.to_str().unwrap(),
        ])
        .env("PATH", &empty_path)
        .output()
        .expect("production Route 4 bootstrap should launch");

    assert_eq!(output.status.code(), Some(2));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"error_code\": \"openssh_client_missing\""));
    assert!(stdout.contains("`ssh`"));
    assert!(!state_directory.exists());
}

#[cfg(unix)]
#[test]
fn missing_openssh_keygen_fails_independently_before_route4_state_mutation() {
    let temporary = tempfile::tempdir().unwrap();
    let path_directory = temporary.path().join("path");
    fs::create_dir(&path_directory).unwrap();
    write_executable(&path_directory.join("ssh"));
    let state_directory = temporary.path().join("managed-state");
    let output = Command::new(env!("CARGO_BIN_EXE_mottainai-init"))
        .args([
            "--json",
            "--state-directory",
            state_directory.to_str().unwrap(),
        ])
        .env("PATH", &path_directory)
        .output()
        .expect("production Route 4 bootstrap should launch");

    assert_eq!(output.status.code(), Some(2));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"error_code\": \"openssh_keygen_missing\""));
    assert!(stdout.contains("`ssh-keygen`"));
    assert!(!state_directory.exists());
}

#[test]
fn runtime_ensure_missing_openssh_fails_before_route3_state_mutation() {
    let temporary = tempfile::tempdir().unwrap();
    let empty_path = temporary.path().join("empty-path");
    fs::create_dir(&empty_path).unwrap();
    let spec_path = temporary.path().join("runtime-spec.json");
    fs::write(&spec_path, serde_json::to_vec(&runtime_spec()).unwrap()).unwrap();
    let state_directory = temporary.path().join("managed-state");
    let output = Command::new(env!("CARGO_BIN_EXE_mottainai-init"))
        .args([
            "runtime",
            "ensure",
            "--spec",
            spec_path.to_str().unwrap(),
            "--state-directory",
            state_directory.to_str().unwrap(),
            "--json",
        ])
        .env("PATH", &empty_path)
        .output()
        .expect("production Route 3 ensure should launch");

    assert_eq!(output.status.code(), Some(2));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"error_code\":\"openssh_client_missing\""));
    assert!(stdout.contains("`ssh`"));
    assert!(!state_directory.exists());
}
