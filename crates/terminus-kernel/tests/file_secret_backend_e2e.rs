//! The development file secret backend, end to end through the kernel.
//!
//! Proven here:
//! 1. `TERMINUS_SECRETS_BACKEND=file` + `TERMINUS_DEV=1` registers the file
//!    provider for BOTH namespaces at kernel assembly, so nothing in the
//!    provider-account path reaches the OS keychain;
//! 2. `ProviderAccountService::import_local` writes through that backend and
//!    the credential lands as a 0600 file under
//!    `<data dir>/secrets/<namespace>/<account>`;
//! 3. the stored credential then resolves through the broker — synchronously
//!    and through the non-blocking async path the gRPC handlers use — so a
//!    fresh dev run with the file backend ends with the OpenCode account
//!    resolvable;
//! 4. `SecretService::delete` removes it and the URI stops resolving;
//! 5. `TERMINUS_SECRETS_BACKEND=file` WITHOUT `TERMINUS_DEV=1` refuses kernel
//!    startup, so a packaged build can never leave the OS keychain.
//!
//! This file holds exactly ONE test on purpose: it mutates process
//! environment variables, and cargo runs each integration-test file in its
//! own process, so there is no other thread to race with.
//!
//! The fixture credential is an obviously fake API key written into a temp
//! directory. No real auth store is read and nothing touches the login keychain.

#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(test)]

use sha2::Digest;
use terminus_authz::{OperationClass, Scope, TokenBinder};
use terminus_kernel::{KernelHandle, LocalCredentialRoots};
use terminus_kernel_protocol::RequestContext;
use terminus_secrets::SecretNamespace;

const ACCOUNT_URI: &str = "secret://provider-account/0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b";

fn fingerprint(secret: &str) -> String {
    hex::encode(sha2::Sha256::digest(secret.as_bytes()))
}

#[tokio::test]
async fn file_backend_carries_a_provider_account_from_import_to_resolve() {
    // ---------- 1. a kernel wired to the file backend ----------
    std::env::set_var("TERMINUS_DEV", "1");
    std::env::set_var("TERMINUS_SECRETS_BACKEND", "file");

    let data_dir = tempfile::tempdir().unwrap();
    let stores = tempfile::tempdir().unwrap();
    let opencode_dir = stores.path().join("opencode-data");
    let empty_path = stores.path().join("empty-bin");
    for dir in [&opencode_dir, &empty_path] {
        std::fs::create_dir_all(dir).unwrap();
    }

    let access_token = "fixture-not-a-real-opencode-key";
    write_owner_only(
        &opencode_dir.join("auth.json"),
        &serde_json::json!({
            "opencode-provider": { "type": "api", "key": access_token }
        })
        .to_string(),
    );

    let kernel = KernelHandle::new(data_dir.path().to_path_buf())
        .expect("a dev kernel accepts the file secret backend")
        .with_local_credential_roots(
            LocalCredentialRoots::empty()
                .with_opencode_dir(&opencode_dir)
                .with_path_override(empty_path.as_os_str()),
        );

    // ---------- 2. import writes through the active backend ----------
    let token = secret_token(&kernel, ACCOUNT_URI);
    let imported = kernel
        .provider_accounts
        .import_local(
            &ctx(&token),
            "opencode:opencode-provider",
            ACCOUNT_URI,
            &fingerprint(access_token),
        )
        .expect("the OpenCode login imports into the file backend");
    assert!(imported.stored);
    assert_eq!(imported.capability_uri, ACCOUNT_URI);

    let credential_path = data_dir
        .path()
        .join("secrets")
        .join(SecretNamespace::ProviderAccount.service())
        .join(
            SecretNamespace::ProviderAccount
                .account_for(ACCOUNT_URI)
                .unwrap(),
        );
    assert!(
        credential_path.exists(),
        "expected a credential file at {}",
        credential_path.display()
    );
    let metadata = std::fs::symlink_metadata(&credential_path).expect("credential file metadata");
    assert!(metadata.is_file());
    assert_eq!(
        metadata.len(),
        access_token.len() as u64,
        "the credential is stored byte-for-byte"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        let dir_mode = std::fs::metadata(credential_path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);
    }

    // ---------- 3. the account resolves, sync and async ----------
    let expected_digest = hex::encode(sha2::Sha256::digest(access_token.as_bytes()));
    let handle = kernel
        .secrets
        .broker()
        .request(ACCOUNT_URI, "file-backend-test")
        .expect("the imported account resolves");
    assert_eq!(handle.digest(), expected_digest);
    assert_eq!(handle.metadata.provider, "provider-account");
    drop(handle);

    let handle = kernel
        .secrets
        .broker()
        .request_async(ACCOUNT_URI, "file-backend-test")
        .await
        .expect("the imported account resolves on the async path");
    assert_eq!(handle.digest(), expected_digest);
    drop(handle);

    // The capability-checked service path (what `SecretService.Mint` — and so
    // the control plane's resolvability probe — calls) sees it too.
    let resolved = kernel
        .secrets
        .request_metadata_async(&ctx(&token), ACCOUNT_URI, "file-backend-test")
        .await
        .expect("the account resolves through the capability-checked path");
    assert_eq!(resolved.uri, ACCOUNT_URI);

    // ---------- 4. delete removes it ----------
    kernel
        .secrets
        .delete(&ctx(&token), ACCOUNT_URI)
        .expect("delete succeeds");
    assert!(!credential_path.exists());
    assert!(
        kernel
            .secrets
            .broker()
            .request_async(ACCOUNT_URI, "file-backend-test")
            .await
            .is_err(),
        "a deleted credential must not be served from the resolve cache"
    );

    // ---------- 5. the file backend is development-only ----------
    std::env::remove_var("TERMINUS_DEV");
    let packaged = tempfile::tempdir().unwrap();
    let refused = KernelHandle::new(packaged.path().to_path_buf())
        .expect_err("a non-development kernel must refuse the file backend");
    let message = refused.to_string();
    assert!(
        message.contains("TERMINUS_DEV=1"),
        "the refusal must name the requirement: {message}"
    );

    std::env::remove_var("TERMINUS_SECRETS_BACKEND");
}

// ---------- helpers ----------

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
    let mut ctx = RequestContext::new("file-backend-request");
    ctx.capability_token = token.to_string();
    ctx.idempotency_key = "file-backend-idempotency".to_string();
    ctx.task_id = "account-task".to_string();
    ctx.actor_id = "account-principal".to_string();
    ctx.session_id = "account-session".to_string();
    ctx.workspace_id = "account-ws".to_string();
    ctx
}

fn secret_token(kernel: &KernelHandle, uri: &str) -> String {
    kernel
        .token_issuer
        .mint(
            binder(),
            vec![OperationClass::Secret],
            Scope {
                workspace_paths: Vec::new(),
                network_destinations: Vec::new(),
                secret_capabilities: vec![uri.to_string()],
            },
            None,
            "file-secret-backend".to_string(),
        )
        .unwrap()
        .encode()
        .unwrap()
}

fn write_owner_only(path: &std::path::Path, contents: &str) {
    std::fs::write(path, contents).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}
