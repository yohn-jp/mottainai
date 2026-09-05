use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use sha2::{Digest, Sha256};

use crate::error::{BootstrapError, ErrorCode};
use crate::paths::ManagedPaths;

pub const BOOTSTRAP_KEY_LABEL: &str = "MTNAI_BOOT";
pub const BOOTSTRAP_KEY_FILE: &str = "authorized_keys";
pub const MAX_BOOTSTRAP_KEY_BYTES: usize = 8 * 1024;
pub const MAX_BOOTSTRAP_KEY_LINES: usize = 16;

const BYTES_PER_SECTOR: usize = 512;
const SECTORS_PER_CLUSTER: usize = 4;
const RESERVED_SECTORS: usize = 1;
const FAT_COUNT: usize = 2;
const SECTORS_PER_FAT: usize = 32;
const ROOT_DIRECTORY_ENTRIES: usize = 32;
const ROOT_DIRECTORY_SECTORS: usize = 2;
const TOTAL_SECTORS: usize = 32768;
const IMAGE_BYTES: usize = TOTAL_SECTORS * BYTES_PER_SECTOR;
const DATA_START_SECTOR: usize =
    RESERVED_SECTORS + FAT_COUNT * SECTORS_PER_FAT + ROOT_DIRECTORY_SECTORS;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BootstrapDisk {
    pub name: String,
    pub path: PathBuf,
    pub public_key_sha256: String,
}

/// Returns the exact Lima disk name used for one managed Runtime instance.
/// The name is deliberately independent of key contents: changing a key
/// regenerates the same managed carrier, while runtime reconciliation verifies
/// the carrier before allowing a running instance to remain managed.
pub fn bootstrap_disk_name(instance_name: &str) -> String {
    let digest = Sha256::digest(instance_name.as_bytes());
    format!("mtnai-boot-{:x}", digest)[..27].to_owned()
}

pub fn bootstrap_disk_path(paths: &ManagedPaths, instance_name: &str) -> PathBuf {
    paths
        .lima_home_directory
        .join("_disk")
        .join(bootstrap_disk_name(instance_name))
        .join("datadisk")
}

/// Reads Lima's own managed public identity. It never consults ambient home
/// SSH keys or any other unrelated key location. On a fresh managed Lima home,
/// the missing identity is created at the same path Lima uses, so both Lima
/// SSH and the MTNAI_BOOT carrier share one authority.
pub fn ensure_lima_public_key(paths: &ManagedPaths) -> Result<String, BootstrapError> {
    let config_directory = paths.lima_home_directory.join("_config");
    ensure_private_directory(&paths.lima_home_directory, "managed Lima home")?;
    ensure_private_directory(&config_directory, "managed Lima config directory")?;

    let private_key_path = config_directory.join("user");
    let public_key_path = config_directory.join("user.pub");
    let private_exists = regular_file_exists(&private_key_path)?;
    let public_exists = regular_file_exists(&public_key_path)?;

    match (private_exists, public_exists) {
        (true, true) => read_public_key(&public_key_path),
        (false, false) => generate_lima_identity(&config_directory, &private_key_path),
        _ => Err(BootstrapError::new(
            ErrorCode::BootstrapKeyUnavailable,
            "managed Lima SSH identity is incomplete; refusing to replace or adopt it",
        )),
    }
}

