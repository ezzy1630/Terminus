//! macOS sandbox backend (SPEC §13.4, ADR-0035 §4): real **Seatbelt**
//! profile generation via `sandbox-exec`.
//!
//! This build TRANSLATES [`SandboxProfile`] into a deny-by-default Seatbelt
//! `.sb` program:
//!
//! - every `file-read*` / `file-write*` right is denied by default;
//! - reads are granted from an EXPLICIT list of system, developer-toolchain
//!   and workspace trees — never `(subpath "/")`. The previous whole-
//!   filesystem read allowance made `~/.ssh`, `~/.aws` and every other
//!   ambient credential readable from inside the sandbox;
//! - the workspace root is the WRITABLE root, minus write-protection
//!   overlays (`.git/hooks`, `.git/config`) and full-deny overlays
//!   (`.terminus*`, `credentials`);
//! - the kernel-provisioned scratch directory is read-write and exported as
//!   `TMPDIR`/`TMP`/`TEMP` (the darwin per-user temp dir itself is NOT
//!   writable, so a payload cannot use it to escape the workspace);
//! - `NetworkAccess::Deny` emits no `network-*` allowance at all;
//! - `ProcessAccess::AllowWithLimits` permits exec/fork but nothing else;
//! - secrets are broker-only: no ambient environment reach-through exists
//!   in the generated profile, and the payload launches under `env -i` with
//!   an allowlist/denylist applied to the caller's `public_env`.
//!
//! Rule ordering matters: Seatbelt resolves to the LAST matching rule, so
//! the generator emits allowances first (least specific first), then the
//! profile's own denials, then an unconditional secret-path denial block.
//!
//! Honesty contract: `Enforced` claims cover exactly what the generated
//! profile constrains. Seatbelt cannot provide seccomp, cgroups, or
//! namespace semantics, so those stay Degraded/Unsupported. When
//! `sandbox-exec` is absent the backend reports `Unsupported` and rejects
//! isolation profiles — fail closed (SPEC §19.4).

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use terminus_sandbox::profile::{FilesystemAccess, NetworkAccess, ProcessAccess, SandboxProfile};
use terminus_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use terminus_sandbox::{SandboxBackend, SandboxError};

#[derive(Debug, Clone, Default)]
pub struct MacOsSandboxBackend {
    /// Resolved path to `sandbox-exec`. `None` means not available.
    sandbox_exec_path: Option<PathBuf>,
    /// Host directory that backs `workspace://` rules.
    workspace_root: Option<PathBuf>,
}

impl MacOsSandboxBackend {
    /// Probe `$PATH` for `sandbox-exec`.
    pub fn new() -> Self {
        Self {
            sandbox_exec_path: which_sandbox_exec(),
            workspace_root: None,
        }
    }

    pub fn with_mocked_sandbox_exec(available: bool) -> Self {
        let mut b = Self::default();
        if available {
            b.sandbox_exec_path = Some(PathBuf::from("/usr/bin/sandbox-exec"));
        }
        b
    }

    /// Map `workspace://` rules onto a concrete host directory.
    pub fn with_workspace_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.workspace_root = Some(root.into());
        self
    }

    pub fn is_seatbelt_available(&self) -> bool {
        self.sandbox_exec_path.is_some()
    }
}

// ---------------------------------------------------------------------------
// Read allowances
// ---------------------------------------------------------------------------

/// System trees every macOS process needs in order to start and run.
///
/// `(literal "/")` is separate and NOT optional: dyld reads the root vnode
/// before anything else, and without it every payload dies with SIGABRT
/// before `main`.
const SYSTEM_READ_TREES: &[&str] = &[
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/opt/homebrew",
    "/opt/local",
    "/usr/local",
    "/nix",
    "/private/etc",
    // dyld shared-cache metadata, timezone database, launchd databases.
    "/private/var/db",
    // `/bin/sh` resolves its personality through `/var/select/sh`.
    "/private/var/select",
    // `/etc/resolv.conf` is a symlink into here; libSystem stats it.
    "/private/var/run",
    "/dev",
    // Command-line tools and the active Xcode. `git`, `clang` and friends
    // in `/usr/bin` are `xcrun` shims that dlopen out of the developer dir.
    "/Library/Developer",
    "/Applications/Xcode.app",
];

/// Device nodes a payload may write to.
const DEVICE_WRITE_PATHS: &[&str] = &[
    "/dev/null",
    "/dev/zero",
    "/dev/tty",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/fd",
    "/dev/dtracehelper",
];

/// Toolchain roots under the invoking user's home. Read-only: a payload may
/// USE the toolchain but may not mutate it (poisoning `~/.cargo/bin` would
/// survive the sandbox).
const HOME_READ_TREES: &[&str] = &[
    ".cargo",
    ".rustup",
    ".bun",
    ".nvm",
    ".volta",
    ".local",
    ".npm",
    // git refuses to run at all when it cannot read its own config.
    ".config/git",
];

/// Individual files under the home directory admitted for reading.
const HOME_READ_FILES: &[&str] = &[".gitconfig"];

/// Package-manager caches and registries under the invoking user's home that
/// must be WRITABLE.
///
/// Without these, every offline/cached install path fails inside the sandbox
/// — including `cargo build` and `cargo test`, which are the verification
/// commands for this repository. They hold downloaded artifacts and lock
/// files, not credentials; the credential files that live alongside them
/// (`~/.cargo/credentials*`, `~/.npmrc`, `~/.pypirc`) stay denied below.
///
/// `~/.rustup/toolchains` is deliberately absent: poisoning a toolchain
/// binary would survive the sandbox, so only the download staging areas are
/// writable.
const HOME_WRITE_TREES: &[&str] = &[
    // cargo: registry index and unpacked sources, git checkouts, the build
    // lock, and the installed-binary manifests. The last three are files
    // rather than directories, which `subpath` still covers.
    ".cargo/registry",
    ".cargo/git",
    ".cargo/.package-cache",
    ".cargo/.crates.toml",
    ".cargo/.crates2.json",
    ".rustup/downloads",
    ".rustup/tmp",
    ".bun/install/cache",
    ".npm/_cacache",
    ".npm/_logs",
    // uv, pip, ruff, mypy and prettier all cache under the XDG default.
    ".cache",
    // Homebrew and pip on macOS.
    "Library/Caches",
];

/// Writable cache roots general-purpose enough that some tool may drop a
/// credential file into them. Any path containing `credentials` under these
/// roots is denied even though the surrounding tree is writable.
const HOME_CACHE_CREDENTIAL_ROOTS: &[&str] = &[".cache", "Library/Caches"];

/// Trees under the home directory denied unconditionally, even if some
/// broader rule above would otherwise admit them.
const HOME_DENY_TREES: &[&str] = &[
    ".ssh",
    ".aws",
    ".config/gcloud",
    // gcloud's application-default credentials cache, inside the otherwise
    // writable `~/.cache` tree.
    ".cache/gcloud",
    ".gnupg",
    ".claude",
    ".terminus",
    "Library/Keychains",
    // The kernel's own state directory when it lives under the home dir.
    "Library/Application Support/Terminus",
];

/// Individual credential files denied unconditionally.
///
/// `.git-credentials` is on this list because this backend deliberately
/// ADMITS `~/.gitconfig`, and a `[credential] helper = store` entry there
/// points straight at it.
const HOME_DENY_FILES: &[&str] = &[
    ".netrc",
    ".git-credentials",
    ".codex/auth.json",
    ".npmrc",
    ".pypirc",
    // crates.io publish tokens. These sit directly beside the now-writable
    // `~/.cargo/registry`, and were READABLE before this list gained them:
    // the old `~/.cargo` read-only grant covered them.
    ".cargo/credentials",
    ".cargo/credentials.toml",
    // Hugging Face writes its API token into the cache tree.
    ".cache/huggingface/token",
];

