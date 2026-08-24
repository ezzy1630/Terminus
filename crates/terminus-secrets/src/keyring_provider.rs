use std::sync::Arc;

use crate::{SecretError, SecretHandle, SecretMetadata, SecretProvider, WritableSecretProvider};

const SERVICE: &str = "dev.terminus.provider-credentials";
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub struct KeyringSecretProvider {
    service: Arc<str>,
}

impl KeyringSecretProvider {
    pub fn new() -> Self {
        Self {
            service: Arc::from(SERVICE),
        }
    }
}

impl Default for KeyringSecretProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretProvider for KeyringSecretProvider {
    fn resolve(&self, uri: &str) -> Result<SecretHandle, SecretError> {
        let account = opencode_account(uri)?;
        let value = self
            .entry(account)?
            .get_password()
            .map_err(map_keyring_error)?
            .into_bytes();
        let now = unix_time()?;
        Ok(SecretHandle::from_value(
            SecretMetadata {
                uri: uri.to_string(),
                provider: "opencode".to_string(),
                scope: account.to_string(),
                issued_at_unix: now,
                expires_at_unix: now.saturating_add(300),
                redaction_patterns: vec![format!("REDACTED:{uri}")],
                allowed_destinations: vec!["opencode.ai:443".to_string()],
            },
            value,
        ))
    }
}

impl WritableSecretProvider for KeyringSecretProvider {
    fn store(&self, uri: &str, value: &[u8]) -> Result<(), SecretError> {
        let account = opencode_account(uri)?;
        if value.is_empty() || value.len() > MAX_CREDENTIAL_BYTES {
            return Err(SecretError::Denied(format!(
                "credential must contain 1..={MAX_CREDENTIAL_BYTES} bytes"
            )));
        }
        let password = std::str::from_utf8(value)
            .map_err(|_| SecretError::Denied("credential must be valid UTF-8".to_string()))?;
        if password.chars().any(char::is_whitespace) {
            return Err(SecretError::Denied(
                "credential must not contain whitespace".to_string(),
            ));
        }
        self.entry(account)?
            .set_password(password)
            .map_err(map_keyring_error)
    }

    fn delete(&self, uri: &str) -> Result<(), SecretError> {
        let account = opencode_account(uri)?;
        self.entry(account)?
            .delete_credential()
            .map_err(map_keyring_error)
    }
}

impl KeyringSecretProvider {
    fn entry(&self, account: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, account).map_err(map_keyring_error)
    }
}

fn opencode_account(uri: &str) -> Result<&str, SecretError> {
    match uri {
        "secret://opencode/zen" => Ok("zen"),
        "secret://opencode/go" => Ok("go"),
        _ => Err(SecretError::Denied(format!(
            "keyring provider does not admit {uri}"
        ))),
    }
}

fn map_keyring_error(error: keyring::Error) -> SecretError {
    SecretError::ProviderUnavailable(error.to_string())
}

fn unix_time() -> Result<u64, SecretError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| SecretError::ProviderUnavailable(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn only_exact_opencode_accounts_are_admitted() {
        assert_eq!(opencode_account("secret://opencode/zen").unwrap(), "zen");
        assert_eq!(opencode_account("secret://opencode/go").unwrap(), "go");
        assert!(opencode_account("secret://opencode/other").is_err());
        assert!(opencode_account("secret://other/zen").is_err());
    }

    #[test]
    #[ignore = "writes a generated credential to an isolated OS keychain service"]
    fn os_keychain_round_trip() {
        let nonce = unix_time().unwrap();
        let service = format!("dev.terminus.test.{}.{}", std::process::id(), nonce);
        let provider = KeyringSecretProvider {
            service: Arc::from(service.as_str()),
        };
        struct Cleanup<'a>(&'a KeyringSecretProvider);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.delete("secret://opencode/zen");
            }
        }
        let _cleanup = Cleanup(&provider);
        let value = hex::encode(Sha256::digest(service.as_bytes()));
        provider
            .store("secret://opencode/zen", value.as_bytes())
            .unwrap();
        let handle = provider.resolve("secret://opencode/zen").unwrap();
        assert_eq!(
            handle.digest(),
            hex::encode(Sha256::digest(value.as_bytes()))
        );
        assert!(!format!("{handle:?}").contains(&value));
    }
}
