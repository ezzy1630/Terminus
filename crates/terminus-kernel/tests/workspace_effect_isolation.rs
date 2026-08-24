//! Effects resolve one concrete registered workspace root before host I/O.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::path::Path;
use tempfile::tempdir;
use terminus_authz::{OperationClass, Scope, TokenBinder};
use terminus_kernel::KernelHandle;
use terminus_kernel_protocol::{
    CommandSpec, CreateFile, EffectIntent, ErrorCode, PatchEdit, ProcessEvent, RequestContext,
    WorkspaceBaseline, WorkspacePath,
};

fn intent() -> EffectIntent {
    EffectIntent {
        trust_label: "trusted".to_string(),
        confidentiality_label: "workspace".to_string(),
        policy_profile_id: "default".to_string(),
        ..Default::default()
    }
}

fn capability(
    kernel: &KernelHandle,
    workspace_id: &str,
    operations: Vec<OperationClass>,
    nonce: &str,
) -> String {
    kernel
        .token_issuer
        .mint(
            TokenBinder {
                principal: "workspace-effect-test".to_string(),
                session_id: "session".to_string(),
                task_id: "task".to_string(),
                workspace_id: workspace_id.to_string(),
                kernel_instance_id: String::new(),
            },
            operations,
            Scope::default(),
            None,
            nonce,
        )
        .and_then(|token| token.encode())
        .expect("test capability")
}

fn context(kernel: &KernelHandle, workspace_id: &str, operation: OperationClass) -> RequestContext {
    let mut context = RequestContext::new(format!("request-{workspace_id}-{operation:?}"));
    context.session_id = "session".to_string();
    context.task_id = "task".to_string();
    context.actor_id = "workspace-effect-test".to_string();
    context.workspace_id = workspace_id.to_string();
    context.capability_token = capability(
        kernel,
        workspace_id,
        vec![operation],
        &format!("nonce-{workspace_id}-{operation:?}"),
    );
    context
}

fn register_workspace(kernel: &KernelHandle, workspace_id: &str, root: &Path) {
    let mut admin = context(kernel, "*", OperationClass::Admin);
    admin.workspace_id = "*".to_string();
    kernel
        .workspaces
        .register_with_id(
            &admin,
            &intent(),
            format!("file://{}", root.display()),
            root.display().to_string(),
            "restricted",
            Some(workspace_id),
        )
        .expect("register workspace");
}

fn kernel_with_two_roots() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    tempfile::TempDir,
    KernelHandle,
) {
    let data = tempdir().expect("kernel data");
    let first = tempdir().expect("first workspace");
    let second = tempdir().expect("second workspace");
    let kernel = KernelHandle::new(data.path().to_path_buf()).expect("kernel");
    register_workspace(&kernel, "workspace-a", first.path());
    register_workspace(&kernel, "workspace-b", second.path());
    (data, first, second, kernel)
}

#[cfg(unix)]
async fn cat_from_workspace(
    kernel: &KernelHandle,
    context: &RequestContext,
    workspace_id: &str,
) -> String {
    let command = CommandSpec {
        program: "/bin/cat".to_string(),
        args: vec!["marker.txt".to_string()],
        cwd: WorkspacePath::new(workspace_id, "."),
        timeout_ms: 5_000,
        ..Default::default()
    };
    let mut events = kernel
        .processes
        .start_in_profile(context, &intent(), command, "degraded-local")
        .await
        .expect("registered workspace process starts");
    let mut output = Vec::new();
    while let Some(event) = events.recv().await {
        match event {
            ProcessEvent::Stdout(chunk) => output.extend_from_slice(&chunk.bytes),
            ProcessEvent::Exited(exit) => {
                assert_eq!(exit.exit_code, 0);
                break;
            }
            _ => {}
        }
    }
    String::from_utf8(output).expect("UTF-8 test output")
}

#[cfg(unix)]
#[tokio::test]
async fn process_cwd_is_resolved_per_registered_workspace_and_rejects_wrong_roots() {
    let (_data, first, second, kernel) = kernel_with_two_roots();
    std::fs::write(first.path().join("marker.txt"), "workspace-a\n").expect("first marker");
    std::fs::write(second.path().join("marker.txt"), "workspace-b\n").expect("second marker");
    let first_context = context(&kernel, "workspace-a", OperationClass::Exec);
    let second_context = context(&kernel, "workspace-b", OperationClass::Exec);

    assert_eq!(
        cat_from_workspace(&kernel, &first_context, "workspace-a").await,
        "workspace-a\n"
    );
    assert_eq!(
        cat_from_workspace(&kernel, &second_context, "workspace-b").await,
        "workspace-b\n"
    );

    let mismatch = kernel
        .processes
        .start_in_profile(
            &first_context,
            &intent(),
            CommandSpec {
                program: "/bin/cat".to_string(),
                args: vec!["marker.txt".to_string()],
                cwd: WorkspacePath::new("workspace-b", "."),
                ..Default::default()
            },
            "degraded-local",
        )
        .await
        .expect_err("context cannot select another registered root");
    assert_eq!(mismatch.code(), ErrorCode::PermissionDenied);

    let missing_context = context(&kernel, "missing-workspace", OperationClass::Exec);
    let missing = kernel
        .processes
        .start_in_profile(
            &missing_context,
            &intent(),
            CommandSpec {
                program: "/bin/cat".to_string(),
                args: vec!["marker.txt".to_string()],
                cwd: WorkspacePath::new("missing-workspace", "."),
                ..Default::default()
            },
            "degraded-local",
        )
        .await
        .expect_err("unregistered workspace cannot spawn");
    assert_eq!(missing.code(), ErrorCode::WorkspaceNotFound);
}