pub fn ensure_bootstrap_disk(
    paths: &ManagedPaths,
    instance_name: &str,
    public_key: &str,
) -> Result<BootstrapDisk, BootstrapError> {
    let normalized_key = validate_public_key_text(public_key)?;
    let image = build_fat16_image(&normalized_key)?;
    let path = bootstrap_disk_path(paths, instance_name);
    let parent = path.parent().ok_or_else(|| {
        BootstrapError::new(
            ErrorCode::BootstrapDiskFailed,
            "managed MTNAI_BOOT path has no parent directory",
        )
    })?;
    ensure_private_directory(parent, "managed MTNAI_BOOT disk directory")?;

    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            let unchanged = if metadata.len() == IMAGE_BYTES as u64 {
                read_bounded(&path, IMAGE_BYTES)
                    .map(|current| current == image)
                    .map_err(|error| {
                        BootstrapError::io("inspect managed MTNAI_BOOT image", &error)
                    })?
            } else {
                false
            };
            if !unchanged {
                write_atomic_image(&path, &image)?;
            }
        }
        Ok(_) => {
            return Err(BootstrapError::new(
                ErrorCode::BootstrapDiskFailed,
                "managed MTNAI_BOOT image is not a regular file",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            write_atomic_image(&path, &image)?;
        }
        Err(error) => {
            return Err(BootstrapError::io(
                "inspect managed MTNAI_BOOT image",
                &error,
            ));
        }
    }

    Ok(BootstrapDisk {
        name: bootstrap_disk_name(instance_name),
        path,
        public_key_sha256: format!("{:x}", Sha256::digest(normalized_key.as_bytes())),
    })
}

/// Checks an attached disk without rewriting it. A running Lima instance must
/// never have its open block-device inode replaced under it.
pub fn verify_bootstrap_disk(
    paths: &ManagedPaths,
    instance_name: &str,
    public_key: &str,
) -> Result<(), BootstrapError> {
    let normalized_key = validate_public_key_text(public_key)?;
    let expected = build_fat16_image(&normalized_key)?;
    let path = bootstrap_disk_path(paths, instance_name);
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        BootstrapError::new(
            ErrorCode::BootstrapDiskFailed,
            format!("read managed MTNAI_BOOT image {}: {error}", path.display()),
        )
    })?;
    if !metadata.file_type().is_file() || metadata.len() != IMAGE_BYTES as u64 {
        return Err(BootstrapError::new(
            ErrorCode::BootstrapDiskFailed,
            "managed MTNAI_BOOT image is missing or outside the bounded image size",
        ));
    }
    let actual = read_bounded(&path, IMAGE_BYTES)
        .map_err(|error| BootstrapError::io("read managed MTNAI_BOOT image", &error))?;
    if actual != expected {
        return Err(BootstrapError::new(
            ErrorCode::BootstrapDiskFailed,
            "managed MTNAI_BOOT image does not match the canonical operator key",
        ));
    }
    Ok(())
}

pub fn validate_public_key_text(value: &str) -> Result<String, BootstrapError> {
    if value.is_empty() || value.len() > MAX_BOOTSTRAP_KEY_BYTES {
        return invalid_key("SSH public key input is empty or exceeds the 8KiB bound");
    }
    let mut lines = Vec::new();
    let split_lines = value.split('\n').collect::<Vec<_>>();
    for (index, line) in split_lines.iter().enumerate() {
        if index == split_lines.len() - 1 && line.is_empty() {
            continue;
        }
        if line.is_empty() || line.chars().any(char::is_control) {
            return invalid_key("SSH public key input contains an empty line or control character");
        }
        let mut fields = line.splitn(3, ' ');
        let algorithm = fields.next();
        let encoded = fields.next();
        if !matches!(
            algorithm,
            Some("ssh-ed25519" | "ssh-rsa" | "ecdsa-sha2-nistp256")
        ) || encoded.is_none()
        {
            return invalid_key("SSH public key input uses an unsupported public-key grammar");
        }
        let encoded = encoded.expect("checked above");
        if encoded.is_empty()
            || !encoded
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        {
            return invalid_key("SSH public key input contains an invalid key blob");
        }
        lines.push(*line);
    }
    if lines.is_empty() || lines.len() > MAX_BOOTSTRAP_KEY_LINES {
        return invalid_key("SSH public key input has no key or exceeds the 16-line bound");
    }
    let normalized = format!("{}\n", lines.join("\n"));
    if normalized.len() > MAX_BOOTSTRAP_KEY_BYTES {
        return invalid_key("normalized SSH public key input exceeds the 8KiB bound");
    }
    Ok(normalized)
}

