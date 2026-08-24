//! End-to-end tests for capability-token `max_scope` enforcement
//! (SPEC §31.6).
//!
//! These tests construct a real `KernelHandle`, mint tokens via the shared
//! `TokenIssuer`, and call the service methods directly (not via HTTP). They
//! cover the SPEC §31.6 matrix:
//!
//! 1. `operation_classes` check: a Read-only token cannot Exec.
//! 2. `operation_classes` check: an Exec token can Exec.
//! 3. `max_scope.workspace_paths` check: a token scoped to `src/**` rejects
//!    reads outside that path.
//! 4. `max_scope.workspace_paths` check: a token scoped to `**` accepts any
//!    workspace path.
//! 5. `max_scope.network_destinations` check: a token scoped to
//!    `api.github.com` rejects connections to `evil.com`.
//! 6. `max_scope.secret_capabilities` check: a token scoped to
//!    `secret://github/*` rejects `secret://aws/*`.
//! 7. Expired tokens are rejected.
//! 8. Revoked tokens are rejected.
//! 9. Tokens minted by a different kernel (wrong audience) are rejected.
//! 10. Tampered signatures are rejected.
//!
//! The token-validation pipeline runs as step 3 of the SPEC §31.3 14-step
//! validation, so each test sees the token error before any policy/path/spawn
//! side effects.

#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(test)]

use std::path::PathBuf;
use tempfile::tempdir;
use terminus_authz::{OperationClass, Scope, TokenBinder};
use terminus_kernel::KernelHandle;
use terminus_kernel_protocol::{
    CommandSpec, EffectIntent, ErrorCategory, ErrorCode, RequestContext, WorkspacePath,
};

// ---------- helpers ----------

fn ctx_with_token(token: &str) -> RequestContext {
    let mut ctx = RequestContext::new("cap-e2e-request");
    ctx.capability_token = token.to_string();
    ctx.task_id = "cap-e2e-task".to_string();
    ctx.actor_id = "cap-e2e-principal".to_string();
    ctx.session_id = "cap-e2e-session".to_string();
    ctx.workspace_id = "cap-e2e-ws".to_string();
    ctx
}

fn empty_intent() -> EffectIntent {
    EffectIntent {
        trust_label: "trusted".to_string(),
        confidentiality_label: "workspace".to_string(),
        policy_profile_id: "default".to_string(),
        ..Default::default()
    }
}

fn make_kernel() -> (tempfile::TempDir, KernelHandle) {
    let dir = tempdir().expect("tempdir");
    let kernel = KernelHandle::new(PathBuf::from(dir.path())).expect("kernel");
    (dir, kernel)
}

fn default_binder() -> TokenBinder {
    TokenBinder {
        principal: "cap-e2e-principal".to_string(),
        session_id: "cap-e2e-session".to_string(),
        task_id: "cap-e2e-task".to_string(),
        workspace_id: "cap-e2e-ws".to_string(),
        kernel_instance_id: String::new(),
    }
}

fn mint_and_encode(
    kernel: &KernelHandle,
    binder: TokenBinder,
    ops: Vec<OperationClass>,
    max_scope: Scope,
    ttl: Option<u64>,
    nonce: &str,
) -> String {
    kernel
        .token_issuer
        .mint(binder, ops, max_scope, ttl, nonce)
        .and_then(|t| t.encode())
        .expect("mint+encode")
}

fn is_capability_or_permission_error(err: &terminus_kernel_protocol::KernelError) -> bool {
    matches!(
        err.code(),
        ErrorCode::CapabilityTokenInvalid
            | ErrorCode::CapabilityTokenExpired
            | ErrorCode::CapabilityTokenRevoked
            | ErrorCode::PermissionDenied
    )
}

