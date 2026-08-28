use std::sync::Arc;

use crate::{SecretError, SecretHandle, SecretMetadata, SecretProvider, WritableSecretProvider};

const SERVICE: &str = "dev.terminus.provider-credentials";
/// Distinct keyring service for connected provider accounts. A separate
/// service (not just a separate account name) guarantees the two namespaces
/// can never resolve to the same OS keychain entry.
const PROVIDER_ACCOUNT_SERVICE: &str = "dev.terminus.provider-accounts";
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;

/// Which capability-URI namespace a provider instance admits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyringNamespace {
    /// The original two gateway plans. Kept for the migration window; no new
    /// URIs are minted in this namespace.
    Gateway,
    /// One entry per connected provider account, keyed by a UUIDv7 id:
    /// `secret://provider-account/<uuid-v7>`.
    ProviderAccount,
}

impl KeyringNamespace {
    fn service(self) -> &'static str {
        match self {
            Self::Gateway => SERVICE,
            Self::ProviderAccount => PROVIDER_ACCOUNT_SERVICE,
        }
    }

    fn provider_id(self) -> &'static str {
        match self {
            // Historical provider label; the URI scheme is unchanged.
            Self::Gateway => "opencode",
            Self::ProviderAccount => "provider-account",
        }
    }
}

#[derive(Debug, Clone)]
pub struct KeyringSecretProvider {
    service: Arc<str>,
    namespace: KeyringNamespace,
}

impl KeyringSecretProvider {
    pub fn new() -> Self {
        Self::for_namespace(KeyringNamespace::Gateway)
    }

    /// Provider for connected provider accounts
    /// (`secret://provider-account/<uuid-v7>`).
    pub fn for_provider_accounts() -> Self {
        Self::for_namespace(KeyringNamespace::ProviderAccount)
    }

    pub fn for_namespace(namespace: KeyringNamespace) -> Self {
        Self {
            service: Arc::from(namespace.service()),
            namespace,
        }
    }

    /// Keyring account name for a capability URI this provider admits.
    fn account_for(&self, uri: &str) -> Result<String, SecretError> {
        match self.namespace {
            KeyringNamespace::Gateway => gateway_account(uri).map(ToString::to_string),
            KeyringNamespace::ProviderAccount => provider_account_id(uri)
                // Prefixed so an account name can never be mistaken for a
                // gateway scope even if the services were ever merged.
                .map(|id| format!("account.{id}")),
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
        let account = self.account_for(uri)?;
        let value = self
            .entry(&account)?
            .get_password()
            .map_err(map_keyring_error)?
            .into_bytes();
        let now = unix_time()?;
        Ok(SecretHandle::from_value(
            SecretMetadata {
                uri: uri.to_string(),
                provider: self.namespace.provider_id().to_string(),
                scope: account,
                issued_at_unix: now,
                expires_at_unix: now.saturating_add(300),
                redaction_patterns: vec![format!("REDACTED:{uri}")],
                // Destinations are authorized by the connector grant's
                // `allowed_hosts` plus the L4 egress allowlist, not by this
                // advisory metadata field.
                allowed_destinations: gateway_destinations(self.namespace),
            },
            value,
        ))
    }
}

impl WritableSecretProvider for KeyringSecretProvider {
    fn store(&self, uri: &str, value: &[u8]) -> Result<(), SecretError> {
        let account = self.account_for(uri)?;
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
        self.entry(&account)?
            .set_password(password)
            .map_err(map_keyring_error)
    }

    fn delete(&self, uri: &str) -> Result<(), SecretError> {
        let account = self.account_for(uri)?;
        self.entry(&account)?
            .delete_credential()
            .map_err(map_keyring_error)
    }
}

impl KeyringSecretProvider {
    fn entry(&self, account: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, account).map_err(map_keyring_error)
    }
}

fn gateway_destinations(namespace: KeyringNamespace) -> Vec<String> {
    match namespace {
        KeyringNamespace::Gateway => vec![format!("{GATEWAY_HOST}:443")],
        KeyringNamespace::ProviderAccount => Vec::new(),
    }
}

/// Host of the legacy gateway namespace. Kept as a Rust constant so no
/// shipped JS/TS artifact carries the string.
const GATEWAY_HOST: &str = "opencode.ai";