fn invalid_key(message: &str) -> Result<String, BootstrapError> {
    Err(BootstrapError::new(ErrorCode::BootstrapKeyInvalid, message))
}

fn read_public_key(path: &Path) -> Result<String, BootstrapError> {
    let bytes = read_bounded(path, MAX_BOOTSTRAP_KEY_BYTES)
        .map_err(|error| BootstrapError::io("read Lima public identity", &error))?;
    let value = std::str::from_utf8(&bytes).map_err(|_| {
        BootstrapError::new(
            ErrorCode::BootstrapKeyInvalid,
            "managed Lima public identity is not UTF-8",
        )
    })?;
    validate_public_key_text(value)
}

fn generate_lima_identity(
    config_directory: &Path,
    private_key_path: &Path,
) -> Result<String, BootstrapError> {
    let temporary_private =
        config_directory.join(format!(".user.bootstrap.{}.key", std::process::id()));
    let temporary_public = temporary_private.with_extension("key.pub");
    if temporary_private.exists() || temporary_public.exists() {
        return Err(BootstrapError::new(
            ErrorCode::BootstrapKeyUnavailable,
            "an interrupted Lima SSH identity generation is present; refusing to overwrite it",
        ));
    }

    let output = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&temporary_private)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| BootstrapError::io("create Lima SSH identity with ssh-keygen", &error))?;
    if !output.status.success() {
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        return Err(BootstrapError::new(
            ErrorCode::BootstrapKeyUnavailable,
            format!(
                "ssh-keygen could not create the managed Lima SSH identity: {}",
                diagnostic.chars().take(256).collect::<String>()
            ),
        ));
    }

    let public_key = read_public_key(&temporary_public);
    let public_key = match public_key {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_file(&temporary_private);
            let _ = fs::remove_file(&temporary_public);
            return Err(error);
        }
    };
    fs::rename(&temporary_private, private_key_path)
        .map_err(|error| BootstrapError::io("promote managed Lima private identity", &error))?;
    fs::rename(&temporary_public, private_key_path.with_extension("pub"))
        .map_err(|error| BootstrapError::io("promote managed Lima public identity", &error))?;
    Ok(public_key)
}

fn regular_file_exists(path: &Path) -> Result<bool, BootstrapError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => Err(BootstrapError::new(
            ErrorCode::BootstrapKeyUnavailable,
            format!(
                "managed Lima identity path is not a regular file: {}",
                path.display()
            ),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(BootstrapError::io("inspect managed Lima identity", &error)),
    }
}

fn read_bounded(path: &Path, maximum: usize) -> std::io::Result<Vec<u8>> {
    let mut file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file exceeds the bounded read size",
        ));
    }
    Ok(bytes)
}

fn ensure_private_directory(path: &Path, description: &str) -> Result<(), BootstrapError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => {
            return Err(BootstrapError::new(
                ErrorCode::BootstrapDiskFailed,
                format!("{description} is not a real directory"),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|error| BootstrapError::io(description, &error))?;
        }
        Err(error) => return Err(BootstrapError::io(description, &error)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| BootstrapError::io(description, &error))?;
    }
    Ok(())
}

fn write_atomic_image(path: &Path, image: &[u8]) -> Result<(), BootstrapError> {
    let parent = path.parent().expect("validated managed image parent");
    let (temporary, mut file) = (0..32)
        .map(|attempt| {
            (
                parent.join(format!(".datadisk.tmp.{}.{}", std::process::id(), attempt)),
                attempt,
            )
        })
        .find_map(|(candidate, _)| {
            match OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((candidate, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(BootstrapError::io(
                    "create staged MTNAI_BOOT image",
                    &error,
                ))),
            }
        })
        .ok_or_else(|| {
            BootstrapError::new(
                ErrorCode::BootstrapDiskFailed,
                "could not allocate a unique staged MTNAI_BOOT image path",
            )
        })??;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| BootstrapError::io("protect staged MTNAI_BOOT image", &error))?;
    }
    if let Err(error) = file.write_all(image).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(BootstrapError::io("write staged MTNAI_BOOT image", &error));
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        BootstrapError::io("atomically promote MTNAI_BOOT image", &error)
    })?;
    Ok(())
}

