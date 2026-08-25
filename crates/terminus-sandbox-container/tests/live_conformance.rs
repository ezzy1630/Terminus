//! Live OCI-runtime conformance for the fixed command shape
//! (deep-audit release blocker 0, finding 3.2).
//!
//! Skipped unless `TERMINUS_CONTAINER_CONFORMANCE_IMAGE` names a
//! digest-pinned image (e.g. produced in CI via
//! `docker pull alpine@sha256:...`). Static unit tests prove argv SHAPE;
//! this test proves RUNTIME behavior: the requested program actually
//! executes, stdio/exit codes propagate, the workspace mount is exact,
//! host paths stay invisible, and cleanup leaves no residue.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

use std::process::Command;
use terminus_kernel_protocol::{CommandSpec, WorkspacePath};
use terminus_sandbox::profile::{
    FilesystemAccess, FilesystemRule, NetworkAccess, ProcessAccess, ResourceLimits, SandboxProfile,
    SecretsAccess,
};
use terminus_sandbox_container::{ContainerSandboxBackend, HardenedOptions};

fn conformance_image() -> Option<String> {
    std::env::var("TERMINUS_CONTAINER_CONFORMANCE_IMAGE")
        .ok()
        .filter(|image| image.contains("@sha256:"))
}

fn materialized_profile(ws: &str) -> SandboxProfile {
    SandboxProfile {
        id: "conformance".to_string(),
        filesystem: vec![FilesystemRule {
            path: ws.to_string(),
            access: FilesystemAccess::ReadWrite,
        }],
        network: NetworkAccess::Deny,
        process: ProcessAccess::AllowWithLimits,
        secrets: SecretsAccess::BrokeredCapabilities,
        resources: ResourceLimits::default(),
        plugins_ambient_authority: false,
    }
}

fn run_wrapper(
    backend: &ContainerSandboxBackend,
    profile: &SandboxProfile,
    ws: &str,
    program: &str,
    args: &[&str],
) -> std::process::Output {
    let cmd = CommandSpec {
        program: program.to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: WorkspacePath {
            workspace_id: "ws".to_string(),
            relative_path: ws.to_string(),
        },
        timeout_ms: 30_000,
        ..Default::default()
    };
    let (bin, argv) = backend
        .spawn_wrapper(&cmd, profile)
        .expect("wrapper must be produced for a configured backend");
    Command::new(bin)
        .args(&argv)
        .env_clear()
        .output()
        .expect("spawn docker")
}

#[test]
fn live_container_executes_requested_program_with_exact_mounts() {
    let Some(image) = conformance_image() else {
        eprintln!("skipping: TERMINUS_CONTAINER_CONFORMANCE_IMAGE not set");
        return;
    };
    let backend = ContainerSandboxBackend::configure("docker", &image, 1)
        .expect("pinned image")
        .with_hardened(HardenedOptions::default());

    let temp = tempfile::tempdir().expect("worktree");
    let ws = temp.path().display().to_string();
    std::fs::write(temp.path().join("marker.txt"), b"terminus").expect("marker");
    let profile = materialized_profile(&ws);

    // 1. Requested process executes; stdout/exit propagate.
    let out = run_wrapper(&backend, &profile, &ws, "/bin/echo", &["conformance-ok"]);
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("conformance-ok"));

    // 2. Workdir is the exact workspace mount.
    let out = run_wrapper(
        &backend,
        &profile,
        &ws,
        "/bin/sh",
        &["-c", "pwd && cat marker.txt"],
    );
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains(&ws), "workdir mismatch: {stdout}");
    assert!(
        stdout.contains("terminus"),
        "workspace content invisible: {stdout}"
    );

    // 3. Host paths outside the exact mounts are invisible.
    let out = run_wrapper(
        &backend,
        &profile,
        &ws,
        "/bin/sh",
        &[
            "-c",
            "test ! -e /root/.ssh && test ! -e /usr/local/bin/docker && echo hidden-ok",
        ],
    );
    assert!(
        out.status.success(),
        "host paths leaked: {String}",
        String = String::from_utf8_lossy(&out.stderr)
    );

    // 4. Cleanup leaves no container residue.
    let residue = Command::new("docker")
        .args(["ps", "-a", "--format", "{{.Image}} {{.Status}}"])
        .output()
        .expect("docker ps");
    let text = String::from_utf8_lossy(&residue.stdout);
    assert!(
        !text.contains(&image),
        "container residue after --rm run: {text}"
    );
}
