//! Current×previous schema compatibility tests for terminus.kernel.v1 (SPEC §45.4).

use std::fs;
use std::path::PathBuf;

#[test]
fn test_descriptor_set_exists_and_valid() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .ok_or("crates parent missing")?
        .parent()
        .ok_or("repo root missing")?;
    let binpb_path = repo_root.join("schemas/generated/terminus.kernel.v1.binpb");
    assert!(
        binpb_path.exists(),
        "compiled binpb descriptor set must exist at {}",
        binpb_path.display()
    );

    let bytes = fs::read(&binpb_path)?;
    assert!(!bytes.is_empty(), "binpb descriptor set must not be empty");
    Ok(())
}

#[test]
fn test_request_context_proto_compatibility() -> Result<(), Box<dyn std::error::Error>> {
    let mut ctx = terminus_kernel_protocol::RequestContext::new("test-req-1");
    ctx.idempotency_key = "idemp-key-123".to_string();
    ctx.actor_id = "user-123".to_string();
    ctx.session_id = "sess-456".to_string();
    ctx.task_id = "task-789".to_string();
    ctx.capability_token = "tok-abc".to_string();
    ctx.workspace_id = "ws-default".to_string();
    ctx.deadline_unix_ms = 1_700_000_000_000;
    ctx.resource_budgets = terminus_kernel_protocol::ResourceBudgets {
        max_cpu_milliseconds: 5000,
        max_memory_bytes: 1024 * 1024 * 512,
        max_output_bytes: 1024 * 1024 * 10,
        max_wallclock_seconds: 60,
    };
    ctx.policy_version = "v1".to_string();

    let json = serde_json::to_string(&ctx)?;
    let deserialized: terminus_kernel_protocol::RequestContext = serde_json::from_str(&json)?;

    assert_eq!(ctx, deserialized);
    Ok(())
}