fn build_fat16_image(public_key: &str) -> Result<Vec<u8>, BootstrapError> {
    let content = public_key.as_bytes();
    let clusters = content
        .len()
        .div_ceil(BYTES_PER_SECTOR * SECTORS_PER_CLUSTER)
        .max(1);
    let data_clusters = (TOTAL_SECTORS - DATA_START_SECTOR) / SECTORS_PER_CLUSTER;
    if clusters > data_clusters || clusters > u16::MAX as usize - 2 {
        return Err(BootstrapError::new(
            ErrorCode::BootstrapDiskFailed,
            "validated authorized_keys content does not fit the bounded MTNAI_BOOT image",
        ));
    }

    let mut image = vec![0_u8; IMAGE_BYTES];
    image[0..3].copy_from_slice(&[0xeb, 0x3c, 0x90]);
    image[3..11].copy_from_slice(b"MTNAI16 ");
    put_u16(&mut image, 11, BYTES_PER_SECTOR as u16);
    image[13] = SECTORS_PER_CLUSTER as u8;
    put_u16(&mut image, 14, RESERVED_SECTORS as u16);
    image[16] = FAT_COUNT as u8;
    put_u16(&mut image, 17, ROOT_DIRECTORY_ENTRIES as u16);
    put_u16(&mut image, 19, TOTAL_SECTORS as u16);
    image[21] = 0xf8;
    put_u16(&mut image, 22, SECTORS_PER_FAT as u16);
    put_u16(&mut image, 24, 32);
    put_u16(&mut image, 26, 64);
    image[36] = 0x80;
    image[38] = 0x29;
    put_u32(&mut image, 39, 0x4d544e41);
    write_padded(&mut image[43..54], BOOTSTRAP_KEY_LABEL.as_bytes(), b' ');
    write_padded(&mut image[54..62], b"FAT16", b' ');
    image[510] = 0x55;
    image[511] = 0xaa;

    let fat_start = RESERVED_SECTORS * BYTES_PER_SECTOR;
    for fat_index in 0..FAT_COUNT {
        let start = fat_start + fat_index * SECTORS_PER_FAT * BYTES_PER_SECTOR;
        let fat = &mut image[start..start + SECTORS_PER_FAT * BYTES_PER_SECTOR];
        put_fat_entry(fat, 0, 0xfff8);
        put_fat_entry(fat, 1, 0xffff);
        for offset in 0..clusters {
            let cluster = 2 + offset;
            let value = if offset + 1 == clusters {
                0xffff
            } else {
                (cluster + 1) as u16
            };
            put_fat_entry(fat, cluster, value);
        }
    }

    let root_start = (RESERVED_SECTORS + FAT_COUNT * SECTORS_PER_FAT) * BYTES_PER_SECTOR;
    let volume_label = &mut image[root_start..][..32];
    volume_label[0..11].copy_from_slice(b"MTNAI_BOOT ");
    volume_label[11] = 0x08;
    let short_name = *b"AUTHOR~1KEY";
    let checksum = short_name_checksum(&short_name);
    let name: Vec<u16> = BOOTSTRAP_KEY_FILE.encode_utf16().collect();
    let chunk_count = name.len().div_ceil(13);
    for ordinal in (1..=chunk_count).rev() {
        let start = (ordinal - 1) * 13;
        let end = name.len().min(start + 13);
        let sequence = (ordinal as u8) | if ordinal == chunk_count { 0x40 } else { 0 };
        write_long_name_entry(
            &mut image[root_start + 32 + (chunk_count - ordinal) * 32..][..32],
            sequence,
            &name[start..end],
            checksum,
        );
    }
    let short_entry_start = root_start + 32 + chunk_count * 32;
    let short_entry = &mut image[short_entry_start..][..32];
    short_entry[0..11].copy_from_slice(&short_name);
    short_entry[11] = 0x20;
    put_u16(short_entry, 26, 2);
    put_u32(short_entry, 28, content.len() as u32);

    let data_start = DATA_START_SECTOR * BYTES_PER_SECTOR;
    for (index, chunk) in content.chunks(BYTES_PER_SECTOR).enumerate() {
        let start = data_start + index * BYTES_PER_SECTOR;
        image[start..start + chunk.len()].copy_from_slice(chunk);
    }
    Ok(image)
}

