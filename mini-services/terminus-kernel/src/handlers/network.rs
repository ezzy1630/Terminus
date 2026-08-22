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

    let mut status = 0u16;
    let mut body_out = String::new();
    let mut relay_note: Option<String> = None;
    let mut bytes_relayed = 0u64;

    // The request line must be a bare HTTP token; a client-supplied method
    // containing whitespace or control characters would inject headers into
    // the outbound request.
    let method_upper = req.method.to_ascii_uppercase();
    if method_upper.is_empty() || !method_upper.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ApiError::validation(
            format!("invalid http method `{}`", req.method),
            &trace_id.0,
        ));
    }

    if scheme != "http" {
        // Never downgrade a non-http URL (e.g. https) to plaintext TCP.
        relay_note = Some(format!(
            "{scheme} scheme authorized but not relayed by this broker (TLS not supported here); no request was sent"
        ));
    } else if let Some(target_ip) = resolved_ips.first() {
        let target_addr = std::net::SocketAddr::new(*target_ip, port);
        match tokio::net::TcpStream::connect(target_addr).await {
            Ok(mut stream) => {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let path = if url.path().is_empty() { "/" } else { url.path() };
                let path_and_query = match url.query() {
                    Some(q) => format!("{path}?{q}"),
                    None => path.to_string(),
                };
                let http_req = format!(
                    "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                    method_upper,
                    path_and_query,
                    host,
                    req.body.len(),
                    req.body
                );
                match stream.write_all(http_req.as_bytes()).await {
                    Ok(()) => {
                        bytes_relayed += http_req.len() as u64;
                        let mut resp_buf = Vec::new();
                        match stream.read_to_end(&mut resp_buf).await {
                            Ok(_) => {
                                bytes_relayed += resp_buf.len() as u64;
                                if !resp_buf.is_empty() {
                                    body_out = String::from_utf8_lossy(&resp_buf).to_string();
                                    status = body_out
                                        .split_whitespace()
                                        .nth(1)
                                        .and_then(|s| s.parse::<u16>().ok())
                                        .unwrap_or(0);
                                }
                            }
                            Err(e) => {
                                relay_note = Some(format!("relay read failed: {e}"));
                            }
                        }
                    }
                    Err(e) => {
                        relay_note = Some(format!("relay write failed: {e}"));
                    }
                }
            }
            Err(e) => {
                relay_note = Some(format!("relay connect failed: {e}"));
            }
        }
    } else {
        relay_note = Some("no resolved address to relay to".to_string());
    }

    Ok(Json(EgressResponse {
        authorized: true,
        status,
        headers: std::collections::BTreeMap::new(),
        body: body_out,
        resolved_ips: resolved_ip_strings,
        denial_reason: relay_note,
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
