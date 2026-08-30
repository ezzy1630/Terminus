//! Local credential discovery and import (design §4, spec "Kernel contract").
//!
//! Proven here:
//! 1. the OpenCode entry union decodes by kind, admits only bounded account
//!    identity metadata, and drops entries that do not decode without losing
//!    the rest of the file;
//! 2. a store that is group/world readable, oversized, or malformed produces
//!    a warning and no credentials — the read fails closed;
//! 3. a Codex auth store is never opened or imported, even when present;
//! 4. absent stores are silent, not an error;
//! 5. `import_local` writes through the `provider-account` keyring namespace
//!    and refuses any other destination;
//! 6. both calls require a `Secret`-class capability.
//!
//! Every fixture credential in this file is obviously fake and is never a
//! real key. The stores are temp directories: no test reads the developer's
//! real auth stores, and nothing is written to the login keychain.

#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(test)]

use sha2::Digest;
use std::path::Path;
use tempfile::{tempdir, TempDir};
use terminus_authz::{OperationClass, Scope, TokenBinder};
use terminus_kernel::{
    KernelHandle, LocalAuthKind, LocalCredentialRoots, LocalCredentialStore, DISCOVER_LOCAL_SCOPE,
};
use terminus_kernel_protocol::RequestContext;

const ACCOUNT_URI: &str = "secret://provider-account/0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b";
const CEREBRAS_FIXTURE_KEY: &str = "fixture-not-a-real-key-cerebras";
const CLOUDFLARE_FIXTURE_KEY: &str = "fixture-not-a-real-key-cloudflare";

// ---------- harness ----------

struct Fixture {
    _data_dir: TempDir,
    _stores: TempDir,
    kernel: KernelHandle,
    opencode_store: std::path::PathBuf,
}

/// A kernel whose credential stores are temp directories and whose `PATH`
/// probe sees an empty directory, so the developer's real `codex`/`opencode`
/// installs never change a test outcome.
fn fixture() -> Fixture {
    let data_dir = tempdir().unwrap();
    let stores = tempdir().unwrap();
    let opencode_dir = stores.path().join("opencode-data");
    let empty_path = stores.path().join("empty-bin");
    for dir in [&opencode_dir, &empty_path] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let kernel = KernelHandle::new(data_dir.path().to_path_buf())
        .unwrap()
        .with_local_credential_roots(
            LocalCredentialRoots::empty()
                .with_opencode_dir(&opencode_dir)
                .with_path_override(empty_path.as_os_str()),
        );
    Fixture {
        _data_dir: data_dir,
        _stores: stores,
        kernel,
        opencode_store: opencode_dir.join("auth.json"),
    }
}

fn binder() -> TokenBinder {
    TokenBinder {
        principal: "account-principal".to_string(),
        session_id: "account-session".to_string(),
        task_id: "account-task".to_string(),
        workspace_id: "account-ws".to_string(),
        kernel_instance_id: String::new(),
    }
}

fn ctx(token: &str) -> RequestContext {
    let mut ctx = RequestContext::new("provider-account-request");
    ctx.capability_token = token.to_string();
    ctx.idempotency_key = "provider-account-idempotency".to_string();
    ctx.task_id = "account-task".to_string();
    ctx.actor_id = "account-principal".to_string();
    ctx.session_id = "account-session".to_string();
    ctx.workspace_id = "account-ws".to_string();
    ctx
}

/// Mint a capability with the given operation classes scoped to one secret
/// URI. Mirrors `provider_account_connectors.rs`.
fn token_for(kernel: &KernelHandle, classes: Vec<OperationClass>, uri: &str) -> String {
    kernel
        .token_issuer
        .mint(
            binder(),
            classes,
            Scope {
                workspace_paths: Vec::new(),
                network_destinations: Vec::new(),
                secret_capabilities: vec![uri.to_string()],
            },
            None,
            "provider-account-discovery".to_string(),
        )
        .unwrap()
        .encode()
        .unwrap()
}

fn discover_token(kernel: &KernelHandle) -> String {
    token_for(kernel, vec![OperationClass::Secret], DISCOVER_LOCAL_SCOPE)
}

fn write_store(path: &Path, contents: &str) {
    std::fs::write(path, contents).unwrap();
    set_owner_only(path);
}

