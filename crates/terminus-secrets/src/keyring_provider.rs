use std::sync::Arc;

use crate::namespace::{
    unix_time, validate_credential_bytes, SecretNamespace, CREDENTIAL_LEASE_SECS,
};
use crate::{SecretError, SecretHandle, SecretMetadata, SecretProvider, WritableSecretProvider};

#[derive(Debug, Clone)]
pub struct KeyringSecretProvider {
    service: Arc<str>,
    namespace: SecretNamespace,
}

impl KeyringSecretProvider {
    #[must_use]
    pub fn new() -> Self {
        Self::for_namespace(SecretNamespace::Gateway)
    }

    /// Provider for connected provider accounts
    /// (`secret://provider-account/<uuid-v7>`).
    #[must_use]
    pub fn for_provider_accounts() -> Self {
        Self::for_namespace(SecretNamespace::ProviderAccount)
    }

    #[must_use]
    pub fn for_namespace(namespace: SecretNamespace) -> Self {
        Self {
            service: Arc::from(namespace.service()),
            namespace,
        }
    }

    /// Keyring account name for a capability URI this provider admits.
    fn account_for(&self, uri: &str) -> Result<String, SecretError> {
        self.namespace.account_for(uri)
    }
}

impl Default for KeyringSecretProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretProvider for KeyringSecretProvider {
    fn resolve(&self, uri: &str) -> Result<SecretHandle, SecretError> {
        let account = self.account_for(uri)?;
        let value = self
            .entry(&account)?
            .get_password()
            .map_err(|error| map_keyring_lookup_error(error, uri))?
            .into_bytes();
        let now = unix_time()?;
        Ok(SecretHandle::from_value(
            SecretMetadata {
                uri: uri.to_string(),
                provider: self.namespace.provider_id().to_string(),
                scope: account,
                issued_at_unix: now,
                expires_at_unix: now.saturating_add(CREDENTIAL_LEASE_SECS),
                redaction_patterns: vec![format!("REDACTED:{uri}")],
                // Destinations are authorized by the connector grant's
                // `allowed_hosts` plus the L4 egress allowlist, not by this
                // advisory metadata field.
                allowed_destinations: self.namespace.destinations(),
            },
            value,
        ))
    }
}

impl WritableSecretProvider for KeyringSecretProvider {
    fn store(&self, uri: &str, value: &[u8]) -> Result<(), SecretError> {
        let account = self.account_for(uri)?;
        let password = validate_credential_bytes(value)?;
        self.entry(&account)?
            .set_password(password)
            .map_err(map_keyring_error)
    }

    fn delete(&self, uri: &str) -> Result<(), SecretError> {
        let account = self.account_for(uri)?;
        map_keyring_delete_result(self.entry(&account)?.delete_credential())
    }
}

impl KeyringSecretProvider {
    fn entry(&self, account: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, account).map_err(map_keyring_error)
    }
}

fn map_keyring_error(error: keyring::Error) -> SecretError {
    SecretError::ProviderUnavailable(error.to_string())
}

fn map_keyring_delete_result(result: Result<(), keyring::Error>) -> Result<(), SecretError> {
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(map_keyring_error(error)),
    }
}

fn map_keyring_lookup_error(error: keyring::Error, uri: &str) -> SecretError {
    match error {
        keyring::Error::NoEntry => SecretError::UnknownCapability(uri.to_string()),
        error => map_keyring_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const UUID_V7: &str = "0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b";
    const PROVIDER_ACCOUNT_PREFIX: &str = "secret://provider-account/";

    #[test]
    fn namespaces_use_distinct_keyring_service_and_account_names() {
        let gateway = KeyringSecretProvider::new();
        let accounts = KeyringSecretProvider::for_provider_accounts();
        assert_ne!(gateway.service.as_ref(), accounts.service.as_ref());
        let uri = format!("{PROVIDER_ACCOUNT_PREFIX}{UUID_V7}");
        assert_eq!(
            accounts.account_for(&uri).unwrap(),
            format!("account.{UUID_V7}")
        );
        assert_eq!(gateway.account_for("secret://opencode/zen").unwrap(), "zen");
        // Neither provider admits the other's namespace.
        assert!(gateway.account_for(&uri).is_err());
        assert!(accounts.account_for("secret://opencode/zen").is_err());
    }

    #[test]
    fn delete_treats_absence_as_success_but_preserves_backend_failures() {
        assert!(map_keyring_delete_result(Err(keyring::Error::NoEntry)).is_ok());
        let backend_error = keyring::Error::PlatformFailure(Box::new(std::io::Error::other(
            "keychain unavailable",
        )));
        assert!(matches!(
            map_keyring_delete_result(Err(backend_error)),
            Err(SecretError::ProviderUnavailable(_))
        ));
    }

    #[test]
    #[ignore = "writes a generated credential to an isolated OS keychain service"]
    fn os_keychain_round_trip() {
        let nonce = unix_time().unwrap();
        let service = format!("dev.terminus.test.{}.{}", std::process::id(), nonce);
        let provider = KeyringSecretProvider {
            service: Arc::from(service.as_str()),
            namespace: SecretNamespace::Gateway,
        };
        struct Cleanup<'a>(&'a KeyringSecretProvider, &'a str);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.delete(self.1);
            }
        }
        let _cleanup = Cleanup(&provider, "secret://opencode/zen");
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

    #[test]
    #[ignore = "writes a generated credential to an isolated OS keychain service"]
    fn provider_account_round_trip() {
        let nonce = unix_time().unwrap();
        let service = format!(
            "dev.terminus.test.accounts.{}.{}",
            std::process::id(),
            nonce
        );
        let provider = KeyringSecretProvider {
            service: Arc::from(service.as_str()),
            namespace: SecretNamespace::ProviderAccount,
        };
        let uri = format!("{PROVIDER_ACCOUNT_PREFIX}{UUID_V7}");
        struct Cleanup<'a>(&'a KeyringSecretProvider, &'a str);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.delete(self.1);
            }
        }
        let _cleanup = Cleanup(&provider, uri.as_str());
        let value = hex::encode(Sha256::digest(service.as_bytes()));
        provider.store(&uri, value.as_bytes()).unwrap();
        let handle = provider.resolve(&uri).unwrap();
        assert_eq!(
            handle.digest(),
            hex::encode(Sha256::digest(value.as_bytes()))
        );
        provider.delete(&uri).unwrap();
        assert!(provider.resolve(&uri).is_err());
    }
}
