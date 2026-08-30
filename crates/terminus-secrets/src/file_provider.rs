//! Development-only file-backed credential store.
//!
//! On a machine where the dev kernel binary is ad-hoc (linker) signed, every
//! rebuild produces a new code identity, so the ACL on an OS-keychain item no
//! longer covers the caller and macOS raises a `SecurityAgent` approval prompt
//! on *every* read. A synchronous prompt inside a provider resolve is
//! indistinguishable from a hung kernel: the control plane's unary deadline
//! fires and the turn dies.
//!
//! This provider is the escape hatch. It stores the same bytes, under the
//! same namespaces and account names as [`crate::KeyringSecretProvider`], in
//! `<kernel data dir>/secrets/<namespace>/<account>` with 0700 directories
//! and 0600 files. It is selected only by `TERMINUS_SECRETS_BACKEND=file`
//! **and** `TERMINUS_DEV=1` (see [`crate::SecretBackend`]): the packaged app
//! always keeps the OS keychain.

use std::path::{Path, PathBuf};

use crate::error::SecretError;
use crate::namespace::{
    unix_time, validate_credential_bytes, SecretNamespace, CREDENTIAL_LEASE_SECS,
    MAX_CREDENTIAL_BYTES,
};
use crate::{SecretHandle, SecretMetadata, SecretProvider, WritableSecretProvider};

/// Mode every secret file must have. Anything with group or other bits set
/// is refused rather than read.
#[cfg(unix)]
const FILE_MODE: u32 = 0o600;
/// Mode every namespace directory is created with.
#[cfg(unix)]
const DIR_MODE: u32 = 0o700;
/// Bits that must be clear on a secret file and on the directories holding
/// it (group + other, i.e. `rwxrwx` for group/other).
#[cfg(unix)]
const FORBIDDEN_MODE_BITS: u32 = 0o077;

/// File-backed [`SecretProvider`] for one namespace.
#[derive(Debug, Clone)]
pub struct FileSecretProvider {
    /// `<root>/<namespace service>` — the directory holding this namespace's
    /// account files.
    dir: PathBuf,
    namespace: SecretNamespace,
}

impl FileSecretProvider {
    /// Open (creating if needed) the on-disk namespace directory under
    /// `root` — conventionally `<kernel data dir>/secrets`.
    ///
    /// # Errors
    /// Fails closed when the platform has no POSIX modes, when the root or
    /// namespace directory is group/world accessible, or when either path is
    /// a symlink.
    pub fn open(root: impl AsRef<Path>, namespace: SecretNamespace) -> Result<Self, SecretError> {
        let root = root.as_ref();
        Self::prepare_dir(root)?;
        let dir = root.join(namespace.service());
        Self::prepare_dir(&dir)?;
        Ok(Self { dir, namespace })
    }

    /// The directory this provider reads and writes. Safe to log: it is a
    /// container path, not a credential.
    #[must_use]
    pub fn directory(&self) -> &Path {
        &self.dir
    }