fn set_owner_only(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn fingerprint_of(secret: &str) -> String {
    hex::encode(sha2::Sha256::digest(secret.as_bytes()))
}

// ---------- OpenCode auth store ----------

#[test]
fn opencode_entries_decode_by_kind_and_allowlist_account_metadata() {
    let fixture = fixture();
    write_store(
        &fixture.opencode_store,
        &serde_json::json!({
            "cerebras": {
                "type": "api",
                "key": CEREBRAS_FIXTURE_KEY,
                "metadata": { "accountId": "0123456789abcdef0123456789abcdef" }
            },
            "cloudflare-workers-ai": {
                "type": "api",
                "key": CLOUDFLARE_FIXTURE_KEY,
                "metadata": {
                    "accountId": "0123456789abcdef0123456789abcdef",
                    "accessToken": "must-never-cross-the-kernel-boundary",
                    "arbitrary": { "nested": true }
                }
            },
            "fixture-wellknown": {
                "type": "wellknown",
                "key": "fixture-wellknown-name",
                "token": "fixture-not-a-real-wellknown-token"
            },
            "fixture-oauth": {
                "type": "oauth",
                "refresh": "fixture-not-a-real-refresh-token",
                "access": "fixture-not-a-real-access-token",
                "expires": 1_893_456_000_000_u64
            }
        })
        .to_string(),
    );

    let discovery = fixture
        .kernel
        .provider_accounts
        .discover_local(&ctx(&discover_token(&fixture.kernel)))
        .expect("discovery succeeds");

    assert!(
        discovery.warnings.is_empty(),
        "an owner-only well-formed store produces no warnings: {:?}",
        discovery.warnings
    );
    let sources: Vec<&str> = discovery
        .credentials
        .iter()
        .map(|c| c.source.as_str())
        .collect();
    assert_eq!(
        sources,
        vec![
            "opencode:cerebras",
            "opencode:cloudflare-workers-ai",
            "opencode:fixture-oauth",
            "opencode:fixture-wellknown",
        ],
        "sources are colon-form and deterministically ordered"
    );

    let cerebras = &discovery.credentials[0];
    assert_eq!(cerebras.auth_kind, LocalAuthKind::Api);
    assert_eq!(cerebras.store, LocalCredentialStore::OpencodeAuthStore);
    assert_eq!(cerebras.expires_at_unix, 0);
    assert_eq!(cerebras.fingerprint, fingerprint_of(CEREBRAS_FIXTURE_KEY));
    assert_eq!(cerebras.fingerprint.len(), 64);
    assert_eq!(cerebras.metadata.to_json(), "{}");

    let cloudflare = &discovery.credentials[1];
    assert_eq!(
        cloudflare.metadata.account_id.as_deref(),
        Some("0123456789abcdef0123456789abcdef"),
        "only the named account id is admitted"
    );
    assert_eq!(
        cloudflare.metadata.to_json(),
        r#"{"account_id":"0123456789abcdef0123456789abcdef"}"#,
        "arbitrary and token-shaped plugin metadata is dropped"
    );
    assert_eq!(
        cloudflare.fingerprint,
        fingerprint_of(CLOUDFLARE_FIXTURE_KEY)
    );
    assert_ne!(cloudflare.fingerprint, cerebras.fingerprint);

    let oauth = &discovery.credentials[2];
    assert_eq!(oauth.auth_kind, LocalAuthKind::Oauth);
    assert_eq!(
        oauth.expires_at_unix, 1_893_456_000,
        "oauth expiry is milliseconds in the store and seconds on the wire"
    );

    let wellknown = &discovery.credentials[3];
    assert_eq!(wellknown.auth_kind, LocalAuthKind::Wellknown);
    assert_eq!(
        wellknown.fingerprint,
        fingerprint_of("fixture-not-a-real-wellknown-token"),
        "a wellknown entry's credential is its token, not its key"
    );
}

#[test]
fn account_metadata_is_provider_bound_and_rejects_token_shaped_values() {
    let fixture = fixture();
    write_store(
        &fixture.opencode_store,
        &serde_json::json!({
            "cloudflare-workers-ai": {
                "type": "api",
                "key": CLOUDFLARE_FIXTURE_KEY,
                "metadata": { "accountId": "eyJhbGciOiJIUzI1NiJ9.payload.signature" }
            },
            "cerebras": {
                "type": "api",
                "key": CEREBRAS_FIXTURE_KEY,
                "metadata": { "accountId": "0123456789abcdef0123456789abcdef" }
            }
        })
        .to_string(),
    );

    let discovery = fixture
        .kernel
        .provider_accounts
        .discover_local(&ctx(&discover_token(&fixture.kernel)))
        .expect("discovery succeeds");

    assert_eq!(discovery.credentials.len(), 2);
    assert_eq!(discovery.credentials[0].metadata.to_json(), "{}");
    assert_eq!(discovery.credentials[1].metadata.to_json(), "{}");
}

#[test]
fn undecodable_opencode_entries_are_dropped_and_the_rest_survive() {
    let fixture = fixture();
    write_store(
        &fixture.opencode_store,
        &serde_json::json!({
            "cerebras": { "type": "api", "key": CEREBRAS_FIXTURE_KEY },
            "missing-key": { "type": "api" },
            "wrong-type": { "type": "totally-unknown", "key": "fixture" },
            "oauth-without-expiry": {
                "type": "oauth",
                "refresh": "fixture-refresh",
                "access": "fixture-access"
            },
            "not-an-object": 42,
            "../../escape": { "type": "api", "key": "fixture" }
        })
        .to_string(),
    );

    let discovery = fixture
        .kernel
        .provider_accounts
        .discover_local(&ctx(&discover_token(&fixture.kernel)))
        .expect("discovery succeeds");

    let sources: Vec<&str> = discovery
        .credentials
        .iter()
        .map(|c| c.source.as_str())
        .collect();
    assert_eq!(
        sources,
        vec!["opencode:cerebras"],
        "every undecodable entry is dropped and the decodable one is kept"
    );
    assert!(
        discovery.warnings.is_empty(),
        "dropping an entry is not a store-level warning: {:?}",
        discovery.warnings
    );
}

#[test]
#[cfg(unix)]
fn a_group_readable_store_is_skipped_with_a_warning() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = fixture();
    std::fs::write(
        &fixture.opencode_store,
        serde_json::json!({ "cerebras": { "type": "api", "key": CEREBRAS_FIXTURE_KEY } })
            .to_string(),
    )
    .unwrap();
    std::fs::set_permissions(
        &fixture.opencode_store,
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();

    let discovery = fixture
        .kernel
        .provider_accounts
        .discover_local(&ctx(&discover_token(&fixture.kernel)))
        .expect("discovery succeeds");

    assert!(
        discovery.credentials.is_empty(),
        "a permissive store yields no credentials"
    );
    assert_eq!(discovery.warnings.len(), 1);
    let warning = &discovery.warnings[0];
    assert!(
        warning.starts_with("opencode-auth-store: "),
        "warnings are labelled by store: {warning}"
    );
    assert!(warning.contains("0644"), "unexpected warning: {warning}");
    assert!(
        !warning.contains(fixture.opencode_store.to_string_lossy().as_ref()),
        "a warning must never carry the store path: {warning}"
    );
}

#[test]
fn an_oversized_store_is_refused_with_a_warning() {
    let fixture = fixture();
    let padding = "p".repeat(70 * 1_024);
    write_store(
        &fixture.opencode_store,
        &serde_json::json!({
            "cerebras": { "type": "api", "key": CEREBRAS_FIXTURE_KEY, "note": padding }
        })
        .to_string(),
    );

    let discovery = fixture
        .kernel
        .provider_accounts
        .discover_local(&ctx(&discover_token(&fixture.kernel)))
        .expect("discovery succeeds");

    assert!(discovery.credentials.is_empty());
    assert_eq!(discovery.warnings.len(), 1);
    assert!(
        discovery.warnings[0].contains("64 KiB"),
        "unexpected warning: {}",
        discovery.warnings[0]
    );
}

#[test]
fn a_malformed_store_is_refused_without_echoing_its_contents() {
    let fixture = fixture();
    write_store(&fixture.opencode_store, "{ this is not json ");

    let discovery = fixture
        .kernel
        .provider_accounts
        .discover_local(&ctx(&discover_token(&fixture.kernel)))
        .expect("discovery succeeds");

    assert!(discovery.credentials.is_empty());
    assert_eq!(
        discovery.warnings,
        vec!["opencode-auth-store: contains malformed JSON".to_string()]
    );
    assert_eq!(discovery.opencode_store_status.as_str(), "rejected");
}

#[test]
fn a_valid_json_array_is_rejected_as_a_structurally_invalid_store() {
    let fixture = fixture();
    write_store(&fixture.opencode_store, "[]");

    let discovery = fixture
        .kernel
        .provider_accounts
        .discover_local(&ctx(&discover_token(&fixture.kernel)))
        .expect("discovery succeeds");

    assert!(discovery.credentials.is_empty());
    assert_eq!(discovery.opencode_store_status.as_str(), "rejected");
    assert_eq!(
        discovery.warnings,
        vec!["opencode-auth-store: root must be a JSON object".to_string()]
    );
}

// ---------- Codex auth store ----------

#[test]
fn a_codex_auth_store_is_never_opened_or_imported() {
    let fixture = fixture();
    let codex_store = fixture._stores.path().join("codex-home/auth.json");
    std::fs::create_dir_all(codex_store.parent().unwrap()).unwrap();
    write_store(
        &codex_store,
        r#"{"auth_mode":"chatgpt","tokens":{"access_token":"fixture-token"}}"#,
    );

    let discovery = fixture
        .kernel
        .provider_accounts
        .discover_local(&ctx(&discover_token(&fixture.kernel)))
        .expect("discovery succeeds");

    assert!(discovery.credentials.is_empty());
    assert!(discovery.warnings.is_empty());
}

#[test]
fn importing_the_codex_source_is_rejected_before_any_store_read_or_write() {
    let fixture = fixture();
    let broker = stub_provider_account_keyring(&fixture.kernel);
    let token = token_for(&fixture.kernel, vec![OperationClass::Secret], ACCOUNT_URI);
    let denied = fixture
        .kernel
        .provider_accounts
        .import_local(&ctx(&token), "codex-chatgpt", ACCOUNT_URI, &"0".repeat(64))
        .expect_err("Codex subscription credentials are not a Terminus provider source");
    assert_eq!(denied.code_name(), "INVALID_REQUEST");
    assert!(broker.request(ACCOUNT_URI, "codex-import-test").is_err());
}

// ---------- absent stores ----------

#[test]
fn missing_stores_produce_an_empty_discovery_without_warnings() {
    let fixture = fixture();
    let discovery = fixture
        .kernel
        .provider_accounts
        .discover_local(&ctx(&discover_token(&fixture.kernel)))
        .expect("discovery succeeds");

    assert!(discovery.credentials.is_empty());
    assert!(
        discovery.warnings.is_empty(),
        "an absent store is not a warning: {:?}",
        discovery.warnings
    );
    assert!(!discovery.codex_installed);
    assert!(!discovery.opencode_installed);
}

#[test]
fn opencode_standard_user_install_is_detected_outside_path() {
    let fixture = fixture();
    let home = tempfile::tempdir().expect("temporary home");
    let bin = home.path().join(".opencode/bin");
    std::fs::create_dir_all(&bin).expect("create OpenCode bin directory");
    let executable = bin.join("opencode");
    std::fs::write(&executable, b"#!/bin/sh\n").expect("write OpenCode executable");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
            .expect("mark OpenCode executable");
    }
    let service = fixture.kernel.provider_accounts.clone().with_roots(
        LocalCredentialRoots::empty()
            .with_home_dir(home.path())
            .with_path_override(""),
    );

    let discovery = service
        .discover_local(&ctx(&discover_token(&fixture.kernel)))
        .expect("discovery succeeds");

    assert!(discovery.opencode_installed);
}

