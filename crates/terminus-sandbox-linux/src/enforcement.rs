//! Linux-only enforcement launcher.
//!
//! Bubblewrap must complete namespace setup before the seccomp filter is
//! installed. The kernel process therefore launches a second copy of itself
//! inside the bubblewrap namespace; that payload joins a cgroup v2, installs
//! the filter, and only then starts the requested program. This keeps the
//! setup syscalls needed by bubblewrap outside the payload filter while still
//! making the user process inherit both controls.

// These entrypoints are consumed by the separately packaged kernel
// mini-service. The sandbox crate is also checked independently, where the
// executable entrypoints are intentionally not referenced.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use terminus_sandbox::{NetworkAccess, ResourceLimits, SandboxError};

pub const LAUNCHER_ARG: &str = "--terminus-sandbox-launch";
pub const PAYLOAD_ARG: &str = "--terminus-sandbox-payload";

/// Build the launcher command used by `ProcessManager`.
pub fn payload_wrapper(
    bwrap_path: &Path,
    bwrap_args: &[String],
    limits: ResourceLimits,
    network: NetworkAccess,
) -> Option<(PathBuf, Vec<String>)> {
    let executable = std::env::current_exe().ok()?;
    let separator = bwrap_args.iter().position(|arg| arg == "--")?;
    let mut payload_args = bwrap_args[..=separator].to_vec();
    let limits_json = serde_json::to_string(&limits).ok()?;
    payload_args.extend([
        executable.to_string_lossy().to_string(),
        PAYLOAD_ARG.to_string(),
        limits_json,
        match network {
            NetworkAccess::Deny => "deny",
            NetworkAccess::ProxyRequired => "proxy",
            NetworkAccess::Allow => "allow",
        }
        .to_string(),
        "--".to_string(),
    ]);
    payload_args.extend(bwrap_args[separator + 1..].iter().cloned());

    let mut launcher_args = vec![
        LAUNCHER_ARG.to_string(),
        bwrap_path.to_string_lossy().to_string(),
    ];
    launcher_args.extend(payload_args);
    Some((executable, launcher_args))
}

