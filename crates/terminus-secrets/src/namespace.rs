//! Capability-URI namespaces shared by every credential-store backend.
//!
//! The OS keyring provider and the development file provider MUST agree on
//! which URIs they admit and on the account name each URI maps to: a
//! credential imported under one backend has to be found under the other by
//! exactly the same name. Keeping the mapping in one module makes that a
//! compile-time fact rather than a convention.

use crate::error::SecretError;

/// Store namespace for the original two gateway plans.
pub(crate) const GATEWAY_SERVICE: &str = "dev.terminus.provider-credentials";
/// Distinct store namespace for connected provider accounts. A separate
/// namespace (not just a separate account name) guarantees the two can never
/// resolve to the same entry.
pub(crate) const PROVIDER_ACCOUNT_SERVICE: &str = "dev.terminus.provider-accounts";
/// Hard ceiling on one stored credential. Identical for every backend.
pub(crate) const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
/// Host of the legacy gateway namespace. Kept as a Rust constant so no
/// shipped JS/TS artifact carries the string.
pub(crate) const GATEWAY_HOST: &str = "opencode.ai";
/// Capability-URI prefix for connected provider accounts.
pub(crate) const PROVIDER_ACCOUNT_PREFIX: &str = "secret://provider-account/";

/// Which capability-URI namespace a credential-store provider admits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretNamespace {
    /// The original two gateway plans. Kept for the migration window; no new
    /// URIs are minted in this namespace.
    Gateway,
    /// One entry per connected provider account, keyed by a UUIDv7 id:
    /// `secret://provider-account/<uuid-v7>`.
    ProviderAccount,
}

impl SecretNamespace {
    /// Backend-facing namespace label: the OS keychain *service* for the
    /// keyring provider, the directory name for the file provider.
    #[must_use]
    pub const fn service(self) -> &'static str {
        match self {
            Self::Gateway => GATEWAY_SERVICE,
            Self::ProviderAccount => PROVIDER_ACCOUNT_SERVICE,
        }
    }

    /// The `provider` component of the `secret://provider/scope` URIs this
    /// namespace admits.
    #[must_use]
    pub const fn provider_id(self) -> &'static str {
        match self {
            // Historical provider label; the URI scheme is unchanged.
            Self::Gateway => "opencode",
            Self::ProviderAccount => "provider-account",
        }
    }

    /// Account (entry) name for a capability URI this namespace admits.
    /// Every backend stores under exactly this name.
    pub fn account_for(self, uri: &str) -> Result<String, SecretError> {
        match self {
            Self::Gateway => gateway_account(uri).map(ToString::to_string),
            Self::ProviderAccount => provider_account_id(uri)
                // Prefixed so an account name can never be mistaken for a
                // gateway scope even if the namespaces were ever merged.
                .map(|id| format!("account.{id}")),
        }
    }

    /// Advisory destination metadata. Destinations are authorized by the
    /// connector grant's `allowed_hosts` plus the L4 egress allowlist, not
    /// by this field.
    #[must_use]
    pub fn destinations(self) -> Vec<String> {
        match self {
            Self::Gateway => vec![format!("{GATEWAY_HOST}:443")],
            Self::ProviderAccount => Vec::new(),
        }
    }
}

pub(crate) fn gateway_account(uri: &str) -> Result<&str, SecretError> {
    match uri {
        "secret://opencode/zen" => Ok("zen"),
        "secret://opencode/go" => Ok("go"),
        _ => Err(SecretError::Denied(format!(
            "credential store does not admit {uri}"
        ))),
    }
}

/// Extract and validate the UUIDv7 account id from a provider-account URI.
/// Rejecting anything that is not a well-formed v7 UUID keeps the namespace
/// a flat, unguessable keyspace with no path traversal or scope smuggling.
pub(crate) fn provider_account_id(uri: &str) -> Result<&str, SecretError> {
    let id = uri
        .strip_prefix(PROVIDER_ACCOUNT_PREFIX)
        .ok_or_else(|| SecretError::Denied(format!("credential store does not admit {uri}")))?;
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

/// Shape rules every backend applies before a credential is written:
/// 1..=16 KiB of whitespace-free UTF-8. Returns the borrowed string so a
/// caller that needs `&str` does not re-decode.
///
/// The rejected value is NEVER included in the error.
pub(crate) fn validate_credential_bytes(value: &[u8]) -> Result<&str, SecretError> {
    if value.is_empty() || value.len() > MAX_CREDENTIAL_BYTES {
        return Err(SecretError::Denied(format!(
            "credential must contain 1..={MAX_CREDENTIAL_BYTES} bytes"
        )));
    }
    let text = std::str::from_utf8(value)
        .map_err(|_| SecretError::Denied("credential must be valid UTF-8".to_string()))?;
    if text.chars().any(char::is_whitespace) {
        return Err(SecretError::Denied(
            "credential must not contain whitespace".to_string(),
        ));
    }
    Ok(text)
}

/// Seconds a resolved credential's lease is advertised for. Both backends
/// use the same window so the broker's resolve cache behaves identically
/// whichever one is active.
pub(crate) const CREDENTIAL_LEASE_SECS: u64 = 300;

pub(crate) fn unix_time() -> Result<u64, SecretError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| SecretError::ProviderUnavailable(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(SecretNamespace::Gateway.account_for(&uri).is_err());
        assert!(SecretNamespace::ProviderAccount
            .account_for("secret://opencode/zen")
            .is_err());
    }

    #[test]
    fn namespaces_use_distinct_services_and_account_names() {
        assert_ne!(
            SecretNamespace::Gateway.service(),
            SecretNamespace::ProviderAccount.service()
        );
        let uri = format!("{PROVIDER_ACCOUNT_PREFIX}{UUID_V7}");
        assert_eq!(
            SecretNamespace::ProviderAccount.account_for(&uri).unwrap(),
            format!("account.{UUID_V7}")
        );
        assert_eq!(
            SecretNamespace::Gateway
                .account_for("secret://opencode/zen")
                .unwrap(),
            "zen"
        );
    }

    #[test]
    fn credential_shape_rules_reject_empty_oversize_and_whitespace() {
        assert_eq!(validate_credential_bytes(b"abc").unwrap(), "abc");
        assert!(validate_credential_bytes(b"").is_err());
        assert!(validate_credential_bytes(&vec![b'a'; MAX_CREDENTIAL_BYTES + 1]).is_err());
        assert!(validate_credential_bytes(b"has space").is_err());
        assert!(validate_credential_bytes(b"trailing\n").is_err());
        assert!(validate_credential_bytes(&[0xff, 0xfe]).is_err());
        // The rejected material never appears in the message.
        let error = validate_credential_bytes(b"secret value")
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret value"));
    }
}