// ---------- import ----------

/// Swap the OS keychain for an in-memory store under the SAME
/// `provider-account` namespace. Writing fixture credentials into the
/// developer's login keychain is not what these tests exercise.
fn stub_provider_account_keyring(
    kernel: &KernelHandle,
) -> std::sync::Arc<terminus_secrets::SecretBroker> {
    let provider = std::sync::Arc::new(terminus_secrets::InMemoryProvider::new());
    kernel
        .secrets
        .broker()
        .register_writable_provider("provider-account", provider);
    std::sync::Arc::clone(kernel.secrets.broker())
}

#[test]
fn import_local_moves_the_credential_into_the_provider_account_namespace() {
    let fixture = fixture();
    let broker = stub_provider_account_keyring(&fixture.kernel);
    write_store(
        &fixture.opencode_store,
        &serde_json::json!({ "cerebras": { "type": "api", "key": CEREBRAS_FIXTURE_KEY } })
            .to_string(),
    );

    let token = token_for(&fixture.kernel, vec![OperationClass::Secret], ACCOUNT_URI);
    let imported = fixture
        .kernel
        .provider_accounts
        .import_local(
            &ctx(&token),
            "opencode:cerebras",
            ACCOUNT_URI,
            &fingerprint_of(CEREBRAS_FIXTURE_KEY),
        )
        .expect("import succeeds");

    assert!(imported.stored);
    assert_eq!(imported.capability_uri, ACCOUNT_URI);
    assert_eq!(imported.credential.source, "opencode:cerebras");
    assert_eq!(
        imported.credential.fingerprint,
        fingerprint_of(CEREBRAS_FIXTURE_KEY)
    );

    let handle = broker
        .request(ACCOUNT_URI, "provider-account-test")
        .expect("the credential is resolvable under the account URI");
    // `SecretHandle` never exposes its bytes; the digest proves the exact
    // fixture landed in the namespace.
    assert_eq!(
        handle.digest(),
        hex::encode(sha2::Sha256::digest(CEREBRAS_FIXTURE_KEY.as_bytes())),
        "the credential is stored byte-for-byte"
    );
    assert_eq!(handle.metadata.uri, ACCOUNT_URI);
}

