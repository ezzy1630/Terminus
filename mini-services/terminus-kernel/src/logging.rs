//! Request observability — logs method, path, status, latency, trace_id
//! for every request.

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use std::time::Instant;
use tracing::info;

use crate::trace_id::TraceId;

pub async fn log_requests(req: Request, next: Next) -> Response {
    let start = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let trace_id = TraceId::from_request_or_new(&req).0;
    let mut req = req;
    req.extensions_mut().insert(TraceId::new(trace_id.clone()));
    let resp = next.run(req).await;
    let status = resp.status();
    let latency_ms = start.elapsed().as_millis();
    info!(
        %method,
        %path,
        %status,
        latency_ms,
        trace_id = %trace_id,
        "request"
    );
    let mut resp = resp;
    resp.headers_mut().insert(
        "x-trace-id",
        axum::http::HeaderValue::from_str(&trace_id)
            .unwrap_or_else(|_| axum::http::HeaderValue::from_static("")),
    );
    resp
}
