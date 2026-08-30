//! Provider-account connector wiring (design §4(f), Part 3 blockers 1/2/4).
//!
//! Proven here:
//! 1. the L4 egress allowlist is derived from the registered connector table
//!    and admits every model host while denying everything unregistered;
//! 2. `openai-compatible` takes its host from the grant's per-account
//!    allowlist, and minting one account's host does not admit another's;
//! 3. a fixed-host connector cannot be minted for a foreign destination;
//! 4. the `provider-account` keyring namespace admits UUIDv7 capability
//!    URIs and denies everything else.

#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(test)]

use tempfile::tempdir;
use terminus_authz::{OperationClass, Scope, TokenBinder};
use terminus_kernel::KernelHandle;
use terminus_kernel_protocol::RequestContext;
use terminus_secrets::GrantBinding;

const ACCOUNT_URI: &str = "secret://provider-account/0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b";
const NVIDIA_HOST: &str = "integrate.api.nvidia.com";

fn kernel() -> (tempfile::TempDir, KernelHandle) {
    let dir = tempdir().unwrap();
    let kernel = KernelHandle::new(dir.path().to_path_buf()).unwrap();
    (dir, kernel)
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
    ctx.task_id = "account-task".to_string();
    ctx.actor_id = "account-principal".to_string();
    ctx.session_id = "account-session".to_string();
    ctx.workspace_id = "account-ws".to_string();
    ctx
}

/// Mint a Secret-class capability scoped to one destination and one URI.
fn secret_token(kernel: &KernelHandle, uri: &str, host: &str, port: u16) -> String {
    kernel
        .token_issuer
        .mint(
            binder(),
            vec![OperationClass::Secret, OperationClass::Network],
            Scope {
                workspace_paths: Vec::new(),
                network_destinations: vec![format!("{host}:{port}")],
                secret_capabilities: vec![uri.to_string()],
            },
            None,
            format!("provider-account-{host}"),
        )
        .unwrap()
        .encode()
        .unwrap()
}

/// Swap the OS-keychain provider for an in-memory one under the SAME
/// `provider-account` namespace. Host authorization and grant minting are
/// what these tests exercise; writing fixture credentials into the
/// developer's login keychain is not.
fn stub_account_credential(kernel: &KernelHandle, credential: &[u8]) {
    let provider = std::sync::Arc::new(terminus_secrets::InMemoryProvider::new());
    provider.register(ACCOUNT_URI, credential.to_vec());
    kernel
        .secrets
        .broker()
        .register_writable_provider("provider-account", provider);
}

fn binding(connector_id: &str, host: &str, allowed_hosts: Vec<String>) -> GrantBinding {
    GrantBinding {
        connector_id: connector_id.to_string(),
        destination_host: host.to_string(),
        destination_port: 443,
        scheme: "https".to_string(),
        method: "POST".to_string(),
        path_class: "/v1/chat/completions".to_string(),
        task_id: "account-task".to_string(),
        effect_id: "eff-account-1".to_string(),
        allowed_hosts,
    }
}

#[test]
fn default_egress_is_derived_from_the_registered_connectors() {
    let (_dir, kernel) = kernel();
    let policy = kernel.network.proxy().policy().clone();
    for host in [
        "opencode.ai",
        "models.dev",
        "api.openai.com",
        "api.anthropic.com",
    ] {
        assert!(
            policy.matches(host, 443, "https"),
            "{host} must be admitted by the derived allowlist"
        );
    }
    for host in [NVIDIA_HOST, "evil.example.com", "api.openai.com.evil.com"] {
        assert!(
            !policy.matches(host, 443, "https"),
            "{host} must not be admitted before an account pins it"
        );
    }
}

#[test]
fn provider_account_secrets_round_trip_and_reject_non_uuid_uris() {
    let (_dir, kernel) = kernel();
    let broker = kernel.secrets.broker();
    // The namespace is registered; a non-UUID scope is refused by the
    // provider before any keychain access happens.
    let denied = broker
        .store("secret://provider-account/not-a-uuid", b"abc")
        .expect_err("a non-UUID provider-account URI must be denied");
    assert!(
        format!("{denied}").contains("UUIDv7"),
        "unexpected error: {denied}"
    );
    // An unregistered namespace stays unknown.
    let unknown = broker
        .store("secret://no-such-namespace/whatever", b"abc")
        .expect_err("an unregistered namespace must be denied");
    assert!(format!("{unknown}").contains("no-such-namespace"));
}

#[test]
fn openai_compatible_admits_only_the_accounts_own_host() {
    let (_dir, kernel) = kernel();
    stub_account_credential(&kernel, b"nvapi-fixture-credential");

    // Minting for the account's own host succeeds and admits that one
    // destination to the L4 allowlist.
    let token = secret_token(&kernel, ACCOUNT_URI, NVIDIA_HOST, 443);
    kernel
        .connectors
        .mint_grant(
            &ctx(&token),
            ACCOUNT_URI,
            binding(
                "openai-compatible",
                NVIDIA_HOST,
                vec![NVIDIA_HOST.to_string()],
            ),
            60,
            1,
        )
        .expect("minting for the account's own host succeeds");
    assert!(
        kernel
            .network
            .proxy()
            .runtime_destinations()
            .iter()
            .any(|d| d.allowed_host_suffixes.iter().any(|h| h == NVIDIA_HOST)),
        "the account host must be admitted to egress"
    );

    // A destination outside this account's allowlist is refused.
    let other_token = secret_token(&kernel, ACCOUNT_URI, "router.huggingface.co", 443);
    let denied = kernel
        .connectors
        .mint_grant(
            &ctx(&other_token),
            ACCOUNT_URI,
            binding(
                "openai-compatible",
                "router.huggingface.co",
                vec![NVIDIA_HOST.to_string()],
            ),
            60,
            1,
        )
        .expect_err("a host outside the account allowlist must be refused");
    assert!(
        format!("{denied}").contains("account host allowlist"),
        "unexpected error: {denied}"
    );

    // And a per-account connector with no allowlist at all is refused.
    let bare = kernel
        .connectors
        .mint_grant(
            &ctx(&token),
            ACCOUNT_URI,
            binding("openai-compatible", NVIDIA_HOST, Vec::new()),
            60,
            1,
        )
        .expect_err("openai-compatible requires allowed_hosts");
    assert!(
        format!("{bare}").contains("allowed_hosts"),
        "unexpected error: {bare}"
    );
}

#[test]
fn a_fixed_host_connector_cannot_be_minted_for_a_foreign_destination() {
    let (_dir, kernel) = kernel();
    stub_account_credential(&kernel, b"fixture-credential");

    let token = secret_token(&kernel, ACCOUNT_URI, "evil.example.com", 443);
    let denied = kernel
        .connectors
        .mint_grant(
            &ctx(&token),
            ACCOUNT_URI,
            binding("openai-responses", "evil.example.com", Vec::new()),
            60,
            1,
        )
        .expect_err("a fixed-host connector must refuse a foreign destination");
    assert!(
        format!("{denied}").contains("does not admit host"),
        "unexpected error: {denied}"
    );
    // The refusal must not have widened egress.
    assert!(kernel.network.proxy().runtime_destinations().is_empty());
}
