//! Platform support-matrix generator (ADR-0035 §8).
//!
//! Runs effective-control probes against every backend available on THIS
//! host and emits `terminus.platform-matrix.v1` JSON. Release tooling
//! consumes this artifact; declarations without it are prohibited
//! (SPEC §19.5, §36).
//!
//! Usage: `cargo run -p terminus-sandbox --example platform-probes [out.json]`

#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::path::PathBuf;
use std::sync::Arc;
use terminus_sandbox::{run_probes, LocalRestrictiveBackend, Platform, SandboxBackend};

fn main() {
    let out_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "platform-probes.json".to_string());

    let platform = if cfg!(target_os = "linux") {
        Platform::Linux
    } else if cfg!(target_os = "macos") {
        Platform::Macos
    } else {
        Platform::Windows
    };

    let mut backends: Vec<Arc<dyn SandboxBackend>> = vec![Arc::new(LocalRestrictiveBackend::new())];

    #[cfg(target_os = "linux")]
    backends.insert(
        0,
        Arc::new(terminus_sandbox_linux::LinuxSandboxBackend::new()) as Arc<dyn SandboxBackend>,
    );

    #[cfg(target_os = "macos")]
    {
        let macos = terminus_sandbox_macos::MacOsSandboxBackend::new();
        if macos.is_seatbelt_available() {
            backends.insert(
                0,
                Arc::new(macos.with_workspace_root(std::env::temp_dir()))
                    as Arc<dyn SandboxBackend>,
            );
        }
    }

    // Container/microVM backends require external runtime configuration;
    // when absent they report Unsupported and are excluded from probing
    // rather than fabricating results.
    let mut all_probes = Vec::new();
    for backend in &backends {
        let probes = run_probes(backend.as_ref(), &std::env::temp_dir());
        println!(
            "backend {}: {}",
            backend.id(),
            probes
                .iter()
                .map(|p| format!("{}={:?} ({})", p.probe.id(), p.verdict, p.detail))
                .collect::<Vec<_>>()
                .join(" | ")
        );
        all_probes.push(probes);
    }

    let refs: Vec<(
        &dyn SandboxBackend,
        Platform,
        &[terminus_sandbox::ProbeResult],
    )> = backends
        .iter()
        .zip(all_probes.iter())
        .map(|(b, p)| (b.as_ref(), platform, p.as_slice()))
        .collect();
    let matrix = terminus_sandbox::platform_matrix(&refs);

    let json = serde_json::to_vec_pretty(&matrix).expect("serialize matrix");
    let destination = PathBuf::from(out_path);
    if let Some(parent) = destination.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&destination, json).expect("write matrix");
    println!("matrix written to {}", destination.display());
}
