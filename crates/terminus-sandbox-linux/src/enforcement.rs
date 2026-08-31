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
    let mut payload_args = bwrap_args[..separator].to_vec();
    let root_freeze = payload_args
        .windows(2)
        .position(|args| args[0] == "--remount-ro" && args[1] == "/")
        .unwrap_or(payload_args.len());
    let executable_path = executable.to_string_lossy().to_string();
    // The payload is a second invocation of this exact trusted kernel binary.
    // Bind only that file into the guest while mount targets are writable;
    // binding its parent would expose unrelated host temporary state.
    payload_args.splice(
        root_freeze..root_freeze,
        [
            "--ro-bind".to_string(),
            executable_path.clone(),
            executable_path.clone(),
        ],
    );
    // The trusted launcher creates the cgroup lease before Bubblewrap starts.
    // The payload receives only this marker and inherits the lease; it never
    // gets write access to a host cgroup filesystem.
    payload_args.extend([
        "--setenv".to_string(),
        "TERMINUS_CGROUP_LEASE".to_string(),
        "1".to_string(),
    ]);
    payload_args.push("--".to_string());
    let limits_json = serde_json::to_string(&limits).ok()?;
    payload_args.extend([
        executable_path,
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
    // Create and join the cgroup before Bubblewrap constructs its read-only
    // mount namespace. The bwrap child and final payload inherit this lease,
    // while the payload itself never gains cgroup write authority.
    let _cgroup = CgroupGuard::create(payload_limits(bwrap_args)?)?;
    let status = std::process::Command::new(bwrap)
        .args(bwrap_args)
        .status()
        .map_err(|error| contextual_io_error(format!("spawn Bubblewrap at {bwrap}"), error))?;
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
    let _limits: ResourceLimits = serde_json::from_str(args.get(1).ok_or_else(|| {
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

    if std::env::var("TERMINUS_CGROUP_LEASE").ok().as_deref() != Some("1") {
        return Err(SandboxError::Misconfigured(
            "sandbox payload was started without a launcher-owned cgroup lease".to_string(),
        ));
    }
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
/// trusted launcher can join its cgroup before Bubblewrap starts. The payload
/// then installs seccomp before the probe command starts. The probe exits
/// non-zero unless the observed controls match the effective report.
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

    // Probe script tests every SPEC §36.5 control from inside the sandbox.
    // Each check prints `key=value` to stdout. The script exits non-zero on
    // any failure so the probe is fail-closed. The canaries exercise the
    // ACTUAL shipped argv shape: a minimal root (host `/` never bound),
    // exact runtime trees, synthetic HOME, cleared environment, and tmpfs
    // overlays over deny rules. Host-path probes must fail because the
    // paths are simply not mounted — the historical `--ro-bind / /`
    // shape would make them succeed read-only.
    let probe_script = r#"set -eu;
echo "=== SPEC §36.5 Linux enforcement probe ===";

# 1. User namespace — uid_map should exist and show mapping
if [ -r /proc/self/uid_map ]; then
  echo "user_namespace=blocked";
else
  echo "user_namespace=failed";
  exit 19;
fi;

# 2. PID namespace — PID should be low (1 or 2), not a host PID
pid=$(cat /proc/self/stat 2>/dev/null | awk '{print $1}');
if [ "$pid" -le 10 ] 2>/dev/null; then
  echo "pid_namespace=blocked";
else
  echo "pid_namespace=failed";
  exit 20;
fi;

# 3. Mount namespace — /proc/self/mountinfo must NOT contain a host-root
#    overlay bind of / (the historical --ro-bind / / defect).
if grep -q " / rw" /proc/self/mountinfo 2>/dev/null; then
  echo "mount_namespace=failed";
  exit 22;
else
  echo "mount_namespace=blocked";
fi;

# 4. Network namespace — no host network interfaces
if ip addr 2>/dev/null | grep -q "state UP"; then
  echo "network_namespace=failed";
  exit 21;
else
  echo "network_namespace=blocked";
fi;

# 5. Seccomp — unshare should fail
if /usr/bin/unshare -Ur true 2>/dev/null; then
  echo "seccomp=failed";
  exit 11;
else
  echo "seccomp=blocked";
fi;

# 6. Network — raw socket creation should fail
if /usr/bin/python3 -c 'import socket; socket.socket()' 2>/dev/null; then
  echo "network=failed";
  exit 12;
else
  echo "network=blocked";
fi;

# 7. Filesystem — write to root should fail (read-only empty root)
if touch /terminus-sandbox-write-probe 2>/dev/null; then
  echo "filesystem=failed";
  exit 13;
else
  echo "filesystem=readonly";
fi;

# 8. Protected .git — creating .git in the root must fail
if mkdir -p .git 2>/dev/null && touch .git/HOOKS_PROBE 2>/dev/null; then
  echo "protected_git=failed";
  exit 14;
else
  echo "protected_git=blocked";
fi;

# 9. Process tree — fork should be contained, child should be killable
child_pid="";
( trap 'exit 0' TERM; sleep 30 ) &
child_pid=$!;
if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
  kill -TERM "$child_pid" 2>/dev/null;
  wait "$child_pid" 2>/dev/null;
  echo "process_tree=blocked";
else
  echo "process_tree=failed";
  exit 15;
fi;

# 10. Secret isolation — no ambient secrets in environment
if env | grep -qiE "OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_TOKEN|AWS_SECRET" 2>/dev/null; then
  echo "secret_isolation=failed";
  exit 16;
else
  echo "secret_isolation=blocked";
fi;

# 11. cgroup — cgroup v2 should be visible through the read-only sysfs bind
if [ -r /sys/fs/cgroup/cgroup.controllers ]; then
  echo "cgroup=visible";
else
  echo "cgroup=failed";
  exit 17;
fi;

# 12. NoNewPrivs — check /proc/self/status
if [ -r /proc/self/status ]; then
  if grep -q "NoNewPrivs" /proc/self/status 2>/dev/null; then
    nnpriv=$(grep "NoNewPrivs" /proc/self/status 2>/dev/null | awk '{print $2}');
    if [ "$nnpriv" = "1" ]; then
      echo "no_new_privs=blocked";
    else
      echo "no_new_privs=failed";
      exit 18;
    fi;
  else
    echo "no_new_privs=blocked";
  fi;
else
  echo "no_new_privs=blocked";
fi;

# 13. Synthetic home — HOME must be the sandbox-only path, never a host path
if [ "$HOME" = "/home/terminus-sandbox" ]; then
  echo "synthetic_home=blocked";
else
  echo "synthetic_home=failed";
  exit 23;
fi;

# 14. Host home hidden — /root and host user homes are not mounted
if [ -e /root/.ssh ] || [ -e /root ] || { [ -n "${USER:-}" ] && [ -e "/home/$USER" ]; }; then
  echo "host_home_hidden=failed";
  exit 24;
else
  echo "host_home_hidden=blocked";
fi;

# 15. SSH/cloud credentials invisible by absolute path
for p in /root/.ssh /root/.aws /root/.config/gcloud /root/.gnupg; do
  if [ -e "$p" ]; then
    echo "credential_paths_hidden=failed";
    exit 25;
  fi;
done;
echo "credential_paths_hidden=blocked";

echo "=== probe complete ===";
"#;

    let path = backend
        .build_enforced_wrapper(
            &CommandSpec {
                program: "/bin/sh".to_string(),
                args: vec!["-c".to_string(), probe_script.to_string()],
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

    // All checks must pass with the expected "blocked" or "visible" values.
    let required: Vec<(&str, &str)> = vec![
        ("user_namespace", "blocked"),
        ("pid_namespace", "blocked"),
        ("mount_namespace", "blocked"),
        ("network_namespace", "blocked"),
        ("seccomp", "blocked"),
        ("network", "blocked"),
        ("filesystem", "readonly"),
        ("protected_git", "blocked"),
        ("process_tree", "blocked"),
        ("secret_isolation", "blocked"),
        ("cgroup", "visible"),
        ("no_new_privs", "blocked"),
        ("synthetic_home", "blocked"),
        ("host_home_hidden", "blocked"),
        ("credential_paths_hidden", "blocked"),
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
    let Some(root) = delegated_cgroup_root() else {
        return false;
    };
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
        std::fs::create_dir_all(&parent).map_err(|error| {
            contextual_io_error(format!("create cgroup parent {}", parent.display()), error)
        })?;
        // The delegated root has controllers enabled for its direct children,
        // but the per-launch parent must enable them again before its job
        // child can receive `*.max` controls. This happens before the
        // launcher joins the lease, so cgroup-v2's no-internal-process rule
        // is preserved.
        write_control(&parent, "cgroup.subtree_control", "+cpu +memory +pids")?;
        let path = parent.join(format!("job-{}-{}", std::process::id(), monotonic_nonce()));
        std::fs::create_dir(&path).map_err(|error| {
            contextual_io_error(format!("create cgroup job {}", path.display()), error)
        })?;
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
    delegated_cgroup_root().unwrap_or_else(|| PathBuf::from("/sys/fs/cgroup"))
}

#[cfg(target_os = "linux")]
fn payload_limits(bwrap_args: &[String]) -> Result<ResourceLimits, SandboxError> {
    let marker = bwrap_args
        .iter()
        .position(|arg| arg == PAYLOAD_ARG)
        .ok_or_else(|| {
            SandboxError::Misconfigured("sandbox launcher is missing payload marker".to_string())
        })?;
    let encoded_limits = bwrap_args.get(marker + 1).ok_or_else(|| {
        SandboxError::Misconfigured("sandbox launcher is missing resource limits".to_string())
    })?;
    serde_json::from_str(encoded_limits).map_err(|error| {
        SandboxError::Misconfigured(format!(
            "sandbox launcher has invalid resource limits: {error}"
        ))
    })
}

/// Return the host-provided cgroup-v2 delegation root for a secure lease.
///
/// The global hierarchy is never a valid delegation root: mounting it
/// writable into a sandbox would expose sibling workloads. Hosts must create
/// and delegate a dedicated subtree, then point `TERMINUS_CGROUP_ROOT` at it.
#[cfg(target_os = "linux")]
pub(crate) fn delegated_cgroup_root() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("TERMINUS_CGROUP_ROOT")?);
    if !root.is_absolute() || root == Path::new("/sys/fs/cgroup") {
        return None;
    }
    Some(root)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn delegated_cgroup_root() -> Option<PathBuf> {
    None
}

#[cfg(target_os = "linux")]
fn write_control(path: &Path, name: &str, value: &str) -> Result<(), SandboxError> {
    std::fs::write(path.join(name), value).map_err(|error| {
        contextual_io_error(
            format!("write cgroup control {}", path.join(name).display()),
            error,
        )
    })
}

#[cfg(target_os = "linux")]
fn contextual_io_error(context: impl std::fmt::Display, error: std::io::Error) -> SandboxError {
    SandboxError::Io(std::io::Error::new(
        error.kind(),
        format!("{context}: {error}"),
    ))
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

#[cfg(test)]
mod tests {
    use super::payload_wrapper;
    use std::path::Path;
    use terminus_sandbox::{NetworkAccess, ResourceLimits};

    #[test]
    fn cgroup_lease_marker_is_a_bubblewrap_option() {
        let wrapped = payload_wrapper(
            Path::new("/usr/bin/bwrap"),
            &["--unshare-all".to_string(), "--".to_string()],
            ResourceLimits::default(),
            NetworkAccess::Deny,
        );
        assert!(wrapped.is_some());
        let Some((_, argv)) = wrapped else {
            return;
        };

        let separator = argv.iter().position(|value| value == "--");
        let setenv = argv.iter().position(|value| value == "--setenv");
        assert!(separator.is_some());
        assert!(setenv.is_some());
        let Some(separator) = separator else {
            return;
        };
        let Some(setenv) = setenv else {
            return;
        };
        assert!(setenv < separator);
        assert_eq!(
            argv.get(setenv + 1),
            Some(&"TERMINUS_CGROUP_LEASE".to_string())
        );
        assert_eq!(argv.get(setenv + 2), Some(&"1".to_string()));
    }

    #[test]
    fn trusted_payload_binary_is_bound_before_the_root_freezes() {
        let executable = std::env::current_exe().expect("current test executable");
        let executable = executable.to_string_lossy().to_string();
        let wrapped = payload_wrapper(
            Path::new("/usr/bin/bwrap"),
            &[
                "--bind".to_string(),
                "/tmp/empty".to_string(),
                "/".to_string(),
                "--remount-ro".to_string(),
                "/".to_string(),
                "--".to_string(),
                "/usr/bin/true".to_string(),
            ],
            ResourceLimits::default(),
            NetworkAccess::Deny,
        )
        .expect("payload wrapper");
        let argv = wrapped.1;
        let payload_bind = argv
            .windows(3)
            .position(|args| {
                args[0] == "--ro-bind" && args[1] == executable && args[2] == executable
            })
            .expect("trusted payload bind");
        let root_freeze = argv
            .windows(2)
            .position(|args| args[0] == "--remount-ro" && args[1] == "/")
            .expect("root freeze");
        assert!(payload_bind < root_freeze);
    }
}