fn gateway_account(uri: &str) -> Result<&str, SecretError> {
    match uri {
        "secret://opencode/zen" => Ok("zen"),
        "secret://opencode/go" => Ok("go"),
        _ => Err(SecretError::Denied(format!(
            "keyring provider does not admit {uri}"
        ))),
    }
}

/// Capability-URI prefix for connected provider accounts.
const PROVIDER_ACCOUNT_PREFIX: &str = "secret://provider-account/";

/// Extract and validate the UUIDv7 account id from a provider-account URI.
/// Rejecting anything that is not a well-formed v7 UUID keeps the namespace
/// a flat, unguessable keyspace with no path traversal or scope smuggling.
fn provider_account_id(uri: &str) -> Result<&str, SecretError> {
    let id = uri
        .strip_prefix(PROVIDER_ACCOUNT_PREFIX)
        .ok_or_else(|| SecretError::Denied(format!("keyring provider does not admit {uri}")))?;
    if !is_uuid_v7(id) {
        return Err(SecretError::Denied(format!(
            "provider-account capability id must be a UUIDv7; got `{id}`"
        )));
    }
    Ok(id)
}

/// `8-4-4-4-12` lowercase hex with version nibble `7` and an RFC 4122
/// variant. Ids are minted by `terminus_kernel_protocol::new_id`.
fn is_uuid_v7(id: &str) -> bool {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let mut parts = id.split('-');
    let mut collected = Vec::with_capacity(5);
    for expected in GROUPS {
        let Some(part) = parts.next() else {
            return false;
        };
        if part.len() != expected || !part.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        collected.push(part);
    }
    if parts.next().is_some() {
        return false;
    }
    if id.bytes().any(|b| b.is_ascii_uppercase()) {
        return false;
    }
    let version = collected[2].as_bytes().first().copied();
    let variant = collected[3].as_bytes().first().copied();
    version == Some(b'7') && matches!(variant, Some(b'8' | b'9' | b'a' | b'b'))
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

    const UUID_V7: &str = "0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b";

    #[test]
    fn only_exact_gateway_accounts_are_admitted() {
        assert_eq!(gateway_account("secret://opencode/zen").unwrap(), "zen");
        assert_eq!(gateway_account("secret://opencode/go").unwrap(), "go");
        assert!(gateway_account("secret://opencode/other").is_err());
        assert!(gateway_account("secret://other/zen").is_err());
    }

    #[test]
    fn provider_account_namespace_admits_only_uuid_v7() {
        let uri = format!("{PROVIDER_ACCOUNT_PREFIX}{UUID_V7}");
        assert_eq!(provider_account_id(&uri).unwrap(), UUID_V7);

        // Non-UUID scopes are denied.
        for denied in [
            "secret://provider-account/zen",
            "secret://provider-account/",
            "secret://provider-account/../opencode/zen",
            "secret://provider-account/0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7",
            "secret://provider-account/0192f3a14b2c7def8a1b2c3d4e5f6a7b",
            // v4 UUIDs are not minted by the kernel id generator.
            "secret://provider-account/9f6b2f1e-2a1c-4d3e-8a1b-2c3d4e5f6a7b",
            // Uppercase is not the canonical form.
            "secret://provider-account/0192F3A1-4B2C-7DEF-8A1B-2C3D4E5F6A7B",
        ] {
            assert!(
                provider_account_id(denied).is_err(),
                "expected {denied} to be denied"
            );
        }

        // The two namespaces never admit each other's URIs.
        assert!(provider_account_id("secret://opencode/zen").is_err());
        let gateway = KeyringSecretProvider::new();
        assert!(gateway.account_for(&uri).is_err());
        let accounts = KeyringSecretProvider::for_provider_accounts();
        assert!(accounts.account_for("secret://opencode/zen").is_err());
    }

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
    }

    #[test]
    #[ignore = "writes a generated credential to an isolated OS keychain service"]
    fn os_keychain_round_trip() {
        let nonce = unix_time().unwrap();
        let service = format!("dev.terminus.test.{}.{}", std::process::id(), nonce);
        let provider = KeyringSecretProvider {
            service: Arc::from(service.as_str()),
            namespace: KeyringNamespace::Gateway,
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
            namespace: KeyringNamespace::ProviderAccount,
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
