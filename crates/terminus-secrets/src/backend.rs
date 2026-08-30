//! Which credential store backs the kernel's secret providers.
//!
//! The packaged app always uses the OS keychain. The file backend exists
//! only so a developer whose ad-hoc-signed dev binary changes code identity
//! on every rebuild — and therefore gets a `SecurityAgent` approval prompt on
//! every keychain read — can keep working. It is refused unless the kernel
//! is explicitly running in development mode.

use crate::error::SecretError;

/// Environment variable selecting the backend.
pub const SECRETS_BACKEND_ENV: &str = "TERMINUS_SECRETS_BACKEND";
/// Environment variable the kernel already uses to mark a development run.
pub const DEV_MODE_ENV: &str = "TERMINUS_DEV";

/// The credential store the kernel registers its writable providers against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SecretBackend {
    /// The OS keychain (macOS Keychain / libsecret / Windows credential
    /// manager). The only backend a packaged build may use.
    #[default]
    Keychain,
    /// 0600 files under `<kernel data dir>/secrets`. Development only.
    File,
}

impl SecretBackend {
    /// Label used in logs and error messages.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Keychain => "keychain",
            Self::File => "file",
        }
    }

    /// Read the selection from the process environment.
    ///
    /// # Errors
    /// Returns [`SecretError::Denied`] for an unknown value, and for `file`
    /// outside a development run.
    pub fn from_env() -> Result<Self, SecretError> {
        let raw = std::env::var(SECRETS_BACKEND_ENV).ok();
        let dev = std::env::var(DEV_MODE_ENV).is_ok_and(|value| value == "1");
        Self::parse(raw.as_deref(), dev)
    }

    /// Pure form of [`Self::from_env`] — the environment is read once by the
    /// caller so this stays deterministic and testable.
    ///
    /// # Errors
    /// Returns [`SecretError::Denied`] for an unknown value, and for `file`
    /// when `dev_mode` is false.
    pub fn parse(raw: Option<&str>, dev_mode: bool) -> Result<Self, SecretError> {
        let value = raw.unwrap_or("").trim();
        match value {
            "" | "keychain" => Ok(Self::Keychain),
            "file" => {
                if dev_mode {
                    Ok(Self::File)
                } else {
                    Err(SecretError::Denied(format!(
                        "{SECRETS_BACKEND_ENV}=file is a development-only backend and requires \
                         {DEV_MODE_ENV}=1; a packaged build must keep the OS keychain"
                    )))
                }
            }
            other => Err(SecretError::Denied(format!(
                "{SECRETS_BACKEND_ENV} must be `keychain` or `file`; got `{other}`"
            ))),
        }
    }
}

impl std::fmt::Display for SecretBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_is_the_default_selection() {
        assert_eq!(
            SecretBackend::parse(None, false).unwrap(),
            SecretBackend::Keychain
        );
        assert_eq!(
            SecretBackend::parse(Some(""), true).unwrap(),
            SecretBackend::Keychain
        );
        assert_eq!(
            SecretBackend::parse(Some("keychain"), false).unwrap(),
            SecretBackend::Keychain
        );
    }

    #[test]
    fn file_backend_requires_development_mode() {
        assert_eq!(
            SecretBackend::parse(Some("file"), true).unwrap(),
            SecretBackend::File
        );
        let error = SecretBackend::parse(Some("file"), false).unwrap_err();
        assert!(
            matches!(error, SecretError::Denied(ref message) if message.contains("TERMINUS_DEV=1")),
            "expected a development-mode refusal, got {error}"
        );
    }

    #[test]
    fn unknown_backend_is_refused() {
        let error = SecretBackend::parse(Some("vault"), true).unwrap_err();
        assert!(
            matches!(error, SecretError::Denied(ref message) if message.contains("`vault`")),
            "expected an unknown-backend refusal, got {error}"
        );
        // A misspelling is never silently downgraded to the default.
        assert!(SecretBackend::parse(Some("keychainx"), true).is_err());
    }
}
