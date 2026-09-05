pub mod appliance;
pub mod bootstrap_disk;
pub mod contract;
pub mod deployment_descriptor;
pub(crate) mod download;
pub mod error;
pub mod evidence;
pub mod host;
pub mod lima;
pub mod lock;
pub(crate) mod materialize;
pub mod model;
pub mod oci;
pub mod paths;
pub mod provider;
pub mod qemu;
pub mod reconcile;

pub use contract::{ProviderContract, BOOTSTRAP_VERSION, CONTRACT_SCHEMA_VERSION};
pub use evidence::Evidence;
pub use lima::{ensure_runtime, RuntimeEnsureConfig, RuntimeEvidence, RuntimeSpec};
pub use model::{Classification, Outcome};
pub use qemu::{
    HttpQemuArtifactSource, QemuArtifact, QemuArtifactSource, QemuContract, QemuDataArtifact,
};
pub use reconcile::{Bootstrap, BootstrapConfig};
