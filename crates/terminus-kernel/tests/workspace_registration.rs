//! Workspace roots are admitted and canonicalized at the Rust boundary.

#![allow(clippy::expect_used)]

use std::path::Path;
use std::sync::Arc;
use tempfile::tempdir;
use terminus_authz::{OperationClass, Scope, TokenBinder, TokenIssuer};
use terminus_kernel::{KernelHandle, WorkspaceService};
use terminus_kernel_protocol::{
    EffectIntent, ErrorCategory, ErrorCode, RequestContext, WorkspacePath,
};

fn register(
    service: &WorkspaceService,
    issuer: &TokenIssuer,
    root_uri: String,
    root: String,
) -> terminus_kernel_protocol::KernelResult<String> {
    let mut context = authorized_context(issuer, OperationClass::Admin, "*", "register");
    context.workspace_id = "*".to_string();
    service.register(
        &context,
        &EffectIntent::default(),
        root_uri,
        root,
        "untrusted",
    )
}

fn test_issuer() -> Arc<TokenIssuer> {
    Arc::new(TokenIssuer::new(
        b"workspace-registration-test-secret".to_vec(),
        "workspace-registration-kernel".to_string(),
        3_600,
    ))
}

fn authorized_context(
    issuer: &TokenIssuer,
    operation: OperationClass,
    workspace_id: &str,
    nonce: &str,
) -> RequestContext {
    let token = issuer
        .mint(
            TokenBinder {
                principal: "workspace-test".to_string(),
                session_id: "session".to_string(),
                task_id: "task".to_string(),
                workspace_id: workspace_id.to_string(),
                kernel_instance_id: String::new(),
            },
            vec![operation],
            Scope::default(),
            None,
            nonce,
        )
        .and_then(|token| token.encode())
        .expect("workspace capability token");
    let mut context = RequestContext::new(format!("request-{nonce}"));
    context.session_id = "session".to_string();
    context.task_id = "task".to_string();
    context.actor_id = "workspace-test".to_string();
    context.workspace_id = workspace_id.to_string();
    context.capability_token = token;
    context
}

fn read_context(issuer: &TokenIssuer, workspace_id: &str, nonce: &str) -> RequestContext {
    authorized_context(issuer, OperationClass::Read, workspace_id, nonce)
}

fn register_root(service: &WorkspaceService, issuer: &TokenIssuer, root: &Path) -> String {
    register(
        service,
        issuer,
        format!("file://{}", root.display()),
        root.display().to_string(),
    )
    .expect("workspace root registration")
}

fn get_workspace(
    service: &WorkspaceService,
    issuer: &TokenIssuer,
    workspace_id: &str,
) -> terminus_kernel_protocol::KernelResult<terminus_kernel::WorkspaceEntry> {
    let context = authorized_context(issuer, OperationClass::Read, workspace_id, "get");
    service.get(&context, workspace_id)
}

#[test]
fn local_workspace_registration_canonicalizes_an_existing_directory() {
    let temporary = tempdir().expect("temporary workspace");
    let nested = temporary.path().join("nested");
    std::fs::create_dir(&nested).expect("nested workspace");
    let issuer = test_issuer();
    let service = WorkspaceService::new(Arc::clone(&issuer));

    let id = register(
        &service,
        &issuer,
        format!("file://{}", nested.display()),
        nested.display().to_string(),
    )
    .expect("existing directory should register");
    let entry = get_workspace(&service, &issuer, &id).expect("registered workspace");

    assert_eq!(
        entry.canonical_root,
        std::fs::canonicalize(&nested)
            .expect("canonical path")
            .display()
            .to_string(),
    );
    assert_eq!(entry.trust, "untrusted");
}