/// Absolute paths denied unconditionally regardless of the home directory.
/// `dslocal` holds the local directory-service records (including shadow
/// hashes); POSIX permissions already block a non-root payload, but the
/// profile should not depend on that.
const GLOBAL_DENY_TREES: &[&str] = &[
    "/Library/Keychains",
    "/private/etc/master.passwd",
    "/private/var/db/dslocal",
    "/private/var/db/shadow",
];

// ---------------------------------------------------------------------------
// Environment contract
// ---------------------------------------------------------------------------

/// Environment names the KERNEL owns. A caller-supplied value is dropped so
/// the kernel-provisioned scratch directory always wins.
const KERNEL_OWNED_ENV: &[&str] = &["TMPDIR", "TMP", "TEMP"];

/// Substrings that mark an environment name as credential-bearing.
const ENV_DENY_SUBSTRINGS: &[&str] = &[
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "PASSPHRASE",
];

/// Prefixes whose whole namespace is provider/cloud credential material, or
/// a loader-injection vector.
const ENV_DENY_PREFIXES: &[&str] = &["AWS_", "ANTHROPIC_", "OPENAI_", "DYLD_", "LD_"];

/// Exact names denied outright.
const ENV_DENY_EXACT: &[&str] = &["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO"];

/// True when `name` must never reach the payload, even if the caller
/// supplied it in `public_env`.
#[must_use]
pub fn env_name_is_denied(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if ENV_DENY_EXACT.contains(&upper.as_str()) {
        return true;
    }
    if KERNEL_OWNED_ENV.contains(&upper.as_str()) {
        return true;
    }
    if ENV_DENY_PREFIXES
        .iter()
        .any(|prefix| upper.starts_with(prefix))
    {
        return true;
    }
    ENV_DENY_SUBSTRINGS
        .iter()
        .any(|needle| upper.contains(needle))
}

/// PATH used when the caller supplies none. Real toolchains arrive through
/// the caller's PATH (the control plane forwards its own).
const FALLBACK_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Escape a host path for inclusion in a Seatbelt string literal. Without
/// this a workspace directory containing `"` could terminate the string and
/// inject arbitrary profile clauses.
fn sb_escape(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            // Control characters cannot appear in a profile literal; drop
            // them rather than emitting an unparseable profile.
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

/// The path plus its symlink-resolved form when they differ. Seatbelt
/// matches on the RESOLVED path, so an allowance for a symlinked tree (this
/// machine's `/Applications/Xcode.app` → an external volume) is inert unless
/// the target is named too.
fn path_variants(path: &str) -> Vec<String> {
    let mut variants = vec![path.to_string()];
    if let Ok(canonical) = std::fs::canonicalize(path) {
        let canonical = canonical.display().to_string();
        if canonical != path {
            variants.push(canonical);
        }
    }
    variants
}

fn push_rule(sb: &mut String, verb: &str, operations: &str, path: &str) {
    for variant in path_variants(path) {
        push_rule_exact(sb, verb, operations, &variant);
    }
}

/// Emit a rule for exactly this path, without symlink resolution. Used for
/// device nodes: `/dev/stdout` resolves to whatever the KERNEL's stdout
/// happens to be, and following it would hand the payload write access to
/// the kernel's own log file.
fn push_rule_exact(sb: &mut String, verb: &str, operations: &str, path: &str) {
    sb.push_str(&format!(
        "({verb} {operations} (subpath \"{}\"))\n",
        sb_escape(path)
    ));
}

/// Depth of a Seatbelt path in POSIX components; used to order allowances
/// least-specific first so a nested rule is the LAST match. This must not use
/// the build host's path parser because the generated policy always targets
/// macOS, including when its unit tests compile on Windows.
fn path_depth(path: &str) -> usize {
    path.split('/')
        .filter(|component| !component.is_empty())
        .count()
}

fn seatbelt_path_is_within(path: &Path, parent: &Path) -> bool {
    let path = path.to_string_lossy();
    let parent = parent.to_string_lossy();
    let parent = parent.trim_end_matches('/');
    if parent.is_empty() {
        return path.starts_with('/');
    }
    path == parent
        || path
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

/// The invoking user's home directory, or `None` when `HOME` is unset.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("TERMINUS_USER_HOME")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|home| {
            let home = home.as_path();
            home.is_absolute() && home != Path::new("/")
        })
}

/// The darwin per-user temp directory (`confstr(_CS_DARWIN_USER_TEMP_DIR)`),
/// symlink-resolved. Derived from `TMPDIR`, falling back to `getconf` — the
/// crate forbids `unsafe`, so `confstr` is reached through the shipped CLI
/// rather than through FFI.
fn darwin_user_dir(kind: &str, env_fallback: Option<PathBuf>) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        if let Ok(output) = std::process::Command::new("/usr/bin/getconf")
            .arg(kind)
            .stderr(std::process::Stdio::null())
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() {
                let path = PathBuf::from(text);
                return Some(std::fs::canonicalize(&path).unwrap_or(path));
            }
        }
    }
    env_fallback.map(|path| std::fs::canonicalize(&path).unwrap_or(path))
}

fn darwin_user_temp_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| darwin_user_dir("DARWIN_USER_TEMP_DIR", Some(std::env::temp_dir())))
        .as_deref()
}

/// The ACTIVE developer directory, symlink-resolved.
///
/// `/usr/bin/git`, `/usr/bin/clang` and friends are `xcrun` shims that
/// dlopen `libxcrun.dylib` out of whichever Xcode `xcode-select` points at.
/// That is `/Applications/Xcode.app` on a default install but
/// `/Applications/Xcode_<version>.app` on CI runners, and it may be a
/// symlink onto another volume — hardcoding the default path leaves `git`
/// unable to start on both. Resolved once per process.
fn active_developer_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        if !cfg!(target_os = "macos") {
            return None;
        }
        let raw = match std::env::var_os("DEVELOPER_DIR") {
            Some(value) => PathBuf::from(value),
            None => {
                let output = std::process::Command::new("/usr/bin/xcode-select")
                    .arg("-p")
                    .stderr(std::process::Stdio::null())
                    .output()
                    .ok()?;
                let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if text.is_empty() {
                    return None;
                }
                PathBuf::from(text)
            }
        };
        // `<Xcode>.app/Contents/Developer` → allow the whole bundle, which
        // is where the shared frameworks and toolchains live.
        let bundle = raw
            .ancestors()
            .find(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
            })
            .map_or_else(|| raw.clone(), Path::to_path_buf);
        Some(std::fs::canonicalize(&bundle).unwrap_or(bundle))
    })
    .as_deref()
}

fn darwin_user_cache_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        // Fallback: the cache dir is the `C` sibling of the `T` temp dir.
        let sibling = darwin_user_temp_dir()
            .filter(|dir| dir.file_name() == Some(std::ffi::OsStr::new("T")))
            .and_then(|dir| dir.parent())
            .map(|parent| parent.join("C"));
        darwin_user_dir("DARWIN_USER_CACHE_DIR", sibling)
    })
    .as_deref()
}

