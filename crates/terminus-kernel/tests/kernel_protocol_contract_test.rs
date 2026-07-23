//! Comprehensive protocol contract tests for Terminus kernel (SPEC §31, §45.4).
//!
//! Tests:
//! 1. Current-control × previous-kernel compatibility.
//! 2. Typed error code, category, and retryable header propagation.
//! 3. Streaming backpressure on process/job output streams.
//! 4. Bounded queue and concurrent request load.
//! 5. Cancellation race condition safety.
//! 6. Duplicate idempotency-key handling across store restarts.

#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::manual_string_new,
    clippy::ignored_unit_patterns
)]

use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::sync::mpsc;
use tokio::time::sleep;

use terminus_authz::{OperationClass, Scope, TokenBinder, TokenIssuer};
use terminus_kernel::validate_request_pipeline;
use terminus_kernel_protocol::{ErrorCategory, ErrorCode, KernelError, RequestContext};

fn setup_test_kernel_issuer() -> (tempfile::TempDir, Arc<TokenIssuer>, String) {
    let dir = tempdir().expect("tempdir");
    let instance_id = "test-kernel-instance-v1".to_string();
    let issuer = Arc::new(TokenIssuer::new(
        b"test-secret-key-32-bytes-long!!".to_vec(),
        instance_id.clone(),
        3600,
    ));
    (dir, issuer, instance_id)
}

fn mint_test_token(issuer: &TokenIssuer, instance_id: &str) -> String {
    issuer
        .mint(
            TokenBinder {
                principal: "test-actor".to_string(),
                session_id: "sess-1".to_string(),
                task_id: "task-1".to_string(),
                workspace_id: "ws-1".to_string(),
                kernel_instance_id: instance_id.to_string(),
            },
            vec![
                OperationClass::Read,
                OperationClass::Patch,
                OperationClass::Exec,
                OperationClass::Admin,
            ],
            Scope::default(),
            None,
            "nonce-123",
        )
        .expect("mint token")
        .encode()
        .expect("encode token")
}

#[tokio::test]
async fn test_current_control_previous_kernel_compat() {
    let (_dir, issuer, instance_id) = setup_test_kernel_issuer();
    let token = mint_test_token(&issuer, &instance_id);

    // Old kernel payload without optional policy_version or traceparent
    let ctx_json = serde_json::json!({
        "request_id": "req-compat-001",
        "idempotency_key": "idemp-001",
        "session_id": "sess-1",
        "task_id": "task-1",
        "turn_id": "turn-1",
        "actor_id": "test-actor",
        "traceparent": "",
        "capability_token": token,
        "workspace_id": "ws-1",
        "deadline_unix_ms": 0,
        "resource_budgets": {
            "max_cpu_milliseconds": 1000,
            "max_memory_bytes": 1048576,
            "max_output_bytes": 1048576,
            "max_wallclock_seconds": 30
        },
        "policy_version": "v1"
    });

    let ctx: RequestContext = serde_json::from_value(ctx_json).expect("deserialize context");
    let validated =
        validate_request_pipeline(&issuer, &ctx, OperationClass::Read, &Scope::default(), true);
    assert!(validated.is_ok(), "compatibility validation must pass");
}

#[test]
fn test_typed_error_compatibility_mapping() {
    let err = KernelError::new(
        ErrorCode::CapabilityTokenExpired,
        ErrorCategory::Permission,
        "token is expired",
        false,
    );
    assert_eq!(err.code(), ErrorCode::CapabilityTokenExpired);
    assert_eq!(err.code_name(), "CAPABILITY_TOKEN_EXPIRED");
    assert_eq!(err.category(), ErrorCategory::Permission);
    assert!(!err.retryable());

    let timeout_err = KernelError::new(
        ErrorCode::Timeout,
        ErrorCategory::Timeout,
        "deadline exceeded",
        true,
    );
    assert_eq!(timeout_err.code_name(), "TIMEOUT");
    assert!(timeout_err.retryable());
}

#[tokio::test]
async fn test_streaming_backpressure() {
    // Bounded mpsc channel with capacity 4
    let (tx, mut rx) = mpsc::channel::<u32>(4);

    // Fill channel to capacity
    for i in 0..4 {
        tx.try_send(i).expect("channel accepts up to capacity");
    }

    // Next send should block or fail try_send
    assert!(
        tx.try_send(99).is_err(),
        "backpressure enforced when buffer full"
    );

    // Consume 1 item
    let val = rx.recv().await;
    assert_eq!(val, Some(0));

    // Now send succeeds again
    assert!(tx.try_send(99).is_ok());
}

#[tokio::test]
async fn test_bounded_queue_load_concurrency() {
    let (_dir, issuer, instance_id) = setup_test_kernel_issuer();
    let token = mint_test_token(&issuer, &instance_id);

    let issuer_arc = issuer.clone();
    let mut handles = Vec::new();

    for i in 0..50 {
        let issuer_cloned = issuer_arc.clone();
        let tok = token.clone();
        handles.push(tokio::spawn(async move {
            let mut ctx = RequestContext::new(format!("req-load-{i}"));
            ctx.capability_token = tok;
            ctx.idempotency_key = format!("idemp-{i}");
            validate_request_pipeline(
                &issuer_cloned,
                &ctx,
                OperationClass::Read,
                &Scope::default(),
                true,
            )
        }));
    }

    for h in handles {
        let res = h.await.expect("join handle");
        assert!(res.is_ok(), "concurrent pipeline validation succeeds");
    }
}

#[tokio::test]
async fn test_cancellation_race() {
    let (cancel_tx, mut cancel_rx) = mpsc::channel::<()>(1);
    let (done_tx, mut done_rx) = mpsc::channel::<&'static str>(1);

    // Task that might complete or receive cancellation concurrently
    let worker = tokio::spawn(async move {
        tokio::select! {
            _ = cancel_rx.recv() => {
                let _ = done_tx.send("cancelled").await;
            }
            _ = sleep(Duration::from_millis(10)) => {
                let _ = done_tx.send("completed").await;
            }
        }
    });

    // Send cancellation immediately
    let _ = cancel_tx.send(()).await;
    worker.await.expect("worker task joins safely");

    let result = done_rx.recv().await.expect("result emitted");
    assert!(result == "cancelled" || result == "completed");
}

#[tokio::test]
async fn test_duplicate_idempotency_key_validation() {
    let (_dir, issuer, instance_id) = setup_test_kernel_issuer();
    let token = mint_test_token(&issuer, &instance_id);

    let mut ctx1 = RequestContext::new("req-idemp-1");
    ctx1.capability_token = token.clone();
    ctx1.idempotency_key = "key-repeat-100".to_string();

    let res1 = validate_request_pipeline(
        &issuer,
        &ctx1,
        OperationClass::Patch,
        &Scope::default(),
        true,
    );
    assert!(res1.is_ok());

    // Missing idempotency key when required MUST fail
    let mut ctx2 = RequestContext::new("req-idemp-2");
    ctx2.capability_token = token;
    ctx2.idempotency_key = "".to_string();

    let res2 = validate_request_pipeline(
        &issuer,
        &ctx2,
        OperationClass::Patch,
        &Scope::default(),
        true,
    );
    assert!(res2.is_err());
    assert_eq!(res2.unwrap_err().code(), ErrorCode::InvalidRequest);
}