#[cfg(unix)]
#[test]
fn symlink_alias_resolves_to_one_workspace_identity() {
    use std::os::unix::fs::symlink;

    let temporary = tempdir().expect("temporary roots");
    let real = temporary.path().join("real");
    let alias = temporary.path().join("alias");
    std::fs::create_dir(&real).expect("real workspace");
    symlink(&real, &alias).expect("workspace alias");
    let issuer = test_issuer();
    let service = WorkspaceService::new(Arc::clone(&issuer));

    let real_id = register(
        &service,
        &issuer,
        format!("file://{}", real.display()),
        real.display().to_string(),
    )
    .expect("real root registration");
    let alias_id = register(
        &service,
        &issuer,
        format!("file://{}", alias.display()),
        alias.display().to_string(),
    )
    .expect("equivalent alias registration");

    assert_eq!(alias_id, real_id);
    assert_eq!(
        get_workspace(&service, &issuer, &alias_id)
            .expect("registered alias")
            .canonical_root,
        std::fs::canonicalize(&real)
            .expect("canonical real root")
            .display()
            .to_string(),
    );
}

#[test]
fn local_workspace_registration_rejects_a_missing_root() {
    let temporary = tempdir().expect("temporary workspace");
    let missing = temporary.path().join("missing");
    let issuer = test_issuer();
    let service = WorkspaceService::new(Arc::clone(&issuer));

    let error = register(
        &service,
        &issuer,
        format!("file://{}", missing.display()),
        missing.display().to_string(),
    )
    .expect_err("missing directory must fail closed");

    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    assert_eq!(error.category(), ErrorCategory::Validation);
}

#[test]
fn local_workspace_registration_rejects_a_file() {
    let temporary = tempdir().expect("temporary workspace");
    let file = temporary.path().join("not-a-directory");
    std::fs::write(&file, b"not a workspace").expect("test file");
    let issuer = test_issuer();
    let service = WorkspaceService::new(Arc::clone(&issuer));

    let error = register(
        &service,
        &issuer,
        format!("file://{}", file.display()),
        file.display().to_string(),
    )
    .expect_err("file root must fail closed");

    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    assert_eq!(error.category(), ErrorCategory::Validation);
}

#[test]
fn durable_workspace_registration_survives_reopen() {
    let temporary = tempdir().expect("temporary registry");
    let workspace = tempdir().expect("temporary workspace");
    let registry_path = temporary.path().join("workspaces.sqlite");
    let issuer = test_issuer();
    let service =
        WorkspaceService::open(registry_path.clone(), Arc::clone(&issuer)).expect("open registry");
    let id = register_root(&service, &issuer, workspace.path());
    drop(service);

    let reopened =
        WorkspaceService::open(registry_path, Arc::clone(&issuer)).expect("reopen registry");
    let entry = get_workspace(&reopened, &issuer, &id).expect("workspace survives restart");
    assert_eq!(
        entry.canonical_root,
        std::fs::canonicalize(workspace.path())
            .expect("canonical workspace")
            .display()
            .to_string(),
    );
}

#[test]
fn durable_registry_adopts_an_existing_control_plane_workspace_id() {
    let temporary = tempdir().expect("temporary registry");
    let workspace = tempdir().expect("temporary workspace");
    let registry_path = temporary.path().join("workspaces.sqlite");
    let issuer = test_issuer();
    let service =
        WorkspaceService::open(registry_path.clone(), Arc::clone(&issuer)).expect("open registry");
    let generated_id = register_root(&service, &issuer, workspace.path());
    let authoritative_id = "existing-control-workspace";
    let admin_context = authorized_context(&issuer, OperationClass::Admin, "*", "adopt");

    let adopted_id = service
        .register_with_id(
            &admin_context,
            &EffectIntent::default(),
            format!("file://{}", workspace.path().display()),
            workspace.path().display().to_string(),
            "untrusted",
            Some(authoritative_id),
        )
        .expect("existing control-plane identity is adopted");
    assert_eq!(adopted_id, authoritative_id);
    assert!(get_workspace(&service, &issuer, &generated_id).is_err());
    drop(service);

    let reopened =
        WorkspaceService::open(registry_path, Arc::clone(&issuer)).expect("reopen registry");
    let entry = get_workspace(&reopened, &issuer, authoritative_id)
        .expect("adopted identity survives restart");
    assert_eq!(
        entry.canonical_root,
        std::fs::canonicalize(workspace.path())
            .expect("canonical workspace")
            .display()
            .to_string(),
    );
}

