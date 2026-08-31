use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::error::{bound_text, BootstrapError, ErrorCode};
use crate::model::Classification;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct KvmObservation {
    pub path: String,
    pub exists: bool,
    pub character_device: Option<bool>,
    pub access_checked: bool,
    pub current_user_access: Option<bool>,
    pub diagnostic: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct HostObservation {
    pub os: String,
    pub architecture: String,
    pub kernel: Option<String>,
    pub kvm: KvmObservation,
}

pub fn inspect_host() -> HostObservation {
    inspect_host_at(
        Path::new("/dev/kvm"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        read_kernel_release(),
    )
}

pub fn inspect_host_at(
    kvm_path: &Path,
    os: &str,
    architecture: &str,
    kernel: Option<String>,
) -> HostObservation {
    HostObservation {
        os: os.to_owned(),
        architecture: architecture.to_owned(),
        kernel,
        kvm: inspect_kvm(kvm_path),
    }
}

fn read_kernel_release() -> Option<String> {
    let mut file = File::open("/proc/sys/kernel/osrelease").ok()?;
    let mut value = String::new();
    file.by_ref().take(256).read_to_string(&mut value).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| bound_text(value))
}

fn inspect_kvm(path: &Path) -> KvmObservation {
    let path_string = path.to_string_lossy().into_owned();
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return KvmObservation {
                path: path_string,
                exists: false,
                character_device: None,
                access_checked: false,
                current_user_access: None,
                diagnostic: Some("/dev/kvm does not exist".to_owned()),
            }
        }
        Err(error) => {
            return KvmObservation {
                path: path_string,
                exists: true,
                character_device: None,
                access_checked: false,
                current_user_access: None,
                diagnostic: Some(bound_text(&format!("could not inspect /dev/kvm: {error}"))),
            }
        }
    };

    #[cfg(unix)]
    let character_device = {
        use std::os::unix::fs::FileTypeExt;
        metadata.file_type().is_char_device()
    };
    #[cfg(not(unix))]
    let character_device = false;

    if !character_device {
        return KvmObservation {
            path: path_string,
            exists: true,
            character_device: Some(false),
            access_checked: false,
            current_user_access: None,
            diagnostic: Some("/dev/kvm exists but is not a character device".to_owned()),
        };
    }

    match OpenOptions::new().read(true).write(true).open(path) {
        Ok(_) => KvmObservation {
            path: path_string,
            exists: true,
            character_device: Some(true),
            access_checked: true,
            current_user_access: Some(true),
            diagnostic: None,
        },
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => KvmObservation {
            path: path_string,
            exists: true,
            character_device: Some(true),
            access_checked: true,
            current_user_access: Some(false),
            diagnostic: Some("current user cannot open /dev/kvm read/write".to_owned()),
        },
        Err(error) => KvmObservation {
            path: path_string,
            exists: true,
            character_device: Some(true),
            access_checked: false,
            current_user_access: None,
            diagnostic: Some(bound_text(&format!("could not open /dev/kvm: {error}"))),
        },
    }
}

pub fn classify_host(observation: &HostObservation) -> Classification {
    if observation.os != "linux" {
        return Classification::Unsupported;
    }
    if observation.architecture != "x86_64" {
        return Classification::Unsupported;
    }
    if !observation.kvm.exists {
        return Classification::Missing;
    }
    if observation.kvm.character_device == Some(false) {
        return Classification::Incompatible;
    }
    if observation.kvm.character_device.is_none() || !observation.kvm.access_checked {
        return Classification::Ambiguous;
    }
    if observation.kvm.current_user_access == Some(false) {
        return Classification::Repairable;
    }
    if observation.kvm.current_user_access == Some(true) {
        return Classification::Satisfied;
    }
    Classification::Ambiguous
}