/// Translate a profile filesystem rule path into a macOS Seatbelt path.
fn map_rule_path(rule_path: &str, workspace_root: Option<&Path>) -> Option<String> {
    if let Some(rest) = rule_path.strip_prefix("workspace://") {
        let root = workspace_root?;
        if rest.is_empty() {
            Some(root.display().to_string())
        } else {
            let root = root.to_string_lossy();
            Some(format!(
                "{}/{}",
                root.trim_end_matches('/'),
                rest.trim_start_matches('/')
            ))
        }
    } else if rule_path.starts_with('/') {
        Some(rule_path.to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Profile generation
// ---------------------------------------------------------------------------

/// Generate the Seatbelt `.sb` text for a restrictive profile. Deny-by-
/// default with explicit allowances only.
pub fn generate_seatbelt_profile(
    profile: &SandboxProfile,
    workspace_root: Option<&Path>,
) -> Result<String, SandboxError> {
    generate_seatbelt_profile_with_temp_dir(profile, workspace_root, darwin_user_temp_dir())
}

fn generate_seatbelt_profile_with_temp_dir(
    profile: &SandboxProfile,
    workspace_root: Option<&Path>,
    user_temp_dir: Option<&Path>,
) -> Result<String, SandboxError> {
    // Security refusal first: ambient authority never generates a profile.
    if matches!(
        profile.secrets,
        terminus_sandbox::SecretsAccess::AmbientEnvironment
    ) {
        return Err(SandboxError::Misconfigured(
            "ambient secrets not permitted".into(),
        ));
    }
    if profile.plugins_ambient_authority {
        return Err(SandboxError::Misconfigured(
            "ambient plugin authority not permitted".into(),
        ));
    }

    let mut mapped_filesystem = profile
        .filesystem
        .iter()
        .map(|rule| {
            let host = map_rule_path(&rule.path, workspace_root).ok_or_else(|| {
                SandboxError::Misconfigured(format!(
                    "filesystem rule `{}` is not an absolute path and has no concrete workspace root",
                    rule.path
                ))
            })?;
            Ok((rule, host))
        })
        .collect::<Result<Vec<_>, SandboxError>>()?;
    // Least specific first: Seatbelt resolves to the last matching rule, so
    // a nested overlay must be emitted after the parent it narrows.
    mapped_filesystem.sort_by_key(|(_, host)| path_depth(host));

    let mut sb = String::new();
    sb.push_str("(version 1)\n");
    sb.push_str("(deny default)\n");

    // ---- darwin userland plumbing ---------------------------------------
    sb.push_str("; darwin userland plumbing: read-only system trees only\n");
    sb.push_str("(allow sysctl-read)\n");
    sb.push_str("(allow mach-lookup)\n");
    sb.push_str("(allow iokit-get-properties)\n");
    // Path resolution: stat()/lstat() on ancestors is required by getcwd(),
    // by dyld, and by every interpreter that probes for a config file.
    // Metadata reveals existence and size only; content, directory listings
    // and the explicit secret denials below are unaffected.
    sb.push_str("(allow file-read-metadata)\n");
    // dyld reads the root vnode itself before main().
    sb.push_str("(allow file-read* (literal \"/\"))\n");
    for tree in SYSTEM_READ_TREES {
        push_rule(&mut sb, "allow", "file-read*", tree);
    }
    for device in DEVICE_WRITE_PATHS {
        push_rule_exact(&mut sb, "allow", "file-read* file-write*", device);
    }
    sb.push_str("(allow file-read* (literal \"/dev/urandom\"))\n");
    sb.push_str("(allow file-read* (literal \"/dev/random\"))\n");
    if let Some(developer) = active_developer_dir() {
        push_rule(
            &mut sb,
            "allow",
            "file-read*",
            &developer.display().to_string(),
        );
    }

    // ---- toolchain roots under the invoking user's home ------------------
    if let Some(home) = home_dir() {
        for tree in HOME_READ_TREES {
            push_rule(
                &mut sb,
                "allow",
                "file-read*",
                &home.join(tree).display().to_string(),
            );
        }
        for file in HOME_READ_FILES {
            push_rule(
                &mut sb,
                "allow",
                "file-read*",
                &home.join(file).display().to_string(),
            );
        }
        // Package-manager caches. Emitted after the read trees so they win
        // over the enclosing read-only grant, and before the deny block so
        // the credential carve-outs below still win over them.
        for tree in HOME_WRITE_TREES {
            push_rule(
                &mut sb,
                "allow",
                "file-read* file-write*",
                &home.join(tree).display().to_string(),
            );
        }
    }

    // ---- darwin per-user temp / cache ------------------------------------
    if let Some(cache) = darwin_user_cache_dir() {
        // CFPreferences, dyld closures and font caches all live here.
        push_rule(
            &mut sb,
            "allow",
            "file-read* file-write*",
            &cache.display().to_string(),
        );
    }
    if let Some(temp) = user_temp_dir {
        // The darwin per-user temp directory, i.e. what
        // `confstr(_CS_DARWIN_USER_TEMP_DIR)` returns. Two things need it:
        // `xcrun` caches its tool lookup here by absolute confstr path and
        // ignores TMPDIR entirely (without it every `git`/`clang` call
        // prints two errors), and BSD `mktemp` with no arguments resolves
        // its template through the same confstr call rather than through
        // `$TMPDIR`.
        //
        // It is per-UID rather than per-workspace, so it is a wider surface
        // than the kernel scratch directory — which is why the scratch dir,
        // not this one, is what `TMPDIR`/`TMP`/`TEMP` point at.
        //
        // CONTAINMENT GUARD: when the workspace itself lives under this
        // directory (every `tempfile::tempdir()` workspace does, and so does
        // any scratch checkout a user makes there), a blanket grant would
        // make the workspace's own PARENT writable — the payload could then
        // write siblings outside its workspace. In that case fall back to
        // the narrow `xcrun_db` allowance and accept that bare `mktemp`
        // fails, which is the fail-closed choice.
        // `canonicalize` fails for a workspace that does not exist yet, so
        // fall back to the path as given rather than to `false` — treating an
        // unresolvable path as "outside" would be fail-open.
        let workspace_is_inside_temp = workspace_root.is_some_and(|root| {
            let resolved = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
            seatbelt_path_is_within(&resolved, temp) || seatbelt_path_is_within(root, temp)
        });
        if workspace_is_inside_temp {
            sb.push_str(&format!(
                "(allow file-read* file-write* (regex #\"^{}/xcrun_db\"))\n",
                sb_escape(&regex_escape(&temp.display().to_string()))
            ));
        } else {
            push_rule(
                &mut sb,
                "allow",
                "file-read* file-write*",
                &temp.display().to_string(),
            );
        }
    }

    // ---- filesystem rules -------------------------------------------------
    for (rule, host) in &mapped_filesystem {
        match rule.access {
            FilesystemAccess::ReadOnly => {
                push_rule(&mut sb, "allow", "file-read*", host);
            }
            FilesystemAccess::ReadWrite => {
                push_rule(&mut sb, "allow", "file-read* file-write*", host);
            }
            FilesystemAccess::Deny => continue,
        }
    }

    // Explicit denials AFTER the allowances: a ReadOnly rule nested inside a
    // ReadWrite parent is a write-protection overlay, and a Deny rule hides
    // the subtree outright.
    for (rule, host) in &mapped_filesystem {
        match rule.access {
            FilesystemAccess::ReadOnly => {
                push_rule(&mut sb, "deny", "file-write*", host);
            }
            FilesystemAccess::Deny => {
                push_rule(
                    &mut sb,
                    "deny",
                    "file-read* file-read-metadata file-write*",
                    host,
                );
            }
            FilesystemAccess::ReadWrite => continue,
        }
    }

    // ---- unconditional secret denials -------------------------------------
    // Emitted last so nothing above can re-admit them. `file-read-metadata`
    // is named explicitly: the global metadata allowance is not overridden
    // by a `file-read*` denial on this implementation (measured).
    sb.push_str("; ambient credential stores: never readable, never writable\n");
    if let Some(home) = home_dir() {
        for tree in HOME_DENY_TREES {
            push_rule(
                &mut sb,
                "deny",
                "file-read* file-read-metadata file-write*",
                &home.join(tree).display().to_string(),
            );
        }
        for file in HOME_DENY_FILES {
            push_rule(
                &mut sb,
                "deny",
                "file-read* file-read-metadata file-write*",
                &home.join(file).display().to_string(),
            );
        }
        // The general-purpose cache roots are writable wholesale, so a tool
        // that drops a credential file into one would otherwise expose it.
        // Deny by name rather than trying to enumerate every tool.
        for root in HOME_CACHE_CREDENTIAL_ROOTS {
            for variant in path_variants(&home.join(root).display().to_string()) {
                sb.push_str(&format!(
                    "(deny file-read* file-read-metadata file-write* (regex #\"^{}/.*credentials\"))\n",
                    sb_escape(&regex_escape(&variant))
                ));
            }
        }
    }
    for tree in GLOBAL_DENY_TREES {
        push_rule(
            &mut sb,
            "deny",
            "file-read* file-read-metadata file-write*",
            tree,
        );
    }
    // The kernel's own state directory (artifacts, jobs.sqlite,
    // `state/connector-grants.json`). Skipped when it contains the workspace
    // itself — an e2e fixture registers the data dir AS the workspace, and
    // denying it there would make the whole workspace unreachable.
    if let Some(data_dir) = kernel_state_dir() {
        let contains_workspace = workspace_root.is_some_and(|root| root.starts_with(&data_dir));
        if !contains_workspace {
            push_rule(
                &mut sb,
                "deny",
                "file-read* file-read-metadata file-write*",
                &data_dir.display().to_string(),
            );
        }
    }

    // ---- network ---------------------------------------------------------
    match profile.network {
        NetworkAccess::Deny => {
            // Emit nothing: deny default blocks all sockets.
            sb.push_str("; network: denied by deny-default\n");
        }
        NetworkAccess::Allow => {
            sb.push_str("(allow network-outbound)\n");
            sb.push_str("(allow network-inbound)\n");
        }
        NetworkAccess::ProxyRequired => {
            // Only the kernel-owned local broker socket may be reached.
            sb.push_str("(allow network-outbound (to unix-socket*))\n");
            sb.push_str("; TCP destinations MUST traverse the L4/L7 brokers\n");
        }
    }

    // ---- process ----------------------------------------------------------
    match profile.process {
        ProcessAccess::Deny => {
            sb.push_str("; process execution: denied by deny-default\n");
        }
        ProcessAccess::Allow | ProcessAccess::AllowWithLimits => {
            sb.push_str("(allow process-fork)\n");
            sb.push_str("(allow process-exec)\n");
        }
    }

    Ok(sb)
}

/// Escape the regex metacharacters that can occur in a darwin temp path.
fn regex_escape(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        if "\\^$.|?*+()[]{}".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// The kernel's on-disk state root. The mini-service reads `TERMINUS_DATA`
/// (default `.terminus-data`, relative to its working directory), so the
/// same variable identifies the credential store from inside this process.
fn kernel_state_dir() -> Option<PathBuf> {
    let raw = std::env::var_os("TERMINUS_DATA")?;
    let path = PathBuf::from(raw);
    if path.as_os_str().is_empty() {
        return None;
    }
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    Some(std::fs::canonicalize(&absolute).unwrap_or(absolute))
}

impl SandboxBackend for MacOsSandboxBackend {
    fn id(&self) -> &'static str {
        "macos"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if self.sandbox_exec_path.is_some() {
            EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Enforced,
                enforced: vec![
                    EnforcementFeature::AmbientSecretDenial,
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::ProtectedGit,
                    EnforcementFeature::SecretIsolation,
                    EnforcementFeature::ProcessIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::PluginAmbientAuthorityDenial,
                ],
                degraded: vec![
                    EnforcementFeature::CgroupResourceLimits,
                    EnforcementFeature::NoNewPrivs,
                    EnforcementFeature::SeccompFilter,
                ],
                unsupported: vec![
                    EnforcementFeature::PidNamespace,
                    EnforcementFeature::MountNamespace,
                    EnforcementFeature::UserNamespace,
                ],
                notes: vec![
                    "seatbelt profile generated from SandboxProfile (ADR-0035 §4)".to_string(),
                    "filesystem: deny-default + explicit system/toolchain read list; the \
                     workspace root is the writable root"
                        .to_string(),
                    "git: .git stays readable and its object database writable; \
                     .git/hooks and .git/config are write-protected"
                        .to_string(),
                    "secrets: ~/.ssh, ~/.aws, ~/.config/gcloud, ~/.gnupg, ~/.netrc, \
                     keychains, ~/.claude, ~/.terminus and the kernel state dir are denied \
                     unconditionally"
                        .to_string(),
                    "environment: env -i plus an explicit denylist over the caller's \
                     public_env (KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL, AWS_*, ANTHROPIC_*, \
                     OPENAI_*, DYLD_*, LD_*, SSH_AUTH_SOCK)"
                        .to_string(),
                    "network: Deny emits NO socket allowance; ProxyRequired restricts \
                     outbound to the broker unix socket"
                        .to_string(),
                    "cgroups/no-new-privs/seccomp: not expressible in Seatbelt — resource \
                     limits come from the caller's process supervision"
                        .to_string(),
                    "pid/mount/user namespaces: unsupported on macOS (use container or \
                     microVM backends)"
                        .to_string(),
                ],
            }
        } else {
            EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Unsupported,
                enforced: vec![],
                degraded: vec![],
                unsupported: vec![
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::NoNewPrivs,
                    EnforcementFeature::PidNamespace,
                    EnforcementFeature::MountNamespace,
                    EnforcementFeature::UserNamespace,
                    EnforcementFeature::CgroupResourceLimits,
                ],
                notes: vec![
                    "seatbelt CLI (sandbox-exec) not found on PATH".to_string(),
                    "fail closed: use terminus-sandbox-container or a microVM backend".to_string(),
                ],
            }
        }
    }

    fn supports_profile(&self, profile: &SandboxProfile) -> Result<(), SandboxError> {
        // Security refusals are unconditional.
        if matches!(
            profile.secrets,
            terminus_sandbox::SecretsAccess::AmbientEnvironment
        ) {
            return Err(SandboxError::Misconfigured(
                "ambient secrets not permitted".into(),
            ));
        }
        if profile.plugins_ambient_authority {
            return Err(SandboxError::Misconfigured(
                "ambient plugin authority not permitted".into(),
            ));
        }
        // Fail closed without the platform primitive. There is no degraded
        // acceptance anymore: either we generate AND enforce, or the
        // profile is rejected.
        if self.sandbox_exec_path.is_none() {
            return Err(SandboxError::Unsupported(
                "macOS seatbelt CLI unavailable; refusing to run unsandboxed".into(),
            ));
        }
        // Generation must succeed for THIS profile before acceptance.
        let _ = generate_seatbelt_profile(profile, self.workspace_root.as_deref())?;
        Ok(())
    }

    fn spawn_wrapper(
        &self,
        command: &terminus_kernel_protocol::CommandSpec,
        profile: &SandboxProfile,
    ) -> Option<(std::path::PathBuf, Vec<String>)> {
        let exec = self.sandbox_exec_path.as_ref()?;
        let sb_text = generate_seatbelt_profile(profile, self.workspace_root.as_deref()).ok()?;
        // Pass the generated profile directly. It contains policy paths but
        // no credentials, and avoiding a temporary file also avoids leaving
        // mutable policy artifacts behind after a crash.
        //
        // Seatbelt constrains filesystem/network/process rights but does
        // NOT scrub environment variables. Ambient-secret denial is
        // therefore enforced structurally: every payload launches under
        // `env -i` (ADR-0035 §4; brokered secrets arrive via handles, never
        // environment). The caller's `public_env` is forwarded through the
        // denylist so a credential the control plane holds cannot be handed
        // to the model's shell either.
        let home = command
            .public_env
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("HOME"))
            .map(|(_, value)| value.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                self.workspace_root
                    .clone()
                    .unwrap_or_else(|| PathBuf::from("/var/empty"))
                    .display()
                    .to_string()
            });
        let path = command
            .public_env
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
            .map(|(_, value)| value.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| FALLBACK_PATH.to_string());
        let term = command
            .public_env
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("TERM"))
            .map(|(_, value)| value.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "dumb".to_string());

        let mut argv = vec![
            "-p".to_string(),
            sb_text,
            "--".to_string(),
            "/usr/bin/env".to_string(),
            "-i".to_string(),
            format!("HOME={home}"),
            format!("PATH={path}"),
            format!("TERM={term}"),
            "__CF_USER_TEXT_ENCODING=0x0:0:0".to_string(),
        ];
        argv.extend(
            command
                .public_env
                .iter()
                .filter(|(name, _)| {
                    !name.eq_ignore_ascii_case("HOME")
                        && !name.eq_ignore_ascii_case("PATH")
                        && !name.eq_ignore_ascii_case("TERM")
                        && !env_name_is_denied(name)
                })
                .map(|(name, value)| format!("{name}={value}")),
        );
        // Kernel-provisioned scratch directory, last so it always wins.
        // `/tmp` and the darwin per-user temp dir are both unwritable under
        // this profile, so without this the payload has no temp space at all.
        if let Some(scratch) = profile.scratch_dir() {
            for key in KERNEL_OWNED_ENV {
                argv.push(format!("{key}={scratch}"));
            }
        }
        argv.push(command.program.clone());
        argv.extend(command.args.clone());
        Some((exec.clone(), argv))
    }
}