    #[cfg(unix)]
    fn prepare_dir(dir: &Path) -> Result<(), SecretError> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        if !dir.exists() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(DIR_MODE)
                .create(dir)
                .map_err(|error| {
                    SecretError::ProviderUnavailable(format!(
                        "cannot create secret directory {}: {error}",
                        dir.display()
                    ))
                })?;
        }
        let metadata = std::fs::symlink_metadata(dir).map_err(|error| {
            SecretError::ProviderUnavailable(format!(
                "cannot stat secret directory {}: {error}",
                dir.display()
            ))
        })?;
        if metadata.file_type().is_symlink() {
            return Err(SecretError::Denied(format!(
                "secret directory {} is a symlink",
                dir.display()
            )));
        }
        if !metadata.is_dir() {
            return Err(SecretError::Denied(format!(
                "secret directory {} is not a directory",
                dir.display()
            )));
        }
        let mode = metadata.permissions().mode() & 0o777;
        if mode & FORBIDDEN_MODE_BITS != 0 {
            return Err(SecretError::Denied(format!(
                "secret directory {} must be mode 0700; found {mode:04o}",
                dir.display()
            )));
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn prepare_dir(dir: &Path) -> Result<(), SecretError> {
        let _ = dir;
        Err(SecretError::Denied(
            "the file secret backend requires a POSIX filesystem".to_string(),
        ))
    }

    /// Absolute path of one account file. The account name comes from
    /// [`SecretNamespace::account_for`], which admits only a fixed gateway
    /// scope or `account.<uuid-v7>`; neither can contain a separator, so the
    /// join can never escape `dir`.
    fn path_for(&self, uri: &str) -> Result<PathBuf, SecretError> {
        let account = self.namespace.account_for(uri)?;
        debug_assert!(!account.contains('/') && account != "." && account != "..");
        Ok(self.dir.join(account))
    }

    /// Read the exact bytes of an account file after checking that nothing
    /// about it invites another process to substitute the credential.
    #[cfg(unix)]
    fn read_checked(path: &Path, uri: &str) -> Result<Vec<u8>, SecretError> {
        use std::os::unix::fs::PermissionsExt;

        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(SecretError::UnknownCapability(uri.to_string()));
            }
            Err(error) => {
                return Err(SecretError::ProviderUnavailable(format!(
                    "cannot stat credential for {uri}: {error}"
                )));
            }
        };
        if metadata.file_type().is_symlink() {
            return Err(SecretError::Denied(format!(
                "credential file for {uri} is a symlink; refusing to follow it"
            )));
        }
        if !metadata.is_file() {
            return Err(SecretError::Denied(format!(
                "credential file for {uri} is not a regular file"
            )));
        }
        let mode = metadata.permissions().mode() & 0o777;
        if mode & FORBIDDEN_MODE_BITS != 0 {
            return Err(SecretError::Denied(format!(
                "credential file for {uri} must be mode 0600; found {mode:04o}"
            )));
        }
        if metadata.len() > MAX_CREDENTIAL_BYTES as u64 {
            return Err(SecretError::Denied(format!(
                "credential for {uri} exceeds {MAX_CREDENTIAL_BYTES} bytes"
            )));
        }
        // `symlink_metadata` above proves the *name* is not a symlink; the
        // open below can still fail if it was swapped in between, in which
        // case the read simply errors out.
        let bytes = std::fs::read(path).map_err(|error| {
            SecretError::ProviderUnavailable(format!("cannot read credential for {uri}: {error}"))
        })?;
        if bytes.is_empty() {
            return Err(SecretError::Denied(format!(
                "credential file for {uri} is empty"
            )));
        }
        Ok(bytes)
    }

    #[cfg(not(unix))]
    fn read_checked(path: &Path, uri: &str) -> Result<Vec<u8>, SecretError> {
        let _ = path;
        let _ = uri;
        Err(SecretError::Denied(
            "the file secret backend requires a POSIX filesystem".to_string(),
        ))
    }

    /// Write `value` to `path` atomically with mode 0600: a temp file in the
    /// same directory, then a rename. A reader therefore never observes a
    /// half-written credential and never sees a wider mode.
    #[cfg(unix)]
    fn write_atomic(path: &Path, value: &[u8]) -> Result<(), SecretError> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        use std::sync::atomic::{AtomicU64, Ordering};

        static COUNTER: AtomicU64 = AtomicU64::new(0);

        let parent = path.parent().ok_or_else(|| {
            SecretError::ProviderUnavailable("credential path has no parent".to_string())
        })?;
        let file_name = path
            .file_name()
            .and_then(std::ffi::OsStr::to_str)
            .ok_or_else(|| {
                SecretError::ProviderUnavailable("credential path has no file name".to_string())
            })?;
        let temp = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        // `create_new` refuses to reuse (or follow) anything already at the
        // temp path.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(FILE_MODE)
            .open(&temp)
            .map_err(|error| {
                SecretError::ProviderUnavailable(format!("cannot create credential file: {error}"))
            })?;
        let written = file
            .write_all(value)
            .and_then(|()| file.sync_all())
            .map_err(|error| {
                SecretError::ProviderUnavailable(format!("cannot write credential file: {error}"))
            });
        drop(file);
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temp);
            return Err(error);
        }
        if let Err(error) = std::fs::rename(&temp, path) {
            let _ = std::fs::remove_file(&temp);
            return Err(SecretError::ProviderUnavailable(format!(
                "cannot install credential file: {error}"
            )));
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn write_atomic(path: &Path, value: &[u8]) -> Result<(), SecretError> {
        let _ = path;
        let _ = value;
        Err(SecretError::Denied(
            "the file secret backend requires a POSIX filesystem".to_string(),
        ))
    }

    /// Refuse to write through, or unlink, a name another process planted as
    /// a symlink.
    fn reject_symlink(path: &Path, uri: &str) -> Result<(), SecretError> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(SecretError::Denied(format!(
                "credential file for {uri} is a symlink; refusing to follow it"
            ))),
            Ok(_) | Err(_) => Ok(()),
        }
    }
}