pub fn host_error(observation: &HostObservation, classification: Classification) -> BootstrapError {
    match classification {
        Classification::Missing => BootstrapError::new(
            ErrorCode::KvmMissing,
            "supported Linux x86_64 host is missing /dev/kvm; enable KVM explicitly and rerun",
        ),
        Classification::Repairable => BootstrapError::new(
            ErrorCode::KvmInaccessible,
            "current user cannot access /dev/kvm; grant access explicitly and rerun (no sudo was invoked)",
        ),
        Classification::Incompatible => BootstrapError::new(
            ErrorCode::KvmNotCharacterDevice,
            observation
                .kvm
                .diagnostic
                .as_deref()
                .unwrap_or("/dev/kvm is not a character device"),
        ),
        Classification::Unsupported if observation.architecture != "x86_64" => BootstrapError::new(
            ErrorCode::UnsupportedArchitecture,
            format!("supported host architecture is x86_64, detected {}", observation.architecture),
        ),
        Classification::Unsupported => BootstrapError::new(
            ErrorCode::UnsupportedHostProfile,
            format!("supported host profile is Linux x86_64, detected {}/{}", observation.os, observation.architecture),
        ),
        Classification::Ambiguous => BootstrapError::new(
            ErrorCode::AmbiguousHostCapability,
            observation
                .kvm
                .diagnostic
                .as_deref()
                .unwrap_or("could not prove the supported KVM capability"),
        ),
        Classification::Satisfied => BootstrapError::new(ErrorCode::IoError, "unexpected satisfied host error"),
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_host, HostObservation, KvmObservation};
    use crate::model::Classification;

    fn observation(kvm: KvmObservation) -> HostObservation {
        HostObservation {
            os: "linux".to_owned(),
            architecture: "x86_64".to_owned(),
            kernel: Some("test-kernel".to_owned()),
            kvm,
        }
    }

    #[test]
    fn all_supported_classifications_are_deterministic() {
        let cases = [
            (
                "satisfied",
                KvmObservation {
                    path: "/dev/kvm".to_owned(),
                    exists: true,
                    character_device: Some(true),
                    access_checked: true,
                    current_user_access: Some(true),
                    diagnostic: None,
                },
                Classification::Satisfied,
            ),
            (
                "missing",
                KvmObservation {
                    path: "/dev/kvm".to_owned(),
                    exists: false,
                    character_device: None,
                    access_checked: false,
                    current_user_access: None,
                    diagnostic: Some("missing".to_owned()),
                },
                Classification::Missing,
            ),
            (
                "repairable",
                KvmObservation {
                    path: "/dev/kvm".to_owned(),
                    exists: true,
                    character_device: Some(true),
                    access_checked: true,
                    current_user_access: Some(false),
                    diagnostic: Some("permission denied".to_owned()),
                },
                Classification::Repairable,
            ),
            (
                "incompatible",
                KvmObservation {
                    path: "/dev/kvm".to_owned(),
                    exists: true,
                    character_device: Some(false),
                    access_checked: false,
                    current_user_access: None,
                    diagnostic: Some("regular file".to_owned()),
                },
                Classification::Incompatible,
            ),
            (
                "unsupported",
                KvmObservation {
                    path: "/dev/kvm".to_owned(),
                    exists: true,
                    character_device: Some(true),
                    access_checked: true,
                    current_user_access: Some(true),
                    diagnostic: None,
                },
                Classification::Unsupported,
            ),
            (
                "ambiguous",
                KvmObservation {
                    path: "/dev/kvm".to_owned(),
                    exists: true,
                    character_device: None,
                    access_checked: false,
                    current_user_access: None,
                    diagnostic: Some("metadata unavailable".to_owned()),
                },
                Classification::Ambiguous,
            ),
        ];
        for (name, kvm, expected) in cases {
            let host = if name == "unsupported" {
                HostObservation {
                    os: "linux".to_owned(),
                    architecture: "aarch64".to_owned(),
                    kernel: None,
                    kvm: kvm.clone(),
                }
            } else {
                observation(kvm)
            };
            assert_eq!(classify_host(&host), expected, "{name}");
        }
    }
}
