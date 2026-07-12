//! Forge kernel HTTP mini-service — the non-bypassable effect boundary
//! (SPEC §5.2, §13, §27, §31).
//!
//! Stands up an `axum` HTTP server on port `3040` that wires every kernel
//! service to a JSON-over-HTTP endpoint. The TypeScript control plane and
//! Next.js UI reach this service through the Caddy gateway using
//! `?XTransformPort=3040`.

mod api;
mod auth;
mod error;
mod handlers;
mod idempotency;
mod logging;
mod state;
mod trace_id;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::middleware::{self, from_fn, from_fn_with_state};
use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::auth::{cors_layer, require_bearer, require_capability_for_path};
use crate::state::AppState;

/// Hardcoded port — never from env (SPEC §31 dev mini-service contract).
const PORT: u16 = 3040;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let state = Arc::new(AppState::from_env()?);
    let app = build_router(state.clone());

    let addr: SocketAddr = ([0, 0, 0, 0], PORT).into();
    let listener = TcpListener::bind(addr).await?;
    info!(%addr, "forge-kernel mini-service listening");
    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn build_router(state: Arc<AppState>) -> Router {
    // All routes in one Router. The state type is `Arc<AppState>`; handlers
    // extract `State<Arc<AppState>>`. Middleware layers carry their own
    // state via `from_fn_with_state` independently of the router's state.
    let app = Router::<Arc<AppState>>::new()
        // ----- KernelInfoService -----
        .route("/v1/info", post(handlers::info::info))
        .route("/v1/health", post(handlers::info::health))
        // ----- WorkspaceService -----
        .route("/v1/workspaces/register", post(handlers::workspaces::register))
        .route("/v1/workspaces/:id/get", post(handlers::workspaces::get))
        // ----- FileService -----
        .route("/v1/files/read", post(handlers::files::read))
        .route("/v1/files/list", post(handlers::files::list))
        // ----- PatchService -----
        .route("/v1/patch/preview", post(handlers::patch::preview))
        .route("/v1/patch/apply", post(handlers::patch::apply))
        .route("/v1/patch/reconcile", post(handlers::patch::reconcile))
        // ----- ProcessService -----
        .route("/v1/process/start", post(handlers::process::start))
        .route("/v1/process/:id/cancel", post(handlers::process::cancel))
        .route("/v1/process/:id/output", get(handlers::process::output))
        // ----- JobService -----
        .route("/v1/jobs/start", post(handlers::jobs::start))
        .route("/v1/jobs/:id/stream", get(handlers::jobs::stream))
        .route("/v1/jobs/:id/input", post(handlers::jobs::input))
        .route("/v1/jobs/:id/signal", post(handlers::jobs::signal))
        .route("/v1/jobs/:id/stop", post(handlers::jobs::stop))
        .route("/v1/jobs/:id", get(handlers::jobs::get))
        // ----- SandboxService -----
        .route("/v1/sandbox/backends", get(handlers::sandbox::backends))
        .route("/v1/sandbox/select", post(handlers::sandbox::select))
        // ----- PolicyService -----
        .route("/v1/policy/evaluate", post(handlers::policy::evaluate))
        // ----- SecretService -----
        .route("/v1/secrets/request", post(handlers::secrets::request))
        .route("/v1/secrets/audit", post(handlers::secrets::audit))
        .route("/v1/secrets/redact", post(handlers::secrets::redact))
        // ----- NetworkService -----
        .route("/v1/network/request", post(handlers::network::request))
        .route("/v1/network/allowlist", get(handlers::network::allowlist))
        // ----- CodeIntelligenceService -----
        .route("/v1/code-intel/inspect-symbol", post(handlers::code_intel::inspect_symbol))
        .route("/v1/code-intel/find-references", post(handlers::code_intel::find_references))
        .route("/v1/code-intel/diagnose-files", post(handlers::code_intel::diagnose_files))
        // ----- ExtensionRuntimeService -----
        .route("/v1/extensions/load", post(handlers::extensions::load))
        .route("/v1/extensions/invoke", post(handlers::extensions::invoke))
        // ----- ArtifactIngestService -----
        .route("/v1/artifacts/ingest", post(handlers::artifacts::ingest))
        .route("/v1/artifacts/:hash", get(handlers::artifacts::get))
        .route("/v1/artifacts/:hash/metadata", get(handlers::artifacts::metadata))
        .route("/v1/artifacts/gc", post(handlers::artifacts::gc))
        // ----- Middleware layers (outermost first) -----
        .layer(from_fn_with_state(state.clone(), require_capability_for_path))
        .layer(from_fn_with_state(state.clone(), require_bearer))
        .layer(from_fn(logging::log_requests))
        .layer(middleware::from_fn(cors_layer))
        .with_state(state);

    app
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("shutdown signal received");
}
