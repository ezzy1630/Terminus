//! Terminus kernel HTTP mini-service — the non-bypassable effect boundary
//! (SPEC §5.2, §13, §27, §31).
//!
//! Stands up an `axum` HTTP server on port `3040` that wires every kernel
//! service to a JSON-over-HTTP endpoint. The TypeScript control plane and
//! Next.js UI reach this service through the Caddy gateway using
//! `?XTransformPort=3040`.

mod api;
mod auth;
mod error;
mod grpc;
mod handlers;
mod idempotency;
mod logging;
mod mtls;
mod state;
mod trace_id;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::middleware::{self, from_fn, from_fn_with_state};
use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use crate::auth::{cors_layer, require_bearer, require_capability_for_path};
use crate::state::AppState;

/// Loopback bootstrap port. Production uses the UDS transport; the env
/// override keeps deterministic local harnesses isolated from other runs.
const DEFAULT_PORT: u16 = 3040;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(target_os = "linux")]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(String::as_str) == Some(terminus_sandbox_linux::LAUNCHER_ARG) {
            match terminus_sandbox_linux::run_launcher(&args[1..]) {
                Ok(code) => std::process::exit(code),
                Err(error) => {
                    eprintln!("terminus sandbox launcher failed: {error}");
                    std::process::exit(126);
                }
            }
        }
        if args.get(1).map(String::as_str) == Some(terminus_sandbox_linux::PAYLOAD_ARG) {
            match terminus_sandbox_linux::run_payload(&args[1..]) {
                Ok(code) => std::process::exit(code),
                Err(error) => {
                    eprintln!("terminus sandbox payload failed closed: {error}");
                    std::process::exit(126);
                }
            }
        }
        if args.get(1).map(String::as_str) == Some("--terminus-sandbox-probe") {
            match terminus_sandbox_linux::run_probe() {
                Ok(code) => std::process::exit(code),
                Err(error) => {
                    eprintln!("terminus sandbox probe failed: {error}");
                    std::process::exit(126);
                }
            }
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let state = Arc::new(AppState::from_env()?);
    let app = build_router(state.clone());
    let desktop_parent_pid = desktop_parent_pid_from_env()?;

    let grpc_socket = std::env::var("TERMINUS_KERNEL_GRPC_SOCKET")
        .ok()
        .filter(|value| !value.is_empty());
    let require_uds = std::env::var("TERMINUS_KERNEL_REQUIRE_UDS")
        .map(|value| value == "1")
        .unwrap_or(false);
    let require_mtls = std::env::var("TERMINUS_KERNEL_MTLS")
        .map(|value| value == "1")
        .unwrap_or(false);

    let allow_http_bootstrap = std::env::var("TERMINUS_KERNEL_HTTP_BOOTSTRAP")
        .map(|value| value == "1")
        .unwrap_or(false)
        && std::env::var("TERMINUS_DEV")
            .map(|value| value == "1")
            .unwrap_or(false);
    if !require_uds && !require_mtls && !allow_http_bootstrap {
        return Err(
            "secure kernel startup requires TERMINUS_KERNEL_REQUIRE_UDS=1 or TERMINUS_KERNEL_MTLS=1; HTTP bootstrap is development-only"
                .into(),
        );
    }

    if require_mtls {
        let material = mtls::mtls_material_from_env()?;
        let addr = std::env::var("TERMINUS_KERNEL_MTLS_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:7443".to_string());
        let bind_addr: std::net::SocketAddr = addr
            .parse()
            .map_err(|e| format!("invalid TERMINUS_KERNEL_MTLS_ADDR: {e}"))?;
        grpc::serve_grpc_mtls(bind_addr, state.kernel.clone(), &material).await?;
        return Ok(());
    }

    // Production must not retain the privileged HTTP bootstrap once the UDS
    // transport is required. Failing closed here prevents a misconfigured
    // deployment from silently exposing the effect kernel over TCP.
    if require_uds {
        let socket = grpc_socket
            .ok_or("TERMINUS_KERNEL_REQUIRE_UDS=1 requires TERMINUS_KERNEL_GRPC_SOCKET")?;
        grpc::serve_grpc(
            std::path::PathBuf::from(socket),
            state.kernel.clone(),
            desktop_parent_pid,
        )
        .await?;
        return Ok(());
    }

    // Development-only compatibility path. Production must set
    // TERMINUS_KERNEL_REQUIRE_UDS=1 above, which returns before any TCP
    // listener is created.
    let port = std::env::var("TERMINUS_KERNEL_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = TcpListener::bind(addr).await?;
    info!(%addr, "terminus-kernel mini-service listening (loopback only)");

    // ADR-0007 gRPC-over-UDS transport: if TERMINUS_KERNEL_GRPC_SOCKET is set,
    // serve KernelInfoService over a Unix-domain socket alongside the HTTP
    // bootstrap. The gRPC path is the canonical transport; the HTTP path
    // remains until the control plane migrates method-by-method (M3).
    if let Some(sock) = grpc_socket {
        let kernel = state.kernel.clone();
        let sock_path = std::path::PathBuf::from(sock);
        state
            .spawn_background(async move {
                if let Err(e) = grpc::serve_grpc(sock_path, kernel, desktop_parent_pid).await {
                    tracing::error!(error = %e, "terminus-kernel gRPC server exited with error");
                }
            })
            .await;
    }

    let signal_shutdown_kernel = state.kernel.clone();
    let http_result = axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(async move {
            shutdown_signal(desktop_parent_pid).await;
            if let Err(error) = signal_shutdown_kernel.shutdown().await {
                error!(%error, "kernel failed to reap owned processes during HTTP shutdown");
            }
        })
        .await;
    let process_shutdown = state.kernel.shutdown().await;
    state.shutdown_background().await;
    http_result?;
    process_shutdown.map_err(|error| error.to_string())?;
    Ok(())
}

fn build_router(state: Arc<AppState>) -> Router {
    // All routes in one Router. The state type is `Arc<AppState>`; handlers
    // extract `State<Arc<AppState>>`. Middleware layers carry their own
    // state via `from_fn_with_state` independently of the router's state.
    Router::<Arc<AppState>>::new()
        // ----- KernelInfoService -----
        .route("/v1/info", post(handlers::info::info))
        .route("/v1/health", post(handlers::info::health))
        // ----- WorkspaceService -----
        .route(
            "/v1/workspaces/register",
            post(handlers::workspaces::register),
        )
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
        .route(
            "/v1/connectors/grants/mint",
            post(handlers::connectors::mint_grant),
        )
        .route(
            "/v1/connectors/execute",
            post(handlers::connectors::execute),
        )
        // ----- NetworkService -----
        .route("/v1/network/request", post(handlers::network::request))
        .route("/v1/network/allowlist", get(handlers::network::allowlist))
        // ----- CodeIntelligenceService -----
        .route(
            "/v1/code-intel/inspect-symbol",
            post(handlers::code_intel::inspect_symbol),
        )
        .route(
            "/v1/code-intel/find-references",
            post(handlers::code_intel::find_references),
        )
        .route(
            "/v1/code-intel/diagnose-files",
            post(handlers::code_intel::diagnose_files),
        )
        // ----- ExtensionRuntimeService -----
        .route("/v1/extensions/load", post(handlers::extensions::load))
        .route("/v1/extensions/invoke", post(handlers::extensions::invoke))
        // ----- ArtifactIngestService -----
        .route("/v1/artifacts/ingest", post(handlers::artifacts::ingest))
        .route("/v1/artifacts/:hash", get(handlers::artifacts::get))
        .route(
            "/v1/artifacts/:hash/metadata",
            get(handlers::artifacts::metadata),
        )
        .route("/v1/artifacts/gc", post(handlers::artifacts::gc))
        // ----- Middleware layers (outermost first) -----
        .layer(from_fn_with_state(
            state.clone(),
            require_capability_for_path,
        ))
        .layer(from_fn_with_state(state.clone(), require_bearer))
        .layer(from_fn(logging::log_requests))
        .layer(middleware::from_fn(cors_layer))
        .with_state(state)
}

fn desktop_parent_pid_from_env() -> Result<Option<u32>, String> {
    match std::env::var("TERMINUS_DESKTOP_PARENT_PID") {
        Ok(value) => {
            let parsed = value.parse::<u32>().map_err(|_| {
                "TERMINUS_DESKTOP_PARENT_PID must be a positive process ID".to_string()
            })?;
            if parsed <= 1 {
                return Err(
                    "TERMINUS_DESKTOP_PARENT_PID must be a positive process ID greater than one"
                        .to_string(),
                );
            }
            Ok(Some(parsed))
        }
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err("TERMINUS_DESKTOP_PARENT_PID must contain valid UTF-8".to_string())
        }
    }
}

pub(crate) async fn shutdown_signal(desktop_parent_pid: Option<u32>) {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            error!(%error, "failed to receive Ctrl-C shutdown signal");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                error!(%error, "failed to install termination-signal handler");
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    let parent_exit = async move {
        match desktop_parent_pid {
            Some(expected) => loop {
                #[cfg(unix)]
                {
                    let observed = nix::unistd::getppid().as_raw();
                    if observed <= 1 || i64::from(observed) != i64::from(expected) {
                        error!(expected, observed, "desktop supervisor disappeared");
                        break;
                    }
                }
                #[cfg(not(unix))]
                {
                    let _ = expected;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            },
            None => std::future::pending::<()>().await,
        }
    };

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
        _ = parent_exit => {},
    }

    info!("shutdown signal received");
}