#[test]
fn artifact_reads_require_task_ownership_or_explicit_maintenance_authority() {
    let (_directory, kernel) = make_kernel();
    let owner_token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::ArtifactIngest],
        Scope::default(),
        None,
        "artifact-owner",
    );
    let owner_context = ctx_with_token(&owner_token);
    let artifact = kernel
        .artifact_ingest
        .ingest(&owner_context, &empty_intent(), b"task-a-checkpoint")
        .expect("owner ingests artifact");
    assert_eq!(
        kernel
            .artifact_ingest
            .get(&owner_context, &artifact.sha256)
            .expect("owner reads artifact"),
        b"task-a-checkpoint",
    );

    let other_binder = TokenBinder {
        task_id: "other-task".to_string(),
        ..default_binder()
    };
    let other_token = mint_and_encode(
        &kernel,
        other_binder,
        vec![OperationClass::ArtifactIngest],
        Scope::default(),
        None,
        "artifact-other",
    );
    let mut other_context = ctx_with_token(&other_token);
    other_context.task_id = "other-task".to_string();
    for error in [
        kernel
            .artifact_ingest
            .get(&other_context, &artifact.sha256)
            .expect_err("another task cannot read bytes"),
        kernel
            .artifact_ingest
            .metadata(&other_context, &artifact.sha256)
            .expect_err("another task cannot read metadata"),
    ] {
        assert_eq!(error.code(), ErrorCode::PermissionDenied);
    }

    let maintenance_token = mint_and_encode(
        &kernel,
        TokenBinder {
            task_id: "control-maintenance".to_string(),
            ..default_binder()
        },
        vec![OperationClass::Admin],
        Scope::default(),
        None,
        "artifact-maintenance",
    );
    let mut maintenance_context = ctx_with_token(&maintenance_token);
    maintenance_context.task_id = "control-maintenance".to_string();
    assert_eq!(
        kernel
            .artifact_ingest
            .get(&maintenance_context, &artifact.sha256)
            .expect("maintenance reads artifact"),
        b"task-a-checkpoint",
    );
}

// ---------- Test 1: Read-only token cannot Exec ----------

#[tokio::test]
async fn cap_e2e_read_only_token_rejected_for_exec() {
    let (_dir, kernel) = make_kernel();
    let token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Read],
        Scope::default(),
        None,
        "cap-e2e-n1",
    );
    let ctx = ctx_with_token(&token);
    let command = CommandSpec {
        program: "ls".to_string(),
        args: vec![],
        cwd: WorkspacePath::new("ws-1", "."),
        timeout_ms: 1_000,
        ..Default::default()
    };
    let err = kernel
        .processes
        .start(&ctx, &empty_intent(), command)
        .await
        .expect_err("Read-only token must not allow Exec");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    assert_eq!(err.category(), ErrorCategory::Permission);
}

#[test]
fn capability_binders_reject_cross_context_replay() {
    let (_directory, kernel) = make_kernel();
    let token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Read],
        Scope::default(),
        None,
        "cap-e2e-context-binding",
    );
    for field in ["principal", "session", "task", "workspace"] {
        let mut context = ctx_with_token(&token);
        match field {
            "principal" => context.actor_id = "other-principal".to_string(),
            "session" => context.session_id = "other-session".to_string(),
            "task" => context.task_id = "other-task".to_string(),
            "workspace" => context.workspace_id = "other-workspace".to_string(),
            _ => unreachable!(),
        }
        let error = terminus_kernel::validate_capability_for_op(
            &kernel.token_issuer,
            &context,
            OperationClass::Read,
            &Scope::default(),
        )
        .expect_err("cross-context replay must fail");
        assert_eq!(error.code(), ErrorCode::PermissionDenied, "{field}");
    }
}

// ---------- Test 2: Exec token accepted for Exec ----------

#[tokio::test]
async fn cap_e2e_exec_token_accepted_for_exec() {
    let (dir, kernel) = make_kernel();
    let admin_token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Admin],
        Scope::default(),
        None,
        "cap-e2e-n2-register",
    );
    kernel
        .workspaces
        .register_with_id(
            &ctx_with_token(&admin_token),
            &empty_intent(),
            format!("file://{}", dir.path().display()),
            dir.path().display().to_string(),
            "untrusted",
            Some("cap-e2e-ws"),
        )
        .expect("register Exec test workspace");
    let token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Exec],
        Scope::default(),
        None,
        "cap-e2e-n2",
    );
    let ctx = ctx_with_token(&token);
    // `ls` is allowed by the default `allow-read-tools` rule, so the policy
    // check should pass. The token check MUST pass.
    let command = CommandSpec {
        program: "ls".to_string(),
        args: vec!["-la".to_string()],
        cwd: WorkspacePath::new("cap-e2e-ws", "."),
        timeout_ms: 1_000,
        ..Default::default()
    };
    let result = kernel.processes.start(&ctx, &empty_intent(), command).await;
    match result {
        Ok(_rx) => { /* token accepted, process spawned */ }
        Err(e) => {
            assert!(
                !is_capability_or_permission_error(&e),
                "Exec token must be accepted; got token/permission error: {e}"
            );
        }
    }
}

