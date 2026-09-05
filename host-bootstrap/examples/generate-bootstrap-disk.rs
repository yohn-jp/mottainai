//! Explicit integration harness for connecting the production MTNAI_BOOT
//! writer to the canonical NixOS appliance golden path.
//!
//! This is a test-only entry point. The caller supplies the public key
//! explicitly; production runtime composition reads the same key from Lima's
//! managed _config/user.pub identity and does not adopt ambient SSH keys.

use std::env;
use std::fs;
use std::path::PathBuf;

use mottainai_host_bootstrap::bootstrap_disk::ensure_bootstrap_disk;
use mottainai_host_bootstrap::paths::{ensure_managed_root, ManagedPaths};

fn option_value(args: &mut impl Iterator<Item = String>, option: &str) -> Result<String, String> {
    match args.next() {
        Some(value) if !value.starts_with("--") => Ok(value),
        Some(value) => Err(format!("{option} requires a value, got {value}")),
        None => Err(format!("{option} requires a value")),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let mut state_directory = None;
    let mut public_key_file = None;
    let mut instance_name = String::from("runtime-appliance-golden-path");

    while let Some(option) = args.next() {
        match option.as_str() {
            "--state-directory" => {
                state_directory = Some(PathBuf::from(option_value(&mut args, &option)?));
            }
            "--public-key-file" => {
                public_key_file = Some(PathBuf::from(option_value(&mut args, &option)?));
            }
            "--instance-name" => {
                instance_name = option_value(&mut args, &option)?;
            }
            "--help" => {
                println!(
                    "usage: generate-bootstrap-disk --state-directory DIR \
                     --public-key-file FILE [--instance-name NAME]"
                );
                return Ok(());
            }
            unexpected => return Err(format!("unexpected option: {unexpected}").into()),
        }
    }

    let state_directory = state_directory.ok_or("missing required option --state-directory")?;
    let public_key_file = public_key_file.ok_or("missing required option --public-key-file")?;
    let paths = ManagedPaths::new(state_directory);
    ensure_managed_root(&paths)?;
    let public_key = fs::read_to_string(public_key_file)?;
    let disk = ensure_bootstrap_disk(&paths, &instance_name, &public_key)?;
    println!("{}", disk.path.display());
    Ok(())
}