#[test]
fn requested_workspace_id_cannot_replace_a_different_root() {
    let first = tempdir().expect("first workspace");
    let second = tempdir().expect("second workspace");
    let issuer = test_issuer();
    let service = WorkspaceService::new(Arc::clone(&issuer));
    let authoritative_id = "stable-workspace-id";
    let first_context = authorized_context(&issuer, OperationClass::Admin, "*", "first");
    service
        .register_with_id(
            &first_context,
            &EffectIntent::default(),
            format!("file://{}", first.path().display()),
            first.path().display().to_string(),
            "untrusted",
            Some(authoritative_id),
        )
        .expect("first root registration");

    let second_context = authorized_context(&issuer, OperationClass::Admin, "*", "second");
    let error = service
        .register_with_id(
            &second_context,
            &EffectIntent::default(),
            format!("file://{}", second.path().display()),
            second.path().display().to_string(),
            "untrusted",
            Some(authoritative_id),
        )
        .expect_err("a requested id cannot replace another root");
    assert_eq!(error.code(), ErrorCode::AlreadyExists);
    assert_eq!(error.category(), ErrorCategory::Conflict);
}

#[test]
fn file_reads_are_isolated_by_registered_root_and_capability_binding() {
    let data = tempdir().expect("kernel data");
    let first = tempdir().expect("first workspace");
    let second = tempdir().expect("second workspace");
    std::fs::write(first.path().join("same.txt"), b"first").expect("first fixture");
    std::fs::write(second.path().join("same.txt"), b"second").expect("second fixture");

    let kernel = KernelHandle::new(data.path().to_path_buf()).expect("kernel");
    let first_id = register_root(&kernel.workspaces, &kernel.token_issuer, first.path());
    let second_id = register_root(&kernel.workspaces, &kernel.token_issuer, second.path());
    let first_context = read_context(&kernel.token_issuer, &first_id, "first-read");
    let first_path = WorkspacePath::new(&first_id, "same.txt");
    let (first_bytes, _) = kernel
        .files
        .read(&first_context, &EffectIntent::default(), &first_path)
        .expect("first workspace read");
    assert_eq!(first_bytes, b"first");

    let cross_root = kernel
        .files
        .read(
            &first_context,
            &EffectIntent::default(),
            &WorkspacePath::new(&second_id, "same.txt"),
        )
        .expect_err("workspace-bound token must not cross roots");
    assert_eq!(cross_root.code(), ErrorCode::PermissionDenied);

    let second_context = read_context(&kernel.token_issuer, &second_id, "second-read");
    let (second_bytes, _) = kernel
        .files
        .read(
            &second_context,
            &EffectIntent::default(),
            &WorkspacePath::new(&second_id, "same.txt"),
        )
        .expect("second workspace read");
    assert_eq!(second_bytes, b"second");

    drop(kernel);
    let restarted = KernelHandle::new(data.path().to_path_buf()).expect("restarted kernel");
    let restarted_context = read_context(&restarted.token_issuer, &first_id, "restart-read");
    let (restarted_bytes, _) = restarted
        .files
        .read(
            &restarted_context,
            &EffectIntent::default(),
            &WorkspacePath::new(&first_id, "same.txt"),
        )
        .expect("registered root survives kernel restart");
    assert_eq!(restarted_bytes, b"first");

    let unknown_context = read_context(&restarted.token_issuer, "missing", "missing-read");
    let unknown = restarted
        .files
        .read(
            &unknown_context,
            &EffectIntent::default(),
            &WorkspacePath::new("missing", "same.txt"),
        )
        .expect_err("unknown workspace must fail closed");
    assert_eq!(unknown.code(), ErrorCode::WorkspaceNotFound);
}
