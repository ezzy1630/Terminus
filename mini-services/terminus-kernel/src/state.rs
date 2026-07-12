//! Application state shared by all handlers.

use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;

use forge_authz::{OperationClass, Scope, TokenBinder, TokenIssuer};
use forge_kernel::KernelHandle;
use forge_kernel_protocol::OutputChunk;
use tokio::sync::Mutex;
use tracing::info;

use crate::idempotency::IdempotencyMap;

/// Default bearer token if `FORGE_KERNEL_TOKEN` is unset.
pub const DEFAULT_BEARER_TOKEN: &str = "forge-kernel-dev-token";

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
    pub process_exits: Arc<Mutex<HashMap<String, forge_kernel_protocol::ProcessExited>>>,
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
            .field("dev_capability_token_set", &!self.dev_capability_token.is_empty())
            .field("started_at", &self.started_at)
            .field("build_commit", &self.build_commit)
            .field("data_dir", &self.data_dir)
            .finish_non_exhaustive()
    }
}

impl AppState {
    /// Build the app state from environment variables.
    pub fn from_env() -> Result<Self, std::io::Error> {
        let data_dir = env::var("FORGE_DATA")
            .unwrap_or_else(|_| ".forge-data".to_string());
        let data_dir = PathBuf::from(&data_dir);
        std::fs::create_dir_all(&data_dir)?;

        let kernel = KernelHandle::new(data_dir.clone()).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::Other, format!("kernel assembly: {e}"))
        })?;

        // Token issuer with a dev secret. In production this secret is loaded
        // from a sealed config and the kernel instance id matches the
        // KernelHandle's info service instance id.
        let kernel_instance_id = kernel.info.instance_id().to_string();
        let issuer_secret =
            env::var("FORGE_KERNEL_CAPABILITY_SECRET").unwrap_or_else(|_| {
                "forge-kernel-dev-capability-secret-please-rotate".to_string()
            });
        let token_issuer = Arc::new(TokenIssuer::new(
            issuer_secret.into_bytes(),
            kernel_instance_id,
            // 10-year TTL for the dev token (315_360_000 seconds).
            315_360_000,
        ));

        // Mint a long-lived dev capability token with all operation classes.
        let binder = TokenBinder {
            principal: "forge-dev".to_string(),
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
        let dev_capability_token = token_issuer
            .mint(binder, ops, Scope::default(), None, "dev-capability-nonce")
            .and_then(|t| t.encode())
            .unwrap_or_else(|_| "<dev-token-mint-failed>".to_string());

        let bearer_token =
            env::var("FORGE_KERNEL_TOKEN").unwrap_or_else(|_| DEFAULT_BEARER_TOKEN.to_string());

        let started_at = chrono::Utc::now().to_rfc3339();
        let build_commit = env::var("FORGE_BUILD_COMMIT").unwrap_or_else(|_| "dev".to_string());

        info!(%started_at, %build_commit, data_dir = %data_dir.display(), "kernel mini-service initialized");
        info!("bearer token (Authorization: Bearer ...): {}", &bearer_token);
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