impl SecretProvider for FileSecretProvider {
    fn resolve(&self, uri: &str) -> Result<SecretHandle, SecretError> {
        let path = self.path_for(uri)?;
        let value = Self::read_checked(&path, uri)?;
        let now = unix_time()?;
        Ok(SecretHandle::from_value(
            SecretMetadata {
                uri: uri.to_string(),
                provider: self.namespace.provider_id().to_string(),
                scope: self.namespace.account_for(uri)?,
                issued_at_unix: now,
                expires_at_unix: now.saturating_add(CREDENTIAL_LEASE_SECS),
                redaction_patterns: vec![format!("REDACTED:{uri}")],
                allowed_destinations: self.namespace.destinations(),
            },
            value,
        ))
    }
}

impl WritableSecretProvider for FileSecretProvider {
    fn store(&self, uri: &str, value: &[u8]) -> Result<(), SecretError> {
        let path = self.path_for(uri)?;
        // Same shape rules as the keyring store, so a credential accepted by
        // one backend is accepted by the other.
        let _ = validate_credential_bytes(value)?;
        Self::reject_symlink(&path, uri)?;
        Self::write_atomic(&path, value)
    }

    fn delete(&self, uri: &str) -> Result<(), SecretError> {
        let path = self.path_for(uri)?;
        Self::reject_symlink(&path, uri)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Deletion is an idempotent cleanup operation. An absent
                // account is already in the requested terminal state.
                Ok(())
            }
            Err(error) => Err(SecretError::ProviderUnavailable(format!(
                "cannot remove credential for {uri}: {error}"
            ))),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;

    const GATEWAY_URI: &str = "secret://opencode/zen";
    const ACCOUNT_URI: &str = "secret://provider-account/0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b";

    fn digest_of(value: &[u8]) -> String {
        hex::encode(Sha256::digest(value))
    }

    #[test]
    fn gateway_namespace_round_trip() {
        let root = tempfile::tempdir().unwrap();
        let provider =
            FileSecretProvider::open(root.path().join("secrets"), SecretNamespace::Gateway)
                .unwrap();
        provider.store(GATEWAY_URI, b"zen-token-value").unwrap();
        let handle = provider.resolve(GATEWAY_URI).unwrap();
        assert_eq!(handle.digest(), digest_of(b"zen-token-value"));
        assert_eq!(handle.metadata.provider, "opencode");
        assert_eq!(handle.metadata.scope, "zen");
        assert!(!format!("{handle:?}").contains("zen-token-value"));
        drop(handle);
        provider.delete(GATEWAY_URI).unwrap();
        assert!(provider.resolve(GATEWAY_URI).is_err());
    }