// ---------- Test 3: workspace_paths scoped to src/** rejects /etc/passwd ----------

#[test]
fn cap_e2e_workspace_scope_rejects_out_of_scope_path() {
    let (_dir, kernel) = make_kernel();
    let max_scope = Scope {
        workspace_paths: vec!["src/**".to_string()],
        network_destinations: Vec::new(),
        secret_capabilities: Vec::new(),
    };
    let token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Read],
        max_scope,
        None,
        "cap-e2e-n3",
    );
    let ctx = ctx_with_token(&token);
    // "etc/passwd" is a relative path with no traversal — it passes
    // SafePath — but it is outside the token's `src/**` scope.
    let path = WorkspacePath::new("ws-1", "etc/passwd");
    let err = kernel
        .files
        .read(&ctx, &empty_intent(), &path)
        .expect_err("out-of-scope path must be rejected");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    assert_eq!(err.category(), ErrorCategory::Permission);
}

// ---------- Test 4: workspace_paths = ["**"] accepts any workspace path ----------

#[test]
fn cap_e2e_workspace_scope_wildcard_accepts_any_path() {
    let (dir, kernel) = make_kernel();
    let admin_token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Admin],
        Scope::default(),
        None,
        "cap-e2e-register",
    );
    let admin_context = ctx_with_token(&admin_token);
    let workspace_id = kernel
        .workspaces
        .register(
            &admin_context,
            &empty_intent(),
            format!("file://{}", dir.path().display()),
            dir.path().display().to_string(),
            "untrusted",
        )
        .expect("register capability-test workspace");
    let max_scope = Scope {
        workspace_paths: vec!["**".to_string()],
        network_destinations: Vec::new(),
        secret_capabilities: Vec::new(),
    };
    let token = mint_and_encode(
        &kernel,
        TokenBinder {
            workspace_id: workspace_id.clone(),
            ..default_binder()
        },
        vec![OperationClass::Read],
        max_scope,
        None,
        "cap-e2e-n4",
    );
    let mut ctx = ctx_with_token(&token);
    ctx.workspace_id = workspace_id.clone();
    // The token's `**` scope accepts any path. The subsequent PathNotFound
    // error (file does not exist) is fine — the token check MUST pass.
    let path = WorkspacePath::new(workspace_id, "any/deep/path/file.txt");
    let result = kernel.files.read(&ctx, &empty_intent(), &path);
    match result {
        Ok(_) => { /* unexpected but acceptable */ }
        Err(e) => {
            assert!(
                !is_capability_or_permission_error(&e),
                "wildcard-scope token must be accepted; got token/permission error: {e}"
            );
        }
    }
}

// ---------- Test 5: network_destinations scoped to api.github.com rejects evil.com ----------

#[test]
fn cap_e2e_network_scope_rejects_unauthorized_host() {
    let (_dir, kernel) = make_kernel();
    let max_scope = Scope {
        workspace_paths: Vec::new(),
        network_destinations: vec!["api.github.com".to_string()],
        secret_capabilities: Vec::new(),
    };
    let token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Network],
        max_scope,
        None,
        "cap-e2e-n5",
    );
    let ctx = ctx_with_token(&token);
    let ip: std::net::IpAddr = "93.184.216.34".parse().expect("parse ip");
    let err = kernel
        .network
        .authorize(&ctx, &empty_intent(), "evil.com", 443, "https", &[ip])
        .expect_err("out-of-scope host must be rejected");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    assert_eq!(err.category(), ErrorCategory::Permission);
}

// ---------- Test 6: secret_capabilities scoped to secret://github/* rejects secret://aws/* ----------

#[test]
fn cap_e2e_secret_scope_rejects_unauthorized_uri() {
    let (_dir, kernel) = make_kernel();
    let max_scope = Scope {
        workspace_paths: Vec::new(),
        network_destinations: Vec::new(),
        secret_capabilities: vec!["secret://github/*".to_string()],
    };
    let token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Secret],
        max_scope,
        None,
        "cap-e2e-n6",
    );
    let ctx = ctx_with_token(&token);
    let err = kernel
        .secrets
        .request(&ctx, &empty_intent(), "secret://aws/creds", "test")
        .expect_err("out-of-scope secret URI must be rejected");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    assert_eq!(err.category(), ErrorCategory::Permission);
}

// ---------- Test 7: expired token is rejected ----------

