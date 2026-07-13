//! Application state shared by all handlers.

use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;

use terminus_authz::{OperationClass, Scope, TokenBinder, TokenIssuer};
use terminus_kernel::KernelHandle;
use terminus_kernel_protocol::OutputChunk;
use tokio::sync::Mutex;
use tracing::info;

use crate::idempotency::IdempotencyMap;

/// Default bearer token if `TERMINUS_KERNEL_TOKEN` is unset.
pub const DEFAULT_BEARER_TOKEN: &str = "terminus-kernel-dev-token";

/// The shared application state.
#[derive(Clone)]
pub struct AppState {
    pub kernel: KernelHandle,
    /// Token issuer used to validate capability tokens. In the dev mini-service
    /// this is also used to mint a long-lived dev token at startup.
    pub token_issuer: Arc<TokenIssuer>,
    /// A long-lived dev capability token, logged at startup so the UI/control
    /// plane can use it. In production, capability tokens are short-lived and
    /// minted by the control plane after approval.
    pub dev_capability_token: String,
    /// The static bearer token expected in the `Authorization` header.
    pub bearer_token: String,
    /// In-flight idempotency dedup map.
    pub idempotency: Arc<IdempotencyMap>,
    /// Captured process output chunks, keyed by process_id. Populated by a
    /// background task that consumes the ProcessEvent stream.
    pub process_outputs: Arc<Mutex<HashMap<String, Vec<OutputChunk>>>>,
    /// Final ProcessEvent per process, used to expose exit status.
    pub process_exits: Arc<Mutex<HashMap<String, terminus_kernel_protocol::ProcessExited>>>,
    /// RFC3339 timestamp captured at startup.
    pub started_at: String,
    /// Build commit (best-effort, from env or "dev").
    pub build_commit: String,
    /// Data dir under which artifacts/state live.
    pub data_dir: PathBuf,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("bearer_token_set", &!self.bearer_token.is_empty())
            .field(
                "dev_capability_token_set",
                &!self.dev_capability_token.is_empty(),
            )
            .field("started_at", &self.started_at)
            .field("build_commit", &self.build_commit)
            .field("data_dir", &self.data_dir)
            .finish_non_exhaustive()
    }
}

impl AppState {
    /// Build the app state from environment variables.
    pub fn from_env() -> Result<Self, std::io::Error> {
        let data_dir = env::var("TERMINUS_DATA").unwrap_or_else(|_| ".terminus-data".to_string());
        let data_dir = PathBuf::from(&data_dir);
        std::fs::create_dir_all(&data_dir)?;

        // SPEC §13.6 / §31.6: well-known dev tokens/secrets are permitted
        // ONLY when TERMINUS_DEV=1. Without it, the kernel fails closed if no
        // real token/secret is configured. Never set TERMINUS_DEV=1 in prod.
        let dev_mode = env::var("TERMINUS_DEV").map(|v| v == "1").unwrap_or(false);

        let kernel = KernelHandle::new(data_dir.clone())
            .map_err(|e| std::io::Error::other(format!("kernel assembly: {e}")))?;

        // The KernelHandle owns the one issuer used by every service. The
        // control-plane token must be minted by that issuer; a second issuer
        // would produce signatures and audiences the gRPC adapters cannot
        // validate.
        let token_issuer = Arc::clone(&kernel.token_issuer);

        // Mint a long-lived dev capability token with all operation classes.
        let binder = TokenBinder {
            principal: "terminus-dev".to_string(),
            session_id: "dev-session".to_string(),
            task_id: "dev-task".to_string(),
            workspace_id: "dev-workspace".to_string(),
            kernel_instance_id: String::new(),
        };
        let ops = vec![
            OperationClass::Read,
            OperationClass::Patch,
            OperationClass::Exec,
            OperationClass::Job,
            OperationClass::Sandbox,
            OperationClass::Policy,
            OperationClass::Secret,
            OperationClass::Network,
            OperationClass::CodeIntel,
            OperationClass::Extension,
            OperationClass::Git,
            OperationClass::ArtifactIngest,
            OperationClass::Admin,
        ];
        // The all-operations dev capability token is minted ONLY in dev mode.
        // In production the control plane mints short-lived, scoped capability
        // tokens after approval; the kernel does not vend a god token.
        let dev_capability_token = if dev_mode {
            token_issuer
                .mint(
                    binder,
                    ops,
                    Scope::default(),
                    Some(315_360_000),
                    "dev-capability-nonce",
                )
                .and_then(|t| t.encode())
                .unwrap_or_else(|_| "<dev-token-mint-failed>".to_string())
        } else {
            String::new()
        };

        // Test harnesses must not scrape bearer capabilities from logs. When
        // explicitly requested in development, publish the short-lived test
        // capability through a private file instead. Production never sets
        // this path and therefore has no file-based capability handoff.
        if dev_mode {
            if let Ok(path) = env::var("TERMINUS_KERNEL_CAP_TOKEN_FILE") {
                if !path.is_empty() {
                    std::fs::write(&path, &dev_capability_token)?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
                    }
                }
            }
        }

        let bearer_token = match env::var("TERMINUS_KERNEL_TOKEN") {
            Ok(t) if !t.is_empty() => t,
            _ if dev_mode => DEFAULT_BEARER_TOKEN.to_string(),
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "TERMINUS_KERNEL_TOKEN is required (or set TERMINUS_DEV=1 for local dev)",
                ));
            }
        };

        let started_at = chrono::Utc::now().to_rfc3339();
        let build_commit = env::var("TERMINUS_BUILD_COMMIT").unwrap_or_else(|_| "dev".to_string());

        info!(%started_at, %build_commit, data_dir = %data_dir.display(), "kernel mini-service initialized");
        info!(
            "bearer token (Authorization: Bearer ...): {}",
            &bearer_token
        );
        info!(
            "dev capability token (x-capability-token: ...): {}",
            &dev_capability_token
        );

        Ok(Self {
            kernel,
            token_issuer,
            dev_capability_token,
            bearer_token,
            idempotency: Arc::new(IdempotencyMap::new()),
            process_outputs: Arc::new(Mutex::new(HashMap::new())),
            process_exits: Arc::new(Mutex::new(HashMap::new())),
            started_at,
            build_commit,
            data_dir,
        })
    }
}
