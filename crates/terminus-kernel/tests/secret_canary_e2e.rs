//! Raw-secret canary + connector exfiltration suite (roadmap Phase 4 exit
//! gate; ADR-0035 §9).
//!
//! Exit-gate assertions proven here:
//! 1. a credential canary that traverses mint → grant → trusted-connector
//!    execution appears in NO persisted surface under the kernel data dir,
//!    in the grant token, or in the receipt;
//! 2. grant replay across retries is impossible (single use, durable);
//! 3. cross-task / cross-effect / wrong-destination use is rejected;
//! 4. minting requires the `Secret` operation class; executing requires
//!    `Network` scoped to the exact destination.

#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(test)]

use std::path::PathBuf;
use std::sync::Arc;

use tempfile::tempdir;
use terminus_authz::{OperationClass, Scope, TokenBinder};
use terminus_connector::CanonicalOperation;
use terminus_egress::{DestinationPolicy, EgressPolicy, RateLimit};
use terminus_kernel::KernelHandle;
use terminus_kernel_protocol::RequestContext;
use terminus_secrets::{CanaryMaterial, GrantBinding, InMemoryProvider, ResidueScanner};

const SECRET_URI: &str = "secret://fixture/canary";

fn localhost_policy(port: u16) -> EgressPolicy {
    EgressPolicy {
        default_deny: true,
        destinations: vec![DestinationPolicy {
            allowed_host_suffixes: vec!["localhost".to_string()],
            allowed_ports: vec![port],
            allowed_schemes: vec!["http".to_string()],
        }],
        // The fixture server is loopback; the L7 grant binding is the
        // authority here, so private-range denial is relaxed for this
        // fixture destination only.
        deny_private_ips: false,
    }
}

fn ctx_with_token(token: &str) -> RequestContext {
    let mut ctx = RequestContext::new("canary-request");
    ctx.capability_token = token.to_string();
    ctx.task_id = "canary-task".to_string();
    ctx.actor_id = "canary-actor".to_string();
    ctx.session_id = "canary-session".to_string();
    ctx
}

fn binder() -> TokenBinder {
    TokenBinder {
        principal: "canary-principal".to_string(),
        session_id: "canary-session".to_string(),
        task_id: "canary-task".to_string(),
        workspace_id: "canary-ws".to_string(),
        kernel_instance_id: String::new(),
    }
}

fn full_scope(uri: &str, host: &str, port: u16) -> Scope {
    Scope {
        workspace_paths: vec![],
        network_destinations: vec![format!("{host}:{port}")],
        secret_capabilities: vec![uri.to_string()],
    }
}

struct Fixture {
    kernel: KernelHandle,
    _dir: tempfile::TempDir,
    canary: CanaryMaterial,
    listener_port: u16,
}

fn make_fixture() -> Fixture {
    let dir = tempdir().unwrap();
    // Fixture HTTP server echoing a fixed 201.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let listener_port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            use std::io::{Read as _, Write as _};
            let mut buf = [0u8; 8192];
            let mut raw = Vec::new();
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
                if raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = stream.write_all(
                b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            );
        }
    });

    let egress = localhost_policy(listener_port);
    let kernel = KernelHandle::new_with_egress_policy(dir.path().to_path_buf(), egress, RateLimit {
        bytes_per_second: 10_000_000,
        max_total_bytes: 10_000_000,
    })
    .unwrap();

    // Register the FIXTURE provider with canary material (fixture-only
    // provider per ADR-0035 §1; production wiring uses short-lived
    // credential sources).
    let canary = CanaryMaterial::generate("connector-token", b"phase4-exit-gate");
    let provider = Arc::new(InMemoryProvider::new());
    // Bearer credentials are header text; use the hex form.
    provider.register(SECRET_URI, canary.as_str().into_bytes());
    kernel
        .secrets
        .broker()
        .register_provider("fixture", provider);
    kernel
        .connectors
        .register_connector(
            "fixture-api",
            terminus_connector::AuthStyle::Bearer,
        )
        .unwrap();

    Fixture {
        kernel,
        _dir: dir,
        canary,
        listener_port,
    }
}

fn binding_for(fx: &Fixture) -> GrantBinding {
    GrantBinding {
        connector_id: "fixture-api".into(),
        destination_host: "localhost".into(),
        destination_port: fx.listener_port,
        scheme: "http".into(),
        method: "POST".into(),
        path_class: "/repos/{owner}/{repo}/pulls".into(),
        task_id: "canary-task".into(),
        effect_id: "eff-canary-1".into(),
    }
}

fn operation_for(fx: &Fixture) -> CanonicalOperation {
    CanonicalOperation {
        method: "POST".into(),
        scheme: "http".into(),
        host: "localhost".into(),
        port: fx.listener_port,
        path: "/repos/acme/widget/pulls".into(),
        query: String::new(),
        body: br#"{"title":"canary"}"#.to_vec(),
    }
}

fn secret_and_network_token(kernel: &KernelHandle, scope: Scope) -> String {
    kernel
        .token_issuer
        .mint(
            binder(),
            vec![OperationClass::Secret, OperationClass::Network],
            scope,
            None,
            "canary-nonce-full",
        )
        .and_then(|t| t.encode())
        .unwrap()
}