    #[test]
    fn provider_account_namespace_round_trip() {
        let root = tempfile::tempdir().unwrap();
        let provider = FileSecretProvider::open(
            root.path().join("secrets"),
            SecretNamespace::ProviderAccount,
        )
        .unwrap();
        provider.store(ACCOUNT_URI, b"account-token-value").unwrap();
        let handle = provider.resolve(ACCOUNT_URI).unwrap();
        assert_eq!(handle.digest(), digest_of(b"account-token-value"));
        assert_eq!(handle.metadata.provider, "provider-account");
        assert_eq!(
            handle.metadata.scope,
            "account.0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b"
        );
        // Bytes are stored verbatim.
        let path = provider.path_for(ACCOUNT_URI).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"account-token-value");
    }

    #[test]
    fn namespaces_use_separate_directories_and_never_admit_each_other() {
        let root = tempfile::tempdir().unwrap();
        let secrets = root.path().join("secrets");
        let gateway = FileSecretProvider::open(&secrets, SecretNamespace::Gateway).unwrap();
        let accounts =
            FileSecretProvider::open(&secrets, SecretNamespace::ProviderAccount).unwrap();
        assert_ne!(gateway.directory(), accounts.directory());
        assert!(gateway.resolve(ACCOUNT_URI).is_err());
        assert!(accounts.resolve(GATEWAY_URI).is_err());
        assert!(gateway.store(ACCOUNT_URI, b"x").is_err());
    }

    #[test]
    fn group_or_world_readable_file_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let provider =
            FileSecretProvider::open(root.path().join("secrets"), SecretNamespace::Gateway)
                .unwrap();
        provider.store(GATEWAY_URI, b"zen-token-value").unwrap();
        let path = provider.path_for(GATEWAY_URI).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let error = provider.resolve(GATEWAY_URI).unwrap_err();
        assert!(
            matches!(error, SecretError::Denied(ref message) if message.contains("0644")),
            "expected a mode refusal, got {error}"
        );
    }

    #[test]
    fn symlinked_credential_file_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let provider =
            FileSecretProvider::open(root.path().join("secrets"), SecretNamespace::Gateway)
                .unwrap();
        let target = root.path().join("planted");
        std::fs::write(&target, b"planted-value").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        let path = provider.path_for(GATEWAY_URI).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();

        let error = provider.resolve(GATEWAY_URI).unwrap_err();
        assert!(
            matches!(error, SecretError::Denied(ref message) if message.contains("symlink")),
            "expected a symlink refusal, got {error}"
        );
        // A write through the planted link is refused too, so the symlink can
        // never be used to place bytes outside the namespace directory.
        assert!(provider.store(GATEWAY_URI, b"new-value").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"planted-value");
    }

    #[test]
    fn group_readable_namespace_directory_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let secrets = root.path().join("secrets");
        std::fs::create_dir_all(secrets.join(SecretNamespace::Gateway.service())).unwrap();
        std::fs::set_permissions(&secrets, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = FileSecretProvider::open(&secrets, SecretNamespace::Gateway).unwrap_err();
        assert!(matches!(error, SecretError::Denied(_)), "got {error}");
    }

    #[test]
    fn created_directories_are_private() {
        let root = tempfile::tempdir().unwrap();
        let provider =
            FileSecretProvider::open(root.path().join("secrets"), SecretNamespace::Gateway)
                .unwrap();
        let mode = std::fs::metadata(provider.directory())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, DIR_MODE);
        provider.store(GATEWAY_URI, b"zen-token-value").unwrap();
        let file_mode = std::fs::metadata(provider.path_for(GATEWAY_URI).unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(file_mode, FILE_MODE);
    }

    #[test]
    fn store_applies_the_same_shape_rules_as_the_keyring() {
        let root = tempfile::tempdir().unwrap();
        let provider =
            FileSecretProvider::open(root.path().join("secrets"), SecretNamespace::Gateway)
                .unwrap();
        assert!(provider.store(GATEWAY_URI, b"").is_err());
        assert!(provider.store(GATEWAY_URI, b"has space").is_err());
        assert!(provider
            .store(GATEWAY_URI, &vec![b'a'; MAX_CREDENTIAL_BYTES + 1])
            .is_err());
        assert!(provider.store(GATEWAY_URI, &[0xff, 0xfe]).is_err());
        // Nothing was written by any of the refusals.
        assert!(provider.resolve(GATEWAY_URI).is_err());
    }

    #[test]
    fn store_overwrites_in_place_and_leaves_no_temp_files() {
        let root = tempfile::tempdir().unwrap();
        let provider =
            FileSecretProvider::open(root.path().join("secrets"), SecretNamespace::Gateway)
                .unwrap();
        provider.store(GATEWAY_URI, b"first-value").unwrap();
        provider.store(GATEWAY_URI, b"second-value").unwrap();
        let handle = provider.resolve(GATEWAY_URI).unwrap();
        assert_eq!(handle.digest(), digest_of(b"second-value"));
        let entries: Vec<_> = std::fs::read_dir(provider.directory())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["zen".to_string()]);
    }

    #[test]
    fn delete_of_absent_credential_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let provider =
            FileSecretProvider::open(root.path().join("secrets"), SecretNamespace::Gateway)
                .unwrap();

        provider.delete(GATEWAY_URI).unwrap();
        provider.delete(GATEWAY_URI).unwrap();
    }
}
