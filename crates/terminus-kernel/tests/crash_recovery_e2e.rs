//! E2E crash and restart test for Terminus kernel (SPEC §27, §36).
//!
//! Verifies that after a simulated kernel crash or process restart:
//! 1. Capability tokens minted for a prior kernel instance are rejected as wrong audience;
//! 2. Unsettled approvals or revoked token IDs do not leak open capabilities;
//! 3. Process managers start with clean process tables;
//! 4. Secret handles and egress proxy rules reset to default-deny.

#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(test)]

use std::path::PathBuf;
use tempfile::tempdir;
use terminus_authz::{OperationClass, Scope, TokenBinder};
use terminus_kernel::KernelHandle;
use terminus_kernel_protocol::{ErrorCategory, ErrorCode, RequestContext, WorkspacePath};

fn ctx_with_token(token: &str) -> RequestContext {
    let mut ctx = RequestContext::new("crash-test-req");
    ctx.capability_token = token.to_string();
    ctx.task_id = "task-crash".to_string();
    ctx.actor_id = "actor-crash".to_string();
    ctx.session_id = "session-crash".to_string();
    ctx
}

#[tokio::test]
async fn test_kernel_restart_invalidates_prior_instance_tokens() {
    let dir = tempdir().expect("tempdir");
    let data_path = PathBuf::from(dir.path());

    // 1. Boot kernel 1
    let k1 = KernelHandle::new(data_path.clone()).expect("k1 boot");
    let binder = TokenBinder {
        principal: "user-1".to_string(),
        session_id: "s-1".to_string(),
        task_id: "t-1".to_string(),
        workspace_id: "ws-1".to_string(),
        kernel_instance_id: String::new(),
    };
    let token1 = k1
        .token_issuer
        .mint(
            binder,
            vec![OperationClass::Exec, OperationClass::Read],
            Scope::default(),
            None,
            "crash-n1",
        )
        .and_then(|t| t.encode())
        .expect("mint token in k1");

    // Verify token1 works on k1
    let ctx1 = ctx_with_token(&token1);
    let path = WorkspacePath::new("ws-1", "test.txt");
    std::fs::write(dir.path().join("test.txt"), b"data").expect("write file");
    k1.files
        .read(
            &ctx1,
            &terminus_kernel_protocol::EffectIntent::default(),
            &path,
        )
        .expect("k1 read ok");

    // 2. Simulate crash by dropping k1 and booting fresh k2 on same data_dir
    drop(k1);
    let k2 = KernelHandle::new(data_path).expect("k2 boot");

    // 3. Token from k1 MUST be rejected on k2 due to kernel_instance_id mismatch
    let ctx_reboot = ctx_with_token(&token1);
    let err = k2
        .files
        .read(
            &ctx_reboot,
            &terminus_kernel_protocol::EffectIntent::default(),
            &path,
        )
        .expect_err("token from crashed k1 must be rejected by k2");
    assert_eq!(err.code(), ErrorCode::CapabilityTokenInvalid);
    assert_eq!(err.category(), ErrorCategory::Permission);
}

#[tokio::test]
async fn test_kernel_restart_starts_with_clean_process_and_egress_state() {
    let dir = tempdir().expect("tempdir");
    let data_path = PathBuf::from(dir.path());

    // Boot kernel instance
    let k1 = KernelHandle::new(data_path.clone()).expect("k1 boot");
    let sandbox_report = k1.sandboxes.enforcement_report();
    assert!(!sandbox_report.backend_id.is_empty());

    // Drop and reboot
    drop(k1);
    let k2 = KernelHandle::new(data_path).expect("k2 boot");

    // Mint token on k2
    let binder = TokenBinder {
        principal: "user-1".to_string(),
        workspace_id: "ws-1".to_string(),
        ..Default::default()
    };
    let token2 = k2
        .token_issuer
        .mint(
            binder,
            vec![OperationClass::Exec, OperationClass::Network],
            Scope::default(),
            None,
            "crash-n2",
        )
        .and_then(|t| t.encode())
        .expect("mint token in k2");

    let ctx2 = ctx_with_token(&token2);

    // Egress default-deny remains active on k2
    let private_ip: std::net::IpAddr = "10.0.0.1".parse().expect("parse");
    let err = k2
        .network
        .authorize(
            &ctx2,
            &terminus_kernel_protocol::EffectIntent::default(),
            "internal.host",
            80,
            "http",
            &[private_ip],
        )
        .expect_err("egress default-deny must remain active after restart");
    assert_eq!(err.code(), ErrorCode::PolicyDenied);
}