#[test]
fn import_local_refuses_a_credential_rotated_after_approval() {
    let fixture = fixture();
    let broker = stub_provider_account_keyring(&fixture.kernel);
    write_store(
        &fixture.opencode_store,
        &serde_json::json!({ "cerebras": { "type": "api", "key": CEREBRAS_FIXTURE_KEY } })
            .to_string(),
    );

    let token = token_for(&fixture.kernel, vec![OperationClass::Secret], ACCOUNT_URI);
    let denied = fixture
        .kernel
        .provider_accounts
        .import_local(
            &ctx(&token),
            "opencode:cerebras",
            ACCOUNT_URI,
            &fingerprint_of("the-key-the-user-approved-before-rotation"),
        )
        .expect_err("rotated bytes must not inherit stale consent");

    assert_eq!(denied.code_name(), "TRANSACTION_CONFLICT");
    assert!(broker.request(ACCOUNT_URI, "rotated-import-test").is_err());
}

#[test]
fn import_local_refuses_an_abbreviated_approval_digest() {
    let fixture = fixture();
    let broker = stub_provider_account_keyring(&fixture.kernel);
    write_store(
        &fixture.opencode_store,
        &serde_json::json!({ "cerebras": { "type": "api", "key": CEREBRAS_FIXTURE_KEY } })
            .to_string(),
    );

    let token = token_for(&fixture.kernel, vec![OperationClass::Secret], ACCOUNT_URI);
    let denied = fixture
        .kernel
        .provider_accounts
        .import_local(
            &ctx(&token),
            "opencode:cerebras",
            ACCOUNT_URI,
            "0123456789ab",
        )
        .expect_err("a display-length digest cannot authorize an import");

    assert_eq!(denied.code_name(), "INVALID_REQUEST");
    assert!(broker.request(ACCOUNT_URI, "short-digest-test").is_err());
}