/// Resolve `sandbox-exec` and prove it WORKS by executing a trivial deny-
/// default profile (`/bin/true`). Flag-based probing is unreliable: modern
/// sandbox-exec rejects `--version`/`-h` with exit 64 while remaining fully
/// functional.
fn which_sandbox_exec() -> Option<PathBuf> {
    const PROBE_PROFILE: &str = "(version 1)\n(deny default)\n(allow file-read*)\n(allow process-exec)\n(allow mach-lookup)\n(allow sysctl-read)\n";
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let c = dir.join("sandbox-exec");
            if c.is_file() {
                candidates.push(c);
            }
        }
    }
    let system = PathBuf::from("/usr/bin/sandbox-exec");
    if system.is_file() && !candidates.contains(&system) {
        candidates.push(system);
    }
    for candidate in candidates {
        let ok = std::process::Command::new(&candidate)
            .args(["-p", PROBE_PROFILE, "--", "/bin/sh", "-c", "exit 0"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if ok {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod phase4_tests {
    use super::*;
    use std::sync::Arc;
    use terminus_sandbox::profile::{FilesystemRule, ResourceLimits};
    use terminus_sandbox::SecretsAccess;

    fn backend() -> MacOsSandboxBackend {
        MacOsSandboxBackend::with_mocked_sandbox_exec(true).with_workspace_root("/tmp/ws-root")
    }

    #[cfg(unix)]
    #[test]
    fn golden_profile_deny_default_with_rule_allowances() {
        let profile = SandboxProfile::default_restrictive();
        let sb = generate_seatbelt_profile(&profile, Some(Path::new("/tmp/ws-root"))).unwrap();
        assert!(sb.starts_with("(version 1)\n(deny default)\n"));
        // The workspace root itself is the writable root...
        assert!(sb.contains("(allow file-read* file-write* (subpath \"/tmp/ws-root\"))"));
        // ...git internals stay readable, and only hooks/config lose writes...
        assert!(sb.contains("(deny file-write* (subpath \"/tmp/ws-root/.git/hooks\"))"));
        assert!(sb.contains("(deny file-write* (subpath \"/tmp/ws-root/.git/config\"))"));
        assert!(
            !sb.contains(
                "(deny file-read* file-read-metadata file-write* (subpath \"/tmp/ws-root/.git\"))"
            ),
            "denying all of .git breaks `git status` and `git diff`"
        );
        // ...kernel state and credentials are gone entirely...
        assert!(sb.contains(
            "(deny file-read* file-read-metadata file-write* (subpath \"/tmp/ws-root/.terminus\"))"
        ));
        assert!(sb.contains(
            "(deny file-read* file-read-metadata file-write* (subpath \"/tmp/ws-root/credentials\"))"
        ));
        // ...and network deny emits no socket allowance.
        assert!(!sb.contains("allow network-outbound (to *)"));
        assert!(sb.contains("network: denied by deny-default"));
        // System read trees are allowed; the whole filesystem is not.
        assert!(sb.contains("(allow file-read* (subpath \"/usr\"))"));
        assert!(
            !sb.contains("(allow file-read* (subpath \"/\"))"),
            "a whole-filesystem read allowance exposes ~/.ssh and ~/.aws"
        );
        assert!(!sb.contains("(subpath \"/var/folders\")"));
    }

    #[test]
    fn nested_read_only_rule_becomes_a_write_protection_overlay() {
        let mut profile = SandboxProfile::default_restrictive();
        profile.filesystem.push(FilesystemRule {
            path: "workspace://vendor".to_string(),
            access: FilesystemAccess::ReadOnly,
        });
        let sb = generate_seatbelt_profile(&profile, Some(Path::new("/tmp/ws-root"))).unwrap();
        let allow = sb
            .find("(allow file-read* file-write* (subpath \"/tmp/ws-root\"))")
            .expect("workspace rw allow");
        let deny = sb
            .find("(deny file-write* (subpath \"/tmp/ws-root/vendor\"))")
            .expect("nested write denial");
        assert!(
            allow < deny,
            "Seatbelt resolves to the last matching rule: the overlay must come after the parent"
        );
        assert!(sb.contains("(allow file-read* (subpath \"/tmp/ws-root/vendor\"))"));
    }

    #[test]
    fn ambient_secret_paths_are_denied_after_every_allowance() {
        let home = match home_dir() {
            Some(home) => home,
            None => return,
        };
        let sb = generate_seatbelt_profile(
            &SandboxProfile::default_restrictive(),
            Some(Path::new("/tmp/ws-root")),
        )
        .unwrap();
        for secret in [".ssh", ".aws", ".gnupg", ".claude", ".terminus"] {
            let clause = format!(
                "(deny file-read* file-read-metadata file-write* (subpath \"{}\"))",
                home.join(secret).display()
            );
            assert!(sb.contains(&clause), "missing denial for ~/{secret}");
        }
        // A toolchain root is admitted...
        assert!(sb.contains(&format!(
            "(allow file-read* (subpath \"{}\"))",
            home.join(".cargo").display()
        )));
        // ...but never writable.
        assert!(!sb.contains(&format!(
            "(allow file-read* file-write* (subpath \"{}\"))",
            home.join(".cargo").display()
        )));
    }

    #[test]
    fn package_caches_are_writable_while_their_credential_files_are_not() {
        let home = match home_dir() {
            Some(home) => home,
            None => return,
        };
        let sb = generate_seatbelt_profile(
            &SandboxProfile::default_restrictive(),
            Some(Path::new("/tmp/ws-root")),
        )
        .unwrap();
        // Every cache/registry tree is writable, or the offline install path
        // of the corresponding tool fails inside the sandbox.
        for tree in HOME_WRITE_TREES {
            assert!(
                sb.contains(&format!(
                    "(allow file-read* file-write* (subpath \"{}\"))",
                    home.join(tree).display()
                )),
                "~/{tree} must be writable"
            );
        }
        // The rustup toolchain tree stays read-only: a poisoned toolchain
        // binary would survive the sandbox.
        assert!(!sb.contains(&format!(
            "(allow file-read* file-write* (subpath \"{}\"))",
            home.join(".rustup/toolchains").display()
        )));
        // Credential files beside those caches stay denied.
        for secret in [".cargo/credentials", ".cargo/credentials.toml", ".npmrc"] {
            assert!(
                sb.contains(&format!(
                    "(deny file-read* file-read-metadata file-write* (subpath \"{}\"))",
                    home.join(secret).display()
                )),
                "~/{secret} must stay denied"
            );
        }
        // ...and the general-purpose cache roots carry a name-based carve-out
        // for credential files no explicit rule anticipated.
        for root in HOME_CACHE_CREDENTIAL_ROOTS {
            assert!(
                sb.contains(&format!(
                    "(deny file-read* file-read-metadata file-write* (regex #\"^{}/.*credentials\"))",
                    sb_escape(&regex_escape(&home.join(root).display().to_string()))
                )),
                "~/{root} needs a credentials carve-out"
            );
        }
        // Ordering is what makes the carve-outs effective: Seatbelt resolves
        // to the LAST matching rule, so every deny must follow every allow.
        let last_allow = sb.rfind("(allow file-read* file-write*").unwrap_or(0);
        let first_secret_deny = sb
            .find("(deny file-read* file-read-metadata file-write*")
            .unwrap_or(usize::MAX);
        assert!(
            first_secret_deny > last_allow,
            "secret denials must be emitted after every write allowance"
        );
    }

    #[test]
    fn a_workspace_inside_the_darwin_temp_dir_forfeits_the_blanket_temp_grant() {
        let temp = Path::new("/private/var/folders/zz/terminus/T");
        let blanket = format!(
            "(allow file-read* file-write* (subpath \"{}\"))",
            temp.display()
        );
        // Ordinary workspace: the grant is present, so bare `mktemp` works.
        let outside = generate_seatbelt_profile_with_temp_dir(
            &SandboxProfile::default_restrictive(),
            Some(Path::new("/private/tmp/ws-root")),
            Some(temp),
        )
        .unwrap();
        assert!(
            outside.contains(&blanket),
            "an ordinary workspace should get the temp-dir grant"
        );
        let sibling = generate_seatbelt_profile_with_temp_dir(
            &SandboxProfile::default_restrictive(),
            Some(Path::new(
                "/private/var/folders/zz/terminus/T-sibling/ws-root",
            )),
            Some(temp),
        )
        .unwrap();
        assert!(
            sibling.contains(&blanket),
            "a path with the temp-dir prefix is not inside the temp dir"
        );
        // Workspace under the temp dir: the grant would make the workspace's
        // own parent writable, so it is withheld and only `xcrun_db` remains.
        let inside = generate_seatbelt_profile_with_temp_dir(
            &SandboxProfile::default_restrictive(),
            Some(Path::new("/private/var/folders/zz/terminus/T/ws-root")),
            Some(temp),
        )
        .unwrap();
        assert!(
            !inside.contains(&blanket),
            "a workspace under the temp dir must not make its own parent writable"
        );
        assert!(inside.contains("/xcrun_db"), "xcrun must still work");
    }

    #[test]
    fn workspace_paths_cannot_inject_profile_clauses() {
        let profile = SandboxProfile::default_restrictive();
        let evil = Path::new("/tmp/ws\") (allow default) (deny file-read* (subpath \"/nope");
        let sb = generate_seatbelt_profile(&profile, Some(evil)).unwrap();
        // The quote stays INSIDE the string literal: escaped, so the
        // injected text is data rather than a clause.
        assert!(
            sb.contains("ws\\\")"),
            "the quote in a workspace path must be escaped: {sb}"
        );
        // Every unescaped quote in the profile is a delimiter, so their
        // count stays even on every line.
        for line in sb.lines() {
            let mut previous = '\0';
            let unescaped = line.chars().filter(|c| {
                let is_quote = *c == '"' && previous != '\\';
                previous = if previous == '\\' { '\0' } else { *c };
                is_quote
            });
            assert_eq!(
                unescaped.count() % 2,
                0,
                "unbalanced quotes would let a path start a new clause: {line}"
            );
        }
    }

    #[test]
    fn proxy_required_restricts_outbound_to_broker_socket() {
        let mut profile = SandboxProfile::default_restrictive();
        profile.network = NetworkAccess::ProxyRequired;
        let sb = generate_seatbelt_profile(&profile, Some(Path::new("/tmp/ws-root"))).unwrap();
        assert!(sb.contains("(allow network-outbound (to unix-socket*))"));
        assert!(!sb.contains("(allow network-outbound)\n"));
    }

    #[test]
    fn ambient_secrets_never_generate_a_profile() {
        let mut profile = SandboxProfile::default_restrictive();
        profile.secrets = SecretsAccess::AmbientEnvironment;
        let err = generate_seatbelt_profile(&profile, None).expect_err("ambient secrets refused");
        assert!(matches!(err, SandboxError::Misconfigured(_)));
    }

    fn spec_with_env(env: &[(&str, &str)]) -> terminus_kernel_protocol::CommandSpec {
        terminus_kernel_protocol::CommandSpec {
            program: "echo".to_string(),
            args: vec!["hi".to_string()],
            cwd: terminus_kernel_protocol::WorkspacePath::new("ws", "."),
            public_env: env
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            timeout_ms: 1000,
            ..Default::default()
        }
    }

    #[test]
    fn spawn_wrapper_uses_inline_generated_profile() {
        let b = backend();
        let cmd = spec_with_env(&[("TERMINUS_PROVIDER_PROTOCOL", "v1")]);
        let (bin, argv) = b
            .spawn_wrapper(&cmd, &SandboxProfile::default_restrictive())
            .expect("wrapper with seatbelt available");
        assert_eq!(bin, PathBuf::from("/usr/bin/sandbox-exec"));
        assert_eq!(argv[0], "-p");
        assert!(argv[1].contains("(deny default)"));
        // Payloads launch under `env -i` so ambient secrets cannot leak.
        assert_eq!(argv[2], "--");
        assert_eq!(argv[3], "/usr/bin/env");
        assert!(argv.contains(&"-i".to_string()));
        assert!(argv.contains(&format!("PATH={FALLBACK_PATH}")));
        assert!(argv.contains(&"TERM=dumb".to_string()));
        assert!(argv.contains(&"TERMINUS_PROVIDER_PROTOCOL=v1".to_string()));
        let prog_idx = argv
            .iter()
            .position(|a| a == "echo")
            .expect("original program preserved after env allowlist");
        assert!(prog_idx > argv.iter().position(|a| a == "--").unwrap());
    }

    #[test]
    fn caller_supplied_environment_is_honoured() {
        let b = backend();
        let cmd = spec_with_env(&[
            ("PATH", "/opt/homebrew/bin:/usr/bin:/bin"),
            ("HOME", "/Users/tester"),
            ("TERM", "xterm-256color"),
            ("LANG", "en_US.UTF-8"),
            ("CI", "1"),
            ("NO_COLOR", "1"),
            ("GIT_TERMINAL_PROMPT", "0"),
        ]);
        let (_, argv) = b
            .spawn_wrapper(&cmd, &SandboxProfile::default_restrictive())
            .expect("wrapper");
        for expected in [
            "PATH=/opt/homebrew/bin:/usr/bin:/bin",
            "HOME=/Users/tester",
            "TERM=xterm-256color",
            "LANG=en_US.UTF-8",
            "CI=1",
            "NO_COLOR=1",
            "GIT_TERMINAL_PROMPT=0",
        ] {
            assert!(
                argv.contains(&expected.to_string()),
                "missing {expected} in {argv:?}"
            );
        }
        // Exactly one PATH/HOME/TERM assignment each: the caller's value
        // replaces the default rather than being appended after it.
        assert_eq!(
            argv.iter().filter(|a| a.starts_with("PATH=")).count(),
            1,
            "{argv:?}"
        );
        assert_eq!(argv.iter().filter(|a| a.starts_with("HOME=")).count(), 1);
        assert_eq!(argv.iter().filter(|a| a.starts_with("TERM=")).count(), 1);
    }

    #[test]
    fn credential_bearing_environment_names_are_never_forwarded() {
        let b = backend();
        let denied = [
            "AWS_SECRET_ACCESS_KEY",
            "AWS_ACCESS_KEY_ID",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GITHUB_TOKEN",
            "NPM_TOKEN",
            "DB_PASSWORD",
            "SOME_CREDENTIAL",
            "SSH_AUTH_SOCK",
            "DYLD_INSERT_LIBRARIES",
            "LD_PRELOAD",
            "gh_token",
        ];
        let env: Vec<(&str, &str)> = denied.iter().map(|name| (*name, "leaked")).collect();
        let cmd = spec_with_env(&env);
        let (_, argv) = b
            .spawn_wrapper(&cmd, &SandboxProfile::default_restrictive())
            .expect("wrapper");
        for name in denied {
            assert!(
                !argv.iter().any(|a| a.starts_with(&format!("{name}="))),
                "{name} must never reach the payload: {argv:?}"
            );
        }
        assert!(!argv.iter().any(|a| a.contains("leaked")));
    }

    #[test]
    fn scratch_directory_becomes_the_tmpdir_family() {
        let b = backend();
        let mut profile = SandboxProfile::default_restrictive();
        profile.filesystem.push(FilesystemRule {
            path: format!(
                "/private/tmp/{}cafebabe",
                terminus_sandbox::SCRATCH_DIR_PREFIX
            ),
            access: FilesystemAccess::ReadWrite,
        });
        // A caller-supplied TMPDIR must not win over the kernel's.
        let cmd = spec_with_env(&[("TMPDIR", "/tmp")]);
        let (_, argv) = b.spawn_wrapper(&cmd, &profile).expect("wrapper");
        let expected = format!(
            "/private/tmp/{}cafebabe",
            terminus_sandbox::SCRATCH_DIR_PREFIX
        );
        for key in ["TMPDIR", "TMP", "TEMP"] {
            assert!(
                argv.contains(&format!("{key}={expected}")),
                "missing {key} in {argv:?}"
            );
        }
        assert!(!argv.contains(&"TMPDIR=/tmp".to_string()));
        assert_eq!(argv.iter().filter(|a| a.starts_with("TMPDIR=")).count(), 1);
        // The scratch directory is writable inside the profile.
        assert!(argv[1].contains(&format!(
            "(allow file-read* file-write* (subpath \"{expected}\"))"
        )));
    }

    #[test]
    fn unresolved_workspace_rules_fail_closed() {
        let b = MacOsSandboxBackend::with_mocked_sandbox_exec(true);
        let error = b
            .supports_profile(&SandboxProfile::default_restrictive())
            .expect_err("workspace rules require a concrete root");
        assert!(format!("{error}").contains("concrete workspace root"));
    }

    #[test]
    fn report_claims_enforced_for_profile_expressible_controls_only() {
        let b = backend();
        let r = b.enforcement_report();
        assert_eq!(r.status, EnforcementStatus::Enforced);
        assert!(r
            .enforced
            .contains(&EnforcementFeature::FilesystemIsolation));
        assert!(r.degraded.contains(&EnforcementFeature::SeccompFilter));
        assert!(
            r.unsupported.contains(&EnforcementFeature::UserNamespace),
            "namespaces are not a Seatbelt concept"
        );
    }

    #[test]
    fn secure_mode_tier2_still_rejects_macos_backend() {
        // Seatbelt cannot enforce NoNewPrivs/cgroups: secure tier-2 must
        // fail closed even when generation works.
        let macos = Arc::new(backend()) as Arc<dyn terminus_sandbox::SandboxBackend>;
        let err = terminus_sandbox::select_secure(
            &[macos],
            &SandboxProfile::default_restrictive(),
            terminus_sandbox::RiskTier::Tier2,
        )
        .unwrap_err();
        assert!(format!("{err}").contains("tier2"));
    }

    #[test]
    fn default_resource_limits_no_longer_cap_every_exec_at_sixty_seconds() {
        let limits = ResourceLimits::default();
        assert_eq!(limits.wall_clock_ms, Some(60_000), "default, not a cap");
        assert_eq!(
            terminus_sandbox::resolve_exec_timeout_ms(
                300_000,
                &limits,
                terminus_sandbox::MAX_FOREGROUND_WALL_CLOCK_MS
            ),
            300_000
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
mod live_probe_tests {
    use super::*;
    use terminus_sandbox::probe::{run_probes, ProbeKind, ProbeVerdict};

    /// Effective-control verification on THIS host (SPEC §19.3). A macOS
    /// host without `sandbox-exec` is a broken host, not a reason to skip:
    /// the test fails loudly rather than passing without evidence.
    fn require_backend(workspace: &Path) -> MacOsSandboxBackend {
        let backend = MacOsSandboxBackend::new().with_workspace_root(workspace);
        assert!(
            backend.is_seatbelt_available(),
            "sandbox-exec is absent or non-functional on this macOS host; \
             the Seatbelt backend cannot be verified and MUST NOT be trusted"
        );
        backend
    }

    fn workspace_fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temporary workspace");
        let root = std::fs::canonicalize(dir.path()).expect("canonical workspace");
        (dir, root)
    }

    /// A workspace that is NOT under the darwin per-user temp directory.
    ///
    /// `tempfile::tempdir()` lands in `$TMPDIR`, i.e. inside the per-user
    /// temp dir, which trips the containment guard that withholds the
    /// blanket temp-dir write grant. Production workspaces are ordinary
    /// project directories, so tests that exercise the temp-dir grant need
    /// this shape instead. `/private/tmp` is the world temp dir and is a
    /// different tree from `confstr(_CS_DARWIN_USER_TEMP_DIR)`.
    fn workspace_fixture_outside_darwin_temp() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("terminus-ws-")
            .tempdir_in("/private/tmp")
            .expect("temporary workspace outside the darwin temp dir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical workspace");
        if let Some(temp) = darwin_user_temp_dir() {
            assert!(
                !root.starts_with(temp),
                "fixture must live outside the darwin per-user temp dir"
            );
        }
        (dir, root)
    }

    #[test]
    fn live_seatbelt_blocks_escape_network_and_ambient_secrets() {
        let (_guard, root) = workspace_fixture();
        let backend = require_backend(&root);
        let results = run_probes(&backend, &root);
        let verdict = |k: ProbeKind| {
            results
                .iter()
                .find(|r| r.probe == k)
                .map(|r| (r.verdict.clone(), r.detail.clone()))
                .unwrap_or_else(|| (ProbeVerdict::Unmeasurable, "missing".into()))
        };
        let (fs_v, fs_d) = verdict(ProbeKind::FilesystemEscape);
        assert_eq!(fs_v, ProbeVerdict::Enforced, "fs escape: {fs_d}");
        let (env_v, env_d) = verdict(ProbeKind::AmbientSecretDenial);
        assert_eq!(env_v, ProbeVerdict::Enforced, "ambient secret: {env_d}");
        // The network verdict was measured and then discarded before this
        // change; a deny-network profile that silently permits egress is the
        // single worst failure this suite can miss.
        let (net_v, net_d) = verdict(ProbeKind::NetworkEgress);
        assert_eq!(net_v, ProbeVerdict::Enforced, "network egress: {net_d}");
    }

    fn run_in_sandbox(root: &Path, script: &str) -> std::process::Output {
        let backend = require_backend(root);
        let scratch = root.join(format!(
            "{}live-fixture",
            terminus_sandbox::SCRATCH_DIR_PREFIX
        ));
        std::fs::create_dir_all(&scratch).expect("scratch dir");
        let mut profile = SandboxProfile::default_restrictive();
        profile.filesystem.push(terminus_sandbox::FilesystemRule {
            path: scratch.display().to_string(),
            access: FilesystemAccess::ReadWrite,
        });
        let profile = materialize(profile, root);
        let command = terminus_kernel_protocol::CommandSpec {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            cwd: terminus_kernel_protocol::WorkspacePath::new(
                "probe-workspace",
                root.display().to_string(),
            ),
            public_env: [
                ("TERMINUS_PROVIDER_PROTOCOL".to_string(), "v1".to_string()),
                (
                    "PATH".to_string(),
                    std::env::var("PATH").unwrap_or_else(|_| FALLBACK_PATH.to_string()),
                ),
                (
                    "HOME".to_string(),
                    home_dir()
                        .map(|home| home.display().to_string())
                        .unwrap_or_else(|| "/var/empty".to_string()),
                ),
            ]
            .into_iter()
            .collect(),
            timeout_ms: 20_000,
            ..Default::default()
        };
        let (binary, argv) = backend
            .spawn_wrapper(&command, &profile)
            .expect("Seatbelt wrapper");
        std::process::Command::new(binary)
            .args(argv)
            .current_dir(root)
            .output()
            .expect("Seatbelt payload")
    }

    /// Mirror of the kernel's `materialize_workspace_profile`.
    fn materialize(mut profile: SandboxProfile, root: &Path) -> SandboxProfile {
        for rule in &mut profile.filesystem {
            let Some(relative) = rule.path.strip_prefix("workspace://") else {
                continue;
            };
            rule.path = if relative.is_empty() {
                root.display().to_string()
            } else {
                root.join(relative).display().to_string()
            };
        }
        profile
    }

    #[test]
    fn live_seatbelt_preserves_workspace_contract() {
        let (_guard, root) = workspace_fixture();
        std::fs::create_dir_all(root.join(".git/hooks")).expect("git dir");
        std::fs::create_dir_all(root.join(".git/objects")).expect("git objects");
        std::fs::write(root.join(".git/config"), "[core]\n").expect("git config");
        std::fs::write(root.join(".git/secret"), "git-secret").expect("git fixture");
        std::fs::create_dir_all(root.join(".terminus")).expect("Terminus dir");
        std::fs::write(root.join(".terminus/credentials"), "credential-secret")
            .expect("credential fixture");

        let output = run_in_sandbox(
            &root,
            "test \"$TERMINUS_PROVIDER_PROTOCOL\" = v1 || exit 21; \
             pwd > pwd.txt || exit 22; \
             printf allowed > result || exit 23; \
             printf o > .git/objects/probe || exit 24; \
             cat .git/config >/dev/null || exit 25; \
             cat .git/secret >/dev/null || exit 26; \
             if printf x > .git/hooks/pre-commit 2>/dev/null; then exit 27; fi; \
             if printf x >> .git/config 2>/dev/null; then exit 28; fi; \
             if cat .terminus/credentials >/dev/null 2>&1; then exit 29; fi; \
             printf t > \"$TMPDIR/scratch\" || exit 30",
        );
        assert!(
            output.status.success(),
            "Seatbelt payload failed (status={}): stdout={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(root.join("pwd.txt"))
                .expect("working-directory output")
                .trim(),
            root.display().to_string()
        );
        assert_eq!(
            std::fs::read_to_string(root.join("result")).expect("allowed output"),
            "allowed"
        );
        assert!(root.join(".git/objects/probe").exists());
    }

    #[test]
    fn live_seatbelt_denies_ambient_secrets_and_admits_toolchains() {
        let (_guard, root) = workspace_fixture_outside_darwin_temp();
        std::fs::write(root.join("README"), "readable\n").expect("README fixture");

        let output = run_in_sandbox(
            &root,
            "cat README >/dev/null || exit 41; \
             if ls \"$HOME/.ssh\" >/dev/null 2>&1; then exit 42; fi; \
             if cat \"$HOME/.ssh/config\" >/dev/null 2>&1; then exit 43; fi; \
             if cat \"$HOME/.aws/credentials\" >/dev/null 2>&1; then exit 44; fi; \
             if ls \"$HOME\" >/dev/null 2>&1; then exit 45; fi; \
             if cat \"$HOME/.cargo/credentials.toml\" >/dev/null 2>&1; then exit 47; fi; \
             if cat \"$HOME/.cargo/credentials\" >/dev/null 2>&1; then exit 48; fi; \
             if cat \"$HOME/.cache/huggingface/token\" >/dev/null 2>&1; then exit 49; fi; \
             if ls \"$HOME/.cache/gcloud\" >/dev/null 2>&1; then exit 50; fi; \
             t=$(mktemp) || exit 51; \
             echo probe > \"$t\" || exit 52; \
             rm -f \"$t\"; \
             command -v cargo >/dev/null 2>&1 || exit 0; \
             cargo --version >/dev/null || exit 46",
        );
        let code = output.status.code().unwrap_or(-1);
        assert_eq!(
            code,
            0,
            "exit={code} stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// The verification command for this repository is `cargo test`, so a
    /// sandbox that cannot run `cargo build` cannot verify anything. cargo
    /// takes an exclusive lock on `~/.cargo/.package-cache` and writes the
    /// registry index cache on every invocation; with the toolchain tree
    /// read-only this failed before the cache grants were added.
    #[test]
    fn live_seatbelt_lets_cargo_build_a_crate_and_still_hides_its_credentials() {
        let (_guard, root) = workspace_fixture_outside_darwin_temp();
        std::fs::create_dir_all(root.join("src")).expect("src dir");
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"sandbox-probe\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[dependencies]\n",
        )
        .expect("Cargo.toml fixture");
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").expect("main.rs fixture");
        // Standalone crate: an inherited workspace root would sit outside the
        // sandbox and cargo would fail for an unrelated reason.
        std::fs::write(
            root.join("Cargo.lock"),
            "version = 3\n\n[[package]]\nname = \"sandbox-probe\"\nversion = \"0.0.0\"\n",
        )
        .expect("lock fixture");

        let output = run_in_sandbox(
            &root,
            "command -v cargo >/dev/null 2>&1 || exit 0; \
             cargo build --offline --quiet 2>&1 || exit 60; \
             test -x target/debug/sandbox-probe || exit 61; \
             if cat \"$HOME/.cargo/credentials.toml\" >/dev/null 2>&1; then exit 62; fi",
        );
        let code = output.status.code().unwrap_or(-1);
        assert_eq!(
            code,
            0,
            "exit={code} stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