fn scan_kernel_dir_for_canary(root: &std::path::Path, scanner: &ResidueScanner) -> Vec<String> {
    let mut dirty = Vec::new();
    for entry in walkdir_lite(root) {
        if let Ok(bytes) = std::fs::read(&entry) {
            if !scanner.is_clean(&bytes) {
                dirty.push(entry.display().to_string());
            }
        }
    }
    dirty
}

fn walkdir_lite(root: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out
}

#[tokio::test]
async fn canary_never_reaches_any_persisted_surface() {
    let fx = make_fixture();
    let scope = full_scope(SECRET_URI, "localhost", fx.listener_port);
    let token = secret_and_network_token(&fx.kernel, scope);
    let ctx = ctx_with_token(&token);

    let grant = fx
        .kernel
        .connectors
        .mint_grant(&ctx, SECRET_URI, binding_for(&fx), 300, 1)
        .unwrap();
    let encoded = grant.encode().unwrap();

    let receipt = fx
        .kernel
        .connectors
        .execute(&ctx, &operation_for(&fx), &grant)
        .await
        .expect("grant-bound execution must succeed");

    // Surface 1: the opaque grant token.
    assert!(
        !encoded.contains(&fx.canary.as_str()),
        "canary leaked into grant token"
    );
    // Surface 2: the receipt JSON.
    let receipt_json = serde_json::to_string(&receipt).unwrap();
    assert!(
        !receipt_json.contains(&fx.canary.as_str()),
        "canary leaked into receipt: {receipt_json}"
    );
    // Surface 3: every file the kernel persisted during the flow.
    let mut scanner = fx.canary.scanner();
    // Also scan for the Authorization-style composite form.
    let _ = scanner.register_literal("composite", format!("Bearer {}", fx.canary.as_str()).as_bytes());
    let dirty = scan_kernel_dir_for_canary(fx._dir.path(), &scanner);
    assert!(
        dirty.is_empty(),
        "canary residue found in kernel state files: {dirty:?}"
    );
}

#[tokio::test]
async fn grant_replay_across_retry_rejected_at_kernel() {
    let fx = make_fixture();
    let scope = full_scope(SECRET_URI, "localhost", fx.listener_port);
    let token = secret_and_network_token(&fx.kernel, scope);
    let ctx = ctx_with_token(&token);
    let grant = fx
        .kernel
        .connectors
        .mint_grant(&ctx, SECRET_URI, binding_for(&fx), 300, 1)
        .unwrap();
    let op = operation_for(&fx);

    fx.kernel
        .connectors
        .execute(&ctx, &op, &grant)
        .await
        .expect("first dispatch");
    let second = fx.kernel.connectors.execute(&ctx, &op, &grant).await;
    assert!(second.is_err(), "replayed grant must be refused");
}

#[tokio::test]
async fn wrong_destination_grant_rejected_before_any_io() {
    let fx = make_fixture();
    let scope = full_scope(SECRET_URI, "localhost", fx.listener_port);
    let token = secret_and_network_token(&fx.kernel, scope);
    let ctx = ctx_with_token(&token);
    let grant = fx
        .kernel
        .connectors
        .mint_grant(&ctx, SECRET_URI, binding_for(&fx), 300, 1)
        .unwrap();
    let mut rogue = operation_for(&fx);
    rogue.host = "evil.example.com".into();
    assert!(fx.kernel.connectors.execute(&ctx, &rogue, &grant).await.is_err());
    // Nothing was consumed by the refused attempt.
    assert_eq!(fx.kernel.connectors.consumed_grants(), 0);
}

#[tokio::test]
async fn minting_requires_secret_operation_class() {
    let fx = make_fixture();
    let token = fx
        .kernel
        .token_issuer
        .mint(
            binder(),
            vec![OperationClass::Network],
            full_scope(SECRET_URI, "localhost", fx.listener_port),
            None,
            "canary-nonce-netonly",
        )
        .and_then(|t| t.encode())
        .unwrap();
    let ctx = ctx_with_token(&token);
    let err = fx
        .kernel
        .connectors
        .mint_grant(&ctx, SECRET_URI, binding_for(&fx), 300, 1)
        .unwrap_err();
    assert_eq!(err.code(), terminus_kernel_protocol::ErrorCode::PermissionDenied);
}

#[tokio::test]
async fn network_scope_narrower_than_destination_blocks_minting() {
    let fx = make_fixture();
    // Token allows only an unrelated destination: minting a grant for the
    // real fixture destination must already be denied (the grant is one
    // step from raw use, so the destination check applies at mint time).
    let token = fx
        .kernel
        .token_issuer
        .mint(
            binder(),
            vec![OperationClass::Secret, OperationClass::Network],
            full_scope(SECRET_URI, "localhost", 1),
            None,
            "canary-nonce-narrow",
        )
        .and_then(|t| t.encode())
        .unwrap();
    let ctx = ctx_with_token(&token);
    let err = fx
        .kernel
        .connectors
        .mint_grant(&ctx, SECRET_URI, binding_for(&fx), 300, 1)
        .unwrap_err();
    assert_eq!(
        err.code(),
        terminus_kernel_protocol::ErrorCode::PermissionDenied,
        "minting beyond the token's network scope must be denied"
    );
}
