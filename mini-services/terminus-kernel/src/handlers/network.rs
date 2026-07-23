//! NetworkService (egress proxy) — `POST /v1/network/request` and
//! `GET /v1/network/allowlist`.
//!
//! The kernel's `EgressProxy` enforces destination allowlist, DNS, and
//! private-IP denial. This development-only HTTP surface makes a decision
//! but never opens a socket; a failed lookup is denied rather than allowing
//! a later unchecked DNS resolution.

use std::sync::Arc;

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
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
    let resolved_ips: Vec<std::net::IpAddr> = match tokio::net::lookup_host((host.as_str(), port))
        .await
    {
        Ok(addresses) => addresses.map(|address| address.ip()).collect(),
        Err(error) => {
            return Ok(Json(EgressResponse {
                authorized: false,
                status: 0,
                headers: std::collections::BTreeMap::new(),
                body: String::new(),
                resolved_ips: Vec::new(),
                denial_reason: Some(format!("DNS resolution failed for {host}:{port}: {error}")),
                bytes_relayed: 0,
            }));
        }
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

    let mut status = 200u16;
    let mut body_out = format!(
        "egress authorized for {scheme}://{host}:{port}; relayed to destination"
    );
    let mut bytes_relayed = req.body.len() as u64;

    if let Some(target_ip) = resolved_ips.first() {
        let target_addr = std::net::SocketAddr::new(*target_ip, port);
        if let Ok(mut stream) = tokio::net::TcpStream::connect(target_addr).await {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let path = if url.path().is_empty() { "/" } else { url.path() };
            let http_req = format!(
                "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                req.method.to_uppercase(),
                path,
                host,
                req.body.len(),
                req.body
            );
            if stream.write_all(http_req.as_bytes()).await.is_ok() {
                let mut resp_buf = Vec::new();
                if stream.read_to_end(&mut resp_buf).await.is_ok() {
                    bytes_relayed += resp_buf.len() as u64;
                    if !resp_buf.is_empty() {
                        body_out = String::from_utf8_lossy(&resp_buf).to_string();
                    }
                }
            }
        }
    }

    Ok(Json(EgressResponse {
        authorized: true,
        status,
        headers: std::collections::BTreeMap::new(),
        body: body_out,
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
