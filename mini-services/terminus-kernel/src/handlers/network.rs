//! NetworkService (egress proxy) — `POST /v1/network/request` and
//! `GET /v1/network/allowlist`.
//!
//! The kernel's `EgressProxy` enforces destination allowlist, DNS, and
//! private-IP denial, but its TCP relay is a stub that does not actually
//! open sockets. The HTTP mini-service runs the authorization check and,
//! for allowed destinations, attempts the request via `reqwest`-like
//! behavior. Since we don't want a heavy HTTP client dependency in the
//! dev mini-service, we return a structured "relay not performed" response
//! after authorization succeeds, plus the bytes budget consumed.

use std::sync::Arc;

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::net::ToSocketAddrs;
use terminus_egress::EgressPolicy;

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct EgressRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Serialize)]
pub struct EgressResponse {
    pub authorized: bool,
    pub status: u16,
    pub headers: std::collections::BTreeMap<String, String>,
    pub body: String,
    pub resolved_ips: Vec<String>,
    pub denial_reason: Option<String>,
    pub bytes_relayed: u64,
}

pub async fn request(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<EgressResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: EgressRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);

    // Parse the URL.
    let url = match url::Url::parse(&req.url) {
        Ok(u) => u,
        Err(e) => {
            return Err(ApiError::validation(
                format!("invalid url `{}`: {e}", req.url),
                &trace_id.0,
            ));
        }
    };
    let host = url.host_str().unwrap_or("").to_string();
    let port = url.port_or_known_default().unwrap_or(0);
    let scheme = url.scheme().to_string();

    // Resolve the host to IPs (for private-IP denial).
    let resolved_ips: Vec<std::net::IpAddr> = match (host.as_str(), port).to_socket_addrs() {
        Ok(iter) => iter.map(|sa| sa.ip()).collect(),
        Err(_) => Vec::new(),
    };
    let resolved_ip_strings: Vec<String> = resolved_ips.iter().map(|ip| ip.to_string()).collect();

    // Authorize via the kernel's egress proxy.
    let auth_result = state.kernel.network.authorize(
        &req.envelope.request_context,
        &req.envelope.effect_intent,
        &host,
        port,
        &scheme,
        &resolved_ips,
    );
    if let Err(e) = auth_result {
        return Ok(Json(EgressResponse {
            authorized: false,
            status: 0,
            headers: std::collections::BTreeMap::new(),
            body: String::new(),
            resolved_ips: resolved_ip_strings,
            denial_reason: Some(format!("{e}")),
            bytes_relayed: 0,
        }));
    }

    // The kernel's relay is a stub; we record the byte budget but do not
    // actually perform the network I/O in the dev mini-service.
    let bytes_relayed = req.body.len() as u64;
    Ok(Json(EgressResponse {
        authorized: true,
        status: 200,
        headers: std::collections::BTreeMap::new(),
        body: format!(
            "egress authorized for {scheme}://{host}:{port}; relay not performed in dev mini-service"
        ),
        resolved_ips: resolved_ip_strings,
        denial_reason: None,
        bytes_relayed,
    }))
}

#[derive(Debug, Serialize)]
pub struct AllowlistResponse {
    pub default_deny: bool,
    pub deny_private_ips: bool,
    pub destinations: Vec<serde_json::Value>,
}

pub async fn allowlist(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AllowlistResponse>, ApiError> {
    let policy: &EgressPolicy = state.kernel.network.policy();
    let destinations: Vec<serde_json::Value> = policy
        .destinations
        .iter()
        .map(|d| serde_json::to_value(d).unwrap_or(serde_json::Value::Null))
        .collect();
    Ok(Json(AllowlistResponse {
        default_deny: policy.default_deny,
        deny_private_ips: policy.deny_private_ips,
        destinations,
    }))
}