#[tokio::test]
async fn cap_e2e_expired_token_rejected() {
    let (_dir, kernel) = make_kernel();
    // TTL = 1 second; sleep 2 seconds so the token is expired by the time
    // we call the service.
    let token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Exec],
        Scope::default(),
        Some(1),
        "cap-e2e-n7",
    );
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let ctx = ctx_with_token(&token);
    let command = CommandSpec {
        program: "ls".to_string(),
        args: vec![],
        cwd: WorkspacePath::new("ws-1", "."),
        timeout_ms: 1_000,
        ..Default::default()
    };
    let err = kernel
        .processes
        .start(&ctx, &empty_intent(), command)
        .await
        .expect_err("expired token must be rejected");
    assert_eq!(err.code(), ErrorCode::CapabilityTokenExpired);
    assert_eq!(err.category(), ErrorCategory::Permission);
}

// ---------- Test 8: revoked token is rejected ----------

#[tokio::test]
async fn cap_e2e_revoked_token_rejected() {
    let (_dir, kernel) = make_kernel();
    let token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Exec],
        Scope::default(),
        None,
        "cap-e2e-n8",
    );
    // Validate the token to obtain its token_id, then revoke it.
    let validated = kernel.token_issuer.validate(&token).expect("validate");
    kernel.token_issuer.revoke(&validated.claims.token_id);
    let ctx = ctx_with_token(&token);
    let command = CommandSpec {
        program: "ls".to_string(),
        args: vec![],
        cwd: WorkspacePath::new("ws-1", "."),
        timeout_ms: 1_000,
        ..Default::default()
    };
    let err = kernel
        .processes
        .start(&ctx, &empty_intent(), command)
        .await
        .expect_err("revoked token must be rejected");
    assert_eq!(err.code(), ErrorCode::CapabilityTokenRevoked);
    assert_eq!(err.category(), ErrorCategory::Permission);
}

// ---------- Test 9: token with wrong audience (different kernel_instance_id) is rejected ----------

#[tokio::test]
async fn cap_e2e_wrong_audience_token_rejected() {
    let (_dir, kernel) = make_kernel();
    // Mint a token using a different issuer (different kernel_instance_id)
    // but the SAME signing secret. The signature verifies, but the audience
    // check inside `validate` fails.
    let other_issuer = terminus_authz::TokenIssuer::new(
        b"kernel-default-secret-please-rotate".to_vec(),
        "other-kernel-instance".to_string(),
        3600,
    );
    let token = other_issuer
        .mint(
            default_binder(),
            vec![OperationClass::Exec],
            Scope::default(),
            None,
            "cap-e2e-n9",
        )
        .and_then(|t| t.encode())
        .expect("mint+encode");
    let ctx = ctx_with_token(&token);
    let command = CommandSpec {
        program: "ls".to_string(),
        args: vec![],
        cwd: WorkspacePath::new("ws-1", "."),
        timeout_ms: 1_000,
        ..Default::default()
    };
    let err = kernel
        .processes
        .start(&ctx, &empty_intent(), command)
        .await
        .expect_err("wrong-audience token must be rejected");
    assert_eq!(err.code(), ErrorCode::CapabilityTokenInvalid);
    assert_eq!(err.category(), ErrorCategory::Permission);
}

// ---------- Test 10: tampered signature is rejected ----------

#[tokio::test]
async fn cap_e2e_tampered_signature_rejected() {
    let (_dir, kernel) = make_kernel();
    let token = mint_and_encode(
        &kernel,
        default_binder(),
        vec![OperationClass::Exec],
        Scope::default(),
        None,
        "cap-e2e-n10",
    );
    // Flip the last hex character of the signature half. The claims half is
    // untouched; only the signature is corrupted.
    let mut encoded = token;
    let last = encoded.pop().expect("non-empty token");
    let next = if last == '0' { '1' } else { '0' };
    encoded.push(next);
    let ctx = ctx_with_token(&encoded);
    let command = CommandSpec {
        program: "ls".to_string(),
        args: vec![],
        cwd: WorkspacePath::new("ws-1", "."),
        timeout_ms: 1_000,
        ..Default::default()
    };
    let err = kernel
        .processes
        .start(&ctx, &empty_intent(), command)
        .await
        .expect_err("tampered token must be rejected");
    assert_eq!(err.code(), ErrorCode::CapabilityTokenInvalid);
    assert_eq!(err.category(), ErrorCategory::Permission);
}
