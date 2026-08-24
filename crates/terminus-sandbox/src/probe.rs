//! Effective-control probes (ADR-0035 §8, SPEC §19.3).
//!
//! "Configured is not Enforced": these probes RUN canary programs through a
//! backend's spawn wrapper and MEASURE whether each control held. Results
//! feed the generated platform support matrix; declarations without probe
//! evidence are prohibited.

use crate::profile::SandboxProfile;
use std::path::Path;
use std::time::Duration;
use terminus_kernel_protocol::{CommandSpec, WorkspacePath};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeKind {
    /// Write outside the workspace must fail.
    FilesystemEscape,
    /// Outbound network under `NetworkAccess::Deny` must fail.
    NetworkEgress,
    /// An ambient secret env var must be invisible inside the sandbox.
    AmbientSecretDenial,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeVerdict {
    /// Measured: the control held.
    Enforced,
    /// Measured: the control FAILED (a violation — release blocker).
    Violated,
    /// Could not be measured (no wrapper, tooling absent). Never counts as
    /// enforcement.
    Unmeasurable,
}

impl ProbeKind {
    pub fn id(self) -> &'static str {
        match self {
            ProbeKind::FilesystemEscape => "filesystem_escape",
            ProbeKind::NetworkEgress => "network_egress",
            ProbeKind::AmbientSecretDenial => "ambient_secret_denial",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProbeResult {
    pub backend_id: String,
    pub probe: ProbeKind,
    pub verdict: ProbeVerdict,
    /// Measured observation (stdout excerpt / error class), safe to publish.
    pub detail: String,
}

/// Marker env var planted by the probe harness. A compliant backend strips
/// ambient environment, so the payload must not see it.
const PROBE_SECRET_VAR: &str = "TERMINUS_PROBE_CANARY_SECRET";
const PROBE_SECRET_VALUE: &str = "canary-do-not-expose-0f3c9";

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Run the full probe suite against one backend using `workspace_root` as
/// the mapped workspace directory. Probes are best-effort per platform:
/// anything unmeasurable is reported honestly as `Unmeasurable`.
pub fn run_probes(backend: &dyn crate::SandboxBackend, workspace_root: &Path) -> Vec<ProbeResult> {
    let mut results = vec![
        filesystem_escape_probe(backend, workspace_root),
        ambient_secret_probe(backend, workspace_root),
        network_egress_probe(backend, workspace_root),
    ];
    for r in &mut results {
        r.backend_id = backend.id().to_string();
    }
    results
}

/// Execute `/bin/sh -c script` inside the backend's wrapper for a
/// restrictive profile. The backend constructs its OWN wrapper around the
/// probe payload — no argv splicing — so every layer the wrapper applies
/// (env sanitization, profile rights) applies to the probe exactly as it
/// would to real workloads.
fn execute(
    backend: &dyn crate::SandboxBackend,
    workspace_root: &Path,
    script: &str,
) -> Result<String, String> {
    let mut profile = SandboxProfile::default_restrictive();
    for rule in &mut profile.filesystem {
        let Some(relative) = rule.path.strip_prefix("workspace://") else {
            continue;
        };
        rule.path = if relative.is_empty() {
            workspace_root.display().to_string()
        } else {
            workspace_root.join(relative).display().to_string()
        };
    }
    let cmd = CommandSpec {
        program: "/bin/sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
        cwd: WorkspacePath::new("probe-ws", workspace_root.display().to_string()),
        timeout_ms: PROBE_TIMEOUT.as_millis() as u64,
        ..Default::default()
    };
    let Some((binary, argv)) = backend.spawn_wrapper(&cmd, &profile) else {
        return Err("backend does not wrap spawns".to_string());
    };
    // Plant the canary in the WRAPPER'S environment: a compliant stack must
    // still prevent the payload from seeing it.
    let output = std::process::Command::new(binary)
        .args(&argv)
        .current_dir(workspace_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env(PROBE_SECRET_VAR, PROBE_SECRET_VALUE)
        .output()
        .map_err(|e| format!("spawn failed: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(text.chars().take(400).collect())
}

fn filesystem_escape_probe(
    backend: &dyn crate::SandboxBackend,
    workspace_root: &Path,
) -> ProbeResult {
    let backend_id = backend.id();
    // Attempt to escape the workspace by writing into the OS temp dir,
    // which is OUTSIDE every workspace mapping.
    let escape_target = std::env::temp_dir().join(format!(
        "terminus-fs-escape-probe-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let script = format!(
        "printf x >> '{t}' 2>/dev/null && echo WROTE || echo BLOCKED",
        t = escape_target.display()
    );
    match execute(backend, workspace_root, &script) {
        Ok(out) if out.contains("BLOCKED") => ProbeResult {
            backend_id: backend_id.to_string(),
            probe: ProbeKind::FilesystemEscape,
            verdict: ProbeVerdict::Enforced,
            detail: "write outside workspace rejected".into(),
        },
        Ok(out) if out.contains("WROTE") => {
            let _ = std::fs::remove_file(&escape_target);
            ProbeResult {
                backend_id: backend_id.to_string(),
                probe: ProbeKind::FilesystemEscape,
                verdict: ProbeVerdict::Violated,
                detail: "payload wrote outside the workspace".into(),
            }
        }
        Ok(out) => ProbeResult {
            backend_id: backend_id.to_string(),
            probe: ProbeKind::FilesystemEscape,
            verdict: ProbeVerdict::Unmeasurable,
            detail: format!("ambiguous output: {out}"),
        },
        Err(e) => ProbeResult {
            backend_id: backend_id.to_string(),
            probe: ProbeKind::FilesystemEscape,
            verdict: ProbeVerdict::Unmeasurable,
            detail: e,
        },
    }
}

fn ambient_secret_probe(backend: &dyn crate::SandboxBackend, workspace_root: &Path) -> ProbeResult {
    const BACKEND_PLACEHOLDER: &str = "";
    let script =
        format!("if [ -n \"${PROBE_SECRET_VAR}\" ]; then echo LEAKED; else echo CLEAN; fi");
    match execute(backend, workspace_root, &script) {
        Ok(out) if out.contains("CLEAN") => ProbeResult {
            backend_id: BACKEND_PLACEHOLDER.to_string(),
            probe: ProbeKind::AmbientSecretDenial,
            verdict: ProbeVerdict::Enforced,
            detail: "ambient secret env var invisible".into(),
        },
        Ok(out) if out.contains("LEAKED") => ProbeResult {
            backend_id: BACKEND_PLACEHOLDER.to_string(),
            probe: ProbeKind::AmbientSecretDenial,
            verdict: ProbeVerdict::Violated,
            detail: "ambient environment reached the payload".into(),
        },
        Ok(out) => ProbeResult {
            backend_id: BACKEND_PLACEHOLDER.to_string(),
            probe: ProbeKind::AmbientSecretDenial,
            verdict: ProbeVerdict::Unmeasurable,
            detail: format!("ambiguous output: {out}"),
        },
        Err(e) => ProbeResult {
            backend_id: BACKEND_PLACEHOLDER.to_string(),
            probe: ProbeKind::AmbientSecretDenial,
            verdict: ProbeVerdict::Unmeasurable,
            detail: e,
        },
    }
}

fn network_egress_probe(backend: &dyn crate::SandboxBackend, workspace_root: &Path) -> ProbeResult {
    // Bind a listener the payload must NOT be able to reach.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0));
    let port = match listener {
        Ok(l) => l.local_addr().map(|a| a.port()).unwrap_or(0),
        Err(_) => 0,
    };
    if port == 0 {
        return ProbeResult {
            backend_id: String::new(),
            probe: ProbeKind::NetworkEgress,
            verdict: ProbeVerdict::Unmeasurable,
            detail: "could not bind probe listener".into(),
        };
    }
    // curl exists on macOS and typical Linux runners; its absence is an
    // honest Unmeasurable rather than a fake pass.
    let script = format!(
        "command -v curl >/dev/null 2>&1 || {{ echo NOCURL; exit 0; }}; \
         curl --max-time 2 -o /dev/null http://127.0.0.1:{port}/ 2>/dev/null \
         && echo CONNECTED || echo BLOCKED"
    );
    match execute(backend, workspace_root, &script) {
        Ok(out) if out.contains("BLOCKED") || out.contains("NOCURL") => {
            let detail = if out.contains("NOCURL") {
                "curl unavailable; cannot assert either way".to_string()
            } else {
                "outbound connect refused by sandbox".to_string()
            };
            ProbeResult {
                backend_id: String::new(),
                probe: ProbeKind::NetworkEgress,
                verdict: if out.contains("NOCURL") {
                    ProbeVerdict::Unmeasurable
                } else {
                    ProbeVerdict::Enforced
                },
                detail,
            }
        }
        Ok(out) if out.contains("CONNECTED") => ProbeResult {
            backend_id: String::new(),
            probe: ProbeKind::NetworkEgress,
            verdict: ProbeVerdict::Violated,
            detail: "deny-network payload reached an external listener".into(),
        },
        Ok(out) => ProbeResult {
            backend_id: String::new(),
            probe: ProbeKind::NetworkEgress,
            verdict: ProbeVerdict::Unmeasurable,
            detail: format!("ambiguous output: {out}"),
        },
        Err(e) => ProbeResult {
            backend_id: String::new(),
            probe: ProbeKind::NetworkEgress,
            verdict: ProbeVerdict::Unmeasurable,
            detail: e,
        },
    }
}

/// Aggregate probe results + static enforcement reports into the
/// machine-readable platform support matrix consumed by release decision
/// tooling (SPEC §19.5, §36: declarations derive from artifacts).
pub fn platform_matrix(
    entries: &[(&dyn crate::SandboxBackend, Platform, &[ProbeResult])],
) -> serde_json::Value {
    let rows: Vec<serde_json::Value> = entries
        .iter()
        .map(|(backend, platform, probes)| {
            let report = backend.enforcement_report();
            serde_json::json!({
                "platform": platform,
                "backend": report.backend_id,
                "status": report.status,
                "enforced": report.enforced.iter().map(|f| format!("{f:?}")).collect::<Vec<_>>(),
                "degraded": report.degraded.iter().map(|f| format!("{f:?}")).collect::<Vec<_>>(),
                "unsupported": report.unsupported.iter().map(|f| format!("{f:?}")).collect::<Vec<_>>(),
                "probes": probes.iter().map(|p| serde_json::json!({
                    "probe": p.probe.id(),
                    "verdict": p.verdict,
                    "detail": p.detail,
                })).collect::<Vec<_>>(),
                "notes": report.notes,
            })
        })
        .collect();
    serde_json::json!({
        "schema": "terminus.platform-matrix.v1",
        "generated_from": "effective-control probes (ADR-0035 §8)",
        "rule": "a feature is SUPPORTED only when a probe or argv-proof marks it Enforced; Unmeasurable never counts",
        "rows": rows,
    })
}

/// Host platforms recognized by the matrix generator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum Platform {
    Linux,
    Macos,
    Windows,
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Platform::Linux => write!(f, "linux"),
            Platform::Macos => write!(f, "macos"),
            Platform::Windows => write!(f, "windows"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LocalRestrictiveBackend;

    #[test]
    fn local_backend_wrapperless_probes_are_unmeasurable_not_enforced() {
        let backend = LocalRestrictiveBackend::new();
        let results = run_probes(&backend, std::env::temp_dir().as_path());
        assert_eq!(results.len(), 3);
        for r in &results {
            assert_eq!(
                r.verdict,
                ProbeVerdict::Unmeasurable,
                "wrapperless backend must not claim measured enforcement"
            );
        }
    }

    #[test]
    fn matrix_never_claims_support_from_unmeasurable() {
        let backend = LocalRestrictiveBackend::new();
        let probes = run_probes(&backend, std::env::temp_dir().as_path());
        let matrix = platform_matrix(&[(&backend, Platform::Macos, probes.as_slice())]);
        let row = &matrix["rows"][0];
        assert_eq!(row["status"], "degraded");
        for probe in row["probes"].as_array().unwrap() {
            assert_ne!(probe["verdict"], "enforced");
        }
    }
}