#[cfg(target_os = "linux")]
pub fn run_launcher(args: &[String]) -> Result<i32, SandboxError> {
    let bwrap = args.get(1).ok_or_else(|| {
        SandboxError::Misconfigured("sandbox launcher missing bwrap path".to_string())
    })?;
    let bwrap_args = args.get(2..).ok_or_else(|| {
        SandboxError::Misconfigured("sandbox launcher missing bwrap arguments".to_string())
    })?;
    let status = std::process::Command::new(bwrap)
        .args(bwrap_args)
        .status()?;
    Ok(status.code().unwrap_or(128))
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
pub fn run_launcher(_args: &[String]) -> Result<i32, SandboxError> {
    Err(SandboxError::Unsupported(
        "Linux sandbox launcher invoked on a non-Linux host".to_string(),
    ))
}

#[cfg(target_os = "linux")]
pub fn run_payload(args: &[String]) -> Result<i32, SandboxError> {
    let limits: ResourceLimits = serde_json::from_str(args.get(1).ok_or_else(|| {
        SandboxError::Misconfigured("sandbox payload missing resource limits".to_string())
    })?)
    .map_err(|error| SandboxError::Misconfigured(format!("invalid resource limits: {error}")))?;
    let network_deny = match args.get(2).map(String::as_str) {
        Some("deny") => true,
        // ProxyRequired has an unshared network namespace. It must retain
        // Unix-domain sockets to reach the mounted broker, while direct
        // network routes remain absent from that namespace.
        Some("proxy") | Some("allow") => false,
        _ => {
            return Err(SandboxError::Misconfigured(
                "sandbox payload missing network mode".to_string(),
            ));
        }
    };
    let separator = args.iter().position(|arg| arg == "--").ok_or_else(|| {
        SandboxError::Misconfigured("sandbox payload missing command".to_string())
    })?;
    let program = args.get(separator + 1).ok_or_else(|| {
        SandboxError::Misconfigured("sandbox payload command is empty".to_string())
    })?;
    let command_args = args.get(separator + 2..).unwrap_or_default();

    let _cgroup = CgroupGuard::create(limits)?;
    install_seccomp(network_deny)?;

    let status = std::process::Command::new(program)
        .args(command_args)
        .status()?;
    Ok(status.code().unwrap_or(128))
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
pub fn run_payload(_args: &[String]) -> Result<i32, SandboxError> {
    Err(SandboxError::Unsupported(
        "Linux sandbox payload invoked on a non-Linux host".to_string(),
    ))
}

/// Run the Linux adversarial probe used by CI and release evidence.
///
/// This must execute from the kernel binary itself: the enforced wrapper
/// relaunches that binary after bubblewrap completes namespace setup, so the
/// payload can install seccomp and join its cgroup before the probe command
/// starts. The probe exits non-zero unless the observed controls match the
/// effective report.
#[cfg(target_os = "linux")]
pub fn run_probe() -> Result<i32, SandboxError> {
    use serde_json::json;
    use std::collections::BTreeMap;
    use terminus_kernel_protocol::{CommandSpec, WorkspacePath};
    use terminus_sandbox::{profile::SandboxProfile, SandboxBackend};

    let backend = super::LinuxSandboxBackend::new();
    let report = backend.enforcement_report();
    if !matches!(report.status, terminus_sandbox::EnforcementStatus::Enforced) {
        return Err(SandboxError::Unsupported(format!(
            "secure Linux probe requires Enforced backend, observed {:?}: {:?}",
            report.status, report.notes
        )));
    }
    let path = backend
        .build_enforced_wrapper(
            &CommandSpec {
                program: "/bin/sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    "set -eu; \
                     test -r /proc/self/status; \
                     test -r /sys/fs/cgroup/cgroup.controllers; \
                     if /usr/bin/unshare -Ur true >/dev/null 2>&1; then \
                       echo seccomp=failed; exit 11; \
                     else echo seccomp=blocked; fi; \
                     if /usr/bin/python3 -c 'import socket; socket.socket()' >/dev/null 2>&1; then \
                       echo network=failed; exit 12; \
                     else echo network=blocked; fi; \
                     if touch /terminus-sandbox-write-probe >/dev/null 2>&1; then \
                       echo filesystem=failed; exit 13; \
                     else echo filesystem=readonly; fi; \
                     echo cgroup=visible"
                        .to_string(),
                ],
                cwd: WorkspacePath::new("probe", "."),
                public_env: BTreeMap::from([(
                    "PATH".to_string(),
                    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_string(),
                )]),
                ..Default::default()
            },
            &SandboxProfile::default_restrictive(),
        )
        .ok_or_else(|| SandboxError::Unsupported("probe wrapper could not be built".to_string()))?;
    let output = std::process::Command::new(path.0)
        .args(path.1)
        .env_clear()
        .env(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        )
        .output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let checks = stdout
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| {
            (
                key.to_string(),
                serde_json::Value::String(value.to_string()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let required = [
        ("seccomp", "blocked"),
        ("network", "blocked"),
        ("filesystem", "readonly"),
        ("cgroup", "visible"),
    ];
    let checks_passed = output.status.success()
        && required.iter().all(|(key, expected)| {
            checks.get(*key).and_then(|value| value.as_str()) == Some(*expected)
        });
    let evidence = json!({
        "status": if checks_passed { "enforced" } else { "failed" },
        "sandbox": {
            "backend": report.backend_id,
            "bubblewrap_path": backend.bwrap_path.as_ref().map(|value| value.display().to_string()),
            "cgroup_mode": "v2",
            "network_mode": "deny",
            "seccomp_filter_sha256": seccomp_policy_hash(true),
            "enforced_features": report.enforced,
        },
        "checks": checks,
        "exit_status": output.status.code().unwrap_or(128),
        "stderr": stderr,
    });
    let rendered = serde_json::to_string_pretty(&evidence)
        .map_err(|error| SandboxError::Unsupported(format!("render probe evidence: {error}")))?;
    println!("{rendered}");
    if checks_passed {
        Ok(0)
    } else {
        Err(SandboxError::Unsupported(
            "Linux adversarial enforcement probe failed".to_string(),
        ))
    }
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
pub fn run_probe() -> Result<i32, SandboxError> {
    Err(SandboxError::Unsupported(
        "Linux enforcement probe invoked on a non-Linux host".to_string(),
    ))
}

#[cfg(target_os = "linux")]
pub fn cgroup_v2_ready() -> bool {
    let root = cgroup_root();
    let Ok(controllers) = std::fs::read_to_string(root.join("cgroup.controllers")) else {
        return false;
    };
    let required = ["cpu", "memory", "pids"];
    if !required
        .iter()
        .all(|controller| controllers.split_whitespace().any(|v| v == *controller))
    {
        return false;
    }
    if std::fs::OpenOptions::new()
        .write(true)
        .open(root.join("cgroup.procs"))
        .is_err()
    {
        return false;
    }
    let probe = root.join(format!(".terminus-probe-{}", std::process::id()));
    if std::fs::create_dir(&probe).is_err() {
        return false;
    }
    let ready = required
        .iter()
        .all(|controller| probe.join(format!("{controller}.max")).is_file());
    let _ = std::fs::remove_dir(&probe);
    ready
}

#[cfg(not(target_os = "linux"))]
pub fn cgroup_v2_ready() -> bool {
    false
}

#[cfg(target_os = "linux")]
pub fn seccomp_policy_hash(network_deny: bool) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update("terminus-seccomp-v1\0");
    hasher.update(if network_deny {
        b"deny".as_slice()
    } else {
        b"allow".as_slice()
    });
    for (syscall, number) in blocked_syscalls(network_deny) {
        hasher.update(syscall.as_bytes());
        hasher.update([0]);
        hasher.update(number.to_le_bytes());
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

#[cfg(not(target_os = "linux"))]
pub fn seccomp_policy_hash(_network_deny: bool) -> String {
    String::new()
}

#[cfg(target_os = "linux")]
struct CgroupGuard {
    parent: PathBuf,
    path: PathBuf,
}

#[cfg(target_os = "linux")]
impl CgroupGuard {
    fn create(limits: ResourceLimits) -> Result<Self, SandboxError> {
        let root = cgroup_root();
        if !root.join("cgroup.controllers").is_file() {
            return Err(SandboxError::Unsupported(
                "cgroup v2 controller inventory is unavailable".to_string(),
            ));
        }
        let parent = root.join("terminus");
        std::fs::create_dir_all(&parent)?;
        let path = parent.join(format!("job-{}-{}", std::process::id(), monotonic_nonce()));
        std::fs::create_dir(&path)?;
        let result = (|| {
            if let Some(memory) = limits.memory_bytes {
                write_control(&path, "memory.max", &memory.to_string())?;
            }
            if let Some(pids) = limits.pids {
                write_control(&path, "pids.max", &pids.to_string())?;
            }
            if let Some(cpu_ms) = limits.cpu_ms {
                let quota = cpu_ms.saturating_mul(1_000).max(1);
                write_control(&path, "cpu.max", &format!("{quota} 100000"))?;
            }
            write_control(&path, "cgroup.procs", &std::process::id().to_string())?;
            Ok::<(), SandboxError>(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_dir(&path);
            return Err(error);
        }
        Ok(Self { parent, path })
    }
}

#[cfg(target_os = "linux")]
impl Drop for CgroupGuard {
    fn drop(&mut self) {
        let _ = std::fs::write(
            self.parent.join("cgroup.procs"),
            std::process::id().to_string(),
        );
        let _ = std::fs::remove_dir(&self.path);
    }
}

#[cfg(target_os = "linux")]
fn cgroup_root() -> PathBuf {
    std::env::var_os("TERMINUS_CGROUP_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/sys/fs/cgroup"))
}

#[cfg(target_os = "linux")]
fn write_control(path: &Path, name: &str, value: &str) -> Result<(), SandboxError> {
    std::fs::write(path.join(name), value).map_err(|error| {
        SandboxError::Io(std::io::Error::new(
            error.kind(),
            format!("write cgroup control {name}: {error}"),
        ))
    })
}

#[cfg(target_os = "linux")]
fn monotonic_nonce() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn blocked_syscalls(network_deny: bool) -> Vec<(&'static str, i64)> {
    let mut syscalls = vec![
        ("ptrace", libc::SYS_ptrace),
        ("mount", libc::SYS_mount),
        ("umount2", libc::SYS_umount2),
        ("pivot_root", libc::SYS_pivot_root),
        ("setns", libc::SYS_setns),
        ("unshare", libc::SYS_unshare),
        ("bpf", libc::SYS_bpf),
        ("perf_event_open", libc::SYS_perf_event_open),
        ("kexec_load", libc::SYS_kexec_load),
        ("init_module", libc::SYS_init_module),
        ("finit_module", libc::SYS_finit_module),
        ("delete_module", libc::SYS_delete_module),
        ("open_by_handle_at", libc::SYS_open_by_handle_at),
        ("name_to_handle_at", libc::SYS_name_to_handle_at),
        ("reboot", libc::SYS_reboot),
        ("swapon", libc::SYS_swapon),
        ("swapoff", libc::SYS_swapoff),
        ("acct", libc::SYS_acct),
        ("sethostname", libc::SYS_sethostname),
        ("setdomainname", libc::SYS_setdomainname),
    ];
    if network_deny {
        syscalls.extend([
            ("socket", libc::SYS_socket),
            ("socketpair", libc::SYS_socketpair),
            ("connect", libc::SYS_connect),
            ("bind", libc::SYS_bind),
            ("listen", libc::SYS_listen),
            ("accept", libc::SYS_accept),
            ("accept4", libc::SYS_accept4),
            ("sendto", libc::SYS_sendto),
            ("sendmsg", libc::SYS_sendmsg),
            ("recvfrom", libc::SYS_recvfrom),
            ("recvmsg", libc::SYS_recvmsg),
            ("getsockopt", libc::SYS_getsockopt),
            ("setsockopt", libc::SYS_setsockopt),
            ("shutdown", libc::SYS_shutdown),
        ]);
    }
    syscalls
}

#[cfg(target_os = "linux")]
fn install_seccomp(network_deny: bool) -> Result<(), SandboxError> {
    use seccompiler::{BpfProgram, SeccompAction, SeccompFilter};
    use std::collections::BTreeMap;
    use std::convert::TryInto;

    let mut rules = BTreeMap::new();
    for (_, syscall) in blocked_syscalls(network_deny) {
        rules.insert(syscall, Vec::new());
    }
    let filter: BpfProgram = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        std::env::consts::ARCH.try_into().map_err(|error| {
            SandboxError::Unsupported(format!("unsupported seccomp architecture: {error:?}"))
        })?,
    )
    .map_err(|error| SandboxError::Unsupported(format!("build seccomp filter: {error}")))?
    .try_into()
    .map_err(|error| SandboxError::Unsupported(format!("compile seccomp filter: {error}")))?;
    seccompiler::apply_filter(&filter)
        .map_err(|error| SandboxError::Unsupported(format!("install seccomp filter: {error}")))
}