#[test]
fn patch_engines_are_rooted_and_journaled_per_registered_workspace() {
    let (_data, first, second, kernel) = kernel_with_two_roots();
    for (workspace_id, content, transaction_id) in [
        ("workspace-a", b"from workspace a\n".as_slice(), "tx-a"),
        ("workspace-b", b"from workspace b\n".as_slice(), "tx-b"),
    ] {
        let context = context(&kernel, workspace_id, OperationClass::Patch);
        let response = kernel
            .patches
            .apply(
                &context,
                &intent(),
                transaction_id,
                &WorkspaceBaseline {
                    workspace_id: workspace_id.to_string(),
                    ..Default::default()
                },
                &[PatchEdit::CreateFile(CreateFile {
                    path: WorkspacePath::new(workspace_id, "created.txt"),
                    must_not_exist: true,
                    content: content.to_vec(),
                    media_type: "text/plain".to_string(),
                })],
            )
            .expect("patch applies to selected root");
        assert_eq!(response.state, "applied");
    }
    assert_eq!(
        std::fs::read(first.path().join("created.txt")).expect("first patch result"),
        b"from workspace a\n"
    );
    assert_eq!(
        std::fs::read(second.path().join("created.txt")).expect("second patch result"),
        b"from workspace b\n"
    );

    let first_context = context(&kernel, "workspace-a", OperationClass::Patch);
    let mismatch = kernel
        .patches
        .apply(
            &first_context,
            &intent(),
            "tx-mismatch",
            &WorkspaceBaseline {
                workspace_id: "workspace-a".to_string(),
                ..Default::default()
            },
            &[PatchEdit::CreateFile(CreateFile {
                path: WorkspacePath::new("workspace-b", "must-not-exist.txt"),
                must_not_exist: true,
                content: b"denied".to_vec(),
                media_type: "text/plain".to_string(),
            })],
        )
        .expect_err("patch edit cannot cross workspace roots");
    assert_eq!(mismatch.code(), ErrorCode::PermissionDenied);
    assert!(!second.path().join("must-not-exist.txt").exists());

    let missing_context = context(&kernel, "missing-workspace", OperationClass::Patch);
    let missing = kernel
        .patches
        .apply(
            &missing_context,
            &intent(),
            "tx-missing",
            &WorkspaceBaseline {
                workspace_id: "missing-workspace".to_string(),
                ..Default::default()
            },
            &[],
        )
        .expect_err("unregistered workspace cannot create a patch engine");
    assert_eq!(missing.code(), ErrorCode::WorkspaceNotFound);
}

#[test]
fn code_intelligence_indexes_each_registered_workspace_independently() {
    let (_data, first, second, kernel) = kernel_with_two_roots();
    std::fs::create_dir(first.path().join("src")).expect("first source directory");
    std::fs::create_dir(second.path().join("src")).expect("second source directory");
    std::fs::write(first.path().join("src/a.rs"), "fn shared_symbol() {}\n").expect("first source");
    std::fs::write(second.path().join("src/b.rs"), "fn shared_symbol() {}\n")
        .expect("second source");

    let first_result = kernel
        .code_intel
        .inspect(
            &context(&kernel, "workspace-a", OperationClass::CodeIntel),
            &intent(),
            "shared_symbol",
        )
        .expect("first workspace search")
        .symbol
        .expect("first symbol");
    let second_result = kernel
        .code_intel
        .inspect(
            &context(&kernel, "workspace-b", OperationClass::CodeIntel),
            &intent(),
            "shared_symbol",
        )
        .expect("second workspace search")
        .symbol
        .expect("second symbol");
    assert_eq!(first_result.path, "src/a.rs");
    assert_eq!(second_result.path, "src/b.rs");

    let wrong_token = capability(
        &kernel,
        "workspace-a",
        vec![OperationClass::CodeIntel],
        "wrong-code-intel-workspace",
    );
    let mut mismatched_context = context(&kernel, "workspace-b", OperationClass::CodeIntel);
    mismatched_context.capability_token = wrong_token;
    let mismatch = kernel
        .code_intel
        .inspect(&mismatched_context, &intent(), "shared_symbol")
        .expect_err("workspace-bound code-intel token cannot cross roots");
    assert_eq!(mismatch.code(), ErrorCode::PermissionDenied);

    let missing = kernel
        .code_intel
        .inspect(
            &context(&kernel, "missing-workspace", OperationClass::CodeIntel),
            &intent(),
            "shared_symbol",
        )
        .expect_err("unregistered workspace cannot be indexed");
    assert_eq!(missing.code(), ErrorCode::WorkspaceNotFound);
}