#[test]
fn import_local_reports_an_unknown_source() {
    let fixture = fixture();
    stub_provider_account_keyring(&fixture.kernel);
    let token = token_for(&fixture.kernel, vec![OperationClass::Secret], ACCOUNT_URI);
    let denied = fixture
        .kernel
        .provider_accounts
        .import_local(
            &ctx(&token),
            "opencode:absent",
            ACCOUNT_URI,
            &"0".repeat(64),
        )
        .expect_err("an unknown source cannot be imported");
    assert_eq!(
        denied.code_name(),
        "NOT_FOUND",
        "unexpected error: {denied}"
    );
}

#[test]
fn import_local_refuses_a_non_uuid_v7_or_foreign_namespace_uri() {
    let fixture = fixture();
    stub_provider_account_keyring(&fixture.kernel);
    write_store(
        &fixture.opencode_store,
        &serde_json::json!({ "cerebras": { "type": "api", "key": CEREBRAS_FIXTURE_KEY } })
            .to_string(),
    );

    for uri in [
        "secret://provider-account/not-a-uuid",
        // A v4 UUID: right shape, wrong version nibble.
        "secret://provider-account/0192f3a1-4b2c-4def-8a1b-2c3d4e5f6a7b",
        // The legacy gateway namespace: refused even though the presented
        // capability is scoped to it and the broker would accept the write.
        "secret://opencode/zen",
    ] {
        let token = token_for(&fixture.kernel, vec![OperationClass::Secret], uri);
        let denied = fixture
            .kernel
            .provider_accounts
            .import_local(
                &ctx(&token),
                "opencode:cerebras",
                uri,
                &fingerprint_of(CEREBRAS_FIXTURE_KEY),
            )
            .expect_err("only secret://provider-account/<uuid-v7> is admitted");
        assert_eq!(
            denied.code_name(),
            "INVALID_REQUEST",
            "unexpected error for {uri}: {denied}"
        );
    }
}