fn write_long_name_entry(entry: &mut [u8], sequence: u8, name: &[u16], checksum: u8) {
    entry.fill(0);
    entry[0] = sequence;
    entry[11] = 0x0f;
    entry[13] = checksum;
    let fields = [(1, 5), (14, 6), (28, 2)];
    let mut position = 0;
    for (offset, length) in fields {
        for index in 0..length {
            let value = if let Some(character) = name.get(position) {
                position += 1;
                *character
            } else if position == name.len() {
                position += 1;
                0
            } else {
                0xffff
            };
            entry[offset + index * 2..offset + index * 2 + 2].copy_from_slice(&value.to_le_bytes());
        }
    }
}

fn short_name_checksum(name: &[u8; 11]) -> u8 {
    name.iter().fold(0_u8, |checksum, byte| {
        (((checksum & 1) << 7) | (checksum >> 1)).wrapping_add(*byte)
    })
}

fn put_fat_entry(fat: &mut [u8], cluster: usize, value: u16) {
    let offset = cluster * 2;
    fat[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_padded(destination: &mut [u8], value: &[u8], padding: u8) {
    destination.fill(padding);
    destination[..value.len()].copy_from_slice(value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    use tempfile::TempDir;

    fn paths() -> (TempDir, ManagedPaths) {
        let temp = TempDir::new().unwrap();
        let paths = ManagedPaths::new(temp.path().join("state"));
        fs::create_dir_all(&paths.root).unwrap();
        (temp, paths)
    }

    const VALID_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestBootstrapKeyForMottainai840 operator";

    #[test]
    fn valid_key_creates_bounded_labeled_disk_with_only_authorized_keys() {
        let (_temp, paths) = paths();
        let disk = ensure_bootstrap_disk(&paths, "mottainai-runtime", VALID_KEY).unwrap();
        assert_eq!(disk.name, bootstrap_disk_name("mottainai-runtime"));
        assert_eq!(fs::metadata(&disk.path).unwrap().len(), IMAGE_BYTES as u64);
        let image = fs::read(&disk.path).unwrap();
        assert_eq!(&image[43..54], b"MTNAI_BOOT ");
        assert_eq!(
            &image[DATA_START_SECTOR * BYTES_PER_SECTOR..][..VALID_KEY.len()],
            VALID_KEY.as_bytes()
        );
        assert!(image
            .windows(b"-----BEGIN".len())
            .all(|window| window != b"-----BEGIN"));
        let root_start = (RESERVED_SECTORS + FAT_COUNT * SECTORS_PER_FAT) * BYTES_PER_SECTOR;
        let mut file_name = Vec::new();
        assert_eq!(&image[root_start..root_start + 11], b"MTNAI_BOOT ");
        assert_eq!(image[root_start + 11], 0x08);
        for entry_start in [root_start + 64, root_start + 32] {
            for (offset, length) in [(1, 5), (14, 6), (28, 2)] {
                for index in 0..length {
                    let offset = entry_start + offset + index * 2;
                    let character = u16::from_le_bytes([image[offset], image[offset + 1]]);
                    if character == 0 || character == 0xffff {
                        continue;
                    }
                    file_name.push(character);
                }
            }
        }
        assert_eq!(String::from_utf16(&file_name).unwrap(), BOOTSTRAP_KEY_FILE);
    }

    #[test]
    fn managed_lima_identity_is_used_without_scanning_unrelated_ssh_keys() {
        let (temp, paths) = paths();
        let config_directory = paths.lima_home_directory.join("_config");
        fs::create_dir_all(&config_directory).unwrap();
        fs::write(config_directory.join("user"), b"managed-private-key").unwrap();
        fs::write(config_directory.join("user.pub"), format!("{VALID_KEY}\n")).unwrap();

        let unrelated_directory = temp.path().join("unrelated-home").join(".ssh");
        fs::create_dir_all(&unrelated_directory).unwrap();
        fs::write(
            unrelated_directory.join("operator.pub"),
            "ssh-ed25519 AAAAambient ambient\n",
        )
        .unwrap();

        assert_eq!(
            ensure_lima_public_key(&paths).unwrap(),
            format!("{VALID_KEY}\n")
        );
    }

    #[test]
    fn invalid_private_garbage_and_multiline_input_fail_closed() {
        let (_temp, paths) = paths();
        for value in [
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "not-an-ssh-key",
            "ssh-ed25519 AAAA\nnot-a-key",
            "ssh-ed25519 AAAA\tcomment",
        ] {
            let result = ensure_bootstrap_disk(&paths, "mottainai-runtime", value);
            assert_eq!(result.unwrap_err().code, ErrorCode::BootstrapKeyInvalid);
        }
        let boundary_key = format!(
            "ssh-ed25519 {} operator",
            "A".repeat(MAX_BOOTSTRAP_KEY_BYTES - "ssh-ed25519 ".len() - " operator".len())
        );
        assert_eq!(
            validate_public_key_text(&boundary_key).unwrap_err().code,
            ErrorCode::BootstrapKeyInvalid
        );
        assert!(!bootstrap_disk_path(&paths, "mottainai-runtime").exists());
    }

    #[test]
    fn unchanged_key_does_not_rewrite_and_changed_key_regenerates_deterministically() {
        let (_temp, paths) = paths();
        let first = ensure_bootstrap_disk(&paths, "mottainai-runtime", VALID_KEY).unwrap();
        let first_bytes = fs::read(&first.path).unwrap();
        let first_modified = fs::metadata(&first.path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = ensure_bootstrap_disk(&paths, "mottainai-runtime", VALID_KEY).unwrap();
        assert_eq!(first_bytes, fs::read(&second.path).unwrap());
        assert_eq!(
            first_modified,
            fs::metadata(&second.path).unwrap().modified().unwrap()
        );

        let changed = VALID_KEY.replace("operator", "changed");
        let changed_disk = ensure_bootstrap_disk(&paths, "mottainai-runtime", &changed).unwrap();
        let changed_bytes = fs::read(&changed_disk.path).unwrap();
        assert_ne!(first_bytes, changed_bytes);
        assert_ne!(first.public_key_sha256, changed_disk.public_key_sha256);
        let changed_again =
            build_fat16_image(&validate_public_key_text(&changed).unwrap()).unwrap();
        assert_eq!(changed_bytes, changed_again);
        assert!(SystemTime::now().duration_since(first_modified).is_ok());
    }

    #[test]
    fn partial_current_image_is_replaced_only_after_complete_image_is_ready() {
        let (_temp, paths) = paths();
        let path = bootstrap_disk_path(&paths, "mottainai-runtime");
        ensure_private_directory(path.parent().unwrap(), "test disk directory").unwrap();
        fs::write(&path, vec![0_u8; IMAGE_BYTES / 2]).unwrap();
        ensure_bootstrap_disk(&paths, "mottainai-runtime", VALID_KEY).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), IMAGE_BYTES as u64);
        verify_bootstrap_disk(&paths, "mottainai-runtime", VALID_KEY).unwrap();
    }
}