#[test]
fn import_local_requires_an_idempotency_key() {
    let fixture = fixture();
    stub_provider_account_keyring(&fixture.kernel);
    write_store(
        &fixture.opencode_store,
        &serde_json::json!({ "cerebras": { "type": "api", "key": CEREBRAS_FIXTURE_KEY } })
            .to_string(),
    );
    let token = token_for(&fixture.kernel, vec![OperationClass::Secret], ACCOUNT_URI);
    let mut request = ctx(&token);
    request.idempotency_key = String::new();
    let denied = fixture
        .kernel
        .provider_accounts
        .import_local(
            &request,
            "opencode:cerebras",
            ACCOUNT_URI,
            &fingerprint_of(CEREBRAS_FIXTURE_KEY),
        )
        .expect_err("a mutating import requires an idempotency key");
    assert_eq!(denied.code_name(), "INVALID_REQUEST");
}

// ---------- capability enforcement ----------

#[test]
fn discovery_and_import_require_a_secret_class_capability() {
    let fixture = fixture();
    stub_provider_account_keyring(&fixture.kernel);
    write_store(
        &fixture.opencode_store,
        &serde_json::json!({ "cerebras": { "type": "api", "key": CEREBRAS_FIXTURE_KEY } })
            .to_string(),
    );

    // A Network-class capability with the right scope is still refused.
    let network_only = token_for(
        &fixture.kernel,
        vec![OperationClass::Network],
        DISCOVER_LOCAL_SCOPE,
    );
    let denied = fixture
        .kernel
        .provider_accounts
        .discover_local(&ctx(&network_only))
        .expect_err("discovery requires OperationClass::Secret");
    assert_eq!(denied.code_name(), "PERMISSION_DENIED");

    let network_import = token_for(&fixture.kernel, vec![OperationClass::Network], ACCOUNT_URI);
    let denied = fixture
        .kernel
        .provider_accounts
        .import_local(
            &ctx(&network_import),
            "opencode:cerebras",
            ACCOUNT_URI,
            &fingerprint_of(CEREBRAS_FIXTURE_KEY),
        )
        .expect_err("import requires OperationClass::Secret");
    assert_eq!(denied.code_name(), "PERMISSION_DENIED");

    // A Secret capability scoped to a different URI cannot import this one.
    let wrong_scope = token_for(
        &fixture.kernel,
        vec![OperationClass::Secret],
        "secret://provider-account/0192f3a1-4b2c-7def-8a1b-000000000000",
    );
    let denied = fixture
        .kernel
        .provider_accounts
        .import_local(
            &ctx(&wrong_scope),
            "opencode:cerebras",
            ACCOUNT_URI,
            &fingerprint_of(CEREBRAS_FIXTURE_KEY),
        )
        .expect_err("the capability must be scoped to exactly the destination URI");
    assert_eq!(denied.code_name(), "PERMISSION_DENIED");

    // And an empty token is refused outright.
    let mut anonymous = ctx("");
    anonymous.capability_token = String::new();
    let denied = fixture
        .kernel
        .provider_accounts
        .discover_local(&anonymous)
        .expect_err("a caller with no capability token is refused");
    assert_eq!(denied.code_name(), "CAPABILITY_TOKEN_INVALID");
}
